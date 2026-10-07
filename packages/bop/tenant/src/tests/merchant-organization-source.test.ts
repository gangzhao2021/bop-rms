import { expect, it } from "vitest";
import {
  createPostgresCurrentBrandOrganizationSource,
  createPostgresBrandAdministrationOrganizationSource,
  parseBrandReference,
  type MerchantOrganizationTransaction,
} from "../index.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
function fixture(administrative = false) {
  const row: Record<string, unknown> = {
    brand_id: id(1),
    code: "SYNTHETIC",
    display_name: "Synthetic Brand",
    default_locale: "en-CA",
    currency_code: "CAD",
    lifecycle: "Active",
    version: 1,
    created_at: at,
    updated_at: at,
    precise: true,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const state: { rows: unknown[]; hook?: (sql: string) => Promise<void> } = { rows: [row] };
  const tx: MerchantOrganizationTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      await state.hook?.(sql);
      return { rows: sql.includes("FROM bop_tenant.brand") ? state.rows : [] };
    },
  };
  const source = (
    administrative
      ? createPostgresBrandAdministrationOrganizationSource
      : createPostgresCurrentBrandOrganizationSource
  )(tx, {
    brandReference: id(1),
    observedAt: at,
  });
  return { row, state, tx, source, calls, read: () => source.getBrand(parseBrandReference(id(1))) };
}
it("locks and returns actual Brand identity in null Store scope", async () => {
  const f = fixture();
  expect(await f.read()).toMatchObject({ brandReference: id(1), lifecycle: "Active" });
  expect(f.calls[0]?.sql).toContain("set_config('bop.store_id','',true)");
  expect(f.calls[1]?.sql).toContain("FOR SHARE");
  expect(f.calls[1]?.values).toEqual([id(1)]);
  expect(Object.keys(f.source)).toEqual(["getBrand"]);
});
it.each(["Draft", "Suspended", "Archived"])(
  "preserves refusal of %s as ordinary business scope",
  async (lifecycle) => {
    const f = fixture();
    f.row.lifecycle = lifecycle;
    await expect(f.read()).rejects.toThrow("MERCHANT_ORGANIZATION_UNAVAILABLE");
  },
);
it.each([
  ["brand_id", id(9)],
  ["updated_at", "2026-09-10T10:00:00.001Z"],
  ["created_at", new Date(at)],
  ["precise", false],
] as const)("rejects unsafe %s", async (field, value) => {
  const f = fixture();
  f.row[field] = value;
  await expect(f.read()).rejects.toThrow();
});
it("rejects another requested Brand before SQL and unknown rows without inventing facts", async () => {
  const f = fixture();
  await expect(f.source.getBrand(parseBrandReference(id(2)))).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.state.rows = [];
  expect(await g.read()).toBeNull();
});
it("rejects ambiguous, sparse and accessor rows", async () => {
  for (const kind of ["duplicate", "sparse", "getter"]) {
    const f = fixture();
    let touched = false;
    if (kind === "duplicate") f.state.rows.push(f.row);
    if (kind === "sparse") f.state.rows = Array(1);
    if (kind === "getter")
      Object.defineProperty(f.row, "lifecycle", {
        enumerable: true,
        get: () => {
          touched = true;
          return "Active";
        },
      });
    await expect(f.read()).rejects.toThrow();
    expect(touched).toBe(false);
  }
});
it("refuses query replacement before touching an alternate transaction", async () => {
  const f = fixture();
  let called = false;
  f.tx.query = async () => {
    called = true;
    return { rows: [] };
  };
  await expect(f.read()).rejects.toThrow();
  expect(called).toBe(false);
});
it.each(["Draft", "Active", "Suspended", "Archived"])(
  "administrative read retains true %s lifecycle in exact Tenant/Brand/null Store scope",
  async (lifecycle) => {
    const f = fixture(true);
    f.row.lifecycle = lifecycle;
    expect(await f.read()).toMatchObject({ brandReference: id(1), lifecycle });
    expect(f.calls[0]?.sql).toContain("set_config('bop.tenant_id',$1,true)");
    expect(f.calls[0]?.sql).toContain("set_config('bop.brand_id',$1,true)");
    expect(f.calls[0]?.sql).toContain("set_config('bop.store_id','',true)");
    expect(f.calls[0]?.values).toEqual([id(1)]);
    expect(f.calls[1]?.sql).toContain("FOR SHARE");
    expect(Object.keys(f.source)).toEqual(["getBrand"]);
  },
);
it("administrative unknown remains null and foreign reference rejection poisons later reads", async () => {
  const unknown = fixture(true);
  unknown.state.rows = [];
  expect(await unknown.read()).toBeNull();
  const f = fixture(true);
  await expect(f.source.getBrand(parseBrandReference(id(2)))).rejects.toThrow();
  await expect(f.read()).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it.each(["scope", "future", "precision", "extra", "sparse", "getter"])(
  "administrative read refuses %s transport and remains poisoned",
  async (kind) => {
    const f = fixture(true);
    let touched = false;
    if (kind === "scope") f.row.brand_id = id(9);
    if (kind === "future") f.row.updated_at = "2026-09-10T10:00:00.001Z";
    if (kind === "precision") f.row.precise = false;
    if (kind === "extra") f.row.permission = "Allow";
    if (kind === "sparse") f.state.rows = Array(1);
    if (kind === "getter")
      Object.defineProperty(f.row, "lifecycle", {
        enumerable: true,
        get() {
          touched = true;
          return "Draft";
        },
      });
    await expect(f.read()).rejects.toThrow();
    const calls = f.calls.length;
    await expect(f.read()).rejects.toThrow();
    expect(f.calls).toHaveLength(calls);
    expect(touched).toBe(false);
  },
);
it("captures original query and rejects drift across an awaited return without using the replacement", async () => {
  const f = fixture(true),
    original = f.tx.query;
  let alternate = 0;
  f.state.hook = async () => {
    f.tx.query = async () => {
      alternate++;
      return { rows: [] };
    };
  };
  await expect(f.read()).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(alternate).toBe(0);
  f.tx.query = original;
  await expect(f.read()).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
it("caught administrative reentry still poisons the owning in-flight read", async () => {
  const f = fixture(true);
  f.state.hook = async () => {
    await expect(f.read()).rejects.toThrow();
  };
  await expect(f.read()).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
