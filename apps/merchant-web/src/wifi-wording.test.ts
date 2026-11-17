import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { zhHans } from "./i18n/zh-Hans.js";

/**
 * b25 (live24): the offline page said "Check the wifi" while the app said "Check the Wi-Fi". Staff
 * read one spelling everywhere: "Wi-Fi" in English, and in Chinese too (as the app's own words).
 */
const offlinePage = readFileSync(
  new URL("../public/operations/offline.js", import.meta.url),
  "utf8",
);

it("every staff text spells it Wi-Fi, in English and Chinese, also on the offline page", () => {
  const english = Object.keys(zhHans);
  const chinese = Object.values(zhHans);
  expect(english.filter((text) => /wi-?fi/iu.test(text) && !/Wi-Fi/u.test(text))).toEqual([]);
  expect(chinese.filter((text) => /无线网络|wi-?fi/iu.test(text) && !/Wi-Fi/u.test(text))).toEqual(
    [],
  );
  expect(offlinePage).not.toMatch(/wifi|无线网络/iu);
  expect(offlinePage).toContain('offlineBack: "Check the Wi-Fi.');
  expect(offlinePage).toContain('offlineBack: "请检查 Wi-Fi。');
});
