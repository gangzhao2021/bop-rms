import { createBrand, parseBrandAdministrationContext } from "@bop/tenant";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import {
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceScope,
} from "../contracts/brand-catalog-source.js";
import {
  createPostgresBrandCatalogSourceStore,
  createPostgresBrandAdministrationCatalogSourceStore,
  type BrandAdministrationCatalogSourceStoreOptions,
  type BrandCatalogSourceStoreOptions,
} from "../infrastructure/persistence/brand-catalog-source-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";

// Controlled borrowed SQL/Audit/authority ports prove adapter behavior only; native
// production Audit, RLS, transaction coherence and concurrency need physical evidence.
const id = (n: number) => "01902500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-06T12:00:00.000Z";
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const scope = parseBrandCatalogSourceScope({
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
});
const command = () => ({
  profile: "BrandCatalogSourceRegisterV1",
  ...scope,
  operationReference: id(4),
  code: "CATALOGUE",
  label: "Synthetic Catalogue",
});
const resolve = () => ({
  profile: "BrandCatalogSourceResolveV1",
  ...scope,
  operationReference: id(4),
  intentDigest: brandCatalogSourceIntentDigest(command()),
});
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
interface Memory {
  source: Record<string, unknown> | null;
  operations: Map<string, Record<string, unknown>>;
}
function fixture(memory: Memory = { source: null, operations: new Map() }, currentScope = scope) {
  let now = at,
    seq = 10;
  let guard: () => Promise<void> = async () => {
    throw new Error("guard not registered");
  };
  let final: () => void = () => {
    throw new Error("final not registered");
  };
  const log: string[] = [],
    audits: unknown[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      log.push(sql);
      let rows: unknown[] = [],
        rowCount = 0;
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.includes("SELECT rms_catalog.brand_catalog_source_operation_admit")) {
        const receipt = memory.operations.get(String(values[0]))?.receipt_json as
          Record<string, unknown> | undefined;
        if (
          receipt &&
          (receipt.tenantReference !== currentScope.tenantReference ||
            receipt.brandReference !== currentScope.brandReference ||
            receipt.actorReference !== values[1])
        )
          throw Object.assign(new Error("hidden operation conflict"), { code: "P0001" });
      } else if (sql.startsWith("SELECT receipt_json")) {
        const row = memory.operations.get(String(values[2]));
        if (row) rows = [row];
      } else if (sql.startsWith("SELECT identity_json"))
        rows = memory.source ? [memory.source] : [];
      else if (sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source(")) {
        const identity = JSON.parse(String(values[9])) as Record<string, unknown>;
        memory.source = { identity_json: identity, identity_digest: values[10], precise: true };
        rowCount = 1;
      } else if (sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source_operation(")) {
        const receipt = JSON.parse(String(values[8])) as Record<string, unknown>;
        memory.operations.set(String(values[0]), {
          receipt_json: receipt,
          receipt_digest: values[9],
          precise: true,
        });
        rowCount = 1;
      }
      return { rows: rows as Row[], rowCount };
    },
  };
  const nextReference = vi.fn(() => id(seq++));
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        actual: ProductLifecycleTransaction,
        input: Parameters<
          BrandCatalogSourceStoreOptions["authority"]["holdUntilTransactionCompletes"]
        >[1],
      ) => {
        expect(actual).toBe(tx);
        expect(input.permission).toBe("catalog.manage");
        expect(input.purposeCode).toBe("BRAND_CATALOG_SOURCE");
        log.push("actual controlled parent authority");
        return { validUntil: input.validUntil };
      },
    ),
  };
  const appendAudit = vi.fn(
    async (
      actual: ProductLifecycleTransaction,
      input: Parameters<BrandCatalogSourceStoreOptions["appendAudit"]>[1],
    ) => {
      expect(actual).toBe(tx);
      audits.push(input);
    },
  );
  const options = {
    ...currentScope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: at,
    originalValidUntil: plus(5000),
    authority,
    nextReference,
    appendAudit,
    registerBeforeCommit: (actual, g, f) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  } satisfies BrandCatalogSourceStoreOptions;
  const store = createPostgresBrandCatalogSourceStore(options);
  return {
    store,
    options,
    memory,
    log,
    nextReference,
    appendAudit,
    authority,
    audits,
    setNow: (value: string) => {
      now = value;
    },
    guard: () => guard(),
    final: () => final(),
    finish: async () => {
      await guard();
      final();
      store.assertFinalized();
    },
  };
}
const refused = (run: () => Promise<unknown>, code = "CATALOG_DEPENDENCY_UNAVAILABLE") =>
  expect(run()).rejects.toThrowError(expect.objectContaining({ code }));

