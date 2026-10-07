import { createMembership, createStoreAssignment } from "@bop/membership";
import {
  createTenantContext,
  createStore,
  createBrand,
  createBrandAdministrationContext,
} from "@bop/tenant";
import { expect, it } from "vitest";
import {
  createPostgresCurrentPermissionPolicySource,
  createPostgresTransactionCurrentPermissionPolicySource,
  createPostgresCurrentBrandAdministrationPermissionPolicySource,
} from "../infrastructure/persistence/current-policy-store.js";
import * as f from "./current-policy.fixture.js";

const after = (milliseconds: number) => new Date(Date.parse(f.AT) + milliseconds).toISOString();
const unavailable = { code: "PERMISSION_POLICY_MATERIALIZATION_INVALID" };
type Row = Record<string, unknown>;
interface Packet extends Record<string, unknown> {
  profile: string;
  policy_state: Row[];
  permission_definition: Row[];
  role: Row[];
  role_assignment: Row[];
  permission_grant: Row[];
  permission_override: Row[];
}
function transportRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? Number.isFinite(value.getTime())
          ? value.toISOString()
          : "Invalid Date"
        : value,
    ]),
  );
}
function requiredRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (!row) throw Error("Missing controlled packet row");
  return row;
}
function fixture(transactionLocal = false) {
  // Only database rows are controlled. Actual owner parsers, evidence
  // materialization and permission evaluation run unchanged.
  const metadata = () => ({
      version: "1",
      created_at: new Date(f.FROM),
      updated_at: new Date(f.FROM),
    }),
    period = () => ({ effective_from: new Date(f.FROM), effective_until: null }),
    definition: Row = {
      permission_id: f.PERMISSION,
      action_code: f.ACTION,
      lifecycle: "Active",
      ...metadata(),
    },
    role: Row = {
      role_id: f.BRAND_ROLE,
      brand_id: f.BRAND,
      store_id: null,
      role_code: "synthetic_brand",
      lifecycle: "Active",
      ...period(),
      ...metadata(),
    },
    assignment: Row = {
      assignment_id: f.BRAND_ASSIGNMENT,
      role_id: f.BRAND_ROLE,
      membership_id: f.MEMBERSHIP,
      store_assignment_id: null,
      actor_id: f.ACTOR,
      brand_id: f.BRAND,
      store_id: null,
      lifecycle: "Active",
      ...period(),
      ...metadata(),
    },
    grant: Row = {
      grant_id: f.BRAND_GRANT,
      role_id: f.BRAND_ROLE,
      permission_id: f.PERMISSION,
      brand_id: f.BRAND,
      store_id: null,
      lifecycle: "Active",
      ...period(),
      ...metadata(),
    },
    override: Row = {
      override_id: f.ALLOW,
      permission_id: f.PERMISSION,
      actor_id: f.ACTOR,
      brand_id: f.BRAND,
      store_id: null,
      effect: "Allow",
      lifecycle: "Active",
      reason_reference: f.REASON,
      correlation_reference: f.CORRELATION,
      ...period(),
      ...metadata(),
    },
    definitions = [definition],
    grants = [grant],
    rows: Record<string, Row[]> = {
      policy_state: [
        { brand_id: f.BRAND, snapshot_id: f.SNAPSHOT, version: "1", updated_at: new Date(f.FROM) },
      ],
      permission_definition: definitions,
      role: [role],
      role_assignment: [assignment],
      permission_grant: grants,
      permission_override: [],
    },
    membership = createMembership({ ...f.membership, effectiveUntil: null }, f.actor),
    storeAssignment = createStoreAssignment(
      { ...f.storeAssignment, effectiveUntil: null },
      membership,
      f.store,
    ),
    input = { tenantContext: f.tenantContext, membership, storeAssignment, action: f.ACTION },
    calls: { sql: string; values: readonly unknown[] }[] = [],
    queryControl: { before(sql: string): Promise<void> } = { before: async () => undefined },
    transport: { map(packet: Packet): unknown } = { map: (packet) => packet },
    transaction = {
      async query(sql: string, values: readonly unknown[]) {
        await queryControl.before(sql);
        calls.push({ sql, values });
        if (!sql.startsWith("SELECT jsonb_build_object(")) return { rows: [] };
        // Controlled JSONB transport, not permission decisions. Malformed Date
        // facts become malformed transport so the real owner rejects them.
        const packet: Packet = {
          profile: "PermissionCurrentPolicyPacketV1",
          policy_state: (rows.policy_state ?? []).map(transportRow),
          permission_definition: (rows.permission_definition ?? []).map(transportRow),
          role: (rows.role ?? []).map(transportRow),
          role_assignment: (rows.role_assignment ?? []).map(transportRow),
          permission_grant: (rows.permission_grant ?? []).map(transportRow),
          permission_override: (rows.permission_override ?? []).map(transportRow),
        };
        return { rows: [{ packet: transport.map(packet) }] };
      },
    },
    source = transactionLocal
      ? createPostgresTransactionCurrentPermissionPolicySource(transaction)
      : createPostgresCurrentPermissionPolicySource(transaction);
  return {
    transaction,
    queryControl,
    input,
    source,
    calls,
    transport,
    rows,
    definitions,
    grants,
    definition,
    role,
    assignment,
    grant,
    override,
  };
}

