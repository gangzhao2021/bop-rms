import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { orderSoldOutNowText, soldOutNowText } from "./CurrentOrderQueuePage.js";

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

describe("WP-2423 (b9): the Orders row says what its lines say", () => {
  it("never calls an order with a hidden dish sold out", () => {
    expect(orderSoldOutNowText("Hidden")).toBe("Has a dish off the menu now");
    expect(orderSoldOutNowText("SoldOut")).toBe("Has a dish sold out now");
    expect(orderSoldOutNowText("ChoiceSoldOut")).toBe("Has a choice sold out now");
    expect(orderSoldOutNowText("Several")).toBe("Has dishes sold out or off the menu now");
    setLanguageForTest("zh-Hans");
    try {
      expect(orderSoldOutNowText("Hidden")).toBe("含现在已下架的菜");
    } finally {
      setLanguageForTest("en");
    }
  });
});
