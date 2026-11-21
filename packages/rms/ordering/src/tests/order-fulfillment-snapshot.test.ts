import { describe, it, expect } from "vitest";
import {
  createOrderFulfillmentSourceFromSnapshot,
  createOrderPaymentConfirmationCandidate,
  createOrderConfirmedEnvelope,
  createOrderFulfillmentSourceLineBinding,
  createOrderFulfillmentSourceEvidenceBinding,
} from "../index.js";
import { orderPaymentSourceFixture } from "./order-payment-source.fixture.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderPaymentSourceFixture();
  const disposition = createOrderPaymentConfirmationCandidate(f);
  if (disposition.disposition !== "Confirmed") throw new Error("fixture");
  return {
    order: f.order,
    quoteVersion: f.quoteVersion,
    sha256: f.sha256,
    confirmationEvent: createOrderConfirmedEnvelope({
      eventReference: id(93),
      sourceEvent: f.paymentEvent,
      disposition,
    }),
  };
}
describe("Fulfillment source from original Ordering snapshot", () => {
  it("preserves original order type and quantities without exposing private item details", () => {
    const f = fixture(),
      result = createOrderFulfillmentSourceFromSnapshot(f);
    expect(result.evidenceReference).toBe(f.order.submissionReference);
    expect(result.capturedAt).toBe(f.order.createdAt);
    expect(result.evidenceVersion).toBe(1);
    expect(result.orderType).toBe(f.order.order.orderType);
    expect(result.items).toHaveLength(f.order.items.length);
    result.items.forEach((item, i) => {
      const original = f.order.items[i];
      if (!original) throw new Error("fixture");
      expect(item.orderItemReference).toBe(original.orderItemReference);
      expect(item.ordinal).toBe(i + 1);
      expect(item.quantity).toBe(original.quantity);
      expect(Object.keys(item).sort()).toEqual([
        "lineDigest",
        "orderItemReference",
        "ordinal",
        "quantity",
      ]);
      expect(item.lineDigest).toBe(f.sha256(createOrderFulfillmentSourceLineBinding(item)));
    });
    expect(result.evidenceDigest).toBe(
      f.sha256(createOrderFulfillmentSourceEvidenceBinding(result)),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("paymentIntentReference");
    expect(result.items[0]).not.toHaveProperty("pricing");
  });
  it.each([
    { orderReference: id(99) },
    { orderBatchReference: id(99) },
    { sourceSnapshotDigest: "sha256:" + "a".repeat(64) },
  ])("rejects confirmation for another original source %j", (patch) => {
    const f = fixture();
    expect(() =>
      createOrderFulfillmentSourceFromSnapshot({
        ...f,
        confirmationEvent: {
          ...f.confirmationEvent,
          payload: { ...f.confirmationEvent.payload, ...patch },
        },
      }),
    ).toThrow();
  });
  it("rejects future original history and a failed digest provider", () => {
    const f = fixture(),
      earlier = "2020-01-01T00:00:00.000Z";
    expect(() =>
      createOrderFulfillmentSourceFromSnapshot({
        ...f,
        confirmationEvent: {
          ...f.confirmationEvent,
          occurredAt: earlier,
          payload: { ...f.confirmationEvent.payload, confirmedAt: earlier },
        },
      }),
    ).toThrow();
    expect(() =>
      createOrderFulfillmentSourceFromSnapshot({ ...f, sha256: () => "unavailable" }),
    ).toThrow();
  });
});
