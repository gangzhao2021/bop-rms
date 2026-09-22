import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInternalCompensationIdentity } from "./pilot-compensation-identity.mjs";
import { validateAuditRecord } from "../../packages/bop/audit/src/index.ts";
const id = (n) => "0190fa77-0000-7000-8000-" + String(n).padStart(12, "0");
const d = {
  dispositionReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  paymentTransactionReference: id(7),
  paymentIntentReference: id(8),
  paymentAttemptReference: id(9),
  paymentEventReference: id(10),
  sourceVersion: 1,
  sourceCheckpoint: id(11),
  sourceDigest: "sha256:" + "a".repeat(64),
  evaluatedAt: "2026-09-21T00:00:00.000Z",
  disposition: "PaidWithoutFulfillableOrder",
  reason: "SubmissionCancelled",
  kitchenReleaseDisposition: "Blocked",
};
const now = () => "2026-09-21T01:00:00.000Z";
beforeEach(() => vi.stubEnv("NODE_ENV", "development"));
afterEach(() => vi.unstubAllEnvs());
it("recreates stable identities regardless of field order and separates roles/payments", () => {
  const a = createInternalCompensationIdentity(d, now),
    b = createInternalCompensationIdentity(Object.fromEntries(Object.entries(d).reverse()), now);
  expect(a.identities).toEqual(b.identities);
  expect(new Set(Object.values(a.identities)).size).toBe(6);
  expect(
    createInternalCompensationIdentity({ ...d, paymentAttemptReference: id(12) }, now).identities
      .case,
  ).not.toBe(a.identities.case);
  const expected = {
    environment: "Test",
    brandReference: d.brandReference,
    storeReference: d.storeReference,
    orderReference: d.orderReference,
    paymentTransactionReference: d.paymentTransactionReference,
    paymentAttemptReference: d.paymentAttemptReference,
    purpose: "CompensatePaidWithoutFulfillableOrder",
  };
  expect(a.references.operationFor(expected)).toBe(a.identities.operation);
  expect(() => a.references.operationFor({ ...expected, environment: "Live" })).toThrow();
  expect(() => a.references.operationFor({ ...expected, storeReference: id(99) })).toThrow();
});
it("binds provider idempotency to stable action, not a new retry amount", () => {
  const a = createInternalCompensationIdentity(d, now),
    input = {
      environment: "Test",
      compensationCaseReference: a.identities.case,
      paymentTransactionReference: d.paymentTransactionReference,
      paymentAttemptReference: d.paymentAttemptReference,
      actionReference: a.identities.action,
      purpose: "RefundPaidWithoutFulfillableOrder",
      amountMinor: 1130n,
      currencyCode: "CAD",
      actionDigest: d.sourceDigest,
    };
  const key = a.references.providerIdempotencyKey(input);
  expect(key).toBe("compensation-refund:" + a.identities.action);
  expect(a.references.providerIdempotencyKey({ ...input, amountMinor: 1000n })).toBe(key);
  expect(() =>
    a.references.providerIdempotencyKey({ ...input, actionReference: id(99) }),
  ).toThrow();
  expect(() => a.references.providerIdempotencyKey({ ...input, amountMinor: 0n })).toThrow();
});
it("creates valid bound audit without private summaries and rejects future time", async () => {
  const a = createInternalCompensationIdentity(d, now),
    input = {
      caseReference: a.identities.case,
      brandReference: d.brandReference,
      storeReference: d.storeReference,
      paymentTransactionReference: d.paymentTransactionReference,
      occurredAt: now(),
    };
  const record = validateAuditRecord(await a.audit.createCase(input));
  expect(record.actor).toEqual({ type: "System" });
  expect(record.correlationId).toBe(a.identities.case);
  expect(record.beforeSummary).toBeUndefined();
  expect(record.afterSummary).toBeUndefined();
  await expect(
    a.audit.createCase({ ...input, occurredAt: "2026-09-22T00:00:00.000Z" }),
  ).rejects.toThrow();
  await expect(a.audit.createCase({ ...input, caseReference: id(99) })).rejects.toThrow();
});
it("rejects production construction and later environment changes", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalCompensationIdentity(d, now)).toThrow();
  vi.stubEnv("NODE_ENV", "development");
  const a = createInternalCompensationIdentity(d, now);
  vi.stubEnv("NODE_ENV", "production");
  expect(() => a.references.eventFor({ refundReference: a.identities.refund })).toThrow();
});
