import { describe, it, expect } from "vitest";
import {
  createOrderExpiredPaymentDisposition,
  createOrderPaymentDispositionBinding,
} from "../index.js";
import { orderPaymentSourceFixture } from "./order-payment-source.fixture.js";
const id = (n: number) => "0198a108-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderPaymentSourceFixture(),
    p = f.preparation,
    at = p.capacityExpiresAt;
  return {
    orderType: "Pickup" as const,
    execution: {
      brandReference: p.brandReference,
      storeReference: p.storeReference,
      orderReference: p.orderReference,
      orderBatchReference: p.orderBatchReference,
      phase: "Submitted",
      version: 1,
      checkpoint: p.submissionReference,
      occurredAt: p.committedAt,
    },
    preparation: p,
    paymentEvent: {
      ...f.paymentEvent,
      occurredAt: at,
      payload: { ...f.paymentEvent.payload, terminalOccurredAt: at },
    },
    observedAt: at,
    dispositionReference: id(92),
    sha256: f.sha256,
  };
}
describe("expired pending payment disposition", () => {
  it.each(["Pickup", "DineIn"] as const)(
    "binds actual deadline capture for %s and blocks Kitchen",
    (orderType) => {
      const f = { ...fixture(), orderType },
        result = createOrderExpiredPaymentDisposition(f);
      expect(result).toMatchObject({
        disposition: "PaidWithoutFulfillableOrder",
        reason: "CapacityExpired",
        kitchenReleaseDisposition: "Blocked",
        sourceVersion: 1,
        sourceCheckpoint: f.preparation.submissionReference,
      });
      if (!result) throw Error("missing");
      expect(result.sourceDigest).toBe(
        f.sha256(
          createOrderPaymentDispositionBinding({ event: f.paymentEvent, disposition: result }),
        ),
      );
      expect(result).not.toHaveProperty("refundStatus");
    },
  );
  it("keeps on-time Dining capture eligible when processed later; Pickup has expired", () => {
    const f = fixture(),
      onTime = new Date(Date.parse(f.preparation.capacityExpiresAt) - 1).toISOString(),
      event = {
        ...f.paymentEvent,
        occurredAt: onTime,
        payload: { ...f.paymentEvent.payload, terminalOccurredAt: onTime },
      };
    expect(
      createOrderExpiredPaymentDisposition({ ...f, orderType: "DineIn", paymentEvent: event }),
    ).toBeNull();
    expect(createOrderExpiredPaymentDisposition({ ...f, paymentEvent: event })).toMatchObject({
      reason: "CapacityExpired",
    });
    expect(
      createOrderExpiredPaymentDisposition({ ...f, paymentEvent: event, observedAt: onTime }),
    ).toBeNull();
  });
  it.each([
    { phase: "Accepted", version: 2 },
    { phase: "Cancelled", version: 2 },
    { orderReference: id(99) },
    { orderBatchReference: id(99) },
    { brandReference: id(99) },
    { storeReference: id(99) },
    { checkpoint: id(99) },
  ])("denies execution mismatch %j", (patch) => {
    const f = fixture();
    expect(() =>
      createOrderExpiredPaymentDisposition({ ...f, execution: { ...f.execution, ...patch } }),
    ).toThrow();
  });
  it("denies wrong amounts, future capture, pre-commit capture and invalid digest", () => {
    const f = fixture();
    expect(() =>
      createOrderExpiredPaymentDisposition({
        ...f,
        paymentEvent: {
          ...f.paymentEvent,
          payload: { ...f.paymentEvent.payload, amountMinor: "1" },
        },
      }),
    ).toThrow();
    expect(() =>
      createOrderExpiredPaymentDisposition({ ...f, observedAt: f.preparation.committedAt }),
    ).toThrow();
    const early = new Date(Date.parse(f.preparation.committedAt) - 1).toISOString();
    expect(() =>
      createOrderExpiredPaymentDisposition({
        ...f,
        paymentEvent: {
          ...f.paymentEvent,
          occurredAt: early,
          payload: { ...f.paymentEvent.payload, terminalOccurredAt: early },
        },
      }),
    ).toThrow();
    expect(() => createOrderExpiredPaymentDisposition({ ...f, sha256: () => "invalid" })).toThrow();
  });
});
