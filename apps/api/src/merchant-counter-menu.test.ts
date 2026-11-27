import { describe, expect, it } from "vitest";
import { counterOtherNameLocale } from "./merchant-counter-menu.js";

describe("WP-2423 batch 63 (F41): the counter menu's names in the other staff language", () => {
  it("asks the Chinese names under the locale the Store keeps them in, from the English UI", () => {
    // v15: dish names are kept under en-CA and zh-Hans-CA; "zh-Hans" fell back to English.
    expect(counterOtherNameLocale("en-CA")).toBe("zh-Hans-CA");
  });
  it("asks the English names under en-CA from the Chinese UI", () => {
    expect(counterOtherNameLocale("zh-Hans-CA")).toBe("en-CA");
  });
});
