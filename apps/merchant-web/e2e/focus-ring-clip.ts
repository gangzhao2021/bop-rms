import type { Locator, Page } from "@playwright/test";

/** How far the focused element's drawn outline runs past each edge of what can show it. */
export interface RingOverhang {
  readonly name: string;
  readonly ring: boolean;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  /** The scroll container that clips it, as tag.class, or "viewport". */
  readonly clippedBy: string | null;
}

/**
 * Measures the computed outline box of the element that has focus against the clip rectangle of
 * every scroll container around it (their padding boxes) and the viewport. An outline never adds
 * to a container's scrollable area, so a ring that runs past a container's edge is cut off and
 * cannot be scrolled to.
 */
export function focusedRingOverhang(page: Page): Promise<RingOverhang> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const none = { top: 0, right: 0, bottom: 0, left: 0, clippedBy: null };
    if (element === null || element === document.body)
      return { name: "BODY", ring: false, ...none };
    const name = `${element.tagName} ${(element.textContent ?? "").trim().slice(0, 40)}`;
    const style = getComputedStyle(element);
    const width = parseFloat(style.outlineWidth) || 0;
    if (style.outlineStyle === "none" || width === 0) return { name, ring: false, ...none };
    const offset = parseFloat(style.outlineOffset) || 0;
    const box = element.getBoundingClientRect();
    const reach = width + offset;
    const ring = {
      top: box.top - reach,
      right: box.right + reach,
      bottom: box.bottom + reach,
      left: box.left - reach,
    };
    let worst = { ...none } as {
      top: number;
      right: number;
      bottom: number;
      left: number;
      clippedBy: string | null;
    };
    const measure = (
      clip: { top: number; right: number; bottom: number; left: number },
      by: string,
    ) => {
      const over = {
        top: Math.max(0, clip.top - ring.top),
        right: Math.max(0, ring.right - clip.right),
        bottom: Math.max(0, ring.bottom - clip.bottom),
        left: Math.max(0, clip.left - ring.left),
      };
      const sum = over.top + over.right + over.bottom + over.left;
      const before = worst.top + worst.right + worst.bottom + worst.left;
      if (sum > before) worst = { ...over, clippedBy: by };
    };
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      if (node === document.documentElement || node === document.body) break;
      const own = getComputedStyle(node);
      if (own.overflowX === "visible" && own.overflowY === "visible") continue;
      const outer = node.getBoundingClientRect();
      const left = outer.left + node.clientLeft;
      const top = outer.top + node.clientTop;
      measure(
        { top, left, right: left + node.clientWidth, bottom: top + node.clientHeight },
        `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`,
      );
    }
    measure(
      {
        top: 0,
        left: 0,
        right: document.documentElement.clientWidth,
        bottom: document.documentElement.clientHeight,
      },
      "viewport",
    );
    return { name, ring: true, ...worst };
  });
}

/** Tabs through every stop inside `root` (from its first) and measures each ring. */
export async function ringOverhangsWithin(page: Page, root: Locator): Promise<RingOverhang[]> {
  const results: RingOverhang[] = [];
  const seen = new Set<unknown>();
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    const inside = await root.evaluate((element) => element.contains(document.activeElement));
    if (!inside) break;
    const handle = await page.evaluateHandle(() => document.activeElement);
    const key = await handle.evaluate((element) => {
      const marked = element as HTMLElement & { __ringSeen?: number };
      marked.__ringSeen ??= Math.random();
      return marked.__ringSeen;
    });
    if (seen.has(key)) break;
    seen.add(key);
    // A stop below the fold is scrolled to by the browser; measure where it then sits.
    results.push(await focusedRingOverhang(page));
  }
  return results;
}

/** Focuses `target` as the keyboard would (so :focus-visible draws its ring) and measures it. */
export async function keyboardFocusRing(page: Page, target: Locator): Promise<RingOverhang> {
  // A key press first: the browser then draws the ring for a focus moved by the page.
  await page.keyboard.press("Shift");
  await target.focus();
  return focusedRingOverhang(page);
}

