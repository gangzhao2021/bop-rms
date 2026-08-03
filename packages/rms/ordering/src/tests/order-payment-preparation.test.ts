import { describe, expect, it } from "vitest";

import { OrderPaymentPreparationError, parseOrderPaymentPreparationEvidence } from "../index.js";

const id = (suffix: string) => `0198a002-0000-7000-8000-${suffix.padStart(12, "0")}`;

function evidence() {
  return {
    preparationReference: id("1"),
    orderReference: id("2"),
    orderBatchReference: id("3"),
    submissionReference: id("4"),
    sourceCartReference: id("10"),
    sourceCartVersion: 3,
    brandReference: id("5"),
    storeReference: id("6"),
    guestSessionReference: id("7"),
    quoteReference: id("8"),
    capacityAllocationReference: id("9"),
    readiness: "PaymentPending",
    transactionBoundary: "OrderSubmissionPaymentPreparation",
    orderAllocation: { amountMinor: 2_000n, currencyCode: "CAD" },
    tip: { amountMinor: 200n, currencyCode: "CAD" },
    total: { amountMinor: 2_200n, currencyCode: "CAD" },
    committedAt: "2026-08-03T14:00:00.000Z",
    capacityExpiresAt: "2026-08-03T14:31:00.000Z",
    sourceDigest: `sha256:${"b".repeat(64)}`,
  };
}

function rejects(value: unknown): void {
  expect(() => parseOrderPaymentPreparationEvidence(value)).toThrow(OrderPaymentPreparationError);
}

describe("Ordering payment preparation evidence", () => {
  it("accepts and freezes the exact durable Payment Pending boundary", () => {
    const parsed = parseOrderPaymentPreparationEvidence(evidence());
    expect(parsed.total.amountMinor).toBe(2_200n);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.total)).toBe(true);
  });

  it("rejects non-atomic, non-forward expiry, mismatched money and extra input", () => {
    rejects({ ...evidence(), transactionBoundary: "LaterTransaction" });
    rejects({ ...evidence(), capacityExpiresAt: "2026-08-03T13:59:00.000Z" });
    rejects({ ...evidence(), total: { amountMinor: 2_201n, currencyCode: "CAD" } });
    rejects({ ...evidence(), clientAmount: 2_200 });
  });
});
