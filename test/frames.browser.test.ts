// Real-browser boundary tests for frame-hosted targets and password fields: a local node:http
// server, a real Chromium page, observe()/act() driven directly (no Jev, no runner). Skipped
// entirely when JEV_QA_NO_BROWSER is set.
//
// The iframe is served from the same origin only because the fixture server has one origin;
// the engine code under test never reaches across the frame boundary from the parent (it
// snapshots each frame from inside, via frame.evaluate, and translates geometry from the
// <iframe> element's box) — so the same code path serves a cross-origin payment frame.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { act, observe } from '../src/browser.ts';
import { buildBody } from '../src/jev.ts';

const SKIP = process.env.JEV_QA_NO_BROWSER ? 'JEV_QA_NO_BROWSER is set' : false;

const OUTER_HTML = (overlay: boolean) => `<!doctype html>
<html><head><title>outer</title></head><body>
<h1>Checkout</h1>
<input id="outer" type="text" aria-label="Name">
<input id="pw" type="password" aria-label="Password">
<div style="height:150px"></div>
<iframe id="f" src="/inner" style="width:400px;height:200px;border:10px solid #888;padding:6px"></iframe>
${overlay ? '<div id="overlay" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:10;background:rgba(0,0,0,0.01)"></div>' : ''}
<div style="height:1200px"></div>
</body></html>`;

