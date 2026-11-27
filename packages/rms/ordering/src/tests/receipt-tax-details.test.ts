import { describe, expect, it } from "vitest";
import { createOrderNumberAllocation } from "../domain/order-number.js";
import {
  createOriginalReceiptSnapshotFromOrder,
  receiptRatePercent,
  receiptTaxLines,
  type OriginalReceiptSources,
} from "../application/original-receipt-snapshot.js";
import { createRefundReceiptSnapshot } from "../application/refund-receipt-snapshot.js";
import { parseDigitalReceiptSnapshot } from "../domain/digital-receipt.js";
import type { OrderTaxComponentSnapshot } from "../domain/order-item-snapshot.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";

// TEST-ONLY registration numbers: shaped like CRA / Revenu Québec numbers, not real registrations.
const registrations = [
  { label: "GST/HST" as const, number: "000000000RT0001" },
  { label: "QST" as const, number: "0000000000TQ0001" },
];
const address = {
  addressLines: ["1 Test-only Street"],
  locality: "Toronto",
  regionCode: "ON",
  postalCode: "M5V 0A0",
  countryCode: "CA",
};

function fixture(withDetails = true): OriginalReceiptSources {
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
      captured: money(record.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n)),
      tip: money(0n),
      refunded: money(0n),
      refundDisposition: "NonePending",
    },
    ...(withDetails
      ? { receiptDetails: { businessAddress: address, taxRegistrations: registrations } }
      : {}),
  };
}

function component(
  code: string,
  rate: string,
  amountMinor: bigint,
  calculationOrder: number,
  overrides: Partial<OrderTaxComponentSnapshot> = {},
): OrderTaxComponentSnapshot {
  return {
    ruleVersionReference: "0190ee00-0000-7000-8000-0000000000a1",
    ruleVersionDigest: "sha256:" + "a".repeat(64),
    jurisdictionCode: "CA_ON",
    taxComponentCode: code,
    taxClassificationReference: "0190ee00-0000-7000-8000-0000000000a2",
    treatment: "Taxable",
    rate,
    priceInclusion: "Exclusive",
    roundingMode: "HalfUp",
    calculationOrder,
    compoundOnPriorTax: false,
    taxAmount: { amountMinor, currencyCode: "CAD" },
    ...overrides,
  } as OrderTaxComponentSnapshot;
}

describe("receipt tax details (WP-2423 Q15)", () => {
  it("prints each rate as a percent from the frozen decimal without arithmetic", () => {
    expect(receiptRatePercent("0.13")).toBe("13");
    expect(receiptRatePercent("0.05")).toBe("5");
    expect(receiptRatePercent("0.09975")).toBe("9.975");
    expect(receiptRatePercent("0.07")).toBe("7");
    expect(receiptRatePercent("0")).toBe("0");
    expect(receiptRatePercent("1")).toBe("100");
  });

  it("sums one line per tax type and rate, in calculation order, skipping exempt parts", () => {
    const lines = receiptTaxLines(
      [
        component("PST", "0.07", 70n, 2),
        component("GST", "0.05", 50n, 1),
        component("GST", "0.05", 25n, 1),
        component("PST", "0", 0n, 2, { treatment: "Exempt" }),
        component("HST", "0.13", 13n, 1, { priceInclusion: "Inclusive" }),
      ],
      "CAD",
    );
    expect(lines).toEqual([
      {
        label: "GST",
        ratePercent: "5",
        included: false,
        amount: { amountMinor: 75n, currencyCode: "CAD" },
      },
      {
        label: "HST",
        ratePercent: "13",
        included: true,
        amount: { amountMinor: 13n, currencyCode: "CAD" },
      },
      {
        label: "PST",
        ratePercent: "7",
        included: false,
        amount: { amountMinor: 70n, currencyCode: "CAD" },
      },
    ]);
    expect(() => receiptTaxLines([component("GST", "0.05", 5n, 1)], "USD")).toThrow(
      "DIGITAL_RECEIPT_INPUT_INVALID",
    );
  });

  it("freezes address, registrations and per-tax lines from the order's own tax snapshot", () => {
    const input = fixture();
    const snapshot = createOriginalReceiptSnapshotFromOrder(input);
    const details = snapshot.taxDetails;
    if (!details) throw new Error("tax details missing");
    expect(details.businessAddress).toEqual(address);
    expect(details.taxRegistrations).toEqual(registrations);
    expect(details.paymentMethod).toBe("Card");
    expect(details.taxLines.reduce((sum, line) => sum + line.amount.amountMinor, 0n)).toBe(
      snapshot.tax.amountMinor,
    );
    // Round trip: the stored form parses to the same snapshot.
    expect(
      parseDigitalReceiptSnapshot(
        JSON.parse(
          JSON.stringify(snapshot, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
          (k, v: unknown) => (k === "amountMinor" ? BigInt(v as string) : v),
        ),
      ),
    ).toEqual(snapshot);
  });

  it("omits the registration line when the Owner entered none, and the block for older callers", () => {
    const input = fixture();
    const none = createOriginalReceiptSnapshotFromOrder({
      ...input,
      receiptDetails: { businessAddress: null, taxRegistrations: [] },
    });
    expect(none.taxDetails?.taxRegistrations).toEqual([]);
    expect(none.taxDetails?.businessAddress).toBeNull();
    expect(createOriginalReceiptSnapshotFromOrder(fixture(false)).taxDetails).toBeUndefined();
  });

  it("rejects tax lines that do not add up to the tax total and malformed registrations", () => {
    const snapshot = createOriginalReceiptSnapshotFromOrder(fixture());
    const details = snapshot.taxDetails;
    if (!details) throw new Error("tax details missing");
    expect(() =>
      parseDigitalReceiptSnapshot({
        ...snapshot,
        taxDetails: {
          ...details,
          taxLines: [
            ...details.taxLines,
            {
              label: "EXTRA",
              ratePercent: "1",
              included: false,
              amount: { amountMinor: 1n, currencyCode: "CAD" },
            },
          ],
        },
      }),
    ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
    for (const bad of [
      { label: "GST/HST", number: "12345" },
      { label: "QST", number: "000000000RT0001" },
      { label: "VAT", number: "000000000RT0001" },
    ])
      expect(() =>
        parseDigitalReceiptSnapshot({
          ...snapshot,
          taxDetails: { ...details, taxRegistrations: [bad] },
        }),
      ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
  });

  it("keeps the issued tax details on a refund version (never rewritten)", () => {
    const snapshot = createOriginalReceiptSnapshotFromOrder(fixture());
    const record = {
      recordReference: "0190ee00-0000-7000-8000-000000000010",
      version: 1,
      kind: "Original" as const,
      recordedAt: snapshot.issuedAt,
      previousRecordReference: null,
      reasonCode: null,
      snapshot,
    };
    const refund = createRefundReceiptSnapshot(record, {
      brandReference: snapshot.brandReference,
      storeReference: snapshot.storeReference,
      orderReference: snapshot.orderReference,
      observedAt: "2026-09-12T13:00:00.000Z",
      captured: snapshot.total,
      refunded: { amountMinor: 1n, currencyCode: "CAD" },
      pendingRefund: { amountMinor: 0n, currencyCode: "CAD" },
    });
    expect(refund?.paymentStatus).toBe("PartiallyRefunded");
    expect(refund?.taxDetails).toEqual(snapshot.taxDetails);
  });
});
