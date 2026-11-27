import type { Locator } from "@playwright/test";

/** v3's one accent (brief §2): `--bop-color-accent` #1F63E0. */
export const accent = "rgb(31, 99, 224)";

/**
 * b23 review (brief §2: one filled primary, for the step being taken): the names of the buttons
 * and links in `scope` drawn as a filled primary (accent background), as staff see them now.
 */
export async function filledPrimaries(scope: Locator): Promise<string[]> {
  return scope
    .locator("button, a")
    .evaluateAll(
      (elements, fill) =>
        elements
          .filter(
            (element) =>
              element instanceof HTMLElement &&
              element.checkVisibility() &&
              getComputedStyle(element).backgroundColor === fill,
          )
          .map((element) => (element.textContent ?? "").trim()),
      accent,
    );
}

/** How a choice (a radio's label) is drawn: v3 has no black pill, the chosen one is accent words. */
export async function choiceLook(label: Locator) {
  return label.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      weight: style.fontWeight,
      line: style.borderBottomColor,
    };
  });
}