/** The ring of the element that has focus and of every later stop inside `root`. */
export async function ringsFrom(page: Page, root: Locator, first: Locator) {
  return [await keyboardFocusRing(page, first), ...(await ringOverhangsWithin(page, root))];
}

export const whole = (ring: RingOverhang) => ({ ...ring, top: 0, right: 0, bottom: 0, left: 0 });

/**
 * Batch 61: Tab from the start of the page through every stop, as the v15 live sweeps did, and
 * measure each ring where the browser has scrolled it to. Stops when focus comes round again or
 * leaves the page.
 */
export async function pageRingOverhangs(page: Page, limit = 400): Promise<RingOverhang[]> {
  // The page's first stop (the skip link), focused as the keyboard would: Tab goes on from there.
  await page.keyboard.press("Shift");
  await page.evaluate(() =>
    document
      .querySelector<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary",
      )
      ?.focus(),
  );
  const results: RingOverhang[] = [await focusedRingOverhang(page)];
  const seen = new Set<unknown>();
  for (let step = 0; step < limit; step += 1) {
    const key = await page.evaluate(() => {
      const element = document.activeElement as (HTMLElement & { __ringSeen?: number }) | null;
      if (element === null || element === document.body) return null;
      element.__ringSeen ??= Math.random();
      return element.__ringSeen;
    });
    if (key === null || seen.has(key)) break;
    seen.add(key);
    if (step > 0) results.push(await focusedRingOverhang(page));
    await page.keyboard.press("Tab");
  }
  return results;
}

/**
 * Batch 62 (v15 b61 live, Table QR codes): the same sweep the other way, Shift+Tab from the stop
 * that has focus back to the page's first, so a stop the browser scrolls in at the window's top
 * (the top bar's language switch after the page has scrolled down) is measured too.
 */
export async function pageRingOverhangsBackwards(page: Page, limit = 400): Promise<RingOverhang[]> {
  const results: RingOverhang[] = [];
  const seen = new Set<unknown>();
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const key = await page.evaluate(() => {
      const element = document.activeElement as (HTMLElement & { __ringBack?: number }) | null;
      if (element === null || element === document.body) return null;
      element.__ringBack ??= Math.random();
      return element.__ringBack;
    });
    if (key === null || seen.has(key)) break;
    seen.add(key);
    results.push(await focusedRingOverhang(page));
  }
  return results;
}

/** Batch 62: a ring that runs past what shows it, on any side. */
export const ringCut = (ring: RingOverhang) => ring.top + ring.right + ring.bottom + ring.left > 0;

/**
 * Batch 62: every stop of the page Tabbed forwards from its first and then Shift+Tabbed back,
 * with each cut ring (the name, the sides and what cut it). Also how far the page had to scroll,
 * so a sweep that never scrolled cannot pass for one that did.
 */
export async function windowEdgeSweep(page: Page) {
  const forwards = await pageRingOverhangs(page);
  const scrolled = await page.evaluate(() => window.scrollY);
  const backwards = await pageRingOverhangsBackwards(page);
  return {
    stops: forwards.length,
    back: backwards.length,
    scrolled,
    cut: [...forwards, ...backwards].filter(ringCut),
  };
}

/**
 * Batch 62: the window-edge sweep at each size (the page as it now stands, from its top), with
 * the cut rings named by size. A size whose page needs no scrolling still counts: its rings must
 * be whole too.
 */
export async function windowEdgeSweepAt(
  page: Page,
  sizes: readonly (readonly [number, number])[],
  label: string,
) {
  const cut: (RingOverhang & { readonly at: string })[] = [];
  let scrolled = 0;
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    const sweep = await windowEdgeSweep(page);
    scrolled = Math.max(scrolled, sweep.scrolled);
    cut.push(...sweep.cut.map((ring) => ({ ...ring, at: `${label} ${String(width)}` })));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  return { cut, scrolled };
}
