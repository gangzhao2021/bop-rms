import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext, parseStoreReference } from "@bop/tenant";
import { expect, it } from "vitest";
import {
  createPostgresCurrentMembershipSource,
  createPostgresStoreAssigneeCandidates,
  createPostgresStoreAssigneeEligibility,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
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