function administrationFixture(lifecycle: "Draft" | "Active" | "Suspended" | "Archived" = "Draft") {
  const x = fixture(true);
  x.definition.action_code = "organization.manage";
  const context = createBrandAdministrationContext(
    f.actor,
    createBrand({ ...f.brand, lifecycle }),
    f.AT,
  );
  const source = createPostgresCurrentBrandAdministrationPermissionPolicySource(x.transaction);
  const input = {
    administrationContext: context,
    membership: x.input.membership,
    storeAssignment: null,
    action: "organization.manage",
  };
  return { ...x, source, input, context };
}

it.each(["Draft", "Active", "Suspended", "Archived"] as const)(
  "administrative reader reconstructs actual %s policy rows with Brand-only SHARE admission",
  async (lifecycle) => {
    const x = administrationFixture(lifecycle);
    const result = await x.source.authorizeWithRoles(x.input);
    expect(result).toMatchObject({
      decision: { effect: "Allow", scopeKind: "Brand", action: "organization.manage" },
      activeRoleCodes: ["synthetic_brand"],
      validUntil: after(5000),
    });
    expect(x.context.brand.lifecycle).toBe(lifecycle);
    expect(x.calls[0]?.values).toEqual([f.BRAND, ""]);
    expect(x.calls[1]?.sql).toContain("IN SHARE MODE");
    expect(x.calls[2]?.values).toEqual([f.BRAND, null, f.ACTOR, f.MEMBERSHIP]);
    expect(await x.source.authorize(x.input)).toEqual(result.decision);
    expect(x.calls.filter((call) => call.sql.includes("IN SHARE MODE"))).toHaveLength(1);
    expect(
      x.calls.filter((call) => call.sql.startsWith("SELECT jsonb_build_object(")),
    ).toHaveLength(2);
  },
);
it("administrative rereads observe actual Deny and changed policy instead of caching permission", async () => {
  const x = administrationFixture();
  expect((await x.source.authorize(x.input)).effect).toBe("Allow");
  x.override.effect = "Deny";
  x.rows.permission_override = [x.override];
  expect(await x.source.authorize(x.input)).toMatchObject({
    effect: "Deny",
    reason: "EXPLICIT_DENY",
  });
  x.rows.permission_override = [];
  x.grant.lifecycle = "Revoked";
  expect((await x.source.authorize(x.input)).effect).toBe("Deny");
});
it("administrative missing grants deny and malformed action accessors poison without invocation", async () => {
  const x = administrationFixture();
  x.rows.permission_grant = [];
  expect(await x.source.authorize(x.input)).toMatchObject({
    effect: "Deny",
    reason: "DEFAULT_DENY",
  });
  const malformed = administrationFixture();
  let invoked = false;
  const bad = {
    ...malformed.input,
    get action() {
      invoked = true;
      return "organization.manage";
    },
  };
  await expect(malformed.source.authorize(bad)).rejects.toMatchObject(unavailable);
  expect(invoked).toBe(false);
  expect(malformed.calls).toHaveLength(0);
  await expect(malformed.source.authorize(malformed.input)).rejects.toMatchObject(unavailable);
});
it("administrative observation stops at the original five-second or actual policy boundary", async () => {
  for (const boundary of [1000, 5000]) {
    const x = administrationFixture();
    x.grant.effective_until = new Date(after(boundary));
    expect((await x.source.authorizeWithRoles(x.input)).validUntil).toBe(after(boundary));
    const later = createBrandAdministrationContext(f.actor, x.context.brand, after(boundary));
    await expect(
      x.source.authorize({ ...x.input, administrationContext: later }),
    ).rejects.toMatchObject(unavailable);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  }
});
it("administrative source rejects clock reversal and pinned actual Brand/Membership drift", async () => {
  const changes = [
    (x: ReturnType<typeof administrationFixture>) => ({
      ...x.input,
      administrationContext: createBrandAdministrationContext(f.actor, x.context.brand, after(-1)),
    }),
    (x: ReturnType<typeof administrationFixture>) => ({
      ...x.input,
      administrationContext: createBrandAdministrationContext(
        f.actor,
        createBrand({ ...x.context.brand, version: 2 }),
        f.AT,
      ),
    }),
    (x: ReturnType<typeof administrationFixture>) => ({
      ...x.input,
      membership: createMembership({ ...x.input.membership, version: 2 }, f.actor),
    }),
  ];
  for (const change of changes) {
    const x = administrationFixture();
    await x.source.authorize(x.input);
    await expect(x.source.authorize(change(x))).rejects.toMatchObject(unavailable);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  }
});
it("administrative boundary rejects unrelated action, Store assignment and operational context before SQL", async () => {
  for (const change of [
    { action: "catalog.product.read" },
    { action: "iam.manage" },
    { storeAssignment: f.storeAssignment },
    { administrationContext: f.tenantContext },
  ]) {
    const x = administrationFixture();
    await expect(x.source.authorize({ ...x.input, ...change } as never)).rejects.toMatchObject(
      unavailable,
    );
    expect(x.calls).toHaveLength(0);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  }
});
it("administrative source never admits foreign or inactive Membership / malformed stored policy", async () => {
  for (const change of [
    { brandReference: f.OTHER_BRAND },
    { lifecycle: "Suspended" },
    { effectiveUntil: f.AT },
  ]) {
    const x = administrationFixture();
    const membership = createMembership({ ...x.input.membership, ...change }, f.actor);
    await expect(x.source.authorize({ ...x.input, membership })).rejects.toMatchObject(unavailable);
  }
  for (const mutate of [
    (x: ReturnType<typeof administrationFixture>) => {
      x.role.store_id = f.STORE;
    },
    (x: ReturnType<typeof administrationFixture>) => {
      x.role.brand_id = f.OTHER_BRAND;
    },
    (x: ReturnType<typeof administrationFixture>) => {
      x.assignment.actor_id = f.uuid("999");
    },
    (x: ReturnType<typeof administrationFixture>) => {
      x.grant.updated_at = new Date(after(1));
    },
    (x: ReturnType<typeof administrationFixture>) => {
      x.rows.policy_state = [];
    },
  ]) {
    const x = administrationFixture();
    mutate(x);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  }
});
it("administrative source captures transaction query and poisons reentrant/caught failures", async () => {
  const x = administrationFixture();
  const captured = x.transaction.query;
  x.queryControl.before = async () => {
    x.queryControl.before = async () => undefined;
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  };
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  x.transaction.query = captured;
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  const replaced = administrationFixture();
  replaced.queryControl.before = async () => {
    replaced.transaction.query = async () => ({ rows: [] });
  };
  await expect(replaced.source.authorize(replaced.input)).rejects.toMatchObject(unavailable);
});
it("operational factories still reject Draft and even Active administrative context", async () => {
  for (const lifecycle of ["Draft", "Active"] as const) {
    const x = administrationFixture(lifecycle);
    for (const source of [
      createPostgresCurrentPermissionPolicySource(x.transaction),
      createPostgresTransactionCurrentPermissionPolicySource(x.transaction),
    ])
      await expect(
        source.authorize({
          tenantContext: x.context,
          membership: x.input.membership,
          storeAssignment: null,
          action: "organization.manage",
        } as never),
      ).rejects.toMatchObject(unavailable);
    expect(x.calls).toHaveLength(0);
  }
});

