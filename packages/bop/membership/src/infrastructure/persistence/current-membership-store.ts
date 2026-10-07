import { createIdentityActor, parseOpaqueUuidV7, type IdentityActor } from "@bop/identity";
import {
  createTenantContext,
  parseBrandAdministrationContext,
  type BrandAdministrationContext,
  type TenantContext,
} from "@bop/tenant";
import type { MembershipPort } from "../../application/ports/membership-port.js";
import {
  MembershipContractError,
  createMembership,
  createStoreAssignment,
  parseMembershipInstant,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "../../domain/membership.js";

export interface MembershipReadTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export type CurrentMembershipReadPort = Pick<
  MembershipPort,
  "findMemberships" | "findStoreAssignments"
>;
export type CurrentBrandMembershipReadPort = Pick<MembershipPort, "findMemberships">;
const unavailable = (): never => {
  throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  if (descriptor.value.length > 1024) return unavailable();
  return descriptor.value;
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return value.toISOString();
}
function membership(
  row: Record<string, unknown>,
  context: Pick<TenantContext, "actor" | "brand" | "resolvedAt">,
  readInstant: (value: unknown) => string,
) {
  if (
    row.actor_id !== context.actor.actorReference ||
    row.brand_id !== context.brand.brandReference
  )
    return unavailable();
  const result = createMembership(
    {
      membershipReference: row.membership_id,
      actorReference: row.actor_id,
      brandReference: row.brand_id,
      workforceRelationshipReference: row.workforce_relationship_reference,
      lifecycle: row.lifecycle,
      effectiveFrom: readInstant(row.effective_from),
      effectiveUntil: row.effective_until === null ? null : readInstant(row.effective_until),
      version: row.version,
      createdAt: readInstant(row.created_at),
      updatedAt: readInstant(row.updated_at),
    },
    context.actor,
  );
  if (Date.parse(result.updatedAt) > Date.parse(context.resolvedAt)) return unavailable();
  return result;
}

function brandMembershipRows(value: unknown): readonly Record<string, unknown>[] {
  const result = rows(value);
  if (
    Object.getPrototypeOf(result) !== Array.prototype ||
    Reflect.ownKeys(result).length !== result.length + 1
  )
    return unavailable();
  const keys = [
    "membership_id",
    "actor_id",
    "brand_id",
    "workforce_relationship_reference",
    "lifecycle",
    "effective_from",
    "effective_until",
    "version",
    "created_at",
    "updated_at",
    "precise",
  ];
  return Array.from({ length: result.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(result, String(index));
    if (!entry?.enumerable || !("value" in entry)) return unavailable();
    const row: unknown = entry.value;
    if (
      !row ||
      typeof row !== "object" ||
      Object.getPrototypeOf(row) !== Object.prototype ||
      Reflect.ownKeys(row).length !== keys.length
    )
      return unavailable();
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(row, key);
      if (!field?.enumerable || !("value" in field)) return unavailable();
      copy[key] = field.value;
    }
    if (copy.precise !== true) return unavailable();
    return copy;
  });
}

/** Internal Brand-only owner reader. The outer transaction must hold actual
 * current Identity/Tenant facts and final IAM authority. Membership rows prove
 * neither authentication, Tenant association nor permission. Requires the own
 * internal role; no Store assignment is inferred or read. */
export function createPostgresCurrentBrandMembershipSource(
  tx: MembershipReadTransaction,
  input: TenantContext,
): CurrentBrandMembershipReadPort {
  let context: TenantContext;
  try {
    const keys = ["actor", "brand", "store", "scopeKind", "resolvedAt"];
    if (
      !input ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      !Object.isFrozen(input) ||
      Reflect.ownKeys(input).length !== keys.length ||
      keys.some((key) => {
        const field = Object.getOwnPropertyDescriptor(input, key);
        return !field?.enumerable || !("value" in field);
      }) ||
      input.store !== null ||
      input.scopeKind !== "Brand"
    )
      return unavailable();
    context = createTenantContext(input.actor, input.brand, input.store, input.resolvedAt);
  } catch {
    return unavailable();
  }
  return brandMembershipSource(tx, context, false);
}

