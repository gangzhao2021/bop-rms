import { expect, it, vi } from "vitest";
import { createIdentityActor, parseCurrentWorkforceAccount } from "@bop/identity";
import { createBrand } from "@bop/tenant";
import {
  createPostgresInitialBrandMembershipStore,
  hashInitialBrandMembershipRequest,
  type InitialBrandMembershipStoreOptions,
} from "../infrastructure/persistence/initial-brand-membership-store.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-10-06T10:00:00.000Z",
  end = "2026-10-07T10:00:00.000Z",
  lease = "2026-10-06T10:00:05.000Z";
function fixture() {
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const member = {
    membershipReference: id(6),
    actorReference: id(1),
    workforceRelationshipReference: id(7),
    effectiveUntil: end,
  };
  const request = {
    profile: "InitialBrandMembershipRequestV1",
    operationReference: id(2),
    brandReference: id(3),
    planDigest: "sha256:" + "a".repeat(64),
    approvalEvidenceReference: id(4),
    operatorReference: id(1),
    approvedByReference: id(5),
    members: [member],
  };
  const qualified = {
    membershipReference: id(6),
    account: parseCurrentWorkforceAccount({
      profile: "CurrentWorkforceAccountV1",
      actorType: "User",
      actorReference: id(1),
      accountKind: "Workforce",
      status: "Active",
      observedAt: at,
      validUntil: lease,
    }),
    workforceRelationshipReference: id(7),
    relationshipEvidenceReference: id(8),
    invitationEvidenceReference: id(9),
    invitationQualified: true as const,
    relationshipEffectiveFrom: at,
    relationshipEffectiveUntil: end,
  };
  const authority = {
    brand: createBrand({
      brandReference: id(3),
      code: "SYNTHETIC",
      displayName: "Synthetic Draft",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    operator: actor,
    operationReference: id(2),
    brandReference: id(3),
    planDigest: request.planDigest,
    requestDigest: hashInitialBrandMembershipRequest(request),
    approvalEvidenceReference: id(4),
    approvedByReference: id(5),
    members: [qualified],
    observedAt: at,
    validUntil: lease,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    stored: Record<string, unknown>[] = [];
  const state = {
    now: at,
    duplicate: false,
    isolation: "read committed",
    transactionId: "123",
    failSql: false,
    failAudit: false,
    failAuthority: false,
    onQuery: null as (() => void) | null,
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const tx = {
    async query(sql: string, values: readonly unknown[]) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      state.onQuery?.();
      if (state.failSql) throw Error("synthetic SQL detail");
      if (sql.startsWith("SELECT current_setting"))
        return { rows: [{ isolation: state.isolation, transaction_id: state.transactionId }] };
      if (sql.startsWith("SELECT membership_id FROM"))
        return { rows: state.duplicate ? [{ membership_id: id(99) }] : [] };
      if (sql.startsWith("INSERT")) {
        stored.push({
          membership_id: values[0],
          actor_id: values[1],
          brand_id: values[2],
          workforce_relationship_reference: values[3],
          lifecycle: "Active",
          effective_from: values[4],
          effective_until: values[5],
          version: 1,
          created_at: values[4],
          updated_at: values[4],
          precise: true,
        });
        return { rows: [{ membership_id: values[0] }] };
      }
      if (sql.includes("FROM bop_membership.membership")) return { rows: stored };
      return { rows: [] };
    },
  };
  const hold = vi.fn<InitialBrandMembershipStoreOptions["authority"]["hold"]>(
    async (transaction, input) => {
      expect(transaction).toBe(tx);
      expect(input.request).toEqual(request);
      expect(input.requestDigest).toBe(hashInitialBrandMembershipRequest(request));
      if (state.failAuthority) throw Error("synthetic withdrawn authority");
      return { ...authority, observedAt: input.observedAt };
    },
  );
  const appendAudit = vi.fn<InitialBrandMembershipStoreOptions["appendAudit"]>(
    async (transaction, input) => {
      expect(transaction).toBe(tx);
      expect(input.actorReference).toBe(id(1));
      expect(input.planDigest).toBe(request.planDigest);
      expect(input.requestDigest).toBe(hashInitialBrandMembershipRequest(request));
      if (state.failAudit) throw Error("synthetic Audit unavailable");
    },
  );
  const options: InitialBrandMembershipStoreOptions = {
    transaction: tx,
    clock: { now: () => state.now },
    originalObservedAt: at,
    originalValidUntil: lease,
    auditReference: id(10),
    authority: { hold },
    appendAudit,
    async registerBeforeCommit(transaction, check, seal) {
      expect(transaction).toBe(tx);
      guard = check;
      final = seal;
    },
  };
  const source = createPostgresInitialBrandMembershipStore(options);
  return {
    source,
    request,
    member,
    qualified,
    authority,
    options,
    state,
    calls,
    stored,
    tx,
    hold,
    appendAudit,
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
it("initializes absent Draft memberships using one transaction and the required Audit append, sealing before commit", async () => {
  const f = fixture(),
    result = await f.source.initialize(f.request);
  expect(result.memberships[0]?.lifecycle).toBe("Active");
  expect(result.memberships[0]?.version).toBe(1);
  expect(result.memberships[0]?.effectiveFrom).toBe(at);
  expect(result.memberships[0]?.effectiveUntil).toBe(end);
  expect(Object.isFrozen(result.memberships)).toBe(true);
  expect(f.calls.some((c) => c.sql.includes("pg_advisory_xact_lock"))).toBe(true);
  expect(f.calls.some((c) => c.sql.includes("set_config('bop.tenant_id',$1,true)"))).toBe(true);
  expect(
    f.calls.every(
      (c) =>
        !c.sql.includes("store_assignment") &&
        !c.sql.includes("bop_tenant") &&
        !c.sql.includes("bop_permission"),
    ),
  ).toBe(true);
  await f.guard();
  f.final();
  // Caller now performs COMMIT. The pure assertion must not renew or read time.
  f.options.clock.now = () => {
    throw Error("clock unavailable after commit");
  };
  expect(f.source.assertFinalized()).toBe(id(10));
  expect(f.appendAudit).toHaveBeenCalledTimes(1);
});
it.each(["duplicate", "isolation", "SQL", "Audit", "authority", "expired", "reboundRequest"])(
  "refuses initialization %s and poisons further use",
  async (reason) => {
    const f = fixture();
    if (reason === "duplicate") f.state.duplicate = true;
    if (reason === "isolation") f.state.isolation = "repeatable read";
    if (reason === "SQL") f.state.failSql = true;
    if (reason === "Audit") f.state.failAudit = true;
    if (reason === "authority") f.state.failAuthority = true;
    if (reason === "expired") f.state.now = lease;
    if (reason === "reboundRequest") f.member.effectiveUntil = "2026-10-08T10:00:00.000Z";
    await expect(f.source.initialize(f.request)).rejects.toThrow("membership input is invalid");
    const count = f.calls.length;
    await expect(f.source.initialize(f.request)).rejects.toThrow();
    expect(f.calls).toHaveLength(count);
    expect(() => f.source.assertFinalized()).toThrow();
    if (!["Audit"].includes(reason)) expect(f.appendAudit).not.toHaveBeenCalled();
  },
);
it.each([
  "Membership",
  "Actor",
  "relationship",
  "authority",
  "transaction",
  "clock",
  "query",
  "authorityPort",
  "AuditPort",
])("refuses late %s drift at the required precommit guard", async (reason) => {
  const f = fixture();
  await f.source.initialize(f.request);
  const row = f.stored[0];
  if (!row) throw Error("missing fixture row");
  if (reason === "Membership") row.lifecycle = "Suspended";
  if (reason === "Actor")
    f.qualified.account = parseCurrentWorkforceAccount({
      ...f.qualified.account,
      actorReference: id(99),
    });
  if (reason === "relationship") f.qualified.workforceRelationshipReference = id(99);
  if (reason === "authority") f.state.failAuthority = true;
  if (reason === "transaction") f.state.transactionId = "124";
  if (reason === "clock") f.state.now = lease;
  if (reason === "query") f.tx.query = async () => ({ rows: [] });
  if (reason === "authorityPort")
    Object.defineProperty(f.options.authority, "hold", { value: async () => f.authority });
  if (reason === "AuditPort")
    Object.defineProperty(f.options, "appendAudit", { value: async () => undefined });
  await expect(f.guard()).rejects.toThrow();
  expect(() => f.final()).toThrow();
  expect(() => f.source.assertFinalized()).toThrow();
});
it("requires successful async guards and rejects expiry immediately before the synchronous seal", async () => {
  const f = fixture();
  await f.source.initialize(f.request);
  expect(() => f.final()).toThrow();
  const g = fixture();
  await g.source.initialize(g.request);
  await g.guard();
  g.state.now = lease;
  expect(() => g.final()).toThrow();
  expect(() => g.source.assertFinalized()).toThrow();
});
it("does not independently replay or reinitialize a previously initialized leaf", async () => {
  const f = fixture();
  await f.source.initialize(f.request);
  await f.guard();
  f.final();
  const count = f.calls.length;
  await expect(f.source.initialize(f.request)).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
  expect(f.appendAudit).toHaveBeenCalledTimes(1);
});
it("detects caught transaction-port reentry while initialization is awaiting a collaborator", async () => {
  const f = fixture();
  let attempted = false;
  f.state.onQuery = () => {
    if (attempted) return;
    attempted = true;
    void f.source.initialize(f.request).catch(() => undefined);
  };
  await expect(f.source.initialize(f.request)).rejects.toThrow();
  expect(f.appendAudit).not.toHaveBeenCalled();
});
it.each(["authority", "SQL", "Audit", "parse"])(
  "registers a poison guard before caught %s failure can commit earlier work",
  async (reason) => {
    const f = fixture();
    if (reason === "authority") f.state.failAuthority = true;
    if (reason === "SQL") f.state.failSql = true;
    if (reason === "Audit") f.state.failAudit = true;
    await expect(f.source.initialize(reason === "parse" ? {} : f.request)).rejects.toThrow();
    await expect(f.guard()).rejects.toThrow("membership input is invalid");
    expect(() => f.final()).toThrow("membership input is invalid");
  },
);
it("retains a member's business end within the original lease and rejects its exact boundary", async () => {
  const f = fixture(),
    short = "2026-10-06T10:00:01.000Z";
  f.member.effectiveUntil = short;
  f.authority.requestDigest = hashInitialBrandMembershipRequest(f.request);
  await f.source.initialize(f.request);
  f.state.now = short;
  await expect(f.guard()).rejects.toThrow();
  expect(() => f.final()).toThrow();
});
it("rejects an additional same-Actor Membership introduced after initialization", async () => {
  const f = fixture();
  await f.source.initialize(f.request);
  const row = f.stored[0];
  if (!row) throw Error("missing fixture row");
  f.stored.push({ ...row, membership_id: id(99) });
  await expect(f.guard()).rejects.toThrow();
});

it.each(["invalid", "throws"])("keeps a caught %s final clock failure poisoned", async (reason) => {
  const f = fixture();
  await f.source.initialize(f.request);
  await f.guard();
  const originalNow = f.options.clock.now;
  if (reason === "invalid") f.state.now = "bad";
  else
    f.options.clock.now = () => {
      throw Error("synthetic clock unavailable");
    };
  expect(() => f.final()).toThrow();
  f.state.now = at;
  f.options.clock.now = originalNow;
  expect(() => f.final()).toThrow();
  expect(() => f.source.assertFinalized()).toThrow();
});

it("allows new current-account observations without repinning identity or renewing original lease", async () => {
  const f = fixture();
  await f.source.initialize(f.request);
  f.state.now = "2026-10-06T10:00:01.000Z";
  f.qualified.account = parseCurrentWorkforceAccount({
    ...f.qualified.account,
    observedAt: f.state.now,
    validUntil: lease,
  });
  await f.guard();
  f.final();
  expect(() => f.source.assertFinalized()).not.toThrow();
});
it("shrinks authority to actual account expiry and blocks the last seal after it", async () => {
  const f = fixture();
  f.qualified.account = parseCurrentWorkforceAccount({
    ...f.qualified.account,
    validUntil: "2026-10-06T10:00:03.000Z",
  });
  await f.source.initialize(f.request);
  await f.guard();
  f.state.now = "2026-10-06T10:00:03.000Z";
  expect(() => f.final()).toThrow();
  expect(() => f.source.assertFinalized()).toThrow();
});
it("refuses a caught late account expiry or rebound without committing prior membership writes", async () => {
  for (const mode of ["expired", "Actor"]) {
    const f = fixture();
    await f.source.initialize(f.request);
    if (mode === "expired") f.state.now = lease;
    else
      f.qualified.account = parseCurrentWorkforceAccount({
        ...f.qualified.account,
        actorReference: id(99),
      });
    await expect(f.guard()).rejects.toThrow();
    expect(() => f.final()).toThrow();
  }
});
