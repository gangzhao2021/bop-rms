import { createIdentityActor } from "@bop/identity";
import {
  createBrand,
  createBrandAdministrationContext,
  createStore,
  createTenantContext,
  parseStoreReference,
  type TenantContext,
  type BrandAdministrationContext,
} from "@bop/tenant";
import { expect, it } from "vitest";
import {
  createPostgresCurrentBrandMembershipSource,
  createPostgresBrandAdministrationMembershipSource,
  createPostgresBrandAdministrationMembershipActivationSource,
  createPostgresCurrentMembershipSource,
  createPostgresStoreAssigneeCandidates,
  createPostgresStoreAssigneeEligibility,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type MembershipReadTransaction,
} from "../index.js";

const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const from = "2026-09-10T10:00:00.000Z";
const now = "2026-09-10T10:30:00.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: from,
  recentMfaAt: null,
});
const brand = createBrand({
  brandReference: id(2),
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const store = createStore({
  storeReference: id(3),
  brandReference: id(2),
  code: "SYNTHETIC",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const context = createTenantContext(actor, brand, store, now);
function fixture() {
  const parent: Record<string, unknown> = {
    membership_id: id(4),
    actor_id: id(1),
    brand_id: id(2),
    workforce_relationship_reference: id(5),
    lifecycle: "Active",
    effective_from: new Date(from),
    effective_until: null,
    version: 1,
    created_at: new Date(from),
    updated_at: new Date(from),
  };
  const assignment: Record<string, unknown> = {
    assignment_id: id(6),
    membership_id: id(4),
    actor_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    lifecycle: "Active",
    effective_from: new Date(from),
    effective_until: null,
    version: 1,
    created_at: new Date(from),
    updated_at: new Date(from),
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let parents = [parent];
  const source = createPostgresCurrentMembershipSource(
    {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows: sql.startsWith("SELECT * FROM bop_membership.membership")
            ? parents
            : sql.startsWith("SELECT * FROM bop_membership.store_assignment")
              ? [assignment]
              : [],
        };
      },
    },
    context,
  );
  return {
    source,
    parent,
    assignment,
    calls,
    setParents: (value: typeof parents) => {
      parents = value;
    },
  };
}
async function current(f: ReturnType<typeof fixture>) {
  if (actor.actorReference === null) throw new Error("fixture");
  const membership = resolveActiveMembership(
    await f.source.findMemberships(actor.actorReference, brand.brandReference),
    actor.actorReference,
    brand.brandReference,
    now,
  );
  const assignments = await f.source.findStoreAssignments(
    membership.membershipReference,
    store.storeReference,
  );
  return resolveActiveStoreAssignment(membership, assignments, store.storeReference, now);
}
it("reads owner rows under scoped transaction fences and resolves current access", async () => {
  const f = fixture();
  expect((await current(f)).storeReference).toBe(store.storeReference);
  expect(f.calls[0]?.values).toEqual([brand.brandReference, store.storeReference]);
  expect(f.calls[1]?.sql).toContain("IN SHARE MODE");
});
it("denies a foreign requested Store before any database query", async () => {
  const f = fixture();
  if (actor.actorReference === null) throw new Error("fixture");
  const membership = (
    await f.source.findMemberships(actor.actorReference, brand.brandReference)
  )[0];
  if (!membership) throw new Error("fixture");
  f.calls.length = 0;
  await expect(
    f.source.findStoreAssignments(membership.membershipReference, parseStoreReference(id(9))),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it.each(["Suspended", "Ended"])("preserves %s membership for domain denial", async (lifecycle) => {
  const f = fixture();
  f.parent.lifecycle = lifecycle;
  await expect(current(f)).rejects.toThrow("active membership was not found");
});
it("rejects ambiguous active membership instead of selecting the first", async () => {
  const f = fixture();
  f.setParents([f.parent, { ...f.parent, membership_id: id(7) }]);
  await expect(current(f)).rejects.toThrow("active membership is ambiguous");
});
it.each(["actor_id", "brand_id", "store_id"])("rejects foreign assignment %s", async (field) => {
  const f = fixture();
  f.assignment[field] = id(9);
  await expect(current(f)).rejects.toThrow();
});
it("rejects future database state and bounded-result overflow", async () => {
  const f = fixture();
  f.parent.updated_at = new Date("2026-09-11T10:00:00.000Z");
  await expect(current(f)).rejects.toThrow();
  f.parent.updated_at = new Date(from);
  f.setParents(Array.from({ length: 1025 }, () => f.parent));
  await expect(current(f)).rejects.toThrow();
});

const brandContext = createTenantContext(actor, brand, null, now);
function brandFixture(
  input: TenantContext | BrandAdministrationContext = brandContext,
  activation = false,
) {
  if (actor.actorReference === null) throw new Error("fixture");
  const reference = actor.actorReference;
  const parent: Record<string, unknown> = {
    ...fixture().parent,
    effective_from: from,
    effective_until: null,
    created_at: from,
    updated_at: from,
    precise: true,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const state = {
    result: { rows: [parent] } as unknown,
    beforeReturn: null as ((sql: string) => Promise<void>) | null,
  };
  const tx: MembershipReadTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      await state.beforeReturn?.(sql);
      return sql.includes("FROM bop_membership.membership") ? state.result : { rows: [] };
    },
  };
  const source =
    "profile" in input
      ? activation
        ? createPostgresBrandAdministrationMembershipActivationSource(tx, input)
        : createPostgresBrandAdministrationMembershipSource(tx, input)
      : createPostgresCurrentBrandMembershipSource(tx, input);
  return {
    parent,
    calls,
    state,
    tx,
    source,
    read: () => source.findMemberships(reference, brand.brandReference),
    current: async () =>
      resolveActiveMembership(
        await source.findMemberships(reference, brand.brandReference),
        reference,
        brand.brandReference,
        now,
      ),
  };
}
it("reads fresh Brand membership rows without a Store assignment or permission claim", async () => {
  const f = brandFixture();
  const result = await f.current();
  expect(result.membershipReference).toBe(id(4));
  expect(result.effectiveFrom).toBe(from);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.keys(f.source)).toEqual(["findMemberships"]);
  expect(f.calls[0]?.values).toEqual([brand.brandReference, ""]);
  expect(f.calls[1]?.sql).toBe("LOCK TABLE bop_membership.membership IN SHARE MODE");
  expect(f.calls[2]?.values).toEqual([actor.actorReference, brand.brandReference]);
  expect(f.calls[2]?.sql).toContain("ORDER BY membership_id LIMIT 1025");
  expect(f.calls[2]?.sql).toContain("AT TIME ZONE 'UTC'");
  for (const field of ["effective_from", "effective_until", "created_at", "updated_at"])
    expect(f.calls[2]?.sql).toContain(`${field}=date_trunc('milliseconds',${field})`);
  expect(f.calls.every((call) => !call.sql.includes("store_assignment"))).toBe(true);
  f.state.result = { rows: [] };
  const empty = await f.read();
  expect(empty).toEqual([]);
  expect(Object.isFrozen(empty)).toBe(true);
  expect(f.calls).toHaveLength(6);
});
it("keeps the existing Store reader unavailable for a Brand-only context", () => {
  expect(() =>
    createPostgresCurrentMembershipSource({ query: async () => ({}) }, brandContext),
  ).toThrow("membership input is invalid");
});
it.each(["Store", "scopeKind", "DraftBrand", "nonWorkforceActor", "mutableContext"])(
  "rejects invalid Brand-only context before SQL: %s",
  (reason) => {
    const f = brandFixture();
    const input = {
      ...brandContext,
      ...(reason === "Store" ? { store, scopeKind: "Store" } : {}),
      ...(reason === "scopeKind" ? { scopeKind: "Store" } : {}),
      ...(reason === "DraftBrand" ? { brand: { ...brand, lifecycle: "Draft" } } : {}),
      ...(reason === "nonWorkforceActor" ? { actor: { ...actor, accountKind: "Customer" } } : {}),
    } as TenantContext;
    if (reason !== "mutableContext") Object.freeze(input);
    expect(() => createPostgresCurrentBrandMembershipSource(f.tx, input)).toThrow(
      "membership input is invalid",
    );
    expect(f.calls).toHaveLength(0);
  },
);
it.each(["Actor", "Brand"])("rejects requested foreign %s before SQL", async (scope) => {
  const f = brandFixture();
  const otherActor = createIdentityActor({ ...actor, actorReference: id(99) });
  const otherBrand = createBrand({ ...brand, brandReference: id(99) });
  const reference = scope === "Actor" ? otherActor.actorReference : actor.actorReference;
  if (reference === null) throw new Error("fixture");
  await expect(
    f.source.findMemberships(
      reference,
      scope === "Brand" ? otherBrand.brandReference : brand.brandReference,
    ),
  ).rejects.toThrow("membership input is invalid");
  expect(f.calls).toHaveLength(0);
});
it.each(["PendingActivation", "Suspended", "Ended"])(
  "preserves %s Brand membership facts for Domain resolution",
  async (lifecycle) => {
    const f = brandFixture();
    f.state.result = { rows: [{ ...f.parent, lifecycle }] };
    expect((await f.read())[0]?.lifecycle).toBe(lifecycle);
    await expect(f.current()).rejects.toThrow("active membership was not found");
  },
);
it.each(["future", "expired", "ambiguous"])(
  "lets the owning Domain reject %s Brand memberships",
  async (reason) => {
    const f = brandFixture();
    const row = {
      ...f.parent,
      ...(reason === "future" ? { effective_from: "2026-09-11T10:00:00.000Z" } : {}),
      ...(reason === "expired" ? { effective_until: now } : {}),
    };
    f.state.result = {
      rows: reason === "ambiguous" ? [row, { ...row, membership_id: id(7) }] : [row],
    };
    await expect(f.current()).rejects.toThrow(
      reason === "ambiguous" ? "active membership is ambiguous" : "active membership was not found",
    );
  },
);
it.each([
  ["actor_id", id(99)],
  ["brand_id", id(99)],
  ["workforce_relationship_reference", null],
  ["membership_id", "invalid"],
  ["version", 0],
  ["updated_at", "2026-09-11T10:00:00.000Z"],
  ["effective_from", "2026-09-10T10:00:00.000001Z"],
  ["effective_until", "2026-09-10T10:30:00.000001Z"],
  ["created_at", new Date(from)],
  ["precise", false],
] as const)("rejects the whole Brand membership page for invalid %s", async (field, value) => {
  const f = brandFixture();
  f.state.result = { rows: [f.parent, { ...f.parent, membership_id: id(7), [field]: value }] };
  await expect(f.read()).rejects.toThrow("membership input is invalid");
});
it.each(["sparse", "getter", "rowGetter", "extraField", "duplicate", "outOfOrder", "overflow"])(
  "rejects unsafe Brand membership page: %s",
  async (reason) => {
    const f = brandFixture();
    let touched = false;
    const page: unknown[] = [f.parent];
    if (reason === "sparse") page.length = 2;
    if (reason === "getter")
      Object.defineProperty(page, "0", {
        enumerable: true,
        get: () => {
          touched = true;
          return f.parent;
        },
      });
    if (reason === "rowGetter")
      Object.defineProperty(f.parent, "actor_id", {
        enumerable: true,
        get: () => {
          touched = true;
          return id(1);
        },
      });
    if (reason === "extraField") page[0] = { ...f.parent, unknown: true };
    if (reason === "duplicate") page.push(f.parent);
    if (reason === "outOfOrder") page.unshift({ ...f.parent, membership_id: id(7) });
    f.state.result = { rows: reason === "overflow" ? Array(1025).fill(f.parent) : page };
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(touched).toBe(false);
  },
);
it("accepts exactly 1024 owner rows and refuses an accessor result without invoking it", async () => {
  const f = brandFixture();
  f.state.result = {
    rows: Array.from({ length: 1024 }, (_, index) => ({
      ...f.parent,
      membership_id: id(index + 4),
    })),
  };
  expect(await f.read()).toHaveLength(1024);
  let touched = false;
  f.state.result = Object.defineProperty({}, "rows", {
    get: () => {
      touched = true;
      return [];
    },
  });
  await expect(f.read()).rejects.toThrow("membership input is invalid");
  expect(touched).toBe(false);
});
it.each([0, 1, 2, 3])(
  "rejects and poisons transaction query replacement at checkpoint %s",
  async (at) => {
    const f = brandFixture();
    const original = f.tx.query;
    let replacementCalls = 0;
    const replacement = async () => {
      replacementCalls += 1;
      return { rows: [] };
    };
    if (at === 0) f.tx.query = replacement;
    else
      f.state.beforeReturn = async () => {
        if (f.calls.length === at) f.tx.query = replacement;
      };
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(replacementCalls).toBe(0);
    const count = f.calls.length;
    f.tx.query = original;
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(f.calls).toHaveLength(count);
  },
);
it("poisons caught reentry and does not return a successful outer Brand read", async () => {
  const f = brandFixture();
  f.state.beforeReturn = async () => {
    f.state.beforeReturn = null;
    await expect(f.read()).rejects.toThrow("membership input is invalid");
  };
  await expect(f.read()).rejects.toThrow("membership input is invalid");
  expect(f.calls).toHaveLength(1);
});
it("maps SQL failures to the finite owner error without raw details", async () => {
  const f = brandFixture();
  f.state.beforeReturn = async () => {
    throw new Error("synthetic database detail");
  };
  await expect(f.read()).rejects.toThrow("membership input is invalid");
});

it.each(["Draft", "Active", "Suspended", "Archived"] as const)(
  "reads genuine %s Brand administrative memberships with Tenant equal to Brand and no Store",
  async (lifecycle) => {
    const input = createBrandAdministrationContext(
      actor,
      createBrand({ ...brand, lifecycle }),
      now,
    );
    const f = brandFixture(input);
    const result = await f.current();
    expect(result.membershipReference).toBe(id(4));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(f.source)).toEqual(["findMemberships"]);
    expect(f.calls[0]?.sql).toContain("set_config('bop.tenant_id',$1,true)");
    expect(f.calls[0]?.sql).toContain("set_config('bop.brand_id',$1,true)");
    expect(f.calls[0]?.values).toEqual([brand.brandReference, ""]);
    expect(f.calls[1]?.sql).toBe("LOCK TABLE bop_membership.membership IN SHARE MODE");
    expect(f.calls[2]?.values).toEqual([actor.actorReference, brand.brandReference]);
    expect(f.calls.every((call) => !call.sql.includes("store_assignment"))).toBe(true);
  },
);

const administrativeContext = () =>
  createBrandAdministrationContext(actor, createBrand({ ...brand, lifecycle: "Draft" }), now);

it.each([
  "operational",
  "Store",
  "purpose",
  "profile",
  "actor",
  "futureBrand",
  "futureActor",
  "getter",
])("rejects invalid administrative context before SQL: %s", (reason) => {
  const f = brandFixture();
  let input: unknown = {
    ...administrativeContext(),
    ...(reason === "Store" ? { store } : {}),
    ...(reason === "purpose" ? { purposeCode: "OTHER" } : {}),
    ...(reason === "profile" ? { profile: "OtherV1" } : {}),
    ...(reason === "actor" ? { actor: { ...actor, status: "Suspended" } } : {}),
    ...(reason === "futureBrand"
      ? { brand: { ...brand, updatedAt: "2026-09-11T10:00:00.000Z" } }
      : {}),
    ...(reason === "futureActor"
      ? { actor: { ...actor, authenticatedAt: "2026-09-11T10:00:00.000Z" } }
      : {}),
  };
  if (reason === "operational") input = brandContext;
  let touched = false;
  if (reason === "getter")
    Object.defineProperty(input, "actor", {
      enumerable: true,
      get: () => {
        touched = true;
        return actor;
      },
    });
  for (const factory of [
    createPostgresBrandAdministrationMembershipSource,
    createPostgresBrandAdministrationMembershipActivationSource,
  ])
    expect(() => Reflect.apply(factory, undefined, [f.tx, input])).toThrow(
      "membership input is invalid",
    );
  expect(touched).toBe(false);
  expect(f.calls).toHaveLength(0);
});

it("does not admit an administrative context through either ordinary factory", () => {
  const f = brandFixture();
  for (const factory of [
    createPostgresCurrentBrandMembershipSource,
    createPostgresCurrentMembershipSource,
  ])
    expect(() => Reflect.apply(factory, undefined, [f.tx, administrativeContext()])).toThrow();
  expect(f.calls).toHaveLength(0);
});

it.each([
  "foreignActor",
  "foreignBrand",
  "missingRelationship",
  "future",
  "futureRow",
  "expired",
  "inactive",
  "absent",
  "ambiguous",
  "imprecise",
  "overflow",
])("refuses administrative active Membership resolution: %s", async (reason) => {
  const f = brandFixture(administrativeContext());
  const row = {
    ...f.parent,
    ...(reason === "foreignActor" ? { actor_id: id(99) } : {}),
    ...(reason === "foreignBrand" ? { brand_id: id(99) } : {}),
    ...(reason === "missingRelationship" ? { workforce_relationship_reference: null } : {}),
    ...(reason === "future" ? { effective_from: "2026-09-11T10:00:00.000Z" } : {}),
    ...(reason === "futureRow" ? { updated_at: "2026-09-11T10:00:00.000Z" } : {}),
    ...(reason === "expired" ? { effective_until: now } : {}),
    ...(reason === "inactive" ? { lifecycle: "Suspended" } : {}),
    ...(reason === "imprecise" ? { precise: false } : {}),
  };
  f.state.result = {
    rows:
      reason === "absent"
        ? []
        : reason === "ambiguous"
          ? [row, { ...row, membership_id: id(7) }]
          : reason === "overflow"
            ? Array(1025).fill(row)
            : [row],
  };
  await expect(f.current()).rejects.toThrow();
});

it.each(["Actor", "Brand"])(
  "poisons a foreign administrative requested %s before SQL",
  async (kind) => {
    const f = brandFixture(administrativeContext());
    const other = createIdentityActor({ ...actor, actorReference: id(99) });
    if (actor.actorReference === null || other.actorReference === null) throw Error("fixture");
    await expect(
      f.source.findMemberships(
        kind === "Actor" ? other.actorReference : actor.actorReference,
        kind === "Brand"
          ? createBrand({ ...brand, brandReference: id(99) }).brandReference
          : brand.brandReference,
      ),
    ).rejects.toThrow("membership input is invalid");
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(f.calls).toHaveLength(0);
  },
);

it.each([0, 1, 2, 3])(
  "poisons administrative transaction port drift at checkpoint %s",
  async (at) => {
    const f = brandFixture(administrativeContext());
    const original = f.tx.query;
    let replacementCalls = 0;
    const replacement = async () => {
      replacementCalls += 1;
      return { rows: [] };
    };
    if (at === 0) f.tx.query = replacement;
    else
      f.state.beforeReturn = async () => {
        if (f.calls.length === at) f.tx.query = replacement;
      };
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(replacementCalls).toBe(0);
    const count = f.calls.length;
    f.tx.query = original;
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(f.calls).toHaveLength(count);
  },
);

it("poisons administrative reentry and never grants Membership from an absent row", async () => {
  const f = brandFixture(administrativeContext());
  f.state.beforeReturn = async () => {
    f.state.beforeReturn = null;
    await expect(f.read()).rejects.toThrow("membership input is invalid");
  };
  await expect(f.read()).rejects.toThrow("membership input is invalid");
  expect(f.calls).toHaveLength(1);
  const absent = brandFixture(administrativeContext());
  absent.state.result = { rows: [] };
  expect(await absent.read()).toEqual([]);
  await expect(absent.current()).rejects.toThrow("active membership was not found");
});

it("takes activation SRE before SHARE and actual Pending read without operational permission", async () => {
  const target = createIdentityActor({
    ...actor,
    verificationLevel: "RecentMfa",
    authenticatedAt: now,
    recentMfaAt: now,
  });
  const input = createBrandAdministrationContext(
    target,
    createBrand({ ...brand, lifecycle: "Draft" }),
    now,
  );
  const f = brandFixture(input, true);
  f.parent.lifecycle = "PendingActivation";
  const result = await f.read();
  expect(result[0]?.lifecycle).toBe("PendingActivation");
  expect(result[0]?.version).toBe(1);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
  expect(Object.keys(f.source)).toEqual(["findMemberships"]);
  expect(f.calls[0]?.values).toEqual([brand.brandReference, ""]);
  expect(f.calls[1]?.sql).toBe("LOCK TABLE bop_membership.membership IN SHARE ROW EXCLUSIVE MODE");
  expect(f.calls[2]?.sql).toBe("LOCK TABLE bop_membership.membership IN SHARE MODE");
  expect(f.calls[3]?.sql).toContain(
    "FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2",
  );
  expect(f.calls[3]?.values).toEqual([actor.actorReference, brand.brandReference]);
  expect(
    f.calls.some((call) => call.sql.includes("store_assignment") || call.sql.startsWith("UPDATE")),
  ).toBe(false);
  await expect(f.current()).rejects.toThrow("active membership was not found");
  f.state.result = { rows: [] };
  expect(await f.read()).toEqual([]);
});

it("keeps both ordinary Brand read admissions on SHARE without activation SRE", async () => {
  for (const input of [brandContext, administrativeContext()]) {
    const f = brandFixture(input);
    await f.read();
    expect(
      f.calls.filter((call) => call.sql.startsWith("LOCK TABLE")).map((call) => call.sql),
    ).toEqual(["LOCK TABLE bop_membership.membership IN SHARE MODE"]);
  }
});

it.each(["Actor", "Brand"])(
  "poisons foreign activation %s requests before any lock",
  async (kind) => {
    const f = brandFixture(administrativeContext(), true);
    const other = createIdentityActor({ ...actor, actorReference: id(99) });
    if (actor.actorReference === null || other.actorReference === null) throw new Error("fixture");
    await expect(
      f.source.findMemberships(
        kind === "Actor" ? other.actorReference : actor.actorReference,
        kind === "Brand"
          ? createBrand({ ...brand, brandReference: id(99) }).brandReference
          : brand.brandReference,
      ),
    ).rejects.toThrow("membership input is invalid");
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(f.calls).toHaveLength(0);
  },
);

it.each([1, 2, 3, 4])(
  "poisons activation port drift at checkpoint %s without invoking the replacement",
  async (at) => {
    const f = brandFixture(administrativeContext(), true),
      original = f.tx.query;
    let replacements = 0;
    f.state.beforeReturn = async () => {
      if (f.calls.length === at)
        f.tx.query = async () => {
          replacements++;
          return { rows: [] };
        };
    };
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(replacements).toBe(0);
    const count = f.calls.length;
    f.tx.query = original;
    await expect(f.read()).rejects.toThrow("membership input is invalid");
    expect(f.calls).toHaveLength(count);
  },
);

it("poisons caught activation reentry at SRE and malformed actual rows", async () => {
  const f = brandFixture(administrativeContext(), true);
  f.state.beforeReturn = async (sql) => {
    if (sql.includes("SHARE ROW EXCLUSIVE")) {
      f.state.beforeReturn = null;
      await expect(f.read()).rejects.toThrow("membership input is invalid");
    }
  };
  await expect(f.read()).rejects.toThrow("membership input is invalid");
  expect(f.calls).toHaveLength(2);
  const malformed = brandFixture(administrativeContext(), true);
  malformed.parent.precise = false;
  await expect(malformed.read()).rejects.toThrow("membership input is invalid");
  malformed.parent.precise = true;
  const count = malformed.calls.length;
  await expect(malformed.read()).rejects.toThrow("membership input is invalid");
  expect(malformed.calls).toHaveLength(count);
});

function eligibilityFixture() {
  const f = fixture();
  f.parent.actor_id = id(9);
  f.assignment.actor_id = id(9);
  const state = { allowed: true, duplicate: false, identityChanged: false };
  let reads = 0;
  const eligibility = createPostgresStoreAssigneeEligibility({
    authorize: async () => state.allowed,
    targetActor: async () =>
      createIdentityActor({
        ...actor,
        actorReference: id(state.identityChanged && ++reads > 1 ? 10 : 9),
      }),
  });
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      f.calls.push({ sql, values });
      return {
        rows: sql.startsWith("SELECT * FROM bop_membership.membership")
          ? state.duplicate
            ? [f.parent, f.parent]
            : [f.parent]
          : sql.startsWith("SELECT * FROM bop_membership.store_assignment")
            ? [f.assignment]
            : [],
      };
    },
  };
  return { ...f, state, read: () => eligibility(tx, { context, assigneeReference: id(9) }) };
}
it("authorizes target employee eligibility through owner facts without changing operator identity", async () => {
  const f = eligibilityFixture();
  expect(await f.read()).toBe(true);
  expect(context.actor.actorReference).toBe(id(1));
  expect(f.calls.some((c) => c.sql.startsWith("LOCK TABLE"))).toBe(true);
  expect(
    f.calls
      .filter((c) => c.sql.startsWith("SELECT * FROM bop_membership.membership"))
      .every((c) => c.values.includes(id(9))),
  ).toBe(true);
});
it("does not read target membership when requester authorization is denied", async () => {
  const f = eligibilityFixture();
  f.state.allowed = false;
  expect(await f.read()).toBe(false);
  expect(f.calls).toHaveLength(0);
});
it.each(["expired", "foreignStore", "ambiguous", "identityChanged"])(
  "denies ineligible target: %s",
  async (reason) => {
    const f = eligibilityFixture();
    if (reason === "expired") f.assignment.effective_until = new Date(now);
    if (reason === "foreignStore") f.assignment.store_id = id(99);
    if (reason === "ambiguous") f.state.duplicate = true;
    if (reason === "identityChanged") f.state.identityChanged = true;
    expect(await f.read()).toBe(false);
  },
);

function candidatesFixture() {
  const state = {
    allowed: true,
    revoke: false,
    values: [
      { actor_id: id(8), brand_id: id(2), store_id: id(3) },
      { actor_id: id(9), brand_id: id(2), store_id: id(3) },
    ],
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT DISTINCT")) {
        if (state.revoke) state.allowed = false;
        return { rows: state.values };
      }
      return { rows: [] };
    },
  };
  const read = createPostgresStoreAssigneeCandidates({
    authorize: async (t, c, purpose) => {
      expect(t).toBe(tx);
      expect(c.actor.actorReference).toBe(id(1));
      expect(purpose).toBe("DiscoverStoreAssignees");
      return state.allowed;
    },
  });
  return {
    state,
    calls,
    read: (afterActorReference: string | null = null, limit = 1) =>
      read(tx, { context, afterActorReference, limit }),
  };
}
it("pages scoped membership candidates without manufacturing Identity facts", async () => {
  const f = candidatesFixture();
  expect(await f.read()).toEqual({ actorReferences: [id(8)], nextAfterActorReference: id(8) });
  expect(f.calls[1]?.values).toEqual([id(2), id(3), now, null, 2]);
  f.state.values = f.state.values.slice(1);
  expect(await f.read(id(8))).toEqual({ actorReferences: [id(9)], nextAfterActorReference: null });
});
it("denies discovery before SQL and after authorization revocation", async () => {
  const f = candidatesFixture();
  f.state.allowed = false;
  await expect(f.read()).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.state.allowed = true;
  f.state.revoke = true;
  await expect(f.read()).rejects.toThrow();
});
it.each(["foreignStore", "foreignBrand", "duplicate", "cursor", "limit"])(
  "rejects invalid candidate discovery %s",
  async (reason) => {
    const f = candidatesFixture();
    const first = f.state.values[0];
    if (!first) throw Error("missing fixture");
    if (reason === "foreignStore") first.store_id = id(99);
    if (reason === "foreignBrand") first.brand_id = id(99);
    if (reason === "duplicate") f.state.values[1] = first;
    await expect(
      f.read(reason === "cursor" ? id(8) : null, reason === "limit" ? 51 : 1),
    ).rejects.toThrow();
  },
);