/** Administrative Membership facts only. Tenant validates the real Brand
 * lifecycle and Workforce Actor; Identity and IAM retain authority in the same
 * transaction. This reader grants no permission and never reads a Store. */
export function createPostgresBrandAdministrationMembershipSource(
  tx: MembershipReadTransaction,
  input: BrandAdministrationContext,
): CurrentBrandMembershipReadPort {
  return administrativeMembershipSource(tx, input, false);
}

/** Admission for the actual intended Workforce Actor's onboarding activation.
 * Take the owning write-compatible table fence before any Membership SHARE/read,
 * so different Brands cannot both retain SHARE and then upgrade for UPDATE.
 * The returned Pending receipt is inert; the activation writer owns the exact
 * successor and final guard. Identity/Brand/approval remain actual outer facts. */
export function createPostgresBrandAdministrationMembershipActivationSource(
  tx: MembershipReadTransaction,
  input: BrandAdministrationContext,
): CurrentBrandMembershipReadPort {
  return administrativeMembershipSource(tx, input, true);
}

function administrativeMembershipSource(
  tx: MembershipReadTransaction,
  input: BrandAdministrationContext,
  activation: boolean,
): CurrentBrandMembershipReadPort {
  let context: BrandAdministrationContext;
  try {
    context = parseBrandAdministrationContext(input);
  } catch {
    return unavailable();
  }
  return brandMembershipSource(tx, context, true, activation);
}

