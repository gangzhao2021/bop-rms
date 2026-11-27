import type { Page } from "@playwright/test";

/**
 * Batch 63 (F07): every visible text on the page whose computed size is not one of the v3 four
 * (28 / 20 / 16 / 14) or whose weight is not 600 or 400. The pickup and join codes are left out on
 * purpose: they are codes shown large to staff, not text.
 */
export function offScaleText(page: Page) {
  return page.evaluate(() => {
    const sizes = new Set([14, 16, 20, 28]);
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(".customer-page *")) {
      if (
        element.closest(
          ".pickup-code__visual, .dining-invitation__digits, .sr-only, .bop-skip-link, script, style, svg, noscript",
        )
      )
        continue;
      const own = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if (!own) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      const size = Math.round(Number.parseFloat(style.fontSize) * 100) / 100;
      const weight = Number(style.fontWeight);
      if (!sizes.has(size) || (weight !== 400 && weight !== 600))
        found.push(
          `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0] || "-"} "${(element.textContent ?? "").trim().slice(0, 32)}" ${String(size)}/${String(weight)}`,
        );
    }
    return [...new Set(found)];
  });
}

/**
 * Batch 63 (F08): controls a finger taps that are smaller than 44 × 44 px. Each control's own box
 * is measured; an input inside a label counts by its label (the label is what is tapped).
 */
export function smallTargets(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const target = element.closest("label") ?? element;
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      const style = getComputedStyle(target);
      if (style.visibility === "hidden") return [];
      return box.width < 43.5 || box.height < 43.5
        ? [
            `${target.tagName.toLowerCase()} "${(target.textContent ?? target.getAttribute("aria-label") ?? "").trim().slice(0, 24)}" ${String(Math.round(box.width))}×${String(Math.round(box.height))}`,
          ]
        : [];
    }),
  );
}
