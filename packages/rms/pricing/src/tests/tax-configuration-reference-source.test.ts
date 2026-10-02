import { expect, it, vi } from "vitest";
import {
  buildTaxConfigurationReferenceSourceSnapshot as build,
  parseTaxConfigurationReferenceSourceSnapshot as parse,
  createPostgresTaxConfigurationReferenceSourceStore,
  taxConfigurationReferenceSourceFields,
  type TaxConfigurationReferenceSourceAuthority,
} from "../index.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  past = "2026-08-01T00:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
  storeReference: id(9),
};
const unavailable = { code: "TAX_CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE" };
const rule = (o: Record<string, unknown> = {}) => ({
  ruleReference: id(10),
  taxClassificationReference: id(11),
  orderType: "Pickup",
  chargeType: "Sellable",
  taxComponentCode: "HST",
  ...o,
});
function row(ro: Record<string, unknown> = {}, vo: Record<string, unknown> = {}) {
  return {
    root: {
      configurationReference: id(4),
      brandReference: id(1),
      storeReference: id(9),
      aggregateVersion: 2,
      currentVersionReference: id(7),
      rootCreatedAt: past,
      updatedAt: past,
      ...ro,
    },
    version: {
      versionReference: id(7),
      versionNumber: 2,
      snapshotDigest: "sha256:" + "b".repeat(64),
      lifecycle: "Published",
      timeZone: "America/Toronto",
      effectiveFrom: past,
      effectiveUntil: null,
      createdAt: past,
      rules: [rule()],
      ...vo,
    },
    precise: true,
  };
}
const source = (references: unknown[] = [row()], observedAt = at) => ({ references, observedAt });
function adapter(
  options: { deniedAt?: number; isolation?: string; payload?: unknown; clock?: () => string } = {},
) {
  const hold = vi.fn<TaxConfigurationReferenceSourceAuthority["holdUntilTransactionCompletes"]>(
    async () => {
      if (hold.mock.calls.length === options.deniedAt) throw new Error("denied");
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return sql.includes("transaction_isolation")
      ? { rows: [{ isolation: options.isolation ?? "read committed" }] }
      : sql.includes("set_config")
        ? { rows: [] }
        : { rows: [{ source: options.payload ?? source() }] };
  });
  const run = vi.fn(async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
    work({ query }),
  );
  const store = createPostgresTaxConfigurationReferenceSourceStore({
    tenantReference: id(8),
    brandReference: id(1),
    actorReference: id(2),
    storeReference: id(9),
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: options.clock ?? (() => at) },
    transactions: {
      async run<T>(work: (tx: { query: typeof query }) => Promise<T>) {
        return (await run(work)) as T;
      },
    },
  });
  return { store, hold, query, run };
}

