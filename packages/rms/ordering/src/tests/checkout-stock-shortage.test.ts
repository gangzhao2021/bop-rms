import { describe, expect, it } from "vitest";
import { findCheckoutStockShortage } from "../application/checkout-stock-shortage.js";
import type { CheckoutStockLine } from "../application/ports/checkout-validation-ports.js";

const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as never;
const line = (
  reference: number,
  sellable: number,
  quantity: number,
  options: { optionReference: string; quantity: number }[] = [],
): CheckoutStockLine => ({
  cartItemReference: id(reference),
  sellableReference: id(sellable),
  quantity,
  optionSelections: options as never,
});
/** Synthetic stock in units of one ingredient; `use` is how much one of each item takes. */
const stock = (units: number, use: Record<number, number>) => {
  const asked: number[] = [];
  return {
    asked,
    covers: async (lines: readonly CheckoutStockLine[]) => {
      asked.push(lines.length);
      return (
        lines.reduce(
          (sum, entry) =>
            sum +
            entry.quantity *
              (use[Number.parseInt(String(entry.sellableReference).slice(-4), 16)] ?? 0),
          0,
        ) <= units
      );
    },
  };
};

describe("WP-2423 findCheckoutStockShortage", () => {
  it("is null when the stock covers the Cart (one question)", async () => {
    const answer = stock(4, { 1: 1, 2: 1 });
    expect(await findCheckoutStockShortage([line(10, 1, 2), line(11, 2, 2)], answer.covers)).toBe(
      null,
    );
    expect(answer.asked).toEqual([2]);
  });

  it("counts one item on several lines together and names its first line", async () => {
    const answer = stock(3, { 1: 1 });
    expect(
      await findCheckoutStockShortage([line(10, 1, 2), line(11, 1, 3)], answer.covers),
    ).toEqual({ cartItemReference: id(10), available: 3, sharedStock: false });
  });

  it("keeps different options apart (a large and a small are different items)", async () => {
    const large = [{ optionReference: id(90), quantity: 1 }];
    const answer = {
      covers: async (lines: readonly CheckoutStockLine[]) =>
        lines.reduce(
          (sum, entry) => sum + entry.quantity * (entry.optionSelections.length ? 2 : 1),
          0,
        ) <= 3,
    };
    expect(
      await findCheckoutStockShortage([line(10, 1, 1), line(11, 1, 2, large)], answer.covers),
    ).toEqual({ cartItemReference: id(11), available: 1, sharedStock: false });
  });

  it("reports the most recently added item of two sharing an ingredient, lowered beside the rest", async () => {
    const answer = stock(3, { 1: 1, 2: 1 });
    expect(
      await findCheckoutStockShortage([line(10, 1, 2), line(11, 2, 2)], answer.covers),
    ).toEqual({ cartItemReference: id(11), available: 1, sharedStock: true });
  });

  it("reports an item short on its own before a shared shortage, with what the rest leaves", async () => {
    // Milk 5: latte 1 each, mocha 2 each. Mocha 3 alone needs 6 (short on its own).
    const answer = stock(5, { 1: 1, 2: 2 });
    expect(
      await findCheckoutStockShortage([line(10, 2, 3), line(11, 1, 1)], answer.covers),
    ).toEqual({ cartItemReference: id(10), available: 2, sharedStock: false });
  });

  it("says nothing is left of a sold-out item", async () => {
    const answer = stock(0, { 1: 1 });
    expect(await findCheckoutStockShortage([line(10, 1, 1)], answer.covers)).toEqual({
      cartItemReference: id(10),
      available: 0,
      sharedStock: false,
    });
  });

  it("names the last item with nothing beside the rest when no single item explains it", async () => {
    // Three items each needing 2 of 3 units: any one alone fits, no two fit together.
    const answer = stock(3, { 1: 2, 2: 2, 3: 2 });
    expect(
      await findCheckoutStockShortage(
        [line(10, 1, 1), line(11, 2, 1), line(12, 3, 1)],
        answer.covers,
      ),
    ).toEqual({ cartItemReference: id(12), available: 0, sharedStock: true });
  });

  it("looks at a preferred line first (how many it alone can have when the rest is short too)", async () => {
    const answer = stock(1, { 1: 1, 2: 1 });
    expect(
      await findCheckoutStockShortage([line(10, 1, 2), line(11, 2, 2)], answer.covers, id(10)),
    ).toEqual({ cartItemReference: id(10), available: 1, sharedStock: false });
  });
});
