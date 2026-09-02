import { describe, expect, it } from "vitest";
import { parseReceiptView } from "./receipt-controller.js";

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function payload() {
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    orderReference: id(1),
    freshnessStatus: "Fresh",
    deliveryStatus: "Unavailable",
    supportEligible: true,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-08-12T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Synthetic Store",
          orderNumber: "1001",
          issuedAt: "2026-08-12T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: amount("1000"),
            },
          ],
          subtotal: amount("1000"),
          tax: amount("130"),
          tip: amount("0"),
          total: amount("1130"),
          paymentStatus: "Paid",
          refundedTotal: amount("0"),
        },
      },
    ],
  };
}

describe("receipt response parser", () => {
  it("accepts the closed JSON DTO and converts money strings without binary float", () => {
    const parsed = parseReceiptView(payload(), id(1));
    expect(parsed.records[0]?.snapshot.total.amountMinor).toBe(1130n);
    expect(Object.isFrozen(parsed.records)).toBe(true);
  });

  it("rejects open data bags and accessors without invoking them", () => {
    expect(() => parseReceiptView({ ...payload(), secret: "must-not-pass" }, id(1))).toThrow(
      "invalid receipt",
    );
    const candidate = payload();
    let invoked = false;
    Object.defineProperty(candidate.records[0], "snapshot", {
      enumerable: true,
      get() {
        invoked = true;
        return payload().records[0]?.snapshot;
      },
    });
    expect(() => parseReceiptView(candidate, id(1))).toThrow("invalid receipt");
    expect(invoked).toBe(false);
  });
});