function brandMembershipSource(
  tx: MembershipReadTransaction,
  context: Pick<TenantContext, "actor" | "brand" | "resolvedAt">,
  administrative: boolean,
  activation = false,
): CurrentBrandMembershipReadPort {
  const actor = context.actor.actorReference;
  const brand = context.brand.brandReference;
  const queryPort = tx.query;
  if (actor === null || typeof queryPort !== "function") return unavailable();
  let active = false,
    poisoned = false;
  const check = () => {
    if (poisoned || tx.query !== queryPort) {
      poisoned = true;
      return unavailable();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  return Object.freeze({
    async findMemberships(actorReference, brandReference) {
      try {
        if (active || actorReference !== actor || brandReference !== brand) return unavailable();
        active = true;
        await query(
          administrative
            ? "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)"
            : "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, ""],
        );
        if (activation)
          await query("LOCK TABLE bop_membership.membership IN SHARE ROW EXCLUSIVE MODE", []);
        await query("LOCK TABLE bop_membership.membership IN SHARE MODE", []);
        const records = brandMembershipRows(
          await query(
            `SELECT membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,version,
              to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_from,
              to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_until,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
              effective_from=date_trunc('milliseconds',effective_from)
                AND (effective_until IS NULL OR effective_until=date_trunc('milliseconds',effective_until))
                AND created_at=date_trunc('milliseconds',created_at)
                AND updated_at=date_trunc('milliseconds',updated_at) AS precise
              FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2
              ORDER BY membership_id LIMIT 1025`,
            [actor, brand],
          ),
        );
        let previous = "";
        const memberships = records.map((row) => {
          const result = membership(row, context, parseMembershipInstant);
          if (result.membershipReference <= previous) return unavailable();
          previous = result.membershipReference;
          return result;
        });
        check();
        return Object.freeze(memberships);
      } catch {
        poisoned = true;
        return unavailable();
      } finally {
        active = false;
      }
    },
  });
}

/** Internal owner reader. Identity/Tenant must fence their current facts in this
 * same transaction. SHARE locks also prevent new competing assignments; requires
 * the internal owner role, never a browser-facing database principal. */
export function createPostgresCurrentMembershipSource(
  tx: MembershipReadTransaction,
  input: TenantContext,
): CurrentMembershipReadPort {
  const context = createTenantContext(input.actor, input.brand, input.store, input.resolvedAt);
  const actor = context.actor.actorReference;
  const brand = context.brand.brandReference;
  const store = context.store;
  if (actor === null || store === null) return unavailable();

  async function fence() {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store?.storeReference,
    ]);
    await tx.query(
      "LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN SHARE MODE",
      [],
    );
  }
  return Object.freeze({
    async findMemberships(actorReference, brandReference) {
      try {
        if (actorReference !== actor || brandReference !== brand) return unavailable();
        await fence();
        return Object.freeze(
          rows(
            await tx.query(
              "SELECT * FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2 ORDER BY membership_id LIMIT 1025",
              [actor, brand],
            ),
          ).map((row) => membership(row, context, instant)),
        );
      } catch {
        return unavailable();
      }
    },
    async findStoreAssignments(membershipReference, storeReference) {
      try {
        if (storeReference !== store.storeReference) return unavailable();
        await fence();
        const candidates = rows(
          await tx.query(
            "SELECT * FROM bop_membership.membership WHERE membership_id=$1 AND actor_id=$2 AND brand_id=$3",
            [membershipReference, actor, brand],
          ),
        );
        if (candidates.length !== 1) return unavailable();
        const row = candidates[0];
        if (!row || row.membership_id !== membershipReference) return unavailable();
        const parent = membership(row, context, instant);
        return Object.freeze(
          rows(
            await tx.query(
              "SELECT * FROM bop_membership.store_assignment WHERE membership_id=$1 AND actor_id=$2 AND brand_id=$3 AND store_id=$4 ORDER BY assignment_id LIMIT 1025",
              [membershipReference, actor, brand, store.storeReference],
            ),
          ).map((record) => {
            const result = createStoreAssignment(
              {
                storeAssignmentReference: record.assignment_id,
                membershipReference: record.membership_id,
                actorReference: record.actor_id,
                brandReference: record.brand_id,
                storeReference: record.store_id,
                lifecycle: record.lifecycle,
                effectiveFrom: instant(record.effective_from),
                effectiveUntil:
                  record.effective_until === null ? null : instant(record.effective_until),
                version: record.version,
                createdAt: instant(record.created_at),
                updatedAt: instant(record.updated_at),
              },
              parent,
              store,
            );
            if (Date.parse(result.updatedAt) > Date.parse(context.resolvedAt)) return unavailable();
            return result;
          }),
        );
      } catch {
        return unavailable();
      }
    },
  });
}

/** Owner query only: target identity comes from Identity, while request authority
 * remains the original operator. This does not authenticate or act as the target.
 */
export function createPostgresStoreAssigneeEligibility(options: {
  authorize(
    tx: MembershipReadTransaction,
    context: TenantContext,
    purpose: "AssignStoreWork",
  ): Promise<boolean>;
  targetActor(tx: MembershipReadTransaction, reference: string): Promise<IdentityActor>;
}) {
  return async (
    tx: MembershipReadTransaction,
    input: { context: TenantContext; assigneeReference: string },
  ): Promise<boolean> => {
    try {
      const requester = createTenantContext(
        input.context.actor,
        input.context.brand,
        input.context.store,
        input.context.resolvedAt,
      );
      const requestedReference = parseOpaqueUuidV7(
        input.assigneeReference,
        "ACTOR_REFERENCE_INVALID",
      );
      if (
        requester.actor.actorType !== "User" ||
        requester.actor.accountKind !== "Workforce" ||
        requester.store === null ||
        (await options.authorize(tx, requester, "AssignStoreWork")) !== true
      )
        return false;
      const target = createIdentityActor(await options.targetActor(tx, requestedReference));
      if (
        target.actorReference !== requestedReference ||
        target.actorType !== "User" ||
        target.accountKind !== "Workforce" ||
        target.status !== "Active"
      )
        return false;
      const reference = target.actorReference;
      const context = createTenantContext(
        target,
        requester.brand,
        requester.store,
        requester.resolvedAt,
      );
      const source = createPostgresCurrentMembershipSource(tx, context);
      const membership = resolveActiveMembership(
        await source.findMemberships(reference, context.brand.brandReference),
        reference,
        context.brand.brandReference,
        context.resolvedAt,
      );
      resolveActiveStoreAssignment(
        membership,
        await source.findStoreAssignments(
          membership.membershipReference,
          requester.store.storeReference,
        ),
        requester.store.storeReference,
        context.resolvedAt,
      );
      if ((await options.authorize(tx, requester, "AssignStoreWork")) !== true) return false;
      const fresh = createIdentityActor(await options.targetActor(tx, requestedReference));
      return (
        fresh.actorReference === reference &&
        fresh.actorType === "User" &&
        fresh.accountKind === "Workforce" &&
        fresh.status === "Active"
      );
    } catch {
      return false;
    }
  };
}

