import { describe, it, expect } from "vitest";
import {
  createOrderTerminatedPaymentDisposition,
  createOrderPaymentDispositionBinding,
  parseOrderInitialExecution,
} from "../index.js";
import { orderPaymentSourceFixture } from "./order-payment-source.fixture.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderPaymentSourceFixture(),
    p = f.preparation;
  return {
    execution: {
      brandReference: p.brandReference,
      storeReference: p.storeReference,
      orderReference: p.orderReference,
      orderBatchReference: p.orderBatchReference,
      phase: "Cancelled",
      version: 2,
      checkpoint: id(91),
      occurredAt: f.observedAt,
    },
    preparation: p,
    paymentEvent: f.paymentEvent,
    observedAt: f.observedAt,
    dispositionReference: id(92),
    sha256: f.sha256,
  };
}
describe("Ordering terminated paid disposition", () => {
  it.each([
    ["Cancelled", 2, "SubmissionCancelled"],
    ["Cancelled", 3, "SubmissionCancelled"],
    ["Rejected", 2, "OrderNoLongerFulfillable"],
  ])(
    "binds %s version %i and blocks Kitchen without reporting a refund",
    (phase, version, reason) => {
      const f = fixture();
      const result = createOrderTerminatedPaymentDisposition({
        ...f,
        execution: { ...f.execution, phase, version },
      });
      expect(result.disposition).toBe("PaidWithoutFulfillableOrder");
      if (result.disposition !== "PaidWithoutFulfillableOrder") throw new Error("expected blocked");
      expect(result.reason).toBe(reason);
      expect(result.kitchenReleaseDisposition).toBe("Blocked");
      expect(result.sourceCheckpoint).toBe(f.execution.checkpoint);
      expect(result.sourceVersion).toBe(version);
      expect(result.sourceDigest).toBe(
        f.sha256(
          createOrderPaymentDispositionBinding({
            event: f.paymentEvent,
            disposition: result,
          }),
        ),
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toHaveProperty("confirmationReference");
      expect(result).not.toHaveProperty("refundStatus");
    },
  );
  it.each([
    { phase: "Submitted", version: 1 },
    { phase: "Accepted", version: 2 },
    { phase: "Fulfilled" },
    { version: 1 },
    { version: 4 },
    { orderReference: id(99) },
    { orderBatchReference: id(99) },
    { brandReference: id(99) },
    { storeReference: id(99) },
    { occurredAt: "2099-01-01T00:00:00.000Z" },
    { checkpoint: "missing" },
    { closureStatus: "Closed" },
  ])("rejects nonterminal or mismatched current execution %j", (patch) => {
    const f = fixture();
    expect(() =>
      createOrderTerminatedPaymentDisposition({
        ...f,
        execution: { ...f.execution, ...patch },
      }),
    ).toThrow();
  });
  it("rejects a mismatched amount and failed digest", () => {
    const f = fixture();
    expect(() =>
      createOrderTerminatedPaymentDisposition({
        ...f,
        paymentEvent: {
          ...f.paymentEvent,
          payload: { ...f.paymentEvent.payload, amountMinor: "1" },
        },
      }),
    ).toThrow();
    expect(() =>
      createOrderTerminatedPaymentDisposition({ ...f, sha256: () => "missing" }),
    ).toThrow();
  });
  it("handles actual late captured payment after termination without extending a resource deadline", () => {
    const f = fixture();
    const later = new Date(Date.parse(f.preparation.capacityExpiresAt) + 1).toISOString();
    const result = createOrderTerminatedPaymentDisposition({
      ...f,
      observedAt: later,
      paymentEvent: {
        ...f.paymentEvent,
        occurredAt: later,
        payload: { ...f.paymentEvent.payload, terminalOccurredAt: later },
      },
    });
    expect(result.disposition).toBe("PaidWithoutFulfillableOrder");
    expect(result.evaluatedAt).toBe(later);
    expect(() =>
      createOrderTerminatedPaymentDisposition({
        ...f,
        observedAt: new Date(Date.parse(f.observedAt) - 1).toISOString(),
      }),
    ).toThrow();
  });
  it("parses current initial execution without invoking accessors", () => {
    const f = fixture();
    expect(
      parseOrderInitialExecution({ ...f.execution, phase: "Submitted", version: 1 }).phase,
    ).toBe("Submitted");
    let calls = 0;
    Object.defineProperty(f.execution, "checkpoint", {
      enumerable: true,
      get() {
        calls++;
        return "SECRET";
      },
    });
    expect(() => parseOrderInitialExecution(f.execution)).toThrow();
    expect(calls).toBe(0);
  });
});
