import { afterEach, expect, it, vi } from "vitest";
import { createPaymentReconciliationService } from "../../packages/rms/payment/src/index.ts";
import { createInternalReconciliationRuntime } from "./pilot-reconciliation-runtime.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-22T00:02:00.000Z",
  money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  let held = false,
    sequence = 100,
    ports;
  const scope = { brandReference: id(1), storeReference: id(2) },
    run = {
      runReference: id(3),
      ...scope,
      actorReference: null,
      mode: "Operational",
      purpose: "ReconcilePayments",
      scheduledAt: at,
      cutoffAt: at,
      maxCandidates: 5,
    };
  const candidate = {
    ...scope,
    candidateReference: id(4),
    paymentIntentReference: id(4),
    paymentAttemptReference: id(5),
    orderReference: id(6),
    providerAccountReference: id(7),
    providerIntentReference: "pi_TEST_12345678",
    environment: "Test",
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    internalStatus: "Captured",
    requestedAmount: money(1130n),
    capturedAmount: money(1130n),
    refundedAmount: money(0n),
    lastObservedAt: at,
    dueAt: at,
  };
  const snapshot = {
    kind: "Snapshot",
    context: {
      provider: "Stripe",
      environment: "Test",
      ...scope,
      paymentAttemptReference: id(5),
      operationReference: id(3),
    },
    providerIntentReference: candidate.providerIntentReference,
    providerTransactionReference: "ch_TEST_12345678",
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    status: "Captured",
    requestedAmount: money(1130n),
    authorizedAmount: money(1130n),
    capturedAmount: money(1130n),
    refundedAmount: money(0n),
    observedAt: at,
    evidenceDigest: "sha256:" + "a".repeat(64),
  };
  const tx = { query: vi.fn() },
    resources = {
      scope,
      database: {},
      now: () => at,
      credentials: { reference: () => id(sequence++) },
      publicProfile: {
        binding: { ...scope, tenantReference: id(8), validUntil: "2026-09-23T00:00:00.000Z" },
      },
      transactions: { run: vi.fn((work) => work(tx)) },
    };
  const lease = {
    claim: vi.fn(async () => {
      held = true;
      return true;
    }),
    assertHeld: vi.fn(async () => {
      if (!held) throw Error("LOST");
      return true;
    }),
    release: vi.fn(async () => {
      held = false;
    }),
    dispose: vi.fn(async () => {
      held = false;
    }),
  };
  const repository = {
      loadRun: vi.fn(async () => null),
      commit: vi.fn(async (result) => ({ status: "Created", result })),
    },
    observations = {
      record: vi.fn(async (q) => ({
        status: "Recorded",
        observationReference: q.observationReference,
      })),
    },
    terminal = {
      record: vi.fn(async () => ({
        status: "Created",
        fact: { paymentTransactionReference: id(9) },
      })),
    };
  const simulator = {
    simulation: true,
    adapter: { retrieveIntent: vi.fn(async () => snapshot) },
    readTerminalOccurrence: vi.fn(async () => ({ status: "Captured", occurredAt: at })),
  };
  const f = {
    createInternalReconciliationLease: () => lease,
    createPostgresPaymentReconciliationRepository: () => repository,
    createInternalReconciliationTerminalOccurrence: () => async () => ({
      status: "Captured",
      occurredAt: at,
    }),
    createPostgresPaymentTerminalSource: () => ({}),
    createPostgresPaymentTerminalStore: () => ({}),
    createPaymentTerminalService: () => terminal,
    createPostgresPaymentProviderObservationStore: () => observations,
    createPostgresPaymentReconciliationCandidates: () => async () => [
      { paymentIntentReference: id(4), orderReference: id(6) },
    ],
    createPostgresPaymentReconciliationCandidateSource: () => async () => candidate,
    createPaymentReconciliationService: (p) => {
      ports = p;
      return createPaymentReconciliationService(p);
    },
  };
  const runtime = createInternalReconciliationRuntime(
    { resources, simulator, providerAccountReference: id(7) },
    f,
  );
  return {
    run,
    candidate,
    snapshot,
    resources,
    lease,
    repository,
    observations,
    terminal,
    simulator,
    runtime,
    ports: () => ports,
    lose: () => {
      held = false;
    },
  };
}
it("runs discovered owner candidate through Provider comparison and repository commit", async () => {
  const f = fixture(),
    result = await f.runtime.run(f.run);
  expect(result.result.counts.Matched).toBe(1);
  expect(f.repository.commit).toHaveBeenCalledTimes(1);
  expect(f.observations.record).not.toHaveBeenCalled();
  expect(f.terminal.record).not.toHaveBeenCalled();
  expect(f.lease.release).toHaveBeenCalledTimes(1);
  expect(f.lease.dispose).toHaveBeenCalledTimes(1);
});
it("heals missing internal terminal through occurrence, observation and terminal ports", async () => {
  const f = fixture();
  f.candidate.internalStatus = "Unknown";
  f.candidate.capturedAmount = money(0n);
  const result = await f.runtime.run(f.run);
  expect(result.result.counts.Healed).toBe(1);
  expect(f.observations.record).toHaveBeenCalledTimes(1);
  expect(f.terminal.record).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Captured", occurredAt: at }),
  );
});
it("replays saved runs without Provider calls", async () => {
  const f = fixture(),
    first = await f.runtime.run(f.run);
  f.repository.loadRun.mockResolvedValue(first.result);
  f.simulator.adapter.retrieveIntent.mockClear();
  expect((await f.runtime.run(f.run)).status).toBe("Duplicate");
  expect(f.simulator.adapter.retrieveIntent).not.toHaveBeenCalled();
});
it("does not commit results after losing the execution connection", async () => {
  const f = fixture();
  f.simulator.adapter.retrieveIntent.mockImplementation(async () => {
    f.lose();
    return f.snapshot;
  });
  await expect(f.runtime.run(f.run)).rejects.toThrow();
  expect(f.repository.commit).not.toHaveBeenCalled();
  expect(f.lease.dispose).toHaveBeenCalledTimes(1);
});
it.each(["store", "actor", "daily"])("rejects unsupported %s before claiming", async (kind) => {
  const f = fixture(),
    run = { ...f.run };
  if (kind === "store") run.storeReference = id(99);
  if (kind === "actor") run.actorReference = id(99);
  if (kind === "daily") run.mode = "DailySettlement";
  await expect(f.runtime.run(run)).rejects.toThrow();
  expect(f.lease.claim).not.toHaveBeenCalled();
});
it("derives stable scope/candidate/reason exception identity independent of run", async () => {
  const f = fixture();
  await f.runtime.run(f.run);
  const input = {
    brandReference: id(1),
    storeReference: id(2),
    candidateReference: id(4),
    reason: "RefundMismatch",
  };
  const first = f.ports().references.exceptionFor(input);
  expect(f.ports().references.exceptionFor(input)).toBe(first);
  expect(f.ports().references.exceptionFor({ ...input, reason: "AmountMismatch" })).not.toBe(first);
  expect(() => f.ports().references.exceptionFor({ ...input, storeReference: id(99) })).toThrow();
  await expect(f.runtime.run({ ...f.run, runReference: id(33) })).rejects.toThrow();
  expect(f.ports().references.exceptionFor(input)).toBe(first);
});

