import { expect, it } from "vitest";
import { createPriceQuote, allocateOrdinaryRefundFromQuote } from "../index.js";
import { input } from "./price-quote.fixture.js";
const id = (n: number) => "01909977-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const quote = createPriceQuote(input());
  const items = quote.lines.map((line, index) => ({
    orderItemReference: id(index + 1),
    quoteLineReference: String(line.lineReference),
    quantity: line.quantity,
    occupiedUnitOrdinals: [] as number[],
    refundQuantity: line.quantity,
  }));
  return { quote, items, tipAmountMinor: 101n };
}
it("derives full refund from original quote plus captured tip", () => {
  const f = fixture();
  const result = allocateOrdinaryRefundFromQuote(f.quote, f);
  expect(result.amountMinor).toBe(f.quote.total.amountMinor + 101n);
  expect(result.sourceReference).toBe(f.quote.quoteReference);
  expect(result.sourceDigest).toBe(f.quote.inputDigest);
});
it("preserves cents when partial units are followed by the remaining original units", () => {
  const f = fixture();
  const first = allocateOrdinaryRefundFromQuote(f.quote, {
    ...f,
    items: f.items.map((item) => ({ ...item, refundQuantity: 1 })),
  });
  const remaining = f.items.map((item) => ({
    ...item,
    occupiedUnitOrdinals: [1],
    refundQuantity: item.quantity - 1,
  }));
  expect(remaining.some((item) => item.refundQuantity > 0)).toBe(true);
  const rest = allocateOrdinaryRefundFromQuote(f.quote, { ...f, items: remaining });
  expect(first.amountMinor + rest.amountMinor).toBe(f.quote.total.amountMinor + 101n);
});
it("requires complete unique matching Order-to-quote lines and original quantity", () => {
  const f = fixture();
  for (const items of [
    [],
    [...f.items, ...f.items],
    f.items.map((item) => ({ ...item, quoteLineReference: id(99) })),
    f.items.map((item) => ({ ...item, quantity: item.quantity + 1 })),
  ]) {
    expect(() => allocateOrdinaryRefundFromQuote(f.quote, { ...f, items })).toThrow();
  }
});
it("rejects altered frozen quote totals", () => {
  const f = fixture();
  expect(() =>
    allocateOrdinaryRefundFromQuote(
      { ...f.quote, total: { ...f.quote.total, amountMinor: f.quote.total.amountMinor + 1n } },
      f,
    ),
  ).toThrow();
});
