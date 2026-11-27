import { currentLanguage } from "./i18n/i18n.js";

/** The space between a sentence and a link inside it: none in Chinese, one in English. */
export const wordGap = () => (currentLanguage() === "zh-Hans" ? "" : " ");

/**
 * Batch 56 (v15 b55 live: "…这会开一张新账单。 没有下单…"): sentences said one after another, in
 * the house style of the language: one space between them in English, none after a Chinese full
 * stop. Empty parts are left out.
 */
export function sentences(...parts: readonly (string | null | undefined | false)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(wordGap());
}
