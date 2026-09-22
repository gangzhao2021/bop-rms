import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import type { PaymentCompensationRuntimeOptions } from "@rms/payment";
const d = vi.hoisted(() => ({
  read: vi.fn(),
  runtime: vi.fn(),
  evidence: vi.fn(),
  observed: vi.fn(),
  caseEvidence: vi.fn(),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresPaymentTerminalStore: () => ({ read: d.read }),
  createPostgresPaymentCompensationRuntime: d.runtime,
}));
vi.mock("./payment-compensation-disposition-evidence.js", () => ({
  createPaymentCompensationDispositionEvidence: () => d.evidence,
}));
vi.mock("./payment-compensation-observed-provider.js", () => ({
  createPaymentCompensationObservedProvider: d.observed,
}));
vi.mock("./payment-compensation-case-evidence.js", () => ({
  createPaymentCompensationCaseEvidence: d.caseEvidence,
}));
import {
  createPaymentCompensationComposition,
  type PaymentCompensationCompositionOptions,
} from "./payment-compensation-composition.js";
const id = (n: number) => "0190fa80-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64);
const disposition = {
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
  sourceDigest: digest,
  evaluatedAt: "2026-09-21T00:00:00.000Z",
  disposition: "PaidWithoutFulfillableOrder",
  reason: "SubmissionCancelled",
  kitchenReleaseDisposition: "Blocked",
};
function fixture() {
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
  const provider = { retrieveIntent: vi.fn(), refundPayment: vi.fn() };
  const options = {
    disposition,
    tenantReference: id(12),
    transactions: { run: async (work: (t: ConsumerTransaction) => Promise<unknown>) => work(tx) },
    scope: {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(13),
      environment: "Test",
    },
    clock: { now: () => "2026-09-21T01:00:00.000Z" },
    references: { operationFor: () => id(20), caseFor: () => id(21), actionFor: () => id(22) },
    audit: {},
    provider,
    authorize: vi.fn(async () => true),
    otherRefunds: vi.fn(),
    lease: { leaseDurationMs: 30000, newFenceReference: () => id(23) },
    newObservationReference: () => id(24),
    operations: { authorize: vi.fn(async () => true), validateEvidence: vi.fn(async () => true) },
    authorizeOperations: vi.fn(async () => true),
  } as unknown as PaymentCompensationCompositionOptions;
  return { tx, options, provider };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.evidence.mockResolvedValue(true);
  d.read.mockResolvedValue({ outcome: "Succeeded", providerIntentReference: "pi_DEMOcomposition" });
  d.runtime.mockReturnValue({ execute: vi.fn(), recordOperations: vi.fn() });
  d.observed.mockReturnValue({});
  d.caseEvidence.mockReturnValue({
    validateOpen: vi.fn(),
    validateClaim: vi.fn(),
    validateCurrentSource: vi.fn(),
  });
});
it("assembles durable ports and observed Provider without invoking refunds", async () => {
  const f = fixture();
  await createPaymentCompensationComposition(f.options);
  expect(d.runtime).toHaveBeenCalledOnce();
  expect(f.provider.refundPayment).not.toHaveBeenCalled();
  expect(f.provider.retrieveIntent).not.toHaveBeenCalled();
  expect(d.observed.mock.calls[0]?.[0].context).toMatchObject({
    provider: "Stripe",
    operationReference: id(22),
    paymentAttemptReference: id(9),
  });
  const runtime = d.runtime.mock.calls[0]?.[0] as PaymentCompensationRuntimeOptions;
  expect(runtime.source.otherRefunds).toBe(f.options.otherRefunds);
  const access = {
    action: "Read" as const,
    brandReference: id(2),
    storeReference: id(3),
    caseReference: id(21),
  };
  expect(await runtime.cases.authorize(f.tx, access)).toBe(true);
  expect(await runtime.cases.authorize(f.tx, { ...access, caseReference: id(99) })).toBe(false);
  expect(await runtime.cases.authorize(f.tx, { ...access, storeReference: id(99) })).toBe(false);
  expect(
    await runtime.actions.authorize(f.tx, {
      action: "Read",
      brandReference: id(2),
      storeReference: id(3),
      actionReference: id(99),
    }),
  ).toBe(false);
});
it("denies assembly before terminal read without actual disposition authority", async () => {
  const f = fixture();
  d.evidence.mockResolvedValue(false);
  await expect(createPaymentCompensationComposition(f.options)).rejects.toThrow(
    "PERMISSION_DENIED",
  );
  expect(d.read).not.toHaveBeenCalled();
  expect(d.runtime).not.toHaveBeenCalled();
});
it("rejects missing terminal and revoked authority after reading", async () => {
  const f = fixture();
  d.read.mockResolvedValueOnce(null);
  await expect(createPaymentCompensationComposition(f.options)).rejects.toThrow(
    "SOURCE_UNAVAILABLE",
  );
  d.evidence.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(createPaymentCompensationComposition(f.options)).rejects.toThrow(
    "SOURCE_UNAVAILABLE",
  );
  expect(d.runtime).not.toHaveBeenCalled();
});
it("rechecks bound disposition before execution and retains separate operator authority", async () => {
  const f = fixture();
  await createPaymentCompensationComposition(f.options);
  const runtime = d.runtime.mock.calls[0]?.[0] as PaymentCompensationRuntimeOptions;
  const actual = d.evidence.mock.calls[0]?.[1];
  expect(await runtime.runtime.authorization.authorize(actual)).toBe(true);
  expect(
    await runtime.runtime.authorization.authorize({
      ...actual,
      sourceDigest: "sha256:" + "b".repeat(64),
    }),
  ).toBe(false);
  const access = {
    action: "Record" as const,
    brandReference: id(2),
    storeReference: id(3),
    caseReference: id(21),
    actorReference: id(40),
    purpose: "ReconcilePaidWithoutFulfillableOrder" as const,
  };
  vi.mocked(f.options.operations.authorize).mockResolvedValue(false);
  expect(await runtime.operations.authorize(f.tx, access)).toBe(false);
  expect(runtime.runtime.authorization.authorizeOperations).toBe(f.options.authorizeOperations);
  d.evidence.mockResolvedValue(false);
  expect(await runtime.runtime.authorization.authorize(actual)).toBe(false);
});