function dailyCandidate() {
  return {
    candidateReference: id(80),
    brandReference: id(1),
    storeReference: id(2),
    settlementReference: "simset_SYNTHETIC_DAILY",
    businessDate: "2026-09-20",
    internalCapturedAmount: money(0n),
    providerCapturedAmount: money(0n),
    internalRefundedAmount: money(1250n),
    providerRefundedAmount: money(1250n),
    evidenceObservedAt: at,
  };
}
it("persists prepared refund-only daily evidence and replays without Provider reads", async () => {
  const f = fixture(),
    run = { ...f.run, mode: "DailySettlement" },
    candidate = dailyCandidate();
  const first = await f.runtime.run(run, candidate);
  expect(first.result.counts.Matched).toBe(1);
  expect(f.simulator.adapter.retrieveIntent).not.toHaveBeenCalled();
  expect(f.terminal.record).not.toHaveBeenCalled();
  f.repository.loadRun.mockResolvedValue(first.result);
  f.repository.commit.mockClear();
  expect((await f.runtime.run(run, candidate)).status).toBe("Duplicate");
  expect(f.repository.commit).not.toHaveBeenCalled();
});
it("records daily differences without altering orders or Provider totals", async () => {
  const f = fixture(),
    candidate = dailyCandidate();
  candidate.providerRefundedAmount = money(1200n);
  const result = await f.runtime.run({ ...f.run, mode: "DailySettlement" }, candidate);
  expect(result.result.counts.Difference).toBe(1);
  expect(result.result.checks[0].differenceReason).toBe("RefundMismatch");
  expect(f.terminal.record).not.toHaveBeenCalled();
});
it.each(["scope", "future", "operational"])(
  "refuses inadmissible prepared daily source %s before claiming",
  async (kind) => {
    const f = fixture(),
      candidate = dailyCandidate(),
      run = { ...f.run, mode: "DailySettlement" };
    if (kind === "scope") candidate.storeReference = id(99);
    if (kind === "future") candidate.evidenceObservedAt = "2026-09-22T00:03:00.000Z";
    if (kind === "operational") run.mode = "Operational";
    await expect(f.runtime.run(run, candidate)).rejects.toThrow();
    expect(f.lease.claim).not.toHaveBeenCalled();
  },
);
