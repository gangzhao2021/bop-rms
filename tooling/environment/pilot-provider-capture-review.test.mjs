import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresProviderCaptureExceptionStore: mock.factory,
}));
import { createInternalProviderCaptureReview } from "./pilot-provider-capture-review.mjs";
const id = (n) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
});
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const tx = {},
    entries = [1, 2].map((n) => ({
      brandReference: id(1),
      storeReference: id(2),
      environment: "Test",
      providerIntentReference: "pi_demo00" + n,
      providerTransactionReference: "ch_demo00" + n,
      paymentOperationReference: id(10 + n),
      paymentAttemptReference: id(20 + n),
      amount: { amountMinor: 2260n, currencyCode: "CAD" },
      createdAt: "2026-09-20T03:35:37.211Z",
      occurredAt: "2026-09-20T03:35:37.236Z",
    })),
    r = {
      scope: { brandReference: id(1), storeReference: id(2) },
      publicProfile: {
        binding: {
          tenantReference: id(3),
          brandReference: id(1),
          storeReference: id(2),
          validUntil: "2099-01-01T00:00:00.000Z",
        },
      },
      now: () => "2026-09-22T00:00:00.000Z",
      credentials: { reference: () => id(90) },
      transactions: { run: async (work) => work(tx) },
    };
  const simulator = {
    simulation: true,
    readCaptureJournal: vi.fn(async (input) => ({
      records: entries,
      observedAt: input.observedAt,
      nextAfterProviderIntentReference: null,
    })),
  };
  return {
    tx,
    entries,
    r,
    simulator,
    create: () =>
      createInternalProviderCaptureReview({
        resources: r,
        simulator,
        providerAccountReference: id(4),
      }),
  };
}
it("verifies fresh original source inside the retained transaction and derives stable identities", async () => {
  const f = fixture(),
    calls = [];
  mock.factory.mockImplementation((options) => ({
    record: async (tx, input) => {
      expect(tx).toBe(f.tx);
      expect(await options.verifyEvidence(tx, input.evidence)).toBe(true);
      calls.push(input);
      return { status: "Created" };
    },
  }));
  const run = f.create();
  expect(await run()).toMatchObject({ scannedCount: 2, created: 2, scanComplete: true });
  f.r.now = () => "2026-09-22T00:01:00.000Z";
  await run();
  expect(calls[0].candidateReference).toBe(calls[2].candidateReference);
  expect(calls[0].exceptionReference).toBe(calls[2].exceptionReference);
  expect(calls[0].evidence.evidenceDigest).toBe(calls[2].evidence.evidenceDigest);
});
it("retains cutoff and cursor after partial failure, allowing existing records to replay", async () => {
  const f = fixture(),
    calls = [];
  let failed = false;
  mock.factory.mockImplementation(() => ({
    record: async (_tx, input) => {
      calls.push(input);
      if (calls.length === 2 && !failed) {
        failed = true;
        throw Error("unavailable");
      }
      return { status: failed ? "AlreadyRecorded" : "Created" };
    },
  }));
  const run = f.create();
  await expect(run()).rejects.toThrow();
  f.r.now = () => "2026-09-22T00:01:00.000Z";
  expect(await run()).toMatchObject({ alreadyRecorded: 2, scanComplete: true });
  expect(calls[0].candidateReference).toBe(calls[2].candidateReference);
  expect(calls[0].evidence.observedAt).toBe(calls[2].evidence.observedAt);
  expect(
    f.simulator.readCaptureJournal.mock.calls.every(
      ([v]) => v.afterProviderIntentReference === null,
    ),
  ).toBe(true);
});
it("rejects a changed original Provider record during writer verification", async () => {
  const f = fixture();
  mock.factory.mockImplementation((options) => ({
    record: async (tx, input) => {
      f.entries[0] = { ...f.entries[0], amount: { amountMinor: 999n, currencyCode: "CAD" } };
      if (!(await options.verifyEvidence(tx, input.evidence))) throw Error("source changed");
      return { status: "Created" };
    },
  }));
  await expect(f.create()()).rejects.toThrow("source changed");
});
