// Controlled SQL transport; real public Operating Entity constructors and held-source protocol.
// These tests are not native PostgreSQL or current IAM evidence.
import { expect, it } from "vitest";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseRoleReference,
} from "@bop/permission";
import {
  createPostgresTaxRegistrantSource,
  TaxRegistrantSourceError,
  type TaxRegistrantTransaction,
  type TaxRegistrantSourceOptions,
} from "../infrastructure/persistence/tax-registrant-source.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
function authorityPacket(now: string, lease: string, allowed = true) {
  const brand = createBrand({
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: scope.storeReference,
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Synthetic Store",
    locale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const actor = {
    actorType: "User",
    actorReference: scope.actorReference,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  } as Parameters<typeof createTenantContext>[0];
  const tenantContext = createTenantContext(actor, brand, store, now),
    actorReference = tenantContext.actor.actorReference;
  if (actorReference === null) throw Error("actual fixture workforce actor required");
  const action = parseBusinessAction("organization.manage");
  const permission = evaluatePermission({
    tenantContext,
    action,
    resourceScope: {
      kind: "Store",
      brandReference: brand.brandReference,
      storeReference: store.storeReference,
    },
    policySnapshotReference: parsePolicyReference(id(90)),
    policyVersion: parsePolicyVersion(1),
    evidence: allowed
      ? [
          {
            source: "RolePermission",
            evidenceReference: parseEvidenceReference(id(91)),
            action,
            actorReference,
            roleReference: parseRoleReference(id(92)),
            brandReference: brand.brandReference,
            storeReference: store.storeReference,
            effectiveFrom: parseCanonicalInstant(at),
            effectiveUntil: null,
          },
        ]
      : [],
  });
  return { scope, tenantContext, permission, validUntil: lease };
}
const sourceRow = (taxRegistrationReference: string | null = id(8)) => ({
  assignment: {
    assignmentReference: id(5),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    operatingEntityReference: id(6),
    businessFunction: "TaxRegistrant",
    lifecycle: "Active",
    effectiveFrom: at,
    effectiveUntil: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  },
  entity: {
    operatingEntityReference: id(6),
    kind: "LegalEntity",
    legalName: "Synthetic entity",
    tradeName: null,
    jurisdictionCode: "CA-ON",
    registrationReference: id(7),
    taxRegistrationReference,
    billingIdentityReference: null,
    settlementReference: null,
    evidenceReference: id(9),
    lifecycle: "Active",
    version: 3,
    createdAt: at,
    updatedAt: at,
  },
  profile: {
    profileVersionReference: id(10),
    operatingEntityReference: id(6),
    profileVersion: 1,
    legalName: "Synthetic entity",
    tradeName: null,
    jurisdictionCode: "CA-ON",
    registrationReference: id(7),
    taxRegistrationReference,
    registeredAddressReference: null,
    billingIdentityReference: null,
    settlementReference: null,
    evidenceReferences: [id(9)],
    recordedByReference: id(11),
    recordedAt: at,
    dataClassification: "RestrictedReferenceMetadata",
  },
  profileBrandReference: scope.brandReference,
  profileStoreReference: null,
  precise: true,
});
function fixture() {
  let now = at,
    lease = until,
    allowed = true,
    list: unknown[] = [{ source: sourceRow() }],
    guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined;
  const queries: string[] = [],
    queryValues: (readonly unknown[])[] = [],
    holds: unknown[] = [],
    events: string[] = [];
  const tx: TaxRegistrantTransaction = {
    async query(sql, values) {
      queries.push(sql);
      queryValues.push(values);
      events.push(sql.includes("pg_advisory_xact_lock_shared") ? "lock" : "sql");
      if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.startsWith("SELECT operating_entity_id"))
        return { rows: list.map(() => ({ operatingEntityReference: id(6) })) };
      if (sql.startsWith("SELECT jsonb_build_object")) return { rows: list };
      void values;
      return { rows: [] };
    },
  };
  const options: TaxRegistrantSourceOptions = {
    ...scope,
    originalObservedAt: at,
    originalValidUntil: until,
    clock: { now: () => now },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        events.push("authority");
        holds.push(input);
        if (!allowed) throw new TaxRegistrantSourceError("TAX_REGISTRANT_PERMISSION_DENIED");
        return authorityPacket(now, lease);
      },
    },
    registerBeforeCommit(actual, g, f) {
      expect(actual).toBe(tx);
      if (guard || final) throw Error("duplicate hooks");
      guard = g;
      final = f;
    },
  };
  const source = createPostgresTaxRegistrantSource(options);
  return {
    tx,
    source,
    options,
    queries,
    queryValues,
    holds,
    events,
    setNow: (v: string) => {
      now = v;
    },
    setLease: (v: string) => {
      lease = v;
    },
    deny: () => {
      allowed = false;
    },
    setRows: (v: unknown[]) => {
      list = v;
    },
    async finish() {
      if (!guard || !final) throw Error("missing hooks");
      await guard();
      final();
    },
    async guard() {
      if (!guard) throw Error("missing guard");
      await guard();
    },
    final() {
      if (!final) throw Error("missing final");
      final();
    },
  };
}
it("reads real matching independent entity/profile counters without asserting Verified", async () => {
  const f = fixture(),
    value = await f.source.resolve({ transaction: f.tx, effectiveAt: at });
  expect(value).toMatchObject({
    profile: "TaxRegistrantCurrentSourceV1",
    ...scope,
    businessFunction: "TaxRegistrant",
    entityVersion: 3,
    profileVersion: 1,
    operatingEntityProfileVersionReference: id(10),
    taxRegistrationReference: id(8),
    qualification: "NotEvaluated",
  });
  expect(value).not.toHaveProperty("status");
  expect(value).not.toHaveProperty("billingIdentityReference");
  expect(Object.isFrozen(value)).toBe(true);
  expect(f.events.indexOf("authority")).toBeLessThan(f.events.indexOf("lock"));
  expect(f.queries.find((q) => q.startsWith("SELECT jsonb_build_object"))).toContain(
    "FOR SHARE OF a,e",
  );
  await f.finish();
  expect(f.source.assertFinalized(f.tx)).toBe(until);
});
it("retains actual nullable tax registration and stable absence only after final guards", async () => {
  const f = fixture(),
    r = sourceRow();
  r.entity.taxRegistrationReference = null;
  r.profile.taxRegistrationReference = null;
  f.setRows([{ source: r }]);
  expect(
    (await f.source.resolve({ transaction: f.tx, effectiveAt: at }))?.taxRegistrationReference,
  ).toBeNull();
  await f.finish();
  const absent = fixture();
  absent.setRows([]);
  expect(await absent.source.resolve({ transaction: absent.tx, effectiveAt: at })).toBeNull();
  await absent.finish();
  expect(absent.source.assertFinalized(absent.tx)).toBe(until);
});
it("refuses ambiguity, missing current profile, foreign scope and mismatching actual profile fields", async () => {
  const base = sourceRow();
  for (const rows of [
    [{ source: base }, { source: base }],
    [{ source: { ...base, profile: null } }],
    [{ source: { ...base, profileBrandReference: id(99) } }],
    [{ source: { ...base, profile: { ...base.profile, taxRegistrationReference: id(99) } } }],
    [{ source: { ...base, entity: { ...base.entity, lifecycle: "Suspended" } } }],
  ]) {
    const f = fixture();
    f.setRows(rows);
    await expect(f.source.resolve({ transaction: f.tx, effectiveAt: at })).rejects.toMatchObject({
      code: "TAX_REGISTRANT_UNAVAILABLE",
    });
    await expect(f.source.resolve({ transaction: f.tx, effectiveAt: at })).rejects.toMatchObject({
      code: "TAX_REGISTRANT_UNAVAILABLE",
    });
  }
});
it("holds current organization authority before any source SQL and fails late withdrawal", async () => {
  const initial = fixture();
  initial.deny();
  await expect(
    initial.source.resolve({ transaction: initial.tx, effectiveAt: at }),
  ).rejects.toMatchObject({ code: "TAX_REGISTRANT_PERMISSION_DENIED" });
  expect(initial.queries).toHaveLength(0);
  const late = fixture();
  await late.source.resolve({ transaction: late.tx, effectiveAt: at });
  late.deny();
  await expect(late.finish()).rejects.toMatchObject({ code: "TAX_REGISTRANT_PERMISSION_DENIED" });
  expect(() => late.source.assertFinalized(late.tx)).toThrow();
});
it("rereads actual latest source and catches profile or absence changes before commit", async () => {
  for (const absent of [false, true]) {
    const f = fixture();
    if (absent) f.setRows([]);
    await f.source.resolve({ transaction: f.tx, effectiveAt: at });
    const row = sourceRow();
    row.profile.profileVersionReference = id(55);
    row.profile.profileVersion = 2;
    f.setRows([{ source: row }]);
    await expect(f.finish()).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
  }
});
it("requires both real host hooks exactly once and rejects public reads after guard entry", async () => {
  const skipped = fixture();
  await skipped.source.resolve({ transaction: skipped.tx, effectiveAt: at });
  expect(() => skipped.source.assertFinalized(skipped.tx)).toThrow();
  const f = fixture();
  await f.source.resolve({ transaction: f.tx, effectiveAt: at });
  await f.guard();
  f.final();
  expect(f.source.assertFinalized(f.tx)).toBe(until);
  await expect(f.guard()).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
  const late = fixture();
  await late.source.resolve({ transaction: late.tx, effectiveAt: at });
  await late.guard();
  await expect(
    late.source.resolve({ transaction: late.tx, effectiveAt: at }),
  ).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
});
it("tightens current lease and rejects natural expiry and backward clock", async () => {
  const f = fixture();
  f.setLease("2026-10-05T10:00:02.000Z");
  expect((await f.source.resolve({ transaction: f.tx, effectiveAt: at }))?.validUntil).toBe(
    "2026-10-05T10:00:02.000Z",
  );
  f.setNow("2026-10-05T10:00:02.000Z");
  await expect(f.finish()).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
  const backward = fixture();
  await backward.source.resolve({ transaction: backward.tx, effectiveAt: at });
  backward.setNow("2026-10-05T09:59:59.999Z");
  await expect(backward.finish()).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
});
it("captures clock, authority, transaction and registration ports and rejects accessors", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.tx.query = async () => ({ rows: [] });
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.authority.holdUntilTransactionCompletes = async () => authorityPacket(at, until);
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.clock.now = () => at;
    },
  ]) {
    const f = fixture();
    await f.source.resolve({ transaction: f.tx, effectiveAt: at });
    change(f);
    await expect(f.finish()).rejects.toMatchObject({ code: "TAX_REGISTRANT_UNAVAILABLE" });
  }
  const f = fixture(),
    getter = {
      transaction: f.tx,
      get effectiveAt(): string {
        throw Error("must not execute");
      },
    };
  await expect(f.source.resolve(getter)).rejects.toMatchObject({
    code: "TAX_REGISTRANT_UNAVAILABLE",
  });
});

