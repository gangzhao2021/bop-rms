import { createIdentityActor, parseOpaqueUuidV7, type IdentityActor } from "@bop/identity";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import type { MembershipPort } from "../../application/ports/membership-port.js";
import {
  MembershipContractError,
  createMembership,
  createStoreAssignment,
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
  function membership(row: Record<string, unknown>) {
    if (row.actor_id !== actor || row.brand_id !== brand) return unavailable();
    const result = createMembership(
      {
        membershipReference: row.membership_id,
        actorReference: row.actor_id,
        brandReference: row.brand_id,
        workforceRelationshipReference: row.workforce_relationship_reference,
        lifecycle: row.lifecycle,
        effectiveFrom: instant(row.effective_from),
        effectiveUntil: row.effective_until === null ? null : instant(row.effective_until),
        version: row.version,
        createdAt: instant(row.created_at),
        updatedAt: instant(row.updated_at),
      },
      context.actor,
    );
    if (Date.parse(result.updatedAt) > Date.parse(context.resolvedAt)) return unavailable();
    return result;
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
          ).map(membership),
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
        const parent = membership(row);
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
