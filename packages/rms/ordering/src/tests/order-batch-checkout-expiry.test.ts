import { expect, it } from "vitest";
import {
  parseOrderBatchCheckoutExpiry,
  resolveOrderBatchCheckoutExpiryHistory,
} from "../domain/order-batch-checkout-expiry.js";
const id = (n: number) => `0190ee26-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const initial = () => ({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  commitmentReference: id(7),
  paymentOperationReference: id(8),
  recordReference: id(9),
  previousRecordReference: null,
  version: 1,
  paymentRequestedAt: "2026-09-21T00:00:00.000Z",
  capacityExpiresAt: "2026-09-21T00:30:00.000Z",
  observedAt: "2026-09-21T00:31:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
  paymentEvidence: null,
  status: "AwaitingPaymentResolution",
});
const terminal = (at = "2026-09-21T00:30:00.000Z", outcome = "Succeeded") => ({
  paymentIntentReference: id(10),
  paymentAttemptReference: id(11),
  paymentEventReference: id(12),
  outcome,
  occurredAt: at,
});
it("retains uncertainty without manufacturing failed or cancelled payment", () => {
  const record = parseOrderBatchCheckoutExpiry(initial());
  expect(record.status).toBe("AwaitingPaymentResolution");
  expect(record.paymentEvidence).toBeNull();
  expect(Object.isFrozen(record)).toBe(true);
  expect(() => parseOrderBatchCheckoutExpiry({ ...initial(), status: "PaymentFailed" })).toThrow();
});
it.each([
  { at: "2026-09-21T00:29:59.999Z", status: "PaidBeforeDeadline" },
  { at: "2026-09-21T00:30:00.000Z", status: "LatePayment" },
  { at: "2026-09-21T00:30:00.001Z", status: "LatePayment" },
])("binds terminal boundary $at", ({ at, status }) => {
  expect(
    parseOrderBatchCheckoutExpiry({ ...initial(), paymentEvidence: terminal(at), status }).status,
  ).toBe(status);
});
it("records failure distinctly without claiming operational cancellation", () => {
  expect(
    parseOrderBatchCheckoutExpiry({
      ...initial(),
      paymentEvidence: terminal(undefined, "Failed"),
      status: "PaymentFailed",
    }).status,
  ).toBe("PaymentFailed");
});
it("advances unresolved history once without changing immutable batch/clock", () => {
  const first = initial(),
    next = {
      ...first,
      recordReference: id(13),
      previousRecordReference: first.recordReference,
      version: 2,
      paymentEvidence: terminal(),
      status: "LatePayment",
    };
  expect(resolveOrderBatchCheckoutExpiryHistory([first, next])).toEqual(
    parseOrderBatchCheckoutExpiry(next),
  );
  for (const changed of [
    { orderBatchReference: id(14) },
    { paymentOperationReference: id(14) },
    {
      capacityExpiresAt: "2026-09-21T00:30:01.000Z",
      paymentRequestedAt: "2026-09-21T00:00:01.000Z",
    },
    { previousRecordReference: id(14) },
    { observedAt: "2026-09-21T00:30:00.000Z" },
  ]) {
    expect(() =>
      resolveOrderBatchCheckoutExpiryHistory([first, { ...next, ...changed }]),
    ).toThrow();
  }
});
it("rejects regressions and replacement of already-terminal evidence", () => {
  const first = { ...initial(), paymentEvidence: terminal(), status: "LatePayment" };
  const next = {
    ...first,
    recordReference: id(13),
    previousRecordReference: first.recordReference,
    version: 2,
  };
  expect(() => resolveOrderBatchCheckoutExpiryHistory([first, next])).toThrow();
  expect(() =>
    parseOrderBatchCheckoutExpiry({ ...initial(), version: 2, previousRecordReference: id(13) }),
  ).toThrow();
});
it.each([
  { observedAt: "2026-09-21T00:29:59.999Z" },
  { capacityExpiresAt: "2026-09-21T00:31:00.000Z" },
  { paymentEvidence: terminal("2026-09-21T00:32:00.000Z"), status: "LatePayment" },
  { paymentEvidence: terminal("2026-09-20T23:59:59.999Z"), status: "PaidBeforeDeadline" },
  { extra: "private" },
])("rejects invalid clock or extra fields: %j", (changed) => {
  expect(() => parseOrderBatchCheckoutExpiry({ ...initial(), ...changed })).toThrow(
    "ORDER_BATCH_CHECKOUT_EXPIRY_INVALID",
  );
});
it("requires complete history starting at version one", () => {
  expect(resolveOrderBatchCheckoutExpiryHistory([])).toBeNull();
  expect(() =>
    resolveOrderBatchCheckoutExpiryHistory([
      {
        ...initial(),
        version: 2,
        previousRecordReference: id(13),
        paymentEvidence: terminal(),
        status: "LatePayment",
      },
    ]),
  ).toThrow();
});
