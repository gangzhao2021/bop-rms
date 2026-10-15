import { expect, type Page } from "@playwright/test";
import { findInternalText } from "./internal-text-patterns";

/**
 * Fails when the rendered screen shows internal tokens to staff or guests: visible text, option
 * labels and the accessible names/placeholders a screen reader or sighted user meets.
 */
export async function expectNoInternalText(
  page: Page,
  allow: readonly (RegExp | string)[] = [],
): Promise<void> {
  const texts = await page.evaluate(() => {
    const values = [document.body.innerText];
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
