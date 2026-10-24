import type { ConsumerTransaction } from "@bop/eventing";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), append: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-intent-creation-store.js", () => ({
  createPostgresPaymentIntentCreationStore: () => ({ resolveOperation: mocks.resolve }),
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.append,
}));
import { createPostgresProviderCaptureExceptionStore } from "../infrastructure/persistence/provider-capture-exception-store.js";
const id = (n: number) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(null);
  mocks.append.mockResolvedValue(undefined);
});
function fixture() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    evidence = {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(4),
      environment: "Test",
      providerIntentReference: "pi_test001",
      providerTransactionReference: "ch_test001",
      paymentOperationReference: id(5),
      paymentAttemptReference: id(6),
      amount: { amountMinor: 2260n, currencyCode: "CAD" },
      occurredAt: "2026-09-20T03:35:37.236Z",
      observedAt: "2026-09-22T00:00:00.000Z",
      evidenceDigest: "sha256:" + "a".repeat(64),
    },
    request = { candidateReference: id(7), exceptionReference: id(8), evidence },
    prior: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT candidate_id") ? prior : [],
      rowCount: sql.startsWith("INSERT") ? 1 : 0,
    })),
    tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true),
    audit = vi.fn(async () => ({
      auditId: id(9),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "System" },
      actionCode: "PAYMENT_PROVIDER_CAPTURE_UNMATCHED",
      targetType: "PaymentReconciliationException",
      targetId: id(8),
      correlationId: id(7),
      occurredAt: evidence.observedAt,
      reasonCode: "PROVIDER_CAPTURE_WITHOUT_INTERNAL_OPERATION",
      sourceChannel: "INTERNAL_TEST",
      dataClassification: "Restricted",
      retentionPolicyCode: "PAYMENT_AUDIT",
      retentionPolicyVersion: 1,
    }));
  const verifyEvidence = vi.fn(async () => true);
  const store = createPostgresProviderCaptureExceptionStore({
    scope,
    providerAccountReference: id(4),
    environment: "Test",
    authorize,
    verifyEvidence,
    audit,
  });
  return { store, request, prior, tx, query, authorize, audit, verifyEvidence };
}
it("fences original operation before owner re-read, then appends exception/evidence/Audit in same transaction", async () => {
  const f = fixture();
  expect((await f.store.record(f.tx, f.request)).status).toBe("Created");
  const calls = f.query.mock.calls.map((v) => v[0]);
  expect(calls.filter((v) => v.includes("pg_advisory_xact_lock"))).toHaveLength(2);
  expect(mocks.resolve).toHaveBeenCalledWith(f.request.evidence.paymentOperationReference);
  expect(calls.filter((v) => v.startsWith("INSERT"))).toHaveLength(2);
  expect(mocks.append).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ targetId: f.request.exceptionReference }),
  );
  expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(
    Number(f.audit.mock.invocationCallOrder[0]),
  );
});
it("does not record a missing-operation exception if the operation appeared before the fence", async () => {
  const f = fixture();
  mocks.resolve.mockResolvedValue({ intent: { paymentIntentReference: id(10) } });
  expect((await f.store.record(f.tx, f.request)).status).toBe("OperationPresent");
  expect(mocks.append).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some((v) => v[0].startsWith("INSERT"))).toBe(false);
});
it("replays exact stable evidence without duplicate audit and rejects conflicting money", async () => {
  const f = fixture();
  const { amount, occurredAt, observedAt, ...rest } = f.request.evidence;
  f.prior.push({
    ...rest,
    candidate: id(7),
    exception: id(8),
    tenant: id(1),
    amountMinor: amount.amountMinor.toString(),
    currencyCode: "CAD",
    occurredAt: new Date(occurredAt),
    observedAt: new Date(observedAt),
  });
  expect((await f.store.record(f.tx, f.request)).status).toBe("AlreadyRecorded");
  expect(mocks.append).not.toHaveBeenCalled();
  await expect(
    f.store.record(f.tx, {
      ...f.request,
      evidence: { ...f.request.evidence, amount: { ...amount, amountMinor: 2261n } },
    }),
  ).rejects.toThrow();
});
it("rejects foreign scope and revoked authorization before writes", async () => {
  const f = fixture();
  await expect(
    f.store.record(f.tx, {
      ...f.request,
      evidence: { ...f.request.evidence, storeReference: id(11) },
    }),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.store.record(f.tx, f.request)).rejects.toThrow();
  expect(f.query.mock.calls.some((v) => v[0].startsWith("INSERT"))).toBe(false);
});
it("propagates audit failure to caller transaction instead of reporting success", async () => {
  const f = fixture();
  mocks.append.mockRejectedValue(Error("private"));
  await expect(f.store.record(f.tx, f.request)).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
  });
});

it("rejects unverified Provider evidence before owner reads or writes", async () => {
  const f = fixture();
  f.verifyEvidence.mockResolvedValue(false);
  await expect(f.store.record(f.tx, f.request)).rejects.toThrow();
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some((v) => v[0].startsWith("INSERT"))).toBe(false);
});