it("holds real parent first, global original next, singleton last and writes exact original/Audit/source", async () => {
  const f = fixture(),
    result = await f.store.register(command());
  expect(result.outcome).toBe("Committed");
  expect(result.originalCommand).toEqual(command());
  expect(result.source?.code).toBe("CATALOGUE");
  expect(f.audits).toEqual([
    expect.objectContaining({
      ...scope,
      operationReference: id(4),
      intentDigest: resolve().intentDigest,
      sourceReference: result.source?.sourceReference,
      auditReference: result.auditReference,
      occurredAt: at,
      mode: "Register",
    }),
  ]);
  const parent = f.log.indexOf("actual controlled parent authority"),
    global = f.log.findIndex((sql) =>
      sql.includes("SELECT rms_catalog.brand_catalog_source_operation_admit"),
    ),
    singleton = f.log.findIndex((sql) => sql.includes("pg_advisory_xact_lock("));
  expect(parent).toBeLessThan(global);
  expect(global).toBeLessThan(singleton);
  expect(f.nextReference).toHaveBeenCalledTimes(2);
  await f.finish();
  expect(f.log).toContain(
    "SET CONSTRAINTS rms_catalog.brand_catalog_source_coherence,rms_catalog.brand_catalog_source_operation_coherence IMMEDIATE",
  );
});

it("replays Committed Register and Resolve without IDs or Audit, retaining historical original", async () => {
  const first = fixture(),
    result = await first.store.register(command());
  await first.finish();
  const register = fixture(first.memory);
  expect(await register.store.register(command())).toEqual(result);
  expect(register.nextReference).not.toHaveBeenCalled();
  expect(register.appendAudit).not.toHaveBeenCalled();
  await register.finish();
  const resolved = fixture(first.memory);
  expect(await resolved.store.resolve(resolve())).toEqual(result);
  expect(resolved.nextReference).not.toHaveBeenCalled();
  expect(resolved.appendAudit).not.toHaveBeenCalled();
  await resolved.finish();
});

it("writes true-absence Abandoned without a source/body, repeats it and blocks a late writer", async () => {
  const first = fixture(),
    result = await first.store.resolve(resolve());
  expect(result.outcome).toBe("Abandoned");
  expect(result.source).toBeNull();
  expect(result.originalCommand).toBeNull();
  expect(first.memory.source).toBeNull();
  expect(first.nextReference).toHaveBeenCalledExactlyOnceWith("Audit");
  expect(first.audits).toEqual([
    expect.objectContaining({ mode: "Abandon", sourceReference: null }),
  ]);
  await first.finish();
  const repeated = fixture(first.memory);
  expect(await repeated.store.resolve(resolve())).toEqual(result);
  expect(repeated.appendAudit).not.toHaveBeenCalled();
  expect(repeated.nextReference).not.toHaveBeenCalled();
  await repeated.finish();
  const late = fixture(first.memory);
  await refused(() => late.store.register(command()), "CATALOG_IDEMPOTENCY_CONFLICT");
  expect(late.nextReference).not.toHaveBeenCalled();
});

