import { afterEach, expect, it, test, vi } from "vitest";
import { createPaymentCompensationWorkload } from "../../apps/worker/src/payment-compensation-workload.ts";
const mock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../packages/rms/ordering/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  createPostgresOrderCompensationCandidateReader: mock.factory,
}));
import {
  createInternalCompensationCandidates,
  discoverWithoutCardMachinePayments,
} from "./pilot-compensation-candidates.mjs";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const scope = {
    brandReference: "0190fa01-0000-7000-8000-000000000001",
    storeReference: "0190fa01-0000-7000-8000-000000000002",
  };
  const tx = {},
    page = { candidates: [], nextAfterDispositionReference: null },
    read = vi.fn(async () => page);
  mock.factory.mockReturnValue(read);
  const resources = {
    scope,
    publicProfile: { binding: { ...scope, validUntil: "2026-09-22T00:00:00.000Z" } },
    now: vi.fn(() => "2026-09-21T00:00:00.000Z"),
    transactions: { run: vi.fn((work) => work(tx)) },
  };
  return { resources, read, page, tx };
}
test("passes exact paging and retained transaction to owner reader", async () => {
  const f = fixture(),
    source = createInternalCompensationCandidates(f.resources),
    input = { afterDispositionReference: null, limit: 10 };
  expect(await source.discover(input)).toBe(f.page);
  expect(f.read).toHaveBeenCalledWith(f.tx, input);
  const options = mock.factory.mock.calls[0][0],
    query = { ...f.resources.scope, purpose: "DiscoverPaidWithoutFulfillableOrder" };
  expect(await options.authorize(f.tx, query)).toBe(true);
  expect(await options.authorize(f.tx, { ...query, storeReference: query.brandReference })).toBe(
    false,
  );
  expect(await options.authorize(f.tx, { ...query, purpose: "Other" })).toBe(false);
  f.resources.now.mockReturnValue("2026-09-22T00:00:00.000Z");
  expect(await options.authorize(f.tx, query)).toBe(false);
  await expect(source.discover(input)).rejects.toThrow(
    "INTERNAL_COMPENSATION_DISCOVERY_UNAVAILABLE",
  );
  expect(f.resources.transactions.run).toHaveBeenCalledTimes(1);
  expect(options.includeStaffCancellations).toBe(false);
});
test("includes staff cancellations only when the refund workload asks for them", () => {
  const f = fixture();
  createInternalCompensationCandidates(f.resources, { includeStaffCancellations: true });
  expect(mock.factory.mock.calls[0][0].includeStaffCancellations).toBe(true);
});
test("rejects production and mismatched binding before owner construction", () => {
  const f = fixture();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalCompensationCandidates(f.resources)).toThrow();
  vi.stubEnv("NODE_ENV", "development");
  f.resources.publicProfile.binding.storeReference = f.resources.scope.brandReference;
  expect(() => createInternalCompensationCandidates(f.resources)).toThrow();
  expect(mock.factory).not.toHaveBeenCalled();
});
test("rejects environment changes before entering a transaction", async () => {
  const f = fixture(),
    source = createInternalCompensationCandidates(f.resources);
  vi.stubEnv("NODE_ENV", "production");
  await expect(source.discover({ afterDispositionReference: null, limit: 10 })).rejects.toThrow();
  expect(f.resources.transactions.run).not.toHaveBeenCalled();
});

// Owner discovery rows in reference order; "h" was paid on the Store's card machine (WP-2423 Q7).
const references = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(
  (letter) => `0190fa00-0000-7000-8000-00000000000${letter}`,
);
const card = new Set([references[7]]);
const owner = async ({ afterDispositionReference, limit }) => {
  const rows = references
    .filter(
      (reference) => afterDispositionReference === null || reference > afterDispositionReference,
    )
    .slice(0, limit)
    .map((dispositionReference) => ({ dispositionReference }));
  return {
    candidates: rows,
    nextAfterDispositionReference: rows.length === limit ? rows.at(-1).dispositionReference : null,
  };
};
const filtered = (input) =>
  discoverWithoutCardMachinePayments(input, {
    read: owner,
    isCardMachinePayment: async (candidate) => card.has(candidate.dispositionReference),
  });
/** The single-page filter the v15 worker ran on 2026-10-15: a short page with a cursor. */
const singlePage = async (input) => {
  const page = await owner(input);
  return {
    ...page,
    candidates: page.candidates.filter((c) => !card.has(c.dispositionReference)),
  };
};
async function runRounds(discover, cycles) {
  vi.useFakeTimers();
  const executed = [];
  const workload = createPaymentCompensationWorkload({
    discover,
    execute: async (candidate) => {
      executed.push(candidate.dispositionReference);
      return "Open";
    },
    recordFailure: async () => undefined,
    pageSize: 5,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start().catch(() => undefined);
  for (let n = 1; n < cycles; n++) await vi.advanceTimersByTimeAsync(10);
  const snapshot = workload.snapshot();
  await workload.stop().catch(() => undefined);
  return { executed, snapshot };
}

it("fills each page past card-machine payments so the cursor follows a full page", async () => {
  const first = await filtered({ afterDispositionReference: null, limit: 5 });
  expect(first.candidates.map((c) => c.dispositionReference)).toEqual(references.slice(0, 5));
  expect(first.nextAfterDispositionReference).toBe(references[4]);
  const second = await filtered({ afterDispositionReference: references[4], limit: 5 });
  expect(second.candidates.map((c) => c.dispositionReference)).toEqual([
    references[5],
    references[6],
    references[8],
    references[9],
  ]);
  expect(second.nextAfterDispositionReference).toBeNull();
  const tail = await filtered({ afterDispositionReference: references[8], limit: 1 });
  expect(tail.candidates.map((c) => c.dispositionReference)).toEqual([references[9]]);
  // A full page keeps a cursor; the next read ends the round.
  expect(tail.nextAfterDispositionReference).toBe(references[9]);
  const excludedTail = await filtered({ afterDispositionReference: references[6], limit: 1 });
  expect(excludedTail.candidates.map((c) => c.dispositionReference)).toEqual([references[8]]);
});

it("keeps the refund workload running when a card-machine payment is inside a page", async () => {
  // Regression: the single-page filter failed the workload (and so the business worker).
  const broken = await runRounds(singlePage, 2);
  expect(broken.snapshot.state).toBe("failed");
  expect(broken.snapshot.lastCycleFailure).toMatchObject({
    code: "COMPENSATION_DISCOVERY_INVALID",
    sqlState: null,
  });
  const fixed = await runRounds(filtered, 4);
  expect(fixed.snapshot.lastCycleFailure).toBeNull();
  expect(fixed.snapshot.state).toBe("running");
  expect(fixed.executed.slice(0, 9)).toEqual(references.filter((r) => !card.has(r)));
});

it("refuses an owner cursor that does not advance", async () => {
  await expect(
    discoverWithoutCardMachinePayments(
      { afterDispositionReference: references[2], limit: 2 },
      {
        read: async () => ({
          candidates: [{ dispositionReference: references[1] }],
          nextAfterDispositionReference: references[1],
        }),
        isCardMachinePayment: async () => true,
      },
    ),
  ).rejects.toThrow("INTERNAL_COMPENSATION_DISCOVERY_UNAVAILABLE");
});
