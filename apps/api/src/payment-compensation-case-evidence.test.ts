import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import type { PaymentCompensationCase } from "@rms/payment";
const d = vi.hoisted(() => ({ factory: vi.fn(), identity: vi.fn(), resolve: vi.fn() }));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresPaymentCompensationSource: d.factory,
}));
import { createPaymentCompensationCaseEvidence } from "./payment-compensation-case-evidence.js";
const id = (n: number) => "0190fa76-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  newDigest = "sha256:" + "b".repeat(64);
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
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction,
    validateDisposition = vi.fn(async () => true);
  const source = {
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    capturedAmount: { amountMinor: 1130n, currencyCode: "CAD" },
    confirmedRefundedAmount: { amountMinor: 0n },
    pendingRefundClaimedAmount: { amountMinor: 0n },
  };
  d.resolve.mockResolvedValue(source);
  const options = {
    disposition,
    validateDisposition,
    source: {
      tenantReference: id(12),
      scope: {
        brandReference: id(2),
        storeReference: id(3),
        providerAccountReference: id(13),
        environment: "Test" as const,
      },
      clock: { now: () => "2026-09-21T01:00:00.000Z" },
      authorize: async () => true,
      otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
    },
  };
  const validators = createPaymentCompensationCaseEvidence(options);
  // The owning stores parse complete records before these callbacks; this fixture isolates the binding fields.
  const record = {
    ...disposition,
    dispositionDigest: digest,
    caseReference: id(14),
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    terminalEvidenceDigest: digest,
    sourceSnapshotDigest: digest,
  } as unknown as PaymentCompensationCase;
  const receipt = {
    compensationCaseReference: id(14),
    brandReference: id(2),
    storeReference: id(3),
    paymentTransactionReference: id(7),
    paymentAttemptReference: id(9),
    originalPaymentMethod: "OnlineCard",
    dispositionDigest: digest,
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
  } as unknown as Parameters<typeof validators.validateClaim>[1]["receipt"];
  return { tx, source, record, receipt, validators, validateDisposition };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.identity.mockResolvedValue({ environment: "Test", identityVersion: 1, identityDigest: digest });
  d.factory.mockReturnValue({ resolveIdentity: d.identity, resolve: d.resolve });
});
it("binds case open to exact current source and retained transaction", async () => {
  const f = fixture();
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(true);
  expect(await d.factory.mock.calls[0]?.[0].transactions.run((tx: unknown) => tx)).toBe(f.tx);
  f.source.sourceSnapshotDigest = newDigest;
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(false);
});
it("allows later observations for existing identity but never stale opening or substituted case", async () => {
  const f = fixture();
  f.source.sourceVersion = 2;
  f.source.sourceSnapshotDigest = newDigest;
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(false);
  expect(
    await f.validators.validateCurrentSource(f.tx, {
      current: f.record,
      next: f.record,
      refund: null,
      operations: null,
    }),
  ).toBe(true);
  expect(
    await f.validators.validateCurrentSource(f.tx, {
      current: f.record,
      next: { ...f.record, orderReference: f.record.caseReference },
      refund: null,
      operations: null,
    }),
  ).toBe(false);
});
it("rejects claim if ordinary pending balance exhausts available money", async () => {
  const f = fixture();
  expect(
    await f.validators.validateClaim(f.tx, {
      caseRecord: f.record,
      receipt: f.receipt,
      interacEvidence: null,
    }),
  ).toBe(true);
  f.source.pendingRefundClaimedAmount.amountMinor = 1n;
  expect(
    await f.validators.validateClaim(f.tx, {
      caseRecord: f.record,
      receipt: f.receipt,
      interacEvidence: null,
    }),
  ).toBe(false);
});
it("denies missing identity and revoked disposition evidence", async () => {
  const f = fixture();
  d.identity.mockResolvedValueOnce(null);
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(false);
  expect(d.resolve).not.toHaveBeenCalled();
  f.validateDisposition.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(false);
});
it("rejects another payment or changed terminal digest", async () => {
  const f = fixture();
  expect(
    await f.validators.validateClaim(f.tx, {
      caseRecord: f.record,
      receipt: { ...f.receipt, paymentAttemptReference: f.record.caseReference },
      interacEvidence: null,
    }),
  ).toBe(false);
  f.source.terminalEvidenceDigest = newDigest;
  expect(await f.validators.validateOpen(f.tx, f.record)).toBe(false);
});
