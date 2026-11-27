import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentCompensationCase,
  parsePaymentCompensationActionReceipt,
} from "../application/paid-without-fulfillable-order.js";
const d = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-terminal-store.js", () => ({
  createPostgresPaymentTerminalStore: () => ({ read: d.read }),
}));
import { createPostgresPaymentCompensationActionOutcomeEvidence } from "../infrastructure/persistence/payment-compensation-provider-evidence.js";
const id = (n: number) => "0190fa79-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-21T00:00:00.000Z";
function fixture() {
  const current = parsePaymentCompensationCase({
    caseReference: id(12),
    operationReference: id(13),
    dispositionReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    reason: "PaidWithoutFulfillableOrder",
    dispositionDigest: digest,
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    severity: "Critical",
    state: "Open",
    refundDisposition: "RefundPending",
    operationsDisposition: "Pending",
    refundReference: null,
    refundCompositionDigest: null,
    refundEvidenceDigest: null,
    refundConfirmedAt: null,
    operationsReceiptReference: null,
    operationsReceiptDigest: null,
    operationsRefundEvidenceDigest: null,
    operationsReconciledAt: null,
    openedAt: at,
    updatedAt: at,
    closedAt: null,
    version: 2,
  });
  const receipt = parsePaymentCompensationActionReceipt({
    actionReference: id(20),
    compensationCaseReference: current.caseReference,
    brandReference: current.brandReference,
    storeReference: current.storeReference,
    paymentTransactionReference: current.paymentTransactionReference,
    paymentAttemptReference: current.paymentAttemptReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 1000n, currencyCode: "CAD" },
    interacEvidenceReference: null,
    interacEvidenceDigest: null,
    dispositionDigest: digest,
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    providerObservationDigest: digest,
    actionDigest: digest,
    providerIdempotencyKey: "compensation-refund:" + id(20),
    claimedAt: at,
    claimDisposition: "Claimed",
    phase: "Claimed",
  });
  const terminal = {
    ...current,
    outcome: "Succeeded",
    providerAccountReference: id(30),
    providerIntentReference: "pi_DEMOoutcome",
    evidenceDigest: digest,
    occurredAt: at,
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
  };
  d.read.mockResolvedValue(terminal);
  const query = vi.fn(async () => ({ rows: [{ matched: true }], rowCount: 1 })),
    tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  const verify = createPostgresPaymentCompensationActionOutcomeEvidence({
    scope: {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(30),
      environment: "Test",
    },
    now: () => "2026-09-21T02:00:00.000Z",
    authorize,
  });
  const input = {
    receipt,
    caseRecord: current,
    nextPhase: "ProviderConfirmed" as const,
    observedAt: "2026-09-21T01:00:00.000Z",
  };
  return { verify, input, query, tx, authorize, terminal };
}
beforeEach(() => vi.resetAllMocks());
it.each(["ProviderPending", "ProviderConfirmed"] as const)(
  "requires committed %s observation at exact time and captured balance",
  async (nextPhase) => {
    const f = fixture();
    expect(await f.verify(f.tx, { ...f.input, nextPhase })).toBe(true);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("o.refunded_minor>$7-$8"), [
      id(2),
      id(3),
      id(8),
      id(9),
      "pi_DEMOoutcome",
      f.input.observedAt,
      "1130",
      "1000",
      nextPhase,
    ]);
    f.query.mockResolvedValueOnce({ rows: [{ matched: false }], rowCount: 1 });
    expect(await f.verify(f.tx, { ...f.input, nextPhase })).toBe(false);
  },
);
it("retains unknown invocation without asserting provider confirmation", async () => {
  const f = fixture();
  expect(await f.verify(f.tx, { ...f.input, nextPhase: "InvocationUnknown" })).toBe(true);
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects future and preclaim timestamps before source read", async () => {
  const f = fixture();
  for (const observedAt of ["2026-09-21T03:00:00.000Z", "2026-09-20T23:00:00.000Z"])
    expect(await f.verify(f.tx, { ...f.input, observedAt })).toBe(false);
  expect(d.read).not.toHaveBeenCalled();
});
it("rejects different terminal identity and oversized claim", async () => {
  const f = fixture();
  d.read.mockResolvedValueOnce({ ...f.terminal, paymentAttemptReference: id(99) });
  expect(await f.verify(f.tx, f.input)).toBe(false);
  expect(
    await f.verify(f.tx, {
      ...f.input,
      receipt: { ...f.input.receipt, amount: { ...f.input.receipt.amount, amountMinor: 1131n } },
    }),
  ).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects mismatched action case and authority revoked after reads", async () => {
  const f = fixture();
  expect(
    await f.verify(f.tx, {
      ...f.input,
      receipt: { ...f.input.receipt, compensationCaseReference: f.input.receipt.actionReference },
    }),
  ).toBe(false);
  expect(d.read).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.verify(f.tx, f.input)).toBe(false);
});
