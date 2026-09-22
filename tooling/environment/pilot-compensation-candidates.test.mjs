import { afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../packages/rms/ordering/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  createPostgresOrderCompensationCandidateReader: mock.factory,
}));
import { createInternalCompensationCandidates } from "./pilot-compensation-candidates.mjs";
afterEach(() => {
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
