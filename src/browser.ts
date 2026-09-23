// Playwright is the harness only: one page.evaluate() snapshot per step, and
// input by coordinates (no locator auto-wait).
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { Action, Observation } from './jev.ts';

const SNAPSHOT = readFileSync(new URL('./snapshot.js', import.meta.url), 'utf8');

export async function observe(page: Page): Promise<Observation> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const obs = (await page.evaluate(SNAPSHOT)) as Observation | null;
      if (obs) {
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
async function point(page: Page, node: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((id) => {
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
  return p;
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
// must skip the Enter entirely.
export async function focusAndVerify(page: Page, node: number, expectedValue: string): Promise<boolean> {
  try {
    const { x, y } = await point(page, node);
    await page.mouse.click(x, y);
    return await page.evaluate(
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

async function expanded(page: Page, node: number): Promise<string | null> {
  return page.evaluate((id) => {
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
      const { x, y } = await point(page, action.node!);
      // Hover-opened menus (e.g. a top nav) toggle closed on the first click after the
      // hover: move first, and if hovering alone expanded the target, leave it open.
      const expandedBefore = await expanded(page, action.node!);
      await page.mouse.move(x, y);
      if (expandedBefore === 'false') {
        await page.waitForTimeout(150);
        if ((await expanded(page, action.node!)) === 'true') break;
      }
      await page.mouse.click(x, y);
      break;
    }
    case 'fill': {
      const { x, y } = await point(page, action.node!);
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
      await page.evaluate(
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
