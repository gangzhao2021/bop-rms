import { expect, type Page } from "@playwright/test";
import { findInternalText } from "./internal-text-patterns";

/**
 * Fails when the rendered screen shows internal tokens to staff or guests: visible text, option
 * labels, the accessible names/placeholders a screen reader or sighted user meets, and text only a
 * screen reader hears (live regions, status and alert roles, visually hidden text), which
 * `innerText` can leave out or which is easy to forget because nobody sees it.
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
    // Each text node on its own, so adjacent blocks ("Maple Noodle House" + "Show this code")
    // are never read as one invented word, whether or not the region is laid out.
    for (const spoken of document.body.querySelectorAll(
      "[aria-live],[role=status],[role=alert],[role=log],.sr-only,.visually-hidden",
    )) {
      const walker = document.createTreeWalker(spoken, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        values.push(node.textContent ?? "");
    }
    return values;
  });
  expect(findInternalText(texts, allow), "staff/guest text contains internal tokens").toEqual([]);
}