it("returns a frozen unbounded observation without changing the existing decision or role codes", async () => {
  const x = fixture(),
    result = await x.source.authorizeWithRoles(x.input);
  expect(result.decision).toMatchObject({ effect: "Allow", action: f.ACTION, scopeKind: "Store" });
  expect(result.activeRoleCodes).toEqual(["synthetic_brand"]);
  expect(result.validUntil).toBeNull();
  expect(Object.isFrozen(result)).toBe(true);
  expect(await x.source.authorize(x.input)).toEqual(result.decision);
  expect(Object.hasOwn(await x.source.authorize(x.input), "validUntil")).toBe(false);
  expect(x.calls[0]?.values).toEqual([f.BRAND, f.STORE]);
  expect(x.calls[1]?.sql).toContain("IN SHARE MODE");
  const firstRead = x.calls.findIndex((c) => c.sql.startsWith("SELECT jsonb_build_object("));
  expect(firstRead).toBeGreaterThan(1);
});

it.each(["role", "assignment", "grant", "override"] as const)(
  "retains the actual near %s expiry even while current access is allowed",
  async (kind) => {
    const x = fixture();
    if (kind === "override") x.rows.permission_override = [x.override];
    x[kind].effective_until = new Date(after(1000));
    const result = await x.source.authorizeWithRoles(x.input);
    expect(result.decision.effect).toBe("Allow");
    expect(result.validUntil).toBe(after(1000));
  },
);

it.each(["membership", "storeAssignment"] as const)(
  "includes the validated owning %s expiry",
  async (kind) => {
    const x = fixture();
    if (kind === "membership") {
      x.input.membership = createMembership(
        { ...x.input.membership, effectiveUntil: after(1000) },
        f.actor,
      );
    } else {
      x.input.storeAssignment = createStoreAssignment(
        { ...x.input.storeAssignment, effectiveUntil: after(1000) },
        x.input.membership,
        f.store,
      );
    }
    const result = await x.source.authorizeWithRoles(x.input);
    expect(result.decision.effect).toBe("Allow");
    expect(result.validUntil).toBe(after(1000));
  },
);

