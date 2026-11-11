import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { soldOutNowText } from "./CurrentOrderQueuePage.js";

describe("WP-2423 (M23): a line sold out since it was ordered, in staff words", () => {
  it("says why the line can't be made as ordered now, in English and Chinese", () => {
    expect(soldOutNowText("SoldOut")).toBe("Sold out now");
    expect(soldOutNowText("Hidden")).toBe("Off the menu now");
    expect(soldOutNowText("ChoiceSoldOut")).toBe("A choice is sold out now");
    setLanguageForTest("zh-Hans");
    try {
      expect(soldOutNowText("SoldOut")).toBe("现在已售罄");
      expect(soldOutNowText("Hidden")).toBe("现在已下架");
    } finally {
      setLanguageForTest("en");
    }
  });
});