it("arbitrates changed intent and hidden scope before allocation and rejects an existing singleton", async () => {
  const first = fixture();
  await first.store.register(command());
  await first.finish();
  const changed = fixture(first.memory);
  await refused(
    () => changed.store.register({ ...command(), label: "Other" }),
    "CATALOG_IDEMPOTENCY_CONFLICT",
  );
  expect(changed.nextReference).not.toHaveBeenCalled();
  const singleton = fixture(first.memory);
  await refused(
    () => singleton.store.register({ ...command(), operationReference: id(8) }),
    "CATALOG_CODE_CONFLICT",
  );
  expect(singleton.nextReference).not.toHaveBeenCalled();
  const receipt = first.memory.operations.get(id(4))?.receipt_json as Record<string, unknown>;
  const hidden = { ...receipt, tenantReference: id(9) };
  const other = fixture({
    source: null,
    operations: new Map([
      [id(4), { receipt_json: hidden, receipt_digest: hash(hidden), precise: true }],
    ]),
  });
  await refused(() => other.store.register(command()), "CATALOG_IDEMPOTENCY_CONFLICT");
  expect(other.nextReference).not.toHaveBeenCalled();
});

it("reads actual identity with independent Reader and exact absence, preserving NotEvaluated", async () => {
  const first = fixture(),
    result = await first.store.register(command());
  await first.finish();
  const f = fixture(
    first.memory,
    parseBrandCatalogSourceScope({ ...scope, actorReference: id(7) }),
  );
  const current = await f.store.current();
  expect(current.source).toEqual(result.source);
  expect(current.actorReference).toBe(id(7));
  expect(current.source?.registeredByReference).toBe(id(3));
  expect(current.publicationStatus).toBe("NotEvaluated");
  expect(current.referenceEligibility).toBe("NotEvaluated");
  expect((await f.store.exact(id(8))).source).toBeNull();
  expect((await f.store.exact(result.source?.sourceReference ?? "")).source).toEqual(result.source);
  await f.finish();
  const empty = fixture();
  expect((await empty.store.current()).source).toBeNull();
  await empty.finish();
});

it("rejects malformed source/original private integrity, missing reciprocals and imprecise timestamps", async () => {
  const first = fixture();
  await first.store.register(command());
  await first.finish();
  for (const patch of [
    { identity_digest: "sha256:" + "0".repeat(64) },
    { precise: false },
    { unexpected: true },
  ]) {
    const f = fixture({
      source: { ...first.memory.source, ...patch },
      operations: first.memory.operations,
    });
    await refused(() => f.store.current());
  }
  const missing = fixture({ source: first.memory.source, operations: new Map() });
  await refused(() => missing.store.current());
  const stored = first.memory.operations.get(id(4));
  for (const patch of [
    { receipt_digest: "sha256:" + "0".repeat(64) },
    { precise: false },
    { unexpected: true },
  ]) {
    const f = fixture({
      source: first.memory.source,
      operations: new Map([[id(4), { ...stored, ...patch }]]),
    });
    await refused(() => f.store.current());
  }
  const getter = vi.fn(() => first.memory.source?.identity_json);
  const unsafe = Object.defineProperty({ ...first.memory.source }, "identity_json", {
    get: getter,
    enumerable: true,
  });
  const descriptors = fixture({ source: unsafe, operations: first.memory.operations });
  await refused(() => descriptors.store.current());
  expect(getter).not.toHaveBeenCalled();
});

