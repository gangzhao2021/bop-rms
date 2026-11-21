import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";

/**
 * WP-2423 M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2): the refund role the requester held when the
 * request was recorded. Staff (a cashier) never send their own request, so the Approvals queue
 * lists it for a manager at once, from this record and not from the requester's role today.
 */
export type OrdinaryRefundRequesterRole = "Manager" | "Owner" | "Staff";
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const unavailable = (): never => {
  throw new Error("ORDINARY_REFUND_REQUESTER_ROLE_UNAVAILABLE");
};
async function setScope(tx: ConsumerTransaction, brand: string, store: string) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
}

/**
 * Records the requester's role with the request, in its transaction (Created requests only; the
 * caller resolved the role and authorizes the command). A replay with the same role writes
 * nothing; another role for the same request is refused.
 */
export async function recordOrdinaryRefundRequesterRole(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly orderReference: string;
    readonly requestReference: string;
    readonly actorReference: string;
    readonly requestedAt: string;
    readonly role: OrdinaryRefundRequesterRole;
  },
): Promise<void> {
  if (!["Manager", "Owner", "Staff"].includes(input.role)) return unavailable();
  const brand = String(parsePaymentReference(scope.brandReference)),
    store = String(parsePaymentReference(scope.storeReference));
  const values = [
    brand,
    store,
    String(parsePaymentReference(input.orderReference)),
    String(parsePaymentReference(input.requestReference)),
    String(parsePaymentReference(input.actorReference)),
    input.role,
    String(parsePaymentInstant(input.requestedAt)),
  ];
  await setScope(tx, brand, store);
  const prior = await tx.query<{ role: string }>(
    "SELECT requester_role AS role FROM rms_payment.ordinary_refund_requester_role WHERE brand_id=$1 AND store_id=$2 AND request_id=$3",
    [brand, store, values[3]],
  );
  if (prior.rows.length > 0) {
    if (prior.rows.length !== 1 || prior.rows[0]?.role !== input.role) return unavailable();
    return;
  }
  const written = await tx.query(
    "INSERT INTO rms_payment.ordinary_refund_requester_role (brand_id,store_id,order_id,request_id,actor_id,requester_role,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)",
    values,
  );
  if (written.rowCount !== 1) return unavailable();
}

/** The recorded requester roles of these requests (absent: recorded before this fact existed). */
export async function listOrdinaryRefundRequesterRoles(
  tx: ConsumerTransaction,
  scope: Scope,
  requestReferences: readonly string[],
): Promise<ReadonlyMap<string, OrdinaryRefundRequesterRole>> {
  if (requestReferences.length === 0) return new Map();
  if (requestReferences.length > 1000) return unavailable();
  const brand = String(parsePaymentReference(scope.brandReference)),
    store = String(parsePaymentReference(scope.storeReference));
  const requests = [
    ...new Set(requestReferences.map((value) => String(parsePaymentReference(value)))),
  ];
  await setScope(tx, brand, store);
  const found = await tx.query<{ request: string; role: string }>(
    "SELECT request_id::text AS request,requester_role AS role FROM rms_payment.ordinary_refund_requester_role WHERE brand_id=$1 AND store_id=$2 AND request_id=ANY($3::uuid[])",
    [brand, store, requests],
  );
  const roles = new Map<string, OrdinaryRefundRequesterRole>();
  for (const row of found.rows) {
    if (row.role !== "Manager" && row.role !== "Owner" && row.role !== "Staff")
      return unavailable();
    roles.set(String(parsePaymentReference(row.request)), row.role);
  }
  return roles;
}
