import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): staff merged one table's party into another's. The
 * source table's dine-in Order joins the target's bill (2000_129): its rounds, items, prices, comps
 * and removals stay as they are, on the target's bill from then on. Caller authorizes and owns the
 * transaction (the dining merge and Payment's bill record commit with it).
 */
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const unavailable = (): never => {
  throw new Error("ORDER_MERGE_UNAVAILABLE");
};
const context = async (transaction: ConsumerTransaction, scope: Scope) => {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  return { brand, store };
};

/** Records the merge once; the same operation again returns what it recorded. */
export async function recordOrderMerge(
  transaction: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly mergeReference: string;
    readonly operationReference: string;
    readonly sourceOrderReference: string;
    readonly targetOrderReference: string;
    readonly sourceDiningSessionReference: string;
    readonly targetDiningSessionReference: string;
    readonly actorReference: string;
    readonly mergedAt: string;
  },
): Promise<{ readonly status: "Recorded" | "AlreadyRecorded" }> {
  const { brand, store } = await context(transaction, scope);
  const value = {
    merge: parseOrderingReference(input.mergeReference),
    operation: parseOrderingReference(input.operationReference),
    source: parseOrderingReference(input.sourceOrderReference),
    target: parseOrderingReference(input.targetOrderReference),
    sourceSession: parseOrderingReference(input.sourceDiningSessionReference),
    targetSession: parseOrderingReference(input.targetDiningSessionReference),
    actor: parseOrderingReference(input.actorReference),
    at: parseOrderingInstant(input.mergedAt),
  };
  const prior = (
    await transaction.query(
      "SELECT source_order_id::text source,target_order_id::text target FROM rms_ordering.order_merge WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, value.operation],
    )
  ).rows[0] as { source?: unknown; target?: unknown } | undefined;
  if (prior !== undefined) {
    if (prior.source !== value.source || prior.target !== value.target) return unavailable();
    return Object.freeze({ status: "AlreadyRecorded" as const });
  }
  const inserted = await transaction.query(
    "INSERT INTO rms_ordering.order_merge (merge_id,brand_id,store_id,source_order_id,target_order_id,source_dining_session_id,target_dining_session_id,operation_id,actor_id,merged_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      value.merge,
      brand,
      store,
      value.source,
      value.target,
      value.sourceSession,
      value.targetSession,
      value.operation,
      value.actor,
      value.at,
    ],
  );
  if (inserted.rowCount !== 1) return unavailable();
  return Object.freeze({ status: "Recorded" as const });
}

/**
 * The Orders on this Order's bill: itself first, then the Orders merged into it (and into those),
 * oldest merge first.
 */
export async function listOrderBillOrders(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
): Promise<readonly string[]> {
  const { brand, store } = await context(transaction, scope);
  const order = parseOrderingReference(orderReference);
  const rows = (
    await transaction.query(
      "WITH RECURSIVE down(order_id,merged_at,depth) AS (" +
        "SELECT $3::uuid,NULL::timestamptz,0 " +
        "UNION ALL SELECT m.source_order_id,m.merged_at,down.depth+1 FROM rms_ordering.order_merge m " +
        "JOIN down ON m.brand_id=$1 AND m.store_id=$2 AND m.target_order_id=down.order_id WHERE down.depth<50) " +
        "SELECT down.order_id::text order_ref FROM down ORDER BY down.depth,down.merged_at,down.order_id LIMIT 101",
      [brand, store, order],
    )
  ).rows as readonly { order_ref?: unknown }[];
  if (rows.length > 100) return unavailable();
  return Object.freeze(rows.map((row) => String(parseOrderingReference(row.order_ref))));
}

/** For each given Order merged into another: the Order whose bill it is on now (followed to the end). */
export async function listOrderMergedInto(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 200) return unavailable();
  const { brand, store } = await context(transaction, scope);
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  const rows = (
    await transaction.query(
      "WITH RECURSIVE up(start_id,order_id,depth) AS (" +
        "SELECT m.source_order_id,m.target_order_id,1 FROM rms_ordering.order_merge m WHERE m.brand_id=$1 AND m.store_id=$2 AND m.source_order_id=ANY($3::uuid[]) " +
        "UNION ALL SELECT up.start_id,m.target_order_id,up.depth+1 FROM rms_ordering.order_merge m " +
        "JOIN up ON m.brand_id=$1 AND m.store_id=$2 AND m.source_order_id=up.order_id WHERE up.depth<50) " +
        "SELECT DISTINCT ON (up.start_id) up.start_id::text start_ref,up.order_id::text order_ref FROM up ORDER BY up.start_id,up.depth DESC",
      [brand, store, orders],
    )
  ).rows as readonly { start_ref?: unknown; order_ref?: unknown }[];
  return new Map(
    rows.map((row) => [
      String(parseOrderingReference(row.start_ref)),
      String(parseOrderingReference(row.order_ref)),
    ]),
  );
}

/**
 * Whether the table's shared cart holds dishes not sent yet (its latest cart has lines and was
 * not submitted as it is). A merge leaves a cart behind (a cart stays with its dining session),
 * so staff ask the guests to send or clear it first.
 */
export async function diningSessionHasUnsentCart(
  transaction: ConsumerTransaction,
  scope: Scope,
  diningSessionReference: string,
): Promise<boolean> {
  const { brand, store } = await context(transaction, scope);
  const session = parseOrderingReference(diningSessionReference);
  const rows = (
    await transaction.query(
      "SELECT EXISTS (SELECT 1 FROM rms_ordering.cart_line l WHERE l.brand_id=c.brand_id AND l.store_id=c.store_id AND l.cart_id=c.cart_id) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_submission_record s WHERE s.brand_id=c.brand_id AND s.store_id=c.store_id AND s.source_cart_id=c.cart_id AND s.source_cart_version=c.aggregate_version) AS unsent " +
        "FROM rms_ordering.cart c WHERE c.brand_id=$1 AND c.store_id=$2 AND c.dining_session_id=$3 AND c.order_type='DineIn' ORDER BY c.created_at DESC,c.cart_id DESC LIMIT 1",
      [brand, store, session],
    )
  ).rows as readonly { unsent?: unknown }[];
  return rows[0]?.unsent === true;
}

/** The dining session of each given dine-in Order (absent: not a dine-in Order of the Store). */
export async function listOrderDiningSessions(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 200) return unavailable();
  const { brand, store } = await context(transaction, scope);
  const rows = (
    await transaction.query(
      "SELECT order_id::text order_ref,dining_session_id::text session_ref FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_type='DineIn' AND order_id=ANY($3::uuid[])",
      [brand, store, orderReferences.map((reference) => parseOrderingReference(reference))],
    )
  ).rows as readonly { order_ref?: unknown; session_ref?: unknown }[];
  return new Map(
    rows.map((row) => [
      String(parseOrderingReference(row.order_ref)),
      String(parseOrderingReference(row.session_ref)),
    ]),
  );
}
