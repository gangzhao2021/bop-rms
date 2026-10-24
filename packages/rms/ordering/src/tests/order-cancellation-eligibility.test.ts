import { expect, it } from "vitest";
import { evaluateOrderCancellationRequestEligibility as evaluate } from "../domain/order-cancellation-eligibility.js";
const id = (n: number) => "0190face-0000-7000-8000-" + String(n).padStart(12, "0");
const requested = {
  requestReference: id(1),
  operationReference: id(2),
  intentDigest: "sha256:" + "a".repeat(64),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(6),
  version: 1,
  expectedOrderVersion: 2,
  requestedByActorReference: id(7),
  requestedByActorType: "GuestSession",
  requestReasonCode: "CUSTOMER_REQUEST",
  requestedAt: "2026-09-20T00:00:00.000Z",
  status: "Requested",
  decidedByActorReference: null,
  decisionReasonCode: null,
  executionReference: null,
  occurredAt: "2026-09-20T00:00:00.000Z",
};
const approved = {
  ...requested,
  operationReference: id(8),
  version: 2,
  status: "Approved",
  decidedByActorReference: id(9),
  decisionReasonCode: "STAFF_CONFIRMED",
  occurredAt: "2026-09-20T00:01:00.000Z",
};
const executed = {
  ...approved,
  operationReference: id(10),
  version: 3,
  status: "Executed",
  executionReference: id(11),
  occurredAt: "2026-09-20T00:02:00.000Z",
};

const evidence = {
  brandReference: requested.brandReference,
  storeReference: requested.storeReference,
  orderReference: requested.orderReference,
  orderVersion: 2,
  observedAt: executed.occurredAt,
  phase: "Accepted",
  closureStatus: "Open",
  kitchenEvidenceComplete: true,
  everStarted: false,
  execution: null,
};
it("allows accepted request, never treats approval as execution", () => {
  expect(evaluate(requested, evidence).eligible).toBe(true);
  expect(
    evaluate(approved, { ...evidence, phase: "InProgress", everStarted: true })
      .lossEvidenceRequired,
  ).toBe(true);
});
it.each(["Fulfilled", "Rejected", "Cancelled"])(
  "refuses new request and approval for final phase %s",
  (phase) => {
    for (const record of [requested, approved])
      expect(evaluate(record, { ...evidence, phase }).eligible).toBe(false);
  },
);
it("rejecting a request after fulfillment clears it without cancelling the Order", () => {
  expect(
    evaluate({ ...approved, status: "Rejected" }, { ...evidence, phase: "Fulfilled" }).eligible,
  ).toBe(true);
});
it.each([null, "Closed"])("does not infer open lifecycle from %s", (closureStatus) => {
  expect(evaluate(requested, { ...evidence, closureStatus }).eligible).toBe(false);
});
it("does not invent Kitchen progress and preserves request availability", () => {
  expect(evaluate(requested, { ...evidence, kitchenEvidenceComplete: false }).eligible).toBe(true);
  expect(evaluate(approved, { ...evidence, kitchenEvidenceComplete: false }).eligible).toBe(false);
});
it("requires exact current order version", () => {
  expect(evaluate(approved, { ...evidence, orderVersion: 3 }).reasons).toContain(
    "ORDER_VERSION_CHANGED",
  );
});
it("recording a submitted request does not replace the independent direct-cancel command", () => {
  expect(evaluate(requested, { ...evidence, phase: "Submitted" }).eligible).toBe(true);
});
it("Executed must bind actual owner cancellation reference and versions", () => {
  const current = {
    ...evidence,
    phase: "Cancelled",
    orderVersion: 3,
    execution: {
      reference: executed.executionReference,
      expectedOrderVersion: 2,
      terminatedOrderVersion: 3,
      occurredAt: executed.occurredAt,
    },
  };
  expect(evaluate(executed, current).eligible).toBe(true);
  expect(evaluate(executed, { ...current, execution: null }).eligible).toBe(false);
  expect(
    evaluate(executed, { ...current, execution: { ...current.execution, reference: id(40) } })
      .eligible,
  ).toBe(false);
});
it.each(["scope", "time", "shape", "version"])(
  "rejects malformed or foreign evidence %s",
  (kind) => {
    const current = {
      ...evidence,
      ...(kind === "scope"
        ? { storeReference: id(40) }
        : kind === "time"
          ? { observedAt: "2026-09-19T00:00:00.000Z" }
          : kind === "shape"
            ? { unexpected: true }
            : { orderVersion: 1.5 }),
    };
    expect(() => evaluate(requested, current)).toThrow("ORDER_CANCELLATION_EVIDENCE_INVALID");
  },
);
