import { describe, expect, it } from "vitest";
import { orderListOptionText } from "../infrastructure/persistence/merchant-order-list-summary.js";

describe("Orders v2 list summary: a line's chosen options", () => {
  it("names every chosen option of a combo, not only the first (v15 2026-10-29)", () => {
    expect(
      orderListOptionText(
        ["Siu mai (pork and shrimp), 4 pcs (TEST)", "Dan dan noodles (TEST)"],
        ["en-CA"],
      ),
    ).toBe("Siu mai (pork and shrimp), 4 pcs (TEST), Dan dan noodles (TEST)");
    expect(orderListOptionText(["烧卖（4 只）", "担担面"], ["zh-Hans-CA", "en-CA"])).toBe(
      "烧卖（4 只）、担担面",
    );
  });
  it("is null without a named option and stays within what the staff app reads", () => {
    expect(orderListOptionText([], "en-CA")).toBeNull();
    expect(orderListOptionText([""], "en-CA")).toBeNull();
    expect(orderListOptionText(["Small"], "en-CA")).toBe("Small");
    expect(orderListOptionText(Array(30).fill("Extra shot (TEST)"), "en-CA")?.length).toBe(200);
  });
});
