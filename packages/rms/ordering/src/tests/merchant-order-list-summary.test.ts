import { describe, expect, it } from "vitest";
import {
  mergeOrderListLines,
  orderListOptionText,
} from "../infrastructure/persistence/merchant-order-list-summary.js";

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

describe("Batch 63 (F28): the list summary names a dish once", () => {
  it("adds the same dish with the same options across rounds, keeps different options apart", () => {
    const line = (name: string, option: string | null, quantity: number) => ({
      name,
      option,
      quantity,
    });
    expect(
      mergeOrderListLines([
        line("Beef noodles (TEST)", null, 1),
        line("Soy milk", "Hot", 1),
        line("Beef noodles (TEST)", null, 1),
        line("Soy milk", "Cold", 2),
        line("Soy milk", "Hot", 1),
        line("Wonton soup", null, 1),
      ]),
    ).toEqual({
      items: [
        line("Beef noodles (TEST)", null, 2),
        line("Soy milk", "Hot", 2),
        line("Soy milk", "Cold", 2),
      ],
      lineCount: 4,
    });
    expect(mergeOrderListLines([line("牛肉面", null, 1), line("牛肉面", null, 2)])).toEqual({
      items: [line("牛肉面", null, 3)],
      lineCount: 1,
    });
  });
});