it("preserves scoped rules, history and empty/unversioned states without legal/rate claims", () => {
  const r = build(
    source([
      row(),
      row(
        {},
        {
          versionReference: id(12),
          versionNumber: 1,
          lifecycle: "Draft",
          effectiveUntil: at,
          rules: [],
        },
      ),
      { ...row({ configurationReference: id(5), currentVersionReference: null }), version: null },
    ]),
    request,
    at,
  );
  expect(r).toMatchObject({
    profile: "TaxConfigurationRules",
    scopeCoverage: "SelectedStoreOnly",
    crossStoreCoverage: "Unavailable",
    coverage: "Complete",
  });
  expect(r.roots).toHaveLength(2);
  expect(r.versions).toHaveLength(2);
  expect(r.versions.find((v) => v.versionNumber === 1)).toMatchObject({
    rules: [],
    temporalStatus: "Expired",
    isCurrentVersion: false,
  });
  expect(r.versions.find((v) => v.versionNumber === 2)?.rules).toEqual([rule()]);
  expect(JSON.stringify(r)).not.toMatch(
    /registration|professional|currency|taxRate|rate|receipt|actorReferencePrivate/,
  );
  expect(parse(r, request, at)).toEqual(r);
});
it("retains future rule qualifications and requires explicit actual Store even for an empty profile", () => {
  expect(
    build(source([row({}, { effectiveFrom: "2026-10-01T00:00:00.000Z" })]), request, at).versions[0]
      ?.temporalStatus,
  ).toBe("Future");
  expect(build(source([]), request, at)).toMatchObject({
    roots: [],
    versions: [],
    scopeCoverage: "SelectedStoreOnly",
    crossStoreCoverage: "Unavailable",
  });
  const { storeReference, ...brandOnly } = request;
  void storeReference;
  expect(() => build(source([]), brandOnly as typeof request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it.each([
  { brandReference: id(99) },
  { storeReference: id(99) },
  { aggregateVersion: 0 },
  { aggregateVersion: "2" },
  { currentVersionReference: id(99) },
  { updatedAt: "2026-09-29T12:00:01.000Z" },
])("rejects root scope/precision/pointer %s", (ro) => {
  expect(() => build(source([row(ro)]), request, at)).toThrow(expect.objectContaining(unavailable));
});
it.each([
  { versionNumber: 3 },
  { versionNumber: 1.5 },
  { timeZone: "UTC" },
  { lifecycle: "Archived" },
  { effectiveUntil: past },
  { snapshotDigest: "invalid" },
  { rules: [rule(), rule()] },
  { rules: [rule({ taxComponentCode: "hst" })] },
  { rules: [rule({ orderType: "Delivery" })] },
  { rules: [rule({ chargeType: "Other" })] },
])("rejects malformed versions/rules %s", (vo) => {
  expect(() => build(source([row({}, vo)]), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects incomplete pointer/duplicate history/stale/oversized/accessor payloads", () => {
  const get = vi.fn(() => []),
    r = row();
  Object.defineProperty(r.version, "rules", { enumerable: true, get });
  for (const raw of [
    source([r]),
    source([row(), row()]),
    source([{ ...row(), precise: false }]),
    source(new Array(1)),
    source(Array.from({ length: 1001 }, () => row())),
    source([row()], "2026-09-29T11:59:54.000Z"),
  ])
    expect(() => build(raw, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
  const valid = build(source(), request, at);
  for (const changed of [
    { crossStoreCoverage: "Complete" },
    { scopeCoverage: "Brand" },
    { digest: "sha256:" + "f".repeat(64) },
    { request: { ...request, storeReference: id(99) } },
  ])
    expect(() => parse({ ...valid, ...changed }, request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
});
it("holds actual Store/action/fields before and after exact owned three-table read", async () => {
  const a = adapter();
  await a.store.loadSnapshot(request);
  expect(a.hold).toHaveBeenCalledTimes(2);
  expect(a.hold.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(8),
    request,
    permission: "pricing.tax-config.manage",
    requiredFields: taxConfigurationReferenceSourceFields,
    observedAt: at,
  });
  expect(a.query.mock.calls[1]?.[1]).toEqual([id(1), id(9)]);
  expect(a.query.mock.calls[2]?.[1]).toEqual([id(1), id(9)]);
  const sql = a.query.mock.calls[2]?.[0];
  expect(sql).toContain("LIMIT 1001");
  expect(sql).toContain("r.store_id=$2");
  expect(sql).not.toMatch(/rms_catalog|tax_rate|professional|registration|receipt_presentation/);
});
it("fails closed for wrong Store/caller, early/late authority, stale result and wrong isolation", async () => {
  const a = adapter();
  await expect(a.store.loadSnapshot({ ...request, storeReference: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(a.run).not.toHaveBeenCalled();
  const b = adapter({ deniedAt: 1 });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  expect(b.query).not.toHaveBeenCalled();
  await expect(adapter({ deniedAt: 2 }).store.loadSnapshot(request)).rejects.toMatchObject(
    unavailable,
  );
  await expect(
    adapter({ isolation: "repeatable read" }).store.loadSnapshot(request),
  ).rejects.toMatchObject(unavailable);
});

it("rejects transaction bypass, substituted results, repeated callbacks and private SQL failures", async () => {
  const a = adapter();
  a.run.mockImplementationOnce(async () => undefined as never);
  await expect(a.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const b = adapter();
  b.run.mockImplementationOnce(async (work) => {
    await work({ query: b.query });
    return {} as never;
  });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const c = adapter();
  c.run.mockImplementationOnce(async (work) => {
    await work({ query: c.query });
    return work({ query: c.query });
  });
  await expect(c.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const d = adapter();
  d.query.mockImplementationOnce(async () => {
    throw new Error("synthetic private SQL details");
  });
  await expect(d.store.loadSnapshot(request)).rejects.toMatchObject({
    code: unavailable.code,
    message: "tax configuration references are unavailable",
  });
});
it("rejects stale transaction completion and fixed Actor/Brand mismatch", async () => {
  let reads = 0;
  await expect(
    adapter({ clock: () => (reads++ < 3 ? at : "2026-09-29T12:00:06.000Z") }).store.loadSnapshot(
      request,
    ),
  ).rejects.toMatchObject(unavailable);
  for (const change of [{ actorReference: id(99) }, { brandReference: id(99) }]) {
    const a = adapter();
    await expect(a.store.loadSnapshot({ ...request, ...change })).rejects.toMatchObject(
      unavailable,
    );
    expect(a.run).not.toHaveBeenCalled();
  }
});