it("stops at a future Deny start and lets the owner evaluate Deny at that exact instant", async () => {
  const x = fixture();
  x.override.effect = "Deny";
  x.override.effective_from = new Date(after(1000));
  x.rows.permission_override = [x.override];
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Allow" },
    validUntil: after(1000),
  });
  x.input.tenantContext = createTenantContext(f.actor, f.brand, f.store, after(1000));
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Deny", source: "ExplicitDeny" },
    validUntil: null,
  });
});

it.each(["role", "assignment", "grant"] as const)(
  "retains a future %s start while preserving the current Deny",
  async (kind) => {
    const x = fixture();
    x[kind].effective_from = new Date(after(1000));
    expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
      decision: { effect: "Deny" },
      validUntil: after(1000),
    });
  },
);

it("uses the earliest future boundary across all locked policy facts", async () => {
  const x = fixture();
  x.role.effective_until = new Date(after(3000));
  x.assignment.effective_until = new Date(after(2000));
  x.grant.effective_until = new Date(after(4000));
  x.override.effect = "Deny";
  x.override.effective_from = new Date(after(1000));
  x.override.effective_until = new Date(after(5000));
  x.rows.permission_override = [x.override];
  expect((await x.source.authorizeWithRoles(x.input)).validUntil).toBe(after(1000));
});

it("conservatively includes an unrelated validated grant without treating it as current authority", async () => {
  const x = fixture();
  x.definitions.push({
    ...x.definition,
    permission_id: f.uuid("90"),
    action_code: "synthetic.other.read",
  });
  x.grants.push({
    ...x.grant,
    grant_id: f.uuid("91"),
    permission_id: f.uuid("90"),
    effective_until: new Date(after(1000)),
  });
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Allow", action: f.ACTION },
    validUntil: after(1000),
  });
});

it.each([-1000, 0])(
  "does not carry an already evaluated grant end at offset %s into a future lease",
  async (offset) => {
    const x = fixture();
    x.grant.effective_until = new Date(after(offset));
    expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
      decision: { effect: "Deny" },
      validUntil: null,
    });
  },
);

it("does not carry a start at the exact observation into a future lease", async () => {
  const x = fixture();
  x.grant.effective_from = new Date(f.AT);
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Allow" },
    validUntil: null,
  });
});

it("supports Brand observations without a Store assignment", async () => {
  const x = fixture();
  x.grant.effective_until = new Date(after(1000));
  const result = await x.source.authorizeWithRoles({
    ...x.input,
    tenantContext: createTenantContext(f.actor, f.brand, null, f.AT),
    storeAssignment: null,
  });
  expect(result).toMatchObject({
    decision: { effect: "Allow", scopeKind: "Brand" },
    validUntil: after(1000),
  });
  expect(x.calls[0]?.values).toEqual([f.BRAND, ""]);
});

it.each(["invalidDate", "futureUpdatedAt", "foreignRole", "orphanGrant"])(
  "never issues boundary metadata from %s unvalidated rows",
  async (kind) => {
    const x = fixture();
    if (kind === "invalidDate") x.grant.effective_until = new Date("invalid");
    if (kind === "futureUpdatedAt") x.grant.updated_at = new Date(after(1000));
    if (kind === "foreignRole") x.role.brand_id = f.OTHER_BRAND;
    if (kind === "orphanGrant") x.grant.role_id = f.uuid("99");
    await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
  },
);

