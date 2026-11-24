import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { sentences } from "./word-gap.js";

afterEach(() => setLanguageForTest("en"));

it("joins sentences with a space in English and none after a Chinese full stop", () => {
  setLanguageForTest("en");
  expect(sentences("It is paid.", null, "", "Nothing was sent.")).toBe(
    "It is paid. Nothing was sent.",
  );
  setLanguageForTest("zh-Hans");
  expect(sentences("已付清。", undefined, false, "没有下单。")).toBe("已付清。没有下单。");
});