/** Membership candidates only; Identity and final scoped eligibility must be
 * rechecked before exposing a directory entry or accepting an assignment. */
export function createPostgresStoreAssigneeCandidates(options: {
  authorize(
    tx: MembershipReadTransaction,
    context: TenantContext,
    purpose: "DiscoverStoreAssignees",
  ): Promise<boolean>;
}) {
  return async (
    tx: MembershipReadTransaction,
    input: {
      context: TenantContext;
      afterActorReference: string | null;
      limit: number;
    },
  ) => {
    const context = createTenantContext(
      input.context.actor,
      input.context.brand,
      input.context.store,
      input.context.resolvedAt,
    );
    if (
      context.actor.actorType !== "User" ||
      context.actor.accountKind !== "Workforce" ||
      context.store === null ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      return unavailable();
    const after =
      input.afterActorReference === null
        ? null
        : parseOpaqueUuidV7(input.afterActorReference, "ACTOR_REFERENCE_INVALID");
    const brand = context.brand.brandReference,
      store = context.store.storeReference;
    const authorize = async () => {
      if ((await options.authorize(tx, context, "DiscoverStoreAssignees")) !== true)
        return unavailable();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const candidates = rows(
      await tx.query(
        "SELECT DISTINCT m.actor_id,m.brand_id,s.store_id FROM bop_membership.membership m " +
          "JOIN bop_membership.store_assignment s ON s.membership_id=m.membership_id AND s.actor_id=m.actor_id AND s.brand_id=m.brand_id " +
          "WHERE m.brand_id=$1 AND s.store_id=$2 AND m.lifecycle='Active' AND s.lifecycle='Active' " +
          "AND m.effective_from<=$3 AND (m.effective_until IS NULL OR m.effective_until>$3) " +
          "AND s.effective_from<=$3 AND (s.effective_until IS NULL OR s.effective_until>$3) " +
          "AND m.updated_at<=$3 AND s.updated_at<=$3 AND m.workforce_relationship_reference IS NOT NULL " +
          "AND ($4::uuid IS NULL OR m.actor_id>$4) ORDER BY m.actor_id LIMIT $5",
        [brand, store, context.resolvedAt, after, input.limit + 1],
      ),
    );
    if (candidates.length > input.limit + 1) return unavailable();
    let previous: string | null = after;
    const references = candidates.map((row) => {
      if (row.brand_id !== brand || row.store_id !== store) return unavailable();
      const actor = String(parseOpaqueUuidV7(row.actor_id, "ACTOR_REFERENCE_INVALID"));
      if (previous !== null && actor <= previous) return unavailable();
      previous = actor;
      return actor;
    });
    await authorize();
    const page = references.slice(0, input.limit);
    return Object.freeze({
      actorReferences: Object.freeze(page),
      nextAfterActorReference:
        references.length > input.limit ? (page.at(-1) ?? unavailable()) : null,
    });
  };
}
