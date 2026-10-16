import { createOrderNumberAllocation } from "../domain/order-number.js";
import { describe, expect, it } from "vitest";
import {
  createOriginalReceiptSnapshotFromOrder,
  type OriginalReceiptSources,
} from "../application/original-receipt-snapshot.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";

function fixture(): OriginalReceiptSources {
  const f = orderWriteFixture({ at: "2026-09-12T12:00:00.000Z" });
  const record = {
    ...f.request.record,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: f.request.record.order.orderReference,
      allocatedAt: f.request.record.createdAt,
      sequence: 1n,
      businessDateResolution: f.request.businessDateResolution,
    }),
  };
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    order: record,
    orderSnapshotVersion: 1,
    receiptReference: "0190ee00-0000-7000-8000-000000000001",
    issuedAt: "2026-09-12T12:01:00.000Z",
    issuer: {
      ...f.scope,
      operatingEntityReference: "0190ee00-0000-7000-8000-000000000002",
      displayName: "Synthetic issuer",
    },
    store: { ...f.scope, displayName: "Synthetic Store", currencyCode: "CAD" },
    template: { ...f.scope, locale: "en-CA", version: "RECEIPT_V1" },
    financial: {
      ...f.scope,
      orderReference: record.order.orderReference,
      orderBatchReferences: record.order.batches.map((batch) => batch.orderBatchReference),
      captured: money(
        record.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) + 100n,
      ),
      tip: money(100n),
      refunded: money(0n),
      refundDisposition: "NonePending",
    },
  };
}
describe("original receipt assembly from frozen owner facts", () => {
  it("prints each item at its price before tax, adding up to the subtotal (WP-2423 D5)", () => {
    const input = fixture();
    const record = input.order as {
      items: { orderItemReference: string; pricing: { subtotal: unknown; total: unknown } }[];
    };
    const result = createOriginalReceiptSnapshotFromOrder(input);
    expect(result.lines).toHaveLength(record.items.length);
    for (const line of result.lines) {
      const item = record.items.find((entry) => entry.orderItemReference === line.lineReference);
      if (!item) throw new Error("missing item");
      // The printed price is the item's pre-tax price, never its total after tax.
      expect(line.lineSubtotal).toEqual(item.pricing.subtotal);
      expect(line.lineTotal).toEqual(item.pricing.total);
    }
    const printed = result.lines.reduce(
      (sum, line) => sum + (line.lineSubtotal?.amountMinor ?? 0n),
      0n,
    );
    expect(printed).toBe(result.subtotal.amountMinor);
    if (!result.adjustments) throw new Error("missing frozen adjustments");
    // Items + fees - discounts + tax + tip reconcile to the captured total.
    expect(
      printed -
        result.adjustments.discount.amountMinor +
        result.adjustments.fee.amountMinor +
        result.tax.amountMinor +
        result.tip.amountMinor,
    ).toBe(result.total.amountMinor);
    expect(result.tax.amountMinor).toBeGreaterThan(0n);
  });
  it("keeps frozen names, taxes and line totals and adds the confirmed tip", () => {
    const input = fixture();
    const result = createOriginalReceiptSnapshotFromOrder(input);
    expect(result.paymentStatus).toBe("Paid");
    expect(result.total).toEqual(input.financial.captured);
    expect(result.tip.amountMinor).toBe(100n);
    if (!result.adjustments) throw new Error("missing frozen adjustments");
    expect(
      result.subtotal.amountMinor -
        result.adjustments.discount.amountMinor +
        result.tax.amountMinor +
        result.adjustments.fee.amountMinor +
        result.tip.amountMinor,
    ).toBe(result.total.amountMinor);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lines)).toBe(true);
    const changed = { ...input, issuer: { ...input.issuer, displayName: "Renamed issuer" } };
    expect(createOriginalReceiptSnapshotFromOrder(changed).operatingEntityDisplayName).toBe(
      "Renamed issuer",
    );
    expect(result.operatingEntityDisplayName).toBe("Synthetic issuer");
  });
  it("records the exact template version it was issued with, and reads older receipts without it (WP-2423)", () => {
    const input = fixture();
    expect(
      Object.hasOwn(createOriginalReceiptSnapshotFromOrder(input), "templateVersionReference"),
    ).toBe(false);
    const versionReference = "0190ee00-0000-7000-8000-000000000003";
    const result = createOriginalReceiptSnapshotFromOrder({
      ...input,
      template: { ...input.template, version: "RECEIPT_2", versionReference },
    });
    expect(result.templateVersion).toBe("RECEIPT_2");
    expect(result.templateVersionReference).toBe(versionReference);
    expect(() =>
      createOriginalReceiptSnapshotFromOrder({
        ...input,
        template: { ...input.template, versionReference: "not-a-reference" },
      }),
    ).toThrow();
  });
  it.each(["issuer", "store", "template", "financial"] as const)(
    "rejects foreign %s scope",
    (key) => {
      const input = fixture();
      expect(() =>
        createOriginalReceiptSnapshotFromOrder({
          ...input,
          [key]: { ...input[key], storeReference: "0190ee00-0000-7000-8000-000000000099" },
        }),
      ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
    },
  );
  it("rejects incomplete financial batch coverage and wrong captured allocation", () => {
    const input = fixture();
    for (const financial of [
      { ...input.financial, orderBatchReferences: [] },
      {
        ...input.financial,
        orderBatchReferences: [
          ...input.financial.orderBatchReferences,
          ...input.financial.orderBatchReferences,
        ],
      },
      { ...input.financial, captured: { ...input.financial.captured, amountMinor: 1n } },
    ])
      expect(() => createOriginalReceiptSnapshotFromOrder({ ...input, financial })).toThrow(
        "DIGITAL_RECEIPT_INPUT_INVALID",
      );
  });
  it("requires explicit refund disposition and derives confirmed partial/full refund status", () => {
    const input = fixture();
    const derive = (refunded: bigint, refundDisposition: "Pending" | "NonePending") =>
      createOriginalReceiptSnapshotFromOrder({
        ...input,
        financial: {
          ...input.financial,
          refunded: { amountMinor: refunded, currencyCode: "CAD" },
          refundDisposition,
        },
      }).paymentStatus;
    expect(derive(0n, "Pending")).toBe("RefundPending");
    expect(derive(1n, "NonePending")).toBe("PartiallyRefunded");
    expect(derive(input.financial.captured.amountMinor, "NonePending")).toBe("Refunded");
    expect(() => derive(input.financial.captured.amountMinor + 1n, "NonePending")).toThrow();
    expect(() =>
      createOriginalReceiptSnapshotFromOrder({
        ...input,
        financial: {
          ...input.financial,
          refundDisposition: undefined as never,
        },
      }),
    ).toThrow();
  });
  it("rejects missing localized names, pre-submission issue time and mixed currency", () => {
    const input = fixture();
    for (const changed of [
      { ...input, template: { ...input.template, locale: "zz-ZZ" } },
      { ...input, issuedAt: "2026-09-12T11:59:00.000Z" },
      {
        ...input,
        financial: { ...input.financial, tip: { ...input.financial.tip, currencyCode: "USD" } },
      },
    ])
      expect(() => createOriginalReceiptSnapshotFromOrder(changed)).toThrow(
        "DIGITAL_RECEIPT_INPUT_INVALID",
      );
  });
});