it("uses exact shared writer barriers without table locks or profile UPDATE requirements", async () => {
  const f = fixture();
  await f.source.resolve({ transaction: f.tx, effectiveAt: at });
  const calls = f.queries.map((sql, i) => ({ sql, values: f.queryValues[i] }));
  const assignment = calls.findIndex(
    (c) =>
      c.sql.includes("pg_advisory_xact_lock_shared") &&
      c.values?.[0] === `TaxRegistrantAssignment:${scope.brandReference}:${scope.storeReference}`,
  );
  const profile = calls.findIndex(
    (c) =>
      c.sql.includes("pg_advisory_xact_lock_shared") &&
      c.values?.[0] === `TaxRegistrantProfile:${id(6)}`,
  );
  const read = calls.findIndex((c) => c.sql.startsWith("SELECT jsonb_build_object"));
  expect(assignment).toBeGreaterThanOrEqual(0);
  expect(profile).toBeGreaterThan(assignment);
  expect(read).toBeGreaterThan(profile);
  expect(f.queries.some((sql) => sql.includes("LOCK TABLE"))).toBe(false);
  expect(calls[read]?.sql).not.toContain("FOR SHARE OF p");
});
it("rejects nested getters without invoking them and keeps failed source poisoned", async () => {
  const f = fixture(),
    r = sourceRow();
  let invoked = false;
  Object.defineProperty(r.profile.evidenceReferences, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return id(9);
    },
  });
  f.setRows([{ source: r }]);
  await expect(f.source.resolve({ transaction: f.tx, effectiveAt: at })).rejects.toMatchObject({
    code: "TAX_REGISTRANT_UNAVAILABLE",
  });
  expect(invoked).toBe(false);
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});

