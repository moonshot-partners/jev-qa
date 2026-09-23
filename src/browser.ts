// Playwright is the harness only: one page.evaluate() snapshot per step, and
// input by coordinates (no locator auto-wait).
//
// Frames: the snapshot script runs in the main document AND in every child frame
// (frame.evaluate works for a cross-origin <iframe> too — the engine never needs DOM
// access across the boundary). Each frame-hosted action carries `frame` (an index into
// the frame table built by the last observe() for that page) and geometry translated to
// page coordinates, so input stays "click at x,y, then type" exactly as for the main
// document. Hit-testing is two-sided: the point must land on the frame's own <iframe>
// element in the main document (nothing laid over it) AND on the target inside the frame.
import { readFileSync } from 'node:fs';
import type { Frame, Page } from 'playwright';
import type { Action, Observation } from './jev.ts';

const SNAPSHOT = readFileSync(new URL('./snapshot.js', import.meta.url), 'utf8');

type Box = { x: number; y: number; w: number; h: number };

// Per page: every frame any observe() has seen, in first-seen order (0 = main). Indices are
// STABLE for the page's lifetime — a frame keeps its index across observations and a new frame
// is appended, never inserted — so an action or `lastFill` decided against one observation
// still names the same frame after the page re-rendered and the next observation ran.
const frameTables = new WeakMap<Page, Frame[]>();

function frameOf(page: Page, index: number | undefined): Frame {
  if (!index) return page.mainFrame();
  const frame = frameTables.get(page)?.[index];
  if (!frame || frame.isDetached()) throw new Error('target frame detached');
  return frame;
}

// The frame's CONTENT box (where its viewport starts) in MAIN-FRAME coordinates: Playwright's
// boundingBox() is the <iframe> element's border box relative to the main frame (nested frames
// included), so the element's own border and padding are added — a framed control's
// frame-local coordinates count from inside them. Null when the frame element cannot be
// resolved or has no box (detached, display:none). With `scroll`, first brings the <iframe>
// into the main viewport — scrollIntoView inside a frame never scrolls its parent.
async function frameBox(frame: Frame, scroll = false): Promise<Box | null> {
  if (frame === frame.page().mainFrame()) return { x: 0, y: 0, w: Infinity, h: Infinity };
  const el = await frame.frameElement().catch(() => null);
  if (!el) return null;
  try {
    if (scroll) await el.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    const box = await el.boundingBox();
    if (!box) return null;
    const inset = await el
      .evaluate((e) => {
        const cs = getComputedStyle(e as Element);
        const px = (v: string) => parseFloat(v) || 0;
        return { l: px(cs.borderLeftWidth) + px(cs.paddingLeft), t: px(cs.borderTopWidth) + px(cs.paddingTop), r: px(cs.borderRightWidth) + px(cs.paddingRight), b: px(cs.borderBottomWidth) + px(cs.paddingBottom) };
      })
      .catch(() => ({ l: 0, t: 0, r: 0, b: 0 }));
    return { x: box.x + inset.l, y: box.y + inset.t, w: Math.max(0, box.width - inset.l - inset.r), h: Math.max(0, box.height - inset.t - inset.b) };
  } finally {
    await el.dispose().catch(() => {});
  }
}

// Merges every child frame's snapshot into the main observation: actions get `frame` + page
// coordinates (dropped when their centre falls outside the iframe's box or the viewport — the
// browser would not deliver a click there), frame text is appended to the page text.
async function mergeFrames(page: Page, obs: Observation, frames: Frame[]): Promise<void> {
  const main = page.mainFrame();
  const controls = obs.actions.filter((a) => a.node === undefined);
  const elements = obs.actions.filter((a) => a.node !== undefined);
  const texts: string[] = [];
  const vw = obs.w ?? Infinity;
  const vh = obs.h ?? Infinity;
  for (const frame of page.frames()) {
    if (frame === main || frame.isDetached()) continue;
    const box = await frameBox(frame);
    if (!box || box.w <= 0 || box.h <= 0) continue;
    let sub: Observation | null;
    try {
      sub = (await frame.evaluate(SNAPSHOT)) as Observation | null;
    } catch {
      continue; // about:blank, mid-navigation, or a frame that refuses evaluation: not actionable
    }
    if (!sub) continue;
    let index = frames.indexOf(frame);
    if (index < 0) index = frames.push(frame) - 1;
    for (const a of sub.actions) {
      if (a.node === undefined || !a.rect) continue;
      const rect = { x: a.rect.x + box.x, y: a.rect.y + box.y, w: a.rect.w, h: a.rect.h };
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      if (cx < box.x || cy < box.y || cx > box.x + box.w || cy > box.y + box.h) continue;
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      elements.push({ ...a, frame: index, rect });
    }
    if (sub.text) texts.push(sub.text);
  }
  elements.forEach((a, i) => (a.id = 'e' + (i + 1)));
  obs.actions = [...elements, ...controls];
  if (texts.length) obs.text = [obs.text, ...texts].filter(Boolean).join('\n').slice(0, 6000);
}