// 998 characters (6 copies + separators end 6 short of the cap), distinctive in every 6-character window (no repeats of the head).
const ECHO_SECRET = 'Kq7Zw!' + Array.from({ length: 992 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

const INNER_HTML = `<!doctype html>
<html><head><title>inner</title></head><body>
<label for="card">Card number</label>
<input id="card" name="card" type="text">
<button id="pay" type="button">Pay</button>
<script>
document.getElementById('pay').addEventListener('click', () => { document.title = 'paid'; });
</script>
</body></html>`;

async function fixture(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/inner') res.end(INNER_HTML);
    else if (path === '/covered') res.end(OUTER_HTML(true));
    else if (path === '/echo') res.end('<!doctype html><html><body>' + Array.from({ length: 7 }, () => '<p>' + ECHO_SECRET + '</p>').join('') + '</body></html>');
    else if (path === '/mid') res.end('<!doctype html><html><body><iframe id="m" src="/inner" style="width:380px;height:180px;border:0"></iframe></body></html>');
    else if (path === '/nested-covered') res.end('<!doctype html><html><body><iframe id="o" src="/mid" style="width:420px;height:220px;border:0"></iframe><div id="overlay" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:10;background:rgba(0,0,0,0.01)"></div></body></html>');
    else if (path === '/scaled') res.end('<!doctype html><html><body><iframe id="s" src="/inner" style="width:400px;height:200px;border:0;transform:scale(0.5);transform-origin:0 0"></iframe></body></html>');
    else if (path === '/sibling') res.end(OUTER_HTML(false).replace('<div style="height:1200px"></div>', '<iframe id="g" src="/inner" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0;opacity:0.01"></iframe><div style="height:1200px"></div>'));
    else res.end(OUTER_HTML(false));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('frames: the snapshot lists frame-hosted controls with page coordinates, and input by coordinates reaches them', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/');
    const inner = page.frames().find((f) => f.url().endsWith('/inner'))!;
    const iframeBox = (await (await inner.frameElement()).boundingBox())!;

    const obs = await observe(page);
    const card = obs.actions.find((a) => a.label === 'Card number' && a.kind === 'fill');
    const pay = obs.actions.find((a) => a.label === 'Pay' && a.kind === 'click');
    assert.ok(card, 'the framed input is offered as a fill target');
    assert.ok(pay, 'the framed button is offered as a click target');
    assert.equal(card!.frame, 1, 'it carries the frame index');
    assert.equal(obs.actions.find((a) => a.label === 'Name')!.frame, undefined, 'main-document targets carry no frame');
    // Geometry is translated into page coordinates: the iframe's border box PLUS its border and
    // padding (16px here), then the control's own frame-local position.
    const local = await inner.evaluate(() => { const r = document.getElementById('card')!.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    assert.ok(Math.abs(card!.rect!.x - (iframeBox.x + 16 + local.x)) < 1, `framed input x=${card!.rect!.x}, expected ${iframeBox.x} + 16 + ${local.x}`);
    assert.ok(Math.abs(card!.rect!.y - (iframeBox.y + 16 + local.y)) < 1, `framed input y=${card!.rect!.y}, expected ${iframeBox.y} + 16 + ${local.y}`);
    assert.ok(obs.text.includes('Card number'), 'frame text is appended to the page text');
    assert.ok(obs.text.includes('Checkout'), 'main text is kept');

    // Same node id in two frames must not collapse into one Jev element.
    const outerName = obs.actions.find((a) => a.label === 'Name')!;
    assert.equal(typeof outerName.node, 'number');
    const { elements } = buildBody({ ...obs, actions: [outerName, { ...card!, node: outerName.node }] }, 'goal', {}, []);
    assert.equal(elements.length, 2, 'main node N and frame node N are two distinct elements');

    await act(page, card!, '4242 4242 4242 4242');
    assert.equal(await inner.evaluate(() => (document.getElementById('card') as HTMLInputElement).value), '4242 4242 4242 4242', 'typing by page coordinates lands in the framed input');

    await act(page, pay!, null);
    assert.equal(await inner.title(), 'paid', 'clicking by page coordinates reaches the framed button');

    // Frame indices are stable across observations: a frame inserted BEFORE the payment frame
    // by a re-render must not shift the index an earlier decision (or lastFill) still holds.
    await page.evaluate(() => {
      const extra = document.createElement('iframe');
      extra.src = '/inner';
      extra.style.cssText = 'width:300px;height:100px';
      document.body.insertBefore(extra, document.getElementById('f'));
    });
    await page.waitForTimeout(500);
    const again = await observe(page);
    const cardAgain = again.actions.filter((a) => a.label === 'Card number' && a.kind === 'fill');
    assert.equal(cardAgain.length, 2, 'both frames offer a card field now');
    assert.ok(cardAgain.some((a) => a.frame === card!.frame), 'the original frame keeps its index');
    assert.ok(cardAgain.some((a) => a.frame === 2), 'the new frame gets the next index');
    await act(page, cardAgain.find((a) => a.frame === card!.frame)!, 'still-here');
    assert.equal(await inner.evaluate(() => (document.getElementById('card') as HTMLInputElement).value), 'still-here', 'the original index still reaches the original frame');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});

test('frames: a target inside a frame is refused when something in the main document covers the frame', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/covered');
    const inner = page.frames().find((f) => f.url().endsWith('/inner'))!;
    const obs = await observe(page);
    // The frame's own snapshot cannot see the parent's overlay, so the control is still LISTED …
    const card = obs.actions.find((a) => a.label === 'Card number' && a.kind === 'fill');
    assert.ok(card, 'listed: the frame-side snapshot cannot see a parent-side overlay');
    // … but the parent-side hit test refuses the input, and nothing reaches the field.
    await assert.rejects(() => act(page, card!, '4242'), /occluded/);
    assert.equal(await inner.evaluate(() => (document.getElementById('card') as HTMLInputElement).value), '', 'nothing was typed');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});

test('frames: a target inside a frame is refused when a SIBLING frame is laid over it (any iframe under the point is not enough)', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/sibling');
    const obs = await observe(page);
    const target = (await (await page.$('#f'))!.contentFrame())!;
    const cards = obs.actions.filter((a) => a.label === 'Card number' && a.kind === 'fill');
    assert.equal(cards.length, 2, 'both frames offer a card field');
    // The frame #f sits under the full-page sibling #g: input into #f must be refused (an
    // <iframe> under the point is not enough — it has to be #f's own), #g's own field works.
    let refused = 0;
    for (const a of cards) {
      try {
        await act(page, a, 'probe');
      } catch (e) {
        assert.match((e as Error).message, /occluded/);
        refused++;
      }
    }
    assert.equal(refused, 1, 'exactly the covered frame was refused');
    assert.equal(await target.evaluate(() => (document.getElementById('card') as HTMLInputElement).value), '', 'nothing reached the covered frame');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});

test('password fields: offered by name as fillable, value never read, and a scenario input fills them', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/');
    await page.evaluate(() => ((document.getElementById('pw') as HTMLInputElement).value = 'hunter2-already-there'));

    const obs = await observe(page);
    const pw = obs.actions.find((a) => a.label === 'Password' && a.kind === 'fill');
    assert.ok(pw, 'the password field is offered as a fill target');
    assert.equal(pw!.secret, true);
    assert.equal(pw!.value, '', 'its current value is never read');
    assert.equal(JSON.stringify(obs).includes('hunter2'), false, 'the value appears nowhere in the observation');

    const inputs = { password: 'Corr3ct-Horse!' };
    const { body } = buildBody(obs, 'set the password', inputs, [{ action: 'Password', kind: 'fill', text: inputs.password, page_changed: false }]);
    const json = JSON.stringify(body);
    assert.equal(json.includes(inputs.password), false, 'the scenario input value is never sent to Jev');
    assert.ok(json.includes('«password»'), 'Jev sees the input by key only');
    assert.ok(json.includes('"secret":true'), 'Jev is told the field is a password field');

    await act(page, pw!, inputs.password);
    assert.equal(await page.evaluate(() => (document.getElementById('pw') as HTMLInputElement).value), inputs.password, 'the input value was typed into the password field');
    const after = await observe(page);
    assert.equal(JSON.stringify(after).includes(inputs.password), false, 'still never read back after typing');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});


// Round 9 (P2): the occlusion check walks EVERY frame level up to the main document — an overlay
// over the OUTER frame of a nested pair must refuse the input, not receive the click.
test('frames: a nested-frame target is refused when the main document covers its outer frame', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/nested-covered');
    await page.waitForTimeout(500);
    const inner = page.frames().find((f) => f.url().endsWith('/inner'))!;
    const obs = await observe(page);
    const card = obs.actions.find((a) => a.label === 'Card number' && a.kind === 'fill');
    assert.ok(card, 'listed: no frame-side snapshot can see the main-document overlay');
    await assert.rejects(() => act(page, card!, '4242'), /occluded/);
    assert.equal(await inner.evaluate(() => (document.getElementById('card') as HTMLInputElement).value), '', 'nothing was typed');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});