it("rejects actual denied or contradictory current permission and scope packets before SQL", async () => {
  for (const change of [
    (p: ReturnType<typeof authorityPacket>) => ({
      ...p,
      permission: authorityPacket(at, until, false).permission,
    }),
    (p: ReturnType<typeof authorityPacket>) => ({
      ...p,
      scope: { ...scope, actorReference: id(99) },
    }),
    (p: ReturnType<typeof authorityPacket>) => ({
      ...p,
      permission: {
        ...p.permission,
        audit: { ...p.permission.audit, source: "ExplicitAllow" as const },
      },
    }),
  ]) {
    const f = fixture();
    f.options.authority.holdUntilTransactionCompletes = async () =>
      change(authorityPacket(at, until));
    // Construct after selecting the controlled packet port, so this tests packet admission rather than port drift.
    const source = createPostgresTaxRegistrantSource(f.options);
    await expect(source.resolve({ transaction: f.tx, effectiveAt: at })).rejects.toMatchObject({
      code: "TAX_REGISTRANT_PERMISSION_DENIED",
    });
    expect(f.queries).toHaveLength(0);
    expect(() => source.assertFinalized(f.tx)).toThrow();
  }
});
it("rejects permission/context getters without invoking them", async () => {
  const f = fixture();
  let invoked = false;
  const genuine = authorityPacket(at, until),
    packet = { ...genuine, permission: { ...genuine.permission } };
  Object.defineProperty(packet.permission, "audit", {
    get() {
      invoked = true;
      return {};
    },
    enumerable: true,
  });
  f.options.authority.holdUntilTransactionCompletes = async () => packet;
  const source = createPostgresTaxRegistrantSource(f.options);
  await expect(source.resolve({ transaction: f.tx, effectiveAt: at })).rejects.toMatchObject({
    code: "TAX_REGISTRANT_UNAVAILABLE",
  });
  expect(invoked).toBe(false);
  expect(f.queries).toHaveLength(0);
});

it("accepts a later immutable matching profile without equating its clock or version to the entity", async () => {
  const f = fixture(),
    row = sourceRow(),
    later = "2026-10-05T10:00:00.001Z";
  row.profile.recordedAt = later;
  row.profile.profileVersion = 2;
  f.setRows([{ source: row }]);
  f.setNow(later);
  const value = await f.source.resolve({ transaction: f.tx, effectiveAt: later });
  expect(value).toMatchObject({ entityVersion: 3, profileVersion: 2 });
  await f.finish();
  expect(f.source.assertFinalized(f.tx)).toBe(until);
});
