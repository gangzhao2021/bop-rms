import { currentLanguage } from "./i18n/i18n.js";

/** The space between a sentence and a link inside it: none in Chinese, one in English. */
export const wordGap = () => (currentLanguage() === "zh-Hans" ? "" : " ");