it("rechecks shortest authority lease and actual ports, rejects early finals and keeps postCOMMIT pure", async () => {
  const expired = fixture();
  await expired.store.current();
  expired.setNow(plus(5000));
  await refused(() => expired.guard());
  const replaced = fixture();
  await replaced.store.current();
  replaced.options.clock = { now: () => at };
  await refused(() => replaced.guard());
  const early = fixture();
  await early.store.current();
  expect(() => early.final()).toThrow(CatalogError);
  const pure = fixture();
  await pure.store.current();
  await pure.guard();
  pure.final();
  const count = pure.log.length,
    authorityCount = pure.authority.holdUntilTransactionCompletes.mock.calls.length;
  pure.setNow(plus(60_000));
  pure.store.assertFinalized();
  expect(pure.log).toHaveLength(count);
  expect(pure.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(authorityCount);
  expect(pure.nextReference).not.toHaveBeenCalled();
  const short = fixture();
  short.authority.holdUntilTransactionCompletes.mockImplementation(async () => ({
    validUntil: plus(10),
  }));
  expect((await short.store.current()).validUntil).toBe(plus(10));
  short.setNow(plus(10));
  await refused(() => short.guard());
  const lateChange = fixture();
  await lateChange.store.current();
  lateChange.memory.source = {
    identity_json: {},
    identity_digest: "sha256:" + "0".repeat(64),
    precise: true,
  };
  await refused(() => lateChange.guard());
});

it("preserves actual authority refusal and requires a void trusted Audit completion before inserts", async () => {
  const denied = fixture();
  denied.authority.holdUntilTransactionCompletes.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await refused(() => denied.store.register(command()), "CATALOG_PERMISSION_DENIED");
  expect(denied.nextReference).not.toHaveBeenCalled();
  const audit = fixture();
  audit.appendAudit.mockRejectedValue(new Error("audit unavailable"));
  await refused(() => audit.store.register(command()));
  expect(audit.memory.source).toBeNull();
  expect(audit.memory.operations.size).toBe(0);
  const nonVoid = fixture();
  const wrongAudit = createPostgresBrandCatalogSourceStore({
    ...nonVoid.options,
    appendAudit: (async () => true) as unknown as typeof nonVoid.options.appendAudit,
  });
  await refused(() => wrongAudit.register(command()));
  expect(nonVoid.memory.source).toBeNull();
});

function administrativeFixture(
  memory: Memory = { source: null, operations: new Map() },
  lifecycle = "Draft",
) {
  const administrativeScope = parseBrandCatalogSourceScope({
    ...scope,
    tenantReference: scope.brandReference,
  });
  const f = fixture(memory, administrativeScope);
  const state = {
    lifecycle,
    actorReference: scope.actorReference,
    allowed: true,
    now: at,
    until: plus(5000),
  };
  const authority: BrandAdministrationCatalogSourceStoreOptions["authority"] = {
    async holdUntilTransactionCompletes(actual, input) {
      expect(actual).toBe(f.options.transaction);
      expect(input.permission).toBe("organization.manage");
      expect(input.purposeCode).toBe("BRAND_ADMINISTRATION");
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const brand = createBrand({
        brandReference: scope.brandReference,
        code: "SYNTHETIC",
        displayName: "Synthetic Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: state.lifecycle,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      // Actual public Tenant parser owns nested Identity validation. These are
      // controlled IAM facts, not a successful native Session authentication.
      const administrationContext = parseBrandAdministrationContext({
        profile: "BrandAdministrationContextV1",
        actor: {
          actorType: "User",
          actorReference: state.actorReference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt: at,
          recentMfaAt: at,
        },
        brand,
        store: null,
        purposeCode: "BRAND_ADMINISTRATION",
        resolvedAt: state.now,
      });
      return { administrationContext, validUntil: state.until };
    },
  };
  const options: BrandAdministrationCatalogSourceStoreOptions = { ...f.options, authority };
  const store = createPostgresBrandAdministrationCatalogSourceStore(options);
  const original = { ...command(), ...administrativeScope };
  return {
    ...f,
    store,
    options,
    original,
    state,
    administrativeScope,
    setNow(value: string) {
      state.now = value;
      f.setNow(value);
    },
    async finish() {
      await f.guard();
      f.final();
      store.assertFinalized();
    },
  };
}
it.each(["Draft", "Active"])(
  "registers genuine %s Catalogue metadata with organization.manage only",
  async (lifecycle) => {
    const f = administrativeFixture(undefined, lifecycle);
    const receipt = await f.store.register(f.original);
    expect(receipt.outcome).toBe("Committed");
    expect(receipt.source?.label).toBe(f.original.label);
    await f.finish();
    expect(
      f.log.some(
        (sql) =>
          sql.includes("rms_catalog.product") ||
          sql.includes("rms_catalog.sku") ||
          sql.includes("price"),
      ),
    ).toBe(false);
    expect(f.log).not.toContain("actual controlled parent authority");
  },
);
it.each(["Archived", "Suspended"])(
  "rejects fresh %s registration without allocating identities or Audit",
  async (lifecycle) => {
    const f = administrativeFixture(undefined, lifecycle);
    await refused(() => f.store.register(f.original), "CATALOG_PERMISSION_DENIED");
    expect(f.nextReference).not.toHaveBeenCalled();
    expect(f.appendAudit).not.toHaveBeenCalled();
    await refused(f.guard);
    expect(f.final).toThrow();
  },
);
it("rejects a foreign actual administrative Actor before Catalogue SQL admission", async () => {
  const f = administrativeFixture();
  f.state.actorReference = parseCatalogReference(id(99));
  await refused(() => f.store.current(), "CATALOG_PERMISSION_DENIED");
  expect(f.log.some((sql) => sql.includes("rms_catalog.brand_catalog_source"))).toBe(false);
  await refused(f.guard);
  expect(f.final).toThrow();
});
it("rejects a Tenant mismatch instead of treating administrative Brand context as operational scope", async () => {
  const f = administrativeFixture();
  const store = createPostgresBrandAdministrationCatalogSourceStore({
    ...f.options,
    tenantReference: scope.tenantReference,
  });
  await refused(() => store.current(), "CATALOG_PERMISSION_DENIED");
  expect(f.nextReference).not.toHaveBeenCalled();
  expect(f.appendAudit).not.toHaveBeenCalled();
  await refused(f.guard);
  expect(f.final).toThrow();
});
it("reads and resolves unchanged originals under actual later Archived administration", async () => {
  const first = administrativeFixture();
  const receipt = await first.store.register(first.original);
  await first.finish();
  const replay = administrativeFixture(first.memory, "Archived");
  expect(await replay.store.register(replay.original)).toEqual(receipt);
  await replay.finish();
  expect(replay.nextReference).not.toHaveBeenCalled();
  expect(replay.appendAudit).not.toHaveBeenCalled();
  const read = administrativeFixture(first.memory, "Archived");
  expect((await read.store.current()).source).toEqual(receipt.source);
  await read.finish();
  const resolve = administrativeFixture(first.memory, "Archived");
  expect(
    await resolve.store.resolve({
      profile: "BrandCatalogSourceResolveV1",
      ...resolve.administrativeScope,
      operationReference: resolve.original.operationReference,
      intentDigest: brandCatalogSourceIntentDigest(resolve.original),
    }),
  ).toEqual(receipt);
  await resolve.finish();
  expect(resolve.nextReference).not.toHaveBeenCalled();
  expect(resolve.appendAudit).not.toHaveBeenCalled();
});
it.each(["Actor", "lifecycle", "IAM", "expiry"])(
  "rejects actual late administrative %s drift",
  async (mode) => {
    const f = administrativeFixture();
    await f.store.current();
    if (mode === "Actor") f.state.actorReference = parseCatalogReference(id(99));
    if (mode === "lifecycle") f.state.lifecycle = "Active";
    if (mode === "IAM") f.state.allowed = false;
    if (mode === "expiry") f.state.until = at;
    await refused(
      f.guard,
      mode === "expiry" ? "CATALOG_DEPENDENCY_UNAVAILABLE" : "CATALOG_PERMISSION_DENIED",
    );
    expect(f.final).toThrow();
  },
);
it("keeps the operational catalog.manage admission exact and rejects an admin packet through it", async () => {
  const f = fixture();
  await f.store.current();
  await f.finish();
  expect(
    f.authority.holdUntilTransactionCompletes.mock.calls.every(
      ([, input]) => input.permission === "catalog.manage",
    ),
  ).toBe(true);
  const wrong = fixture();
  wrong.authority.holdUntilTransactionCompletes.mockImplementation(async () => ({
    validUntil: plus(5000),
    administrationContext: { profile: "BrandAdministrationContextV1" },
  }));
  await refused(() => wrong.store.current());
});
