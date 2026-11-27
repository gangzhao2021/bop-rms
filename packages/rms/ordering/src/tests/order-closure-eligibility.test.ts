import { expect, it } from "vitest";
import { evaluateOrderClosureEligibility } from "../domain/order-closure-eligibility.js";
const id = (n: number) => "0190fae3-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-20T00:00:00.000Z";
const fixture = () => ({
  brandReference: id(1),
  storeReference: id(2),
  orderReference: id(3),
  orderVersion: 6,
  observedAt: at,
  inventoryComplete: true,
  batches: [{ batchReference: id(4), state: "Fulfilled" }],
  items: [{ itemReference: id(5), batchReference: id(4), state: "Fulfilled" }],
  fulfillmentState: "Fulfilled",
  pendingAmendmentCount: 0,
  pendingCancellationCount: 0,
  criticalBlockingTaskCount: 0,
  financialFinality: {
    orderReference: id(3),
    class: "Settled",
    ownerFinalityReference: id(6),
    decidedAt: at,
  },
});
it("requires all independent closure invariants and freezes the result", () => {
  const result = evaluateOrderClosureEligibility(fixture());
  expect(result.eligible).toBe(true);
  expect(result.reasons).toEqual([]);
  expect(Object.isFrozen(result.reasons)).toBe(true);
});
it.each([
  [{ inventoryComplete: false }, "EVIDENCE_INCOMPLETE"],
  [{ pendingCancellationCount: null }, "EVIDENCE_INCOMPLETE"],
  [{ pendingAmendmentCount: 1 }, "AMENDMENT_PENDING"],
  [{ pendingCancellationCount: 1 }, "CANCELLATION_PENDING"],
  [{ criticalBlockingTaskCount: 1 }, "CRITICAL_TASK_BLOCKING"],
  [{ financialFinality: null }, "FINANCIAL_FINALITY_REQUIRED"],
  [{ fulfillmentState: "InProgress" }, "FULFILLMENT_NOT_FINAL"],
  [
    { items: [{ itemReference: id(5), batchReference: id(4), state: "InProgress" }] },
    "EXECUTION_NOT_FINAL",
  ],
])("does not close with blocker %j", (change, reason) => {
  const result = evaluateOrderClosureEligibility({ ...fixture(), ...change });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain(reason);
});
it.each(["ProviderConfirmedRefund", "AuthorizedWriteOff", "OtherControlledFinal"])(
  "accepts owning finality %s without inferring it from captures",
  (kind) => {
    const f = fixture();
    f.financialFinality.class = kind;
    expect(evaluateOrderClosureEligibility(f).eligible).toBe(true);
  },
);
it.each([
  { items: [] },
  { batches: [] },
  { items: [{ itemReference: id(5), batchReference: id(99), state: "Fulfilled" }] },
  { pendingCancellationCount: -1 },
  { paid: true },
  { financialFinality: { ...fixture().financialFinality, orderReference: id(99) } },
  { financialFinality: { ...fixture().financialFinality, decidedAt: "2026-09-21T00:00:00.000Z" } },
  { financialFinality: { ...fixture().financialFinality, ownerFinalityReference: null } },
])("rejects malformed or incorrectly bound evidence %j", (change) => {
  expect(() => evaluateOrderClosureEligibility({ ...fixture(), ...change })).toThrow(
    "ORDER_CLOSURE_EVIDENCE_INVALID",
  );
});
