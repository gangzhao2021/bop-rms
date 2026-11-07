import { expect, type Page } from "@playwright/test";
import { findInternalText } from "./internal-text-patterns";

/**
 * Fails when the rendered screen shows internal tokens to staff or guests: visible text, option
 * labels and the accessible names/placeholders a screen reader or sighted user meets.
 *
 * Visible text is read element by element, never as one `innerText` of the page: `innerText`
 * runs adjacent buttons and flex items together, so the Table QR codes row actions "Print",
 * "Replace" and "Turn off" were read as the invented word "PrintReplaceTurn" (WP-2423,
 * 2026-10-18). Each element contributes the text directly inside it; text split by a child element
 * is read in separate pieces, while text React writes as adjacent nodes stays one piece.
 */
export async function expectNoInternalText(
  page: Page,
  allow: readonly (RegExp | string)[] = [],
): Promise<void> {
  const texts = await page.evaluate(() => {
    const values: string[] = [];
    const elements = [document.body, ...document.body.querySelectorAll("*")];
    for (const element of elements) {
      if (element.closest("script,style,noscript,template")) continue;
      // What `innerText` left out stays out: content that is not rendered or is hidden.
      if (
        typeof element.checkVisibility === "function" &&
        !element.checkVisibility({ visibilityProperty: true })
      )
        continue;
      let piece = "";
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) piece += child.textContent ?? "";
        else {
          if (piece.trim()) values.push(piece);
          piece = "";
        }
      }
      if (piece.trim()) values.push(piece);
    }
    for (const element of document.body.querySelectorAll("[placeholder],[aria-label],[alt]"))
      for (const name of ["placeholder", "aria-label", "alt"]) {
        const value = element.getAttribute(name);
        if (value) values.push(value);
      }
    for (const option of document.body.querySelectorAll("option"))
      values.push(option.textContent ?? "");
    return values;
  });
  expect(findInternalText(texts, allow), "staff/guest text contains internal tokens").toEqual([]);
}
