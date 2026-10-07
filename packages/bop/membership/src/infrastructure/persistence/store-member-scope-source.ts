import {
  parseMembershipReference,
  parseStoreAssignmentReference,
} from "../../domain/membership.js";

export interface StoreMemberScopeTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
/**
 * WP-2423: Membership owner's public confirmation, inside the caller's transaction, that an Actor
 * holds an Active Brand Membership and an Active assignment to the Store, both effective at the
 * given instant. Exposes no Membership content.
 */
export async function confirmStoreMemberScope(
  tx: StoreMemberScopeTransaction,
  scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly storeAssignmentReference: string;
    readonly at: string;
  },
): Promise<boolean> {
  const membership = String(parseMembershipReference(scope.membershipReference)),
    assignment = String(parseStoreAssignmentReference(scope.storeAssignmentReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
  const result = await tx.query(
    `SELECT 1 FROM bop_membership.membership m JOIN bop_membership.store_assignment s
       ON s.membership_id=m.membership_id AND s.actor_id=m.actor_id AND s.brand_id=m.brand_id
     WHERE m.membership_id=$1 AND s.assignment_id=$2 AND m.actor_id=$3 AND m.brand_id=$4 AND s.store_id=$5
       AND m.lifecycle='Active' AND s.lifecycle='Active'
       AND m.effective_from<=$6::timestamptz AND (m.effective_until IS NULL OR m.effective_until>$6::timestamptz)
       AND s.effective_from<=$6::timestamptz AND (s.effective_until IS NULL OR s.effective_until>$6::timestamptz)`,
    [
      membership,
      assignment,
      scope.actorReference,
      scope.brandReference,
      scope.storeReference,
      scope.at,
    ],
  );
  return result.rows.length === 1;
}

/**
 * WP-2423 / DEC-PERM-BRAND-ROLES: Membership owner's confirmation that an Actor holds an Active Brand
 * Membership effective at the given instant (Brand-level roles need no Store assignment).
 */
export async function confirmBrandMemberScope(
  tx: StoreMemberScopeTransaction,
  scope: {
    readonly brandReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly at: string;
  },
): Promise<boolean> {
  const membership = String(parseMembershipReference(scope.membershipReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true)", [scope.brandReference]);
  const result = await tx.query(
    `SELECT 1 FROM bop_membership.membership m
     WHERE m.membership_id=$1 AND m.actor_id=$2 AND m.brand_id=$3 AND m.lifecycle='Active'
       AND m.effective_from<=$4::timestamptz AND (m.effective_until IS NULL OR m.effective_until>$4::timestamptz)`,
    [membership, scope.actorReference, scope.brandReference, scope.at],
  );
  return result.rows.length === 1;
}
