import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { openingCountHeading } from "./OpeningCountPages.js";

describe("WP-2423 (b9): the opening count heading in the staff's language", () => {
  it("says a posted count is posted in Chinese, with no English state word or version number", () => {
    setLanguageForTest("zh-Hans");
    try {
      expect(openingCountHeading("Posted")).toBe("期初盘点 · 已过账");
      expect(openingCountHeading("Draft")).toBe("期初盘点 · 盘点中");
      expect(openingCountHeading("Submitted")).toBe("期初盘点 · 等待过账");
      expect(openingCountHeading("Cancelled")).toBe("期初盘点 · 已取消");
    } finally {
      setLanguageForTest("en");
    }
    expect(openingCountHeading("Posted")).toBe("Opening count · posted");
  });
});
