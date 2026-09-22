import { createOriginalReceiptSnapshotFromCurrentOrder } from "../application/original-receipt-snapshot.js";
import { describe, expect, it } from "vitest";
import { parseReceiptOrderSnapshot } from "../domain/receipt-order-snapshot.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const id = (n: number) => "0190ed09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderWriteFixture({ at: "2026-09-12T12:00:00.000Z" });
  const record = f.request.record;
  const secondBatch = id(1);
  const firstItem = record.items[0];
  if (!firstItem) throw new Error("missing fixture item");
  return {
    orderReference: record.order.orderReference,
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    guestSessionReference: record.guestSessionReference,
    orderNumber: "SYNTHETIC-1",
    createdAt: record.createdAt,
    batches: [
      {
        orderBatchReference: record.order.batches[0].orderBatchReference,
        submittedAt: record.createdAt,
      },
      { orderBatchReference: secondBatch, submittedAt: "2026-09-12T12:01:00.000Z" },
    ],
    items: [
      ...record.items.map((snapshot) => ({ snapshotVersion: 1, snapshot })),
      {
        snapshotVersion: 1,
        snapshot: {
          ...firstItem,
          orderItemReference: id(2),
          orderBatchReference: secondBatch,
          cartItemReference: id(3),
          pricing: { ...firstItem.pricing, lineReference: id(3) },
        },
      },
    ],
  };
}
describe("complete receipt Order snapshot", () => {
  it("preserves initial and later batch frozen items without rewriting initial Order state", () => {
    const input = fixture();
    const result = parseReceiptOrderSnapshot(input);
    expect(result.batches).toHaveLength(2);
    expect(result.items).toHaveLength(input.items.length);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.at(-1)?.snapshot.orderBatchReference).toBe(id(1));
  });
  it("issues one snapshot covering both batch totals and rejects initial-batch-only payment coverage", () => {
    const order = fixture();
    const scope = { brandReference: order.brandReference, storeReference: order.storeReference };
    const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
    const total = order.items.reduce(
      (sum, item) => sum + item.snapshot.pricing.total.amountMinor,
      0n,
    );
    const input = {
      order,
      receiptReference: id(5),
      issuedAt: "2026-09-12T12:02:00.000Z",
      issuer: { ...scope, operatingEntityReference: id(6), displayName: "Synthetic issuer" },
      store: { ...scope, displayName: "Synthetic Store", currencyCode: "CAD" },
      template: { ...scope, locale: "en-CA", version: "RECEIPT_V1" },
      financial: {
        ...scope,
        orderReference: order.orderReference,
        orderBatchReferences: order.batches.map((batch) => batch.orderBatchReference),
        captured: money(total + 100n),
        tip: money(100n),
        refunded: money(0n),
        refundDisposition: "NonePending" as const,
      },
    };
    const receipt = createOriginalReceiptSnapshotFromCurrentOrder(input);
    expect(receipt.lines).toHaveLength(order.items.length);
    expect(receipt.total.amountMinor).toBe(total + 100n);
    expect(receipt.paymentStatus).toBe("Paid");
    expect(() =>
      createOriginalReceiptSnapshotFromCurrentOrder({
        ...input,
        financial: {
          ...input.financial,
          orderBatchReferences: input.financial.orderBatchReferences.slice(0, 1),
        },
      }),
    ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
    expect(() =>
      createOriginalReceiptSnapshotFromCurrentOrder({
        ...input,
        financial: { ...input.financial, captured: money(total) },
      }),
    ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
  });
  it("rejects omitted batches, empty batches, duplicate items and foreign Store facts", () => {
    const input = fixture();
    const invalid = [
      { ...input, batches: input.batches.slice(0, 1) },
      { ...input, items: input.items.slice(0, -1) },
      { ...input, items: [...input.items, input.items[0]] },
      { ...input, storeReference: id(8) },
      {
        ...input,
        batches: input.batches.map((batch) => ({
          ...batch,
          submittedAt: "2026-09-12T11:59:00.000Z",
        })),
      },
    ];
    for (const value of invalid)
      expect(() => parseReceiptOrderSnapshot(value)).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
  });
});