// Round 9 (P2): a CSS-scaled frame would translate frame-local coordinates wrongly (the click
// could land on a different control while both hit tests pass) — such a frame is not offered.
test('frames: a CSS-scaled frame is not offered for input', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(base + '/scaled');
    await page.waitForTimeout(500);
    const obs = await observe(page);
    assert.equal(obs.actions.filter((a) => a.label === 'Card number' || a.label === 'Pay').length, 0, 'controls inside a scaled frame are not listed');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});


// Round 10 (P1): the snapshot keeps only WHOLE text nodes — a node cut at the 6,000-character
// cap could leave a secret prefix too short for any redaction to recognise.
test('snapshot: page text never ends in a partial node (no unredactable secret prefix)', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 4000 } });
    await page.goto(base + '/echo');
    const obs = await observe(page);
    assert.ok(obs.text.length <= 6000);
    const { body } = buildBody(obs, 'goal', { password: ECHO_SECRET }, [], new Set(), [ECHO_SECRET]);
    assert.ok(!JSON.stringify(body).includes(ECHO_SECRET.slice(0, 6)), 'no fragment of the secret reaches the decision API');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});

// Round 10 (P2): ANY non-translation transform (a mirror keeps the box size) refuses the frame.
test('frames: a mirrored frame (scaleX(-1)) is not offered; a translated one still is', { skip: SKIP }, async () => {
  const { server, base } = await fixture();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent('<iframe src="' + base + '/inner" style="width:400px;height:200px;border:0;transform:scaleX(-1)"></iframe>');
    await page.waitForTimeout(500);
    let obs = await observe(page);
    assert.equal(obs.actions.filter((a) => a.label === 'Card number').length, 0, 'mirrored: not offered');
    await page.setContent('<iframe src="' + base + '/inner" style="width:400px;height:200px;border:0;transform:translate(30px,10px)"></iframe>');
    await page.waitForTimeout(500);
    obs = await observe(page);
    assert.equal(obs.actions.filter((a) => a.label === 'Card number' && a.kind === 'fill').length, 1, 'translated: still offered');
    await page.close();
  } finally {
    await browser?.close();
    server.close();
  }
});
