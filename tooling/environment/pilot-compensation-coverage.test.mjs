import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ discover: vi.fn(), read: vi.fn() }));
vi.mock("../../packages/rms/payment/src/index.ts", () => ({
  createPostgresPaymentCompensationExceptionCandidates: () => d.discover,
  createPostgresPaymentCompensationExceptionSource: () => d.read,
}));
vi.mock("../../packages/bop/projection/src/index.ts", () => ({
  parseOrderExceptionSource: (value) => value,
}));
vi.mock("./pilot-compensation-projection.mjs", () => ({
  mapInternalCompensationSource: ({ current }) => current.mapped,
}));
import { readInternalCompensationCoverage } from "./pilot-compensation-coverage.mjs";
const source = {
  sourceReference: "case-1",
  tenantReference: "tenant",
  brandReference: "brand",
  storeReference: "store",
  kind: "PaidWithoutFulfillableOrder",
  sourceVersion: 1n,
  sourceDigest: "digest",
};
function options() {
  return {
    tx: { query: vi.fn(async () => ({ rows: [{ isolation: "repeatable read" }] })) },
    scope: { brandReference: "brand", storeReference: "store" },
    tenantReference: "tenant",
    projected: [source],
    authorize: vi.fn(async () => true),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.discover.mockResolvedValue({ items: ["case-1"], nextAfterCaseReference: null });
  d.read.mockResolvedValue({ source: {}, mapped: source });
});
it("covers exact owner snapshot including terminal projections", async () => {
  expect(await readInternalCompensationCoverage(options())).toEqual({
    complete: true,
    sourceCount: 1,
  });
});
it.each(
  [
    [],
    [{ ...source, sourceVersion: 2n }],
    [{ ...source, sourceDigest: "changed" }],
    [source, { ...source, sourceReference: "case-2" }],
  ].map((projected) => ({ projected })),
)("does not certify missing, stale or extra records", async ({ projected }) => {
  expect((await readInternalCompensationCoverage({ ...options(), projected })).complete).toBe(
    false,
  );
});
it("denies insufficient isolation and authorization", async () => {
  const o = options();
  o.tx.query.mockResolvedValue({ rows: [{ isolation: "read committed" }] });
  await expect(readInternalCompensationCoverage(o)).rejects.toThrow();
  const p = options();
  p.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(readInternalCompensationCoverage(p)).rejects.toThrow();
});
it("rejects duplicate, wrong scope, missing owner and invalid pagination", async () => {
  await expect(
    readInternalCompensationCoverage({ ...options(), projected: [source, source] }),
  ).rejects.toThrow();
  await expect(
    readInternalCompensationCoverage({
      ...options(),
      projected: [{ ...source, storeReference: "other" }],
    }),
  ).rejects.toThrow();
  d.read.mockResolvedValueOnce(null);
  await expect(readInternalCompensationCoverage(options())).rejects.toThrow();
  d.discover.mockResolvedValue({ items: ["case-1"], nextAfterCaseReference: "case-1" });
  await expect(readInternalCompensationCoverage(options())).rejects.toThrow();
});
it("certifies actual empty source only when the projection is empty too", async () => {
  d.discover.mockResolvedValue({ items: [], nextAfterCaseReference: null });
  expect(await readInternalCompensationCoverage({ ...options(), projected: [] })).toEqual({
    complete: true,
    sourceCount: 0,
  });
  expect((await readInternalCompensationCoverage(options())).complete).toBe(false);
});