function batchInput(x: ReturnType<typeof fixture>, actions: readonly string[]) {
  const { action, ...facts } = x.input;
  void action;
  return { ...facts, actions };
}
it("transaction source holds six-table SHARE once while every call still obtains the full fresh packet and restores scope", async () => {
  const x = fixture(true),
    legacy = fixture();
  expect(await x.source.authorizeWithRoles(x.input)).toEqual(
    await legacy.source.authorizeWithRoles(legacy.input),
  );
  const result = await x.source.authorizeActionsWithRoles(
    batchInput(x, [f.ACTION, "catalog.product.read"]),
  );
  expect(result).toEqual(
    await legacy.source.authorizeActionsWithRoles(
      batchInput(legacy, [f.ACTION, "catalog.product.read"]),
    ),
  );
  expect(result.decisions).toMatchObject([
    { action: f.ACTION, effect: "Allow" },
    { action: "catalog.product.read", effect: "Deny", source: "DefaultDeny" },
  ]);
  expect(x.calls.filter((call) => call.sql.startsWith("LOCK TABLE"))).toHaveLength(1);
  expect(x.calls.filter((call) => call.sql.includes("set_config"))).toHaveLength(2);
  expect(x.calls.filter((call) => call.sql.startsWith("SELECT jsonb_build_object("))).toHaveLength(
    2,
  );
  expect(legacy.calls.filter((call) => call.sql.startsWith("LOCK TABLE"))).toHaveLength(2);
});
it("transaction source allows Brand-first then the one selected Store without mixing scope facts", async () => {
  const x = fixture(true),
    brand = {
      ...x.input,
      tenantContext: createTenantContext(f.actor, f.brand, null, f.AT),
      storeAssignment: null,
    };
  expect((await x.source.authorize(brand)).scopeKind).toBe("Brand");
  expect((await x.source.authorize(x.input)).scopeKind).toBe("Store");
  expect((await x.source.authorize(brand)).scopeKind).toBe("Brand");
  expect(
    x.calls.filter((call) => call.sql.includes("set_config")).map((call) => call.values),
  ).toEqual([
    [f.BRAND, ""],
    [f.BRAND, f.store.storeReference],
    [f.BRAND, ""],
  ]);
  expect(x.calls.filter((call) => call.sql.startsWith("LOCK TABLE"))).toHaveLength(1);
});
it("transaction source reevaluates unchanged facts at a future deny boundary instead of retaining an Allow", async () => {
  const x = fixture(true);
  x.override.effect = "Deny";
  x.override.effective_from = new Date(after(1000));
  x.rows.permission_override = [x.override];
  const before = await x.source.authorizeWithRoles(x.input);
  expect(before.decision.effect).toBe("Allow");
  expect(before.validUntil).toBe(after(1000));
  const later = await x.source.authorizeWithRoles({
    ...x.input,
    tenantContext: createTenantContext(f.actor, f.brand, f.store, after(1000)),
  });
  expect(later.decision.effect).toBe("Deny");
  expect(later.validUntil).toBeNull();
  expect(x.calls.filter((call) => call.sql.startsWith("SELECT jsonb_build_object("))).toHaveLength(
    2,
  );
});
it.each(["role", "assignment", "grant", "override"] as const)(
  "fresh transaction %s period expiry remains a natural boundary",
  async (group) => {
    const x = fixture(true);
    if (group === "override") x.rows.permission_override = [x.override];
    x[group].effective_until = new Date(after(1000));
    const before = await x.source.authorizeWithRoles(x.input);
    expect(before.validUntil).toBe(after(1000));
    const later = await x.source.authorizeWithRoles({
      ...x.input,
      tenantContext: createTenantContext(f.actor, f.brand, f.store, after(1000)),
    });
    expect(later.decision.effect).toBe(group === "override" ? "Allow" : "Deny");
    expect(later.validUntil).toBeNull();
  },
);
it.each([
  "policy_state",
  "permission_definition",
  "role",
  "role_assignment",
  "permission_grant",
  "permission_override",
] as const)(
  "transaction source detects same-transaction changes to %s even without a policy version advance",
  async (group) => {
    const x = fixture(true);
    if (group === "permission_override") x.rows.permission_override = [x.override];
    await x.source.authorize(x.input);
    const rows = x.rows[group];
    if (!rows) throw new Error("Missing controlled rows");
    const row = requiredRow(rows);
    if (group === "policy_state") row.snapshot_id = f.uuid("98");
    else if (group === "permission_override") row.effect = "Deny";
    else row.lifecycle = group === "role" || group === "role_assignment" ? "Suspended" : "Revoked";
    if (group === "permission_definition") {
      row.lifecycle = "Retired";
    }
    const result = await x.source.authorize(x.input);
    expect(result.effect).toBe(group === "policy_state" ? "Allow" : "Deny");
    if (group === "policy_state") expect(result.policySnapshotReference).toBe(f.uuid("98"));
  },
);
it("fresh context constructor dependencies cannot borrow an earlier validated membership/assignment", async () => {
  const x = fixture(true);
  await x.source.authorize(x.input);
  await expect(x.source.authorize({ ...x.input, storeAssignment: null })).rejects.toMatchObject(
    unavailable,
  );
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("same packet retains timestamp refusal at each new observation", async () => {
  const x = fixture(true);
  x.grant.updated_at = new Date(f.AT);
  await x.source.authorize(x.input);
  await expect(
    x.source.authorize({
      ...x.input,
      tenantContext: createTenantContext(f.actor, f.brand, f.store, f.FROM),
    }),
  ).rejects.toMatchObject(unavailable);
});
it("transaction query replacement permanently refuses further authorization", async () => {
  const x = fixture(true);
  await x.source.authorize(x.input);
  const original = x.transaction.query;
  x.transaction.query = async () => ({ rows: [] });
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  x.transaction.query = original;
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("transaction query drift during an awaited SQL read poisons the captured host", async () => {
  const x = fixture(true),
    original = x.transaction.query;
  x.queryControl.before = async (sql) => {
    if (sql.startsWith("SELECT jsonb_build_object("))
      x.transaction.query = async () => ({ rows: [] });
  };
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  x.transaction.query = original;
  x.queryControl.before = async () => undefined;
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("a fresh over-limit group refuses authorization after an earlier valid packet", async () => {
  const x = fixture(true);
  await x.source.authorize(x.input);
  x.rows.permission_definition = Array.from({ length: 1025 }, () => ({ ...x.definition }));
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  x.rows.permission_definition = [x.definition];
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("transaction packet failure poisons subsequent calls instead of reusing previously allowed facts", async () => {
  const x = fixture(true);
  await x.source.authorize(x.input);
  x.transport.map = (packet) => ({ ...packet, extra: true });
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  x.transport.map = (packet) => packet;
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("future Role activation is reevaluated from unchanged Domain facts", async () => {
  const x = fixture(true);
  x.role.effective_from = new Date(after(1000));
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Deny" },
    validUntil: after(1000),
  });
  expect(
    await x.source.authorizeWithRoles({
      ...x.input,
      tenantContext: createTenantContext(f.actor, f.brand, f.store, after(1000)),
    }),
  ).toMatchObject({ decision: { effect: "Allow" }, validUntil: null });
});
it.each(["Membership", "Store"])(
  "transaction source rejects a different selected %s after a successful observation",
  async (kind) => {
    const x = fixture(true);
    await x.source.authorize(x.input);
    const membership = createMembership(
        { ...f.membership, membershipReference: f.uuid("98") },
        f.actor,
      ),
      store = createStore({ ...f.store, storeReference: f.uuid("98") });
    await expect(
      x.source.authorize(
        kind === "Membership"
          ? { ...x.input, membership }
          : { ...x.input, tenantContext: createTenantContext(f.actor, f.brand, store, f.AT) },
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  },
);
it("failed first SHARE acquisition never permits a packet read or a later cached authorization", async () => {
  const x = fixture(true);
  x.queryControl.before = async (sql) => {
    if (sql.startsWith("LOCK TABLE")) throw new Error("Controlled lock failure");
  };
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  expect(x.calls.some((call) => call.sql.startsWith("SELECT jsonb_build_object("))).toBe(false);
  x.queryControl.before = async () => undefined;
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("a swallowed query-time reentrant authorization poisons the outer call too", async () => {
  const x = fixture(true);
  let entered = false;
  x.queryControl.before = async () => {
    if (entered) return;
    entered = true;
    await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  };
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
  await expect(x.source.authorize(x.input)).rejects.toMatchObject(unavailable);
});
it("fresh constructor dependencies retain validation of inactive Store-role assignments", async () => {
  const x = fixture(true);
  x.rows.role = [{ ...x.role, role_id: f.STORE_ROLE, store_id: f.STORE }];
  x.rows.role_assignment = [
    {
      ...x.assignment,
      role_id: f.STORE_ROLE,
      store_id: f.STORE,
      store_assignment_id: f.STORE_ASSIGNMENT,
      lifecycle: "Suspended",
    },
  ];
  x.rows.permission_grant = [{ ...x.grant, role_id: f.STORE_ROLE, store_id: f.STORE }];
  await x.source.authorize(x.input);
  const different = createStoreAssignment(
    { ...f.storeAssignment, storeAssignmentReference: f.uuid("98") },
    x.input.membership,
    f.store,
  );
  await expect(
    x.source.authorize({ ...x.input, storeAssignment: different }),
  ).rejects.toMatchObject(unavailable);
});
it("batch reads real owning facts once and returns every complete decision in original order", async () => {
  const x = fixture();
  const actions = ["synthetic.unknown.read", f.ACTION, "synthetic.other.read"];
  const result = await x.source.authorizeActionsWithRoles(batchInput(x, actions));
  expect(result.decisions).toMatchObject([
    { action: actions[0], effect: "Deny", source: "DefaultDeny" },
    { action: actions[1], effect: "Allow" },
    { action: actions[2], effect: "Deny", source: "DefaultDeny" },
  ]);
  expect(result.activeRoleCodes).toEqual(["synthetic_brand"]);
  expect(result.validUntil).toBeNull();
  expect(x.calls).toHaveLength(3);
  expect(x.calls.filter((call) => call.sql.startsWith("SELECT jsonb_build_object("))).toHaveLength(
    1,
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.decisions)).toBe(true);
  expect(result.decisions.every(Object.isFrozen)).toBe(true);
});
it("next batch obtains fresh policy rows and does not cache an earlier Allow", async () => {
  const x = fixture();
  const request = batchInput(x, [f.ACTION, "synthetic.unknown.read"]);
  expect((await x.source.authorizeActionsWithRoles(request)).decisions[0]?.effect).toBe("Allow");
  x.override.effect = "Deny";
  x.rows.permission_override = [x.override];
  expect((await x.source.authorizeActionsWithRoles(request)).decisions).toMatchObject([
    { effect: "Deny", source: "ExplicitDeny" },
    { effect: "Deny", source: "DefaultDeny" },
  ]);
  expect(x.calls).toHaveLength(6);
});
it("batch keeps the earliest policy period and owner reevaluates it at the exact boundary", async () => {
  const x = fixture();
  x.override.effect = "Deny";
  x.override.effective_from = new Date(after(1000));
  x.rows.permission_override = [x.override];
  const actions = [f.ACTION, "synthetic.unknown.read"];
  const result = await x.source.authorizeActionsWithRoles(batchInput(x, actions));
  expect(result.validUntil).toBe(after(1000));
  expect(result.decisions[0]?.effect).toBe("Allow");
  x.input.tenantContext = createTenantContext(f.actor, f.brand, f.store, after(1000));
  const next = await x.source.authorizeActionsWithRoles(batchInput(x, actions));
  expect(next.decisions[0]).toMatchObject({ effect: "Deny", source: "ExplicitDeny" });
  expect(next.validUntil).toBeNull();
});
it("Brand batch uses no Store assignment and leaves actual owner Brand RLS", async () => {
  const x = fixture();
  const request = {
    ...batchInput(x, [f.ACTION, "synthetic.unknown.read"]),
    tenantContext: createTenantContext(f.actor, f.brand, null, f.AT),
    storeAssignment: null,
  };
  expect((await x.source.authorizeActionsWithRoles(request)).decisions).toMatchObject([
    { effect: "Allow", scopeKind: "Brand" },
    { effect: "Deny", scopeKind: "Brand" },
  ]);
  expect(x.calls[0]?.values).toEqual([f.BRAND, ""]);
});
it("closed batch rejects getters, duplicates, malformed and oversized actions before SQL", async () => {
  const x = fixture();
  let reads = 0;
  const actions: string[] = [];
  Object.defineProperty(actions, "0", {
    enumerable: true,
    get() {
      reads++;
      return f.ACTION;
    },
  });
  const invalid = [
    [],
    [f.ACTION, f.ACTION],
    ["Bad Action"],
    actions,
    Array.from({ length: 17 }, (_, i) => "synthetic.action" + i),
  ];
  for (const list of invalid)
    await expect(x.source.authorizeActionsWithRoles(batchInput(x, list))).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
  await expect(
    x.source.authorizeActionsWithRoles({
      ...batchInput(x, [f.ACTION]),
      callerEvidence: "untrusted",
    } as never),
  ).rejects.toMatchObject({ code: "PERMISSION_POLICY_MATERIALIZATION_INVALID" });
  expect(reads).toBe(0);
  expect(x.calls).toHaveLength(0);
});
it("invalid source rows fail the entire batch rather than omit an action", async () => {
  const x = fixture();
  x.role.brand_id = f.OTHER_BRAND;
  await expect(
    x.source.authorizeActionsWithRoles(batchInput(x, [f.ACTION, "synthetic.unknown.read"])),
  ).rejects.toMatchObject({ code: "PERMISSION_POLICY_MATERIALIZATION_INVALID" });
});

it("single-action public decisions and metadata remain equivalent to the batch owner", async () => {
  const x = fixture();
  x.grant.effective_until = new Date(after(1000));
  const single = await x.source.authorizeWithRoles(x.input);
  const batch = await x.source.authorizeActionsWithRoles(batchInput(x, [f.ACTION]));
  expect(batch.decisions).toEqual([single.decision]);
  expect(batch.activeRoleCodes).toEqual(single.activeRoleCodes);
  expect(batch.validUntil).toBe(single.validUntil);
  expect(x.calls).toHaveLength(6);
});

it("loads one explicit versioned packet after scope and all six SHARE locks, with original filters and bounds", async () => {
  const x = fixture();
  await x.source.authorizeWithRoles(x.input);
  const sql = x.calls[2]?.sql;
  expect(x.calls).toHaveLength(3);
  expect(sql).toContain("'profile', 'PermissionCurrentPolicyPacketV1'");
  expect(sql).not.toContain("SELECT *");
  expect(sql?.match(/LIMIT 1025/gu)).toHaveLength(6);
  expect(sql).toContain("FROM bop_permission.policy_state WHERE brand_id=$1");
  expect(sql).toContain(
    "FROM bop_permission.permission_definition ORDER BY permission_id LIMIT 1025",
  );
  expect(sql).toContain("AND actor_id=$3 AND membership_id=$4 ORDER BY assignment_id LIMIT 1025");
  expect(sql).toContain("AND actor_id=$3 ORDER BY override_id LIMIT 1025");
  for (const id of ["role_id", "assignment_id", "grant_id", "override_id"])
    expect(sql).toContain("ORDER BY " + id);
  expect(sql).toContain("AT TIME ZONE 'UTC'");
  expect(sql).toContain('YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  expect(sql).toContain("version::text");
  expect(x.calls[2]?.values).toEqual([f.BRAND, f.STORE, f.ACTOR, f.MEMBERSHIP]);
  for (const table of [
    "policy_state",
    "permission_definition",
    "role",
    "role_assignment",
    "permission_grant",
    "permission_override",
  ])
    expect(x.calls[1]?.sql).toContain("bop_permission." + table);
});

it.each([
  "wrongProfile",
  "missingGroup",
  "extraGroup",
  "missingField",
  "extraField",
  "duplicateState",
  "noState",
  "scalarGroup",
  "sparseGroup",
  "extraArrayProperty",
])(
  "rejects %s in the private packet rather than issuing partial permission evidence",
  async (kind) => {
    const x = fixture();
    x.transport.map = (packet) => {
      if (kind === "wrongProfile") packet.profile = "PermissionCurrentPolicyPacketV2";
      if (kind === "missingGroup") Reflect.deleteProperty(packet, "permission_override");
      if (kind === "extraGroup") packet.callerAllow = true;
      if (kind === "missingField") Reflect.deleteProperty(requiredRow(packet.role), "store_id");
      if (kind === "extraField") requiredRow(packet.role).callerAllow = true;
      if (kind === "duplicateState")
        packet.policy_state.push({ ...requiredRow(packet.policy_state) });
      if (kind === "noState") packet.policy_state = [];
      if (kind === "scalarGroup") return { ...packet, permission_grant: null };
      if (kind === "sparseGroup") Reflect.deleteProperty(packet.role, "0");
      if (kind === "extraArrayProperty")
        Object.defineProperty(packet.role, "callerAllow", { value: true });
      return packet;
    };
    await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
  },
);

it.each([
  "policy_state",
  "permission_definition",
  "role",
  "role_assignment",
  "permission_grant",
  "permission_override",
] as const)(
  "rejects over-limit %s transport before materializing a truncated policy",
  async (group) => {
    const x = fixture();
    x.rows.permission_override = [x.override];
    x.transport.map = (packet) => {
      const row = requiredRow(packet[group]);
      packet[group] = Array.from({ length: group === "policy_state" ? 2 : 1025 }, () => ({
        ...row,
      }));
      return packet;
    };
    await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
  },
);

it.each(["group", "row", "arrayItem", "field"])(
  "does not invoke a %s transport accessor",
  async (kind) => {
    const x = fixture();
    let accessorReads = 0;
    const descriptor = {
      enumerable: true,
      get() {
        accessorReads++;
        return true;
      },
    };
    x.transport.map = (packet) => {
      if (kind === "group") Object.defineProperty(packet, "role", descriptor);
      if (kind === "row") Object.defineProperty(requiredRow(packet.role), "version", descriptor);
      if (kind === "arrayItem") Object.defineProperty(packet.role, "0", descriptor);
      if (kind === "field")
        Object.defineProperty(requiredRow(packet.role), "effective_from", descriptor);
      return packet;
    };
    await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
    expect(accessorReads).toBe(0);
  },
);

it.each([
  "2026-02-30T00:00:00.000Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T01:00:00.000+01:00",
  "2026-01-01T00:00:00.0000Z",
  "infinity",
  null,
  new Date(f.FROM),
])("rejects noncanonical or non-JSON timestamp transport %s", async (date) => {
  const x = fixture();
  x.transport.map = (packet) => {
    requiredRow(packet.role).effective_from = date;
    return packet;
  };
  await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
    code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
  });
});

it.each([
  "policy_state",
  "permission_definition",
  "role",
  "role_assignment",
  "permission_grant",
  "permission_override",
] as const)("requires canonical positive decimaltext version even for %s", async (group) => {
  for (const version of ["01", "0", "-1", "1.0", "1e0", "9007199254740992", 1, null]) {
    const x = fixture();
    x.rows.permission_override = [x.override];
    x.transport.map = (packet) => {
      requiredRow(packet[group]).version = version;
      return packet;
    };
    await expect(x.source.authorizeWithRoles(x.input)).rejects.toMatchObject({
      code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
    });
  }
});

it("reconstructs canonical millisecond dates without changing exact future period boundaries", async () => {
  const x = fixture();
  x.grant.effective_until = new Date(after(123));
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Allow" },
    validUntil: after(123),
  });
  x.input.tenantContext = createTenantContext(f.actor, f.brand, f.store, after(123));
  expect(await x.source.authorizeWithRoles(x.input)).toMatchObject({
    decision: { effect: "Deny" },
    validUntil: null,
  });
  expect(x.calls).toHaveLength(6);
});