export async function observe(page: Page): Promise<Observation> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const obs = (await page.evaluate(SNAPSHOT)) as Observation | null;
      if (obs) {
        const frames: Frame[] = frameTables.get(page) ?? [page.mainFrame()];
        await mergeFrames(page, obs, frames);
        frameTables.set(page, frames);
        obs.actions.push({ id: 'press_enter', kind: 'key', label: 'Press Enter in the focused field (submit a typed search or form)' });
        return obs;
      }
    } catch {
      // Navigation destroyed the context mid-snapshot; retry on the new document.
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  throw new Error('Could not snapshot the page');
}

// Re-read geometry right before input and refuse if another element covers the target.
// For a frame-hosted target the check is two-sided: inside the frame (frame-local
// coordinates) the point must hit the target; in the main document (page coordinates) it must
// hit an <iframe> — a modal, a sticky bar or a popover laid over the frame would otherwise
// swallow the click. Intermediate frames of a deeper nesting are not checked separately.
async function point(page: Page, node: number, frameIndex?: number): Promise<{ x: number; y: number }> {
  const frame = frameOf(page, frameIndex);
  const p = await frame.evaluate((id) => {
    const e = (window as any).__jevFast?.nodes.get(id) as Element | undefined;
    if (!e?.isConnected) return { error: 'target detached' };
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(e === hit || e.contains(hit) || hit.contains(e))) return { error: 'target occluded' };
    return { x, y };
  }, node);
  if ('error' in p) throw new Error(p.error as string);
  if (!frameIndex) return p;
  const box = await frameBox(frame, true);
  if (!box) throw new Error('target frame not visible');
  const x = p.x + box.x;
  const y = p.y + box.y;
  if (p.x < 0 || p.y < 0 || p.x > box.w || p.y > box.h) throw new Error('target outside its frame');
  const parentHit = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName ?? null, [x, y]);
  if (parentHit !== 'IFRAME' && parentHit !== 'FRAME') throw new Error('target occluded (frame covered)');
  return { x, y };
}

// Round 8 (N6); extended round 9 (O7): re-resolves the intended field and confirms the page's OWN
// focus actually landed there — AND that the field's own displayed value still reads back as the
// text the runner believes it just typed — before the runner presses Enter into it. A
// focus-stealing element (an autocomplete dropdown, a toast, another control) appearing between
// the fill and the Enter press would otherwise submit whatever silently has focus instead; a
// focus/blur handler that clears or rewrites the field would otherwise submit an Enter into an
// empty or stale value while the runner's own record of "what was typed" goes stale right along
// with it. Reuses point()'s own re-resolve/occlusion check; the click and the verification
// evaluate() are wrapped in the SAME try/catch (round 9, O7 #10) — a detached node or a
// mid-navigation context-destroy on EITHER call must fail closed, not throw past the caller.
// False on ANY failure (detached, occluded, focus didn't land, value doesn't match) — the caller
// must skip the Enter entirely. The focus check runs in the target's own frame: a frame has its
// own document.activeElement.
export async function focusAndVerify(page: Page, node: number, expectedValue: string, frameIndex?: number): Promise<boolean> {
  try {
    const { x, y } = await point(page, node, frameIndex);
    await page.mouse.click(x, y);
    return await frameOf(page, frameIndex).evaluate(
      ({ id, expected }) => {
        const e = (window as any).__jevFast?.nodes.get(id) as Element | undefined;
        if (!e || document.activeElement !== e) return false;
        const current = 'value' in e ? String((e as any).value) : (e as any).isContentEditable ? (e as HTMLElement).innerText.trim() : e.textContent?.trim();
        return current === expected;
      },
      { id: node, expected: expectedValue },
    );
  } catch {
    return false;
  }
}

async function expanded(page: Page, node: number, frameIndex?: number): Promise<string | null> {
  return frameOf(page, frameIndex).evaluate((id) => {
    const e = (window as any).__jevFast?.nodes.get(id) as Element | undefined;
    return e?.getAttribute('aria-expanded') ?? null;
  }, node);
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(250);
}

export async function act(page: Page, action: Action, text: string | null) {
  switch (action.kind) {
    case 'click': {
      const { x, y } = await point(page, action.node!, action.frame);
      // Hover-opened menus (e.g. a top nav) toggle closed on the first click after the
      // hover: move first, and if hovering alone expanded the target, leave it open.
      const expandedBefore = await expanded(page, action.node!, action.frame);
      await page.mouse.move(x, y);
      if (expandedBefore === 'false') {
        await page.waitForTimeout(150);
        if ((await expanded(page, action.node!, action.frame)) === 'true') break;
      }
      await page.mouse.click(x, y);
      break;
    }
    case 'fill': {
      const { x, y } = await point(page, action.node!, action.frame);
      await page.mouse.click(x, y);
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText(text ?? '');
      // Live (debounced) search boxes fire their request a few hundred ms after typing; let the
      // response land so the next observation and the oracles see the result of THIS input.
      await page.waitForTimeout(600);
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
      break;
    }
    case 'select':
      await frameOf(page, action.frame).evaluate(
        ({ id, value }) => {
          const e = (window as any).__jevFast.nodes.get(id) as HTMLSelectElement;
          e.value = value;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { id: action.node!, value: action.value! },
      );
      break;
    case 'scroll':
      await page.mouse.wheel(0, action.delta ?? 560);
      break;
    case 'key':
      await page.keyboard.press('Enter');
      break;
    case 'wait':
      await page.waitForTimeout(1000);
      break;
  }
  await settle(page);
}
