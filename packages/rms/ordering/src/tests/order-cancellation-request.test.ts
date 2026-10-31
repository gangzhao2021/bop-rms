import { expect, it } from "vitest";
import {
  parseOrderCancellationRequest,
  resolveOrderCancellationRequestHistory,
} from "../domain/order-cancellation-request.js";
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
it("keeps both requested and approved cancellation pending", () => {
  expect(resolveOrderCancellationRequestHistory([requested]).pending).toBe(true);
  expect(resolveOrderCancellationRequestHistory([requested, approved]).pending).toBe(true);
});
it("requires executed evidence before approved cancellation becomes final", () => {
  const result = resolveOrderCancellationRequestHistory([requested, approved, executed]);
  expect(result.pending).toBe(false);
  expect(result.current.executionReference).toBe(id(11));
  expect(Object.isFrozen(result.current)).toBe(true);
});
it("rejection completes a request without claiming cancellation", () => {
  const result = resolveOrderCancellationRequestHistory([
    requested,
    { ...approved, status: "Rejected" },
  ]);
  expect(result.pending).toBe(false);
  expect(result.current.executionReference).toBe(null);
});
it.each([
  { ...requested, unexpected: true },
  { ...requested, version: 0 },
  { ...requested, version: 4 },
  { ...requested, requestedByActorType: "System" },
  { ...requested, requestReasonCode: "free text" },
  { ...requested, decidedByActorReference: id(9) },
  { ...approved, decidedByActorReference: null },
  { ...approved, executionReference: id(11) },
  { ...executed, executionReference: null },
  { ...requested, occurredAt: "2026-09-19T23:59:00.000Z" },
])("rejects malformed or ambiguous record %#", (value) => {
  expect(() => parseOrderCancellationRequest(value)).toThrow("ORDER_CANCELLATION_REQUEST_INVALID");
});
it.each(
  [
    [],
    [approved],
    [requested, executed],
    [requested, { ...approved, version: 3 }],
    [requested, { ...approved, storeReference: id(12) }],
    [requested, { ...approved, requestReasonCode: "CHANGED" }],
    [requested, { ...approved, operationReference: requested.operationReference }],
    [requested, { ...approved, expectedOrderVersion: 1 }],
    [requested, approved, { ...executed, occurredAt: requested.occurredAt }],
    [requested, { ...approved, status: "Rejected" }, executed],
  ].map((values) => [values] as const),
)("rejects discontinuous or rewritten history %#", (values) => {
  expect(() => resolveOrderCancellationRequestHistory(values)).toThrow(
    "ORDER_CANCELLATION_REQUEST_INVALID",
  );
});
