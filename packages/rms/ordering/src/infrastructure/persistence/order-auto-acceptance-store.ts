import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import type {
  OrderAutoAcceptanceSkipReason,
  OrderAutoAcceptanceSwitch,
} from "../../domain/order-auto-acceptance.js";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the Store's switch (Ordering's fact, because acceptance is)
 * and the per-batch record of why a paid batch was not sent, or which switch version sent it.
 * Append-only; no row reads as off, so no Store changes until its owner turns it on.
 */
export class OrderAutoAcceptanceSettingConflictError extends Error {
  constructor() {
    super("order auto acceptance setting changed");
    this.name = "OrderAutoAcceptanceSettingConflictError";
  }
}

export interface OrderAutoAcceptanceSetting {
  readonly version: number;
  readonly pickup: OrderAutoAcceptanceSwitch;
  readonly dineIn: OrderAutoAcceptanceSwitch;
  readonly changedAt: string | null;
}

interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const instant = (value: unknown) =>
  String(parseOrderingInstant(value instanceof Date ? value.toISOString() : value));
const asInstant = (column: string) =>
  "to_char(" + column + " AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

async function scoped(tx: ConsumerTransaction, scope: Scope) {
  const brand = String(parseOrderingReference(scope.brandReference));
  const store = String(parseOrderingReference(scope.storeReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { brand, store };
}

/** The switch now, and per order type when it last changed (each type has its own cut-off). */
export async function loadOrderAutoAcceptanceSetting(
  tx: ConsumerTransaction,
  scope: Scope,
): Promise<OrderAutoAcceptanceSetting> {
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      "SELECT version::int AS version,pickup,dine_in," +
        asInstant("occurred_at") +
        " AS occurred_at FROM rms_ordering.order_auto_acceptance_setting WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1000",
      [brand, store],
    )
  ).rows as readonly {
    version: unknown;
    pickup: unknown;
    dine_in: unknown;
    occurred_at: unknown;
  }[];
  const latest = rows[0];
  if (latest === undefined)
    return Object.freeze({
      version: 0,
      pickup: Object.freeze({ on: false, since: null }),
      dineIn: Object.freeze({ on: false, since: null }),
      changedAt: null,
    });
  // Newest first: the switch's value has held since the oldest version still carrying it.
  const heldSince = (column: "pickup" | "dine_in") => {
    let since = instant(latest.occurred_at);
    for (const row of rows) {
      if (row[column] !== latest[column]) break;
      since = instant(row.occurred_at);
    }
    return since;
  };
  return Object.freeze({
    version: Number(latest.version),
    pickup: Object.freeze({ on: latest.pickup === true, since: heldSince("pickup") }),
    dineIn: Object.freeze({ on: latest.dine_in === true, since: heldSince("dine_in") }),
    changedAt: instant(latest.occurred_at),
  });
}

/**
 * The next version against the one the staff member saw (another change in between is a conflict).
 * The same operation again returns the setting it made; a change to what is already set writes
 * nothing. Caller authorizes the person: turning on is the owner's, turning off a manager's too.
 */
export async function changeOrderAutoAcceptanceSetting(
  tx: ConsumerTransaction,
  scope: Scope & { readonly tenantReference: string },
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly pickup: boolean;
    readonly dineIn: boolean;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<OrderAutoAcceptanceSetting> {
  const { brand, store } = await scoped(tx, scope);
  const operation = String(parseOrderingReference(input.operationReference));
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OrderAutoAcceptanceSetting:" + brand + ":" + store,
  ]);
  const prior = (
    await tx.query(
      "SELECT pickup,dine_in FROM rms_ordering.order_auto_acceptance_setting WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    )
  ).rows[0] as { pickup: unknown; dine_in: unknown } | undefined;
  if (prior !== undefined) {
    if (prior.pickup !== input.pickup || prior.dine_in !== input.dineIn)
      throw new OrderAutoAcceptanceSettingConflictError();
    return loadOrderAutoAcceptanceSetting(tx, scope);
  }
  const current = await loadOrderAutoAcceptanceSetting(tx, scope);
  if (current.version !== input.expectedVersion)
    throw new OrderAutoAcceptanceSettingConflictError();
  if (current.pickup.on === input.pickup && current.dineIn.on === input.dineIn) return current;
  await tx.query(
    "INSERT INTO rms_ordering.order_auto_acceptance_setting (tenant_id,brand_id,store_id,version,operation_id,pickup,dine_in,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      String(parseOrderingReference(scope.tenantReference)),
      brand,
      store,
      current.version + 1,
      operation,
      input.pickup,
      input.dineIn,
      String(parseOrderingReference(input.actorReference)),
      instant(input.observedAt),
    ],
  );
  return loadOrderAutoAcceptanceSetting(tx, scope);
}

/** The reason last recorded for this batch (null: none, or it was accepted). */
export async function loadOrderAutoAcceptanceSkip(
  tx: ConsumerTransaction,
  scope: Scope,
  orderBatchReference: string,
): Promise<OrderAutoAcceptanceSkipReason | null> {
  const { brand, store } = await scoped(tx, scope);
  const row = (
    await tx.query(
      "SELECT reason_code FROM rms_ordering.order_auto_acceptance_decision WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3 ORDER BY decided_at DESC,decision_id DESC LIMIT 1",
      [brand, store, String(parseOrderingReference(orderBatchReference))],
    )
  ).rows[0] as { reason_code: OrderAutoAcceptanceSkipReason | null } | undefined;
  return row?.reason_code ?? null;
}

/** Why a paid batch was not sent; written only when the reason changes (the caller checks). */
export async function recordOrderAutoAcceptanceSkip(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly decisionReference: string;
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly reason: OrderAutoAcceptanceSkipReason;
    readonly itemCount: number;
    readonly settingVersion: number;
    readonly decidedAt: string;
  },
): Promise<void> {
  const { brand, store } = await scoped(tx, scope);
  await tx.query(
    "INSERT INTO rms_ordering.order_auto_acceptance_decision (decision_id,brand_id,store_id,order_id,order_batch_id,outcome,reason_code,item_count,setting_version,acceptance_id,decided_at) VALUES ($1,$2,$3,$4,$5,'Skipped',$6,$7,$8,NULL,$9)",
    [
      String(parseOrderingReference(input.decisionReference)),
      brand,
      store,
      String(parseOrderingReference(input.orderReference)),
      String(parseOrderingReference(input.orderBatchReference)),
      input.reason,
      input.itemCount,
      input.settingVersion,
      instant(input.decidedAt),
    ],
  );
}

/** Which switch version sent this batch: the audit stays exactly what a staff Accept writes. */
export async function recordOrderAutoAcceptanceAccepted(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly decisionReference: string;
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly acceptanceReference: string;
    readonly itemCount: number;
    readonly settingVersion: number;
    readonly decidedAt: string;
  },
): Promise<void> {
  const { brand, store } = await scoped(tx, scope);
  await tx.query(
    "INSERT INTO rms_ordering.order_auto_acceptance_decision (decision_id,brand_id,store_id,order_id,order_batch_id,outcome,reason_code,item_count,setting_version,acceptance_id,decided_at) VALUES ($1,$2,$3,$4,$5,'Accepted',NULL,$6,$7,$8,$9)",
    [
      String(parseOrderingReference(input.decisionReference)),
      brand,
      store,
      String(parseOrderingReference(input.orderReference)),
      String(parseOrderingReference(input.orderBatchReference)),
      input.itemCount,
      input.settingVersion,
      String(parseOrderingReference(input.acceptanceReference)),
      instant(input.decidedAt),
    ],
  );
}

export type OrderAutoAcceptanceBatchFact =
  | { readonly kind: "Accepted"; readonly acceptedAt: string }
  | {
      readonly kind: "Skipped";
      readonly reason: OrderAutoAcceptanceSkipReason;
      readonly itemCount: number | null;
    };

/** What the Orders page says per batch of these Orders (batch reference → fact; most have none). */
export async function listStoreOrderAutoAcceptanceFacts(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, OrderAutoAcceptanceBatchFact>> {
  if (orderReferences.length === 0) return new Map();
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      "SELECT DISTINCT ON (d.order_batch_id) d.order_batch_id::text AS batch,d.outcome,d.reason_code,d.item_count::int AS item_count," +
        asInstant("d.decided_at") +
        " AS decided_at FROM rms_ordering.order_auto_acceptance_decision d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[]) ORDER BY d.order_batch_id,d.decided_at DESC,d.decision_id DESC",
      [brand, store, orderReferences.map((value) => String(parseOrderingReference(value)))],
    )
  ).rows as readonly {
    batch: string;
    outcome: string;
    reason_code: OrderAutoAcceptanceSkipReason | null;
    item_count: number | null;
    decided_at: unknown;
  }[];
  return new Map(
    rows.map((row) => [
      row.batch,
      row.outcome === "Accepted"
        ? Object.freeze({ kind: "Accepted" as const, acceptedAt: instant(row.decided_at) })
        : Object.freeze({
            kind: "Skipped" as const,
            reason: row.reason_code as OrderAutoAcceptanceSkipReason,
            itemCount: row.item_count,
          }),
    ]),
  );
}

/** For a screen that names waiting orders, not rounds: each Order's latest reason (order → reason). */
export async function listStoreOrderAutoAcceptanceSkipsByOrder(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    { readonly reason: OrderAutoAcceptanceSkipReason; readonly itemCount: number | null }
  >
> {
  if (orderReferences.length === 0) return new Map();
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      "SELECT DISTINCT ON (d.order_id) d.order_id::text AS order_id,d.reason_code,d.item_count::int AS item_count " +
        "FROM rms_ordering.order_auto_acceptance_decision d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[]) AND d.outcome='Skipped' " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=d.brand_id AND a.store_id=d.store_id AND a.order_batch_id=d.order_batch_id) " +
        "ORDER BY d.order_id,d.decided_at DESC,d.decision_id DESC",
      [brand, store, orderReferences.map((value) => String(parseOrderingReference(value)))],
    )
  ).rows as readonly {
    order_id: string;
    reason_code: OrderAutoAcceptanceSkipReason;
    item_count: number | null;
  }[];
  return new Map(
    rows.map((row) => [
      row.order_id,
      Object.freeze({ reason: row.reason_code, itemCount: row.item_count }),
    ]),
  );
}

/** "Can't make it" refunds since then: the manager's closing list names them, as a count. */
export async function countStoreCantMakeRefundsSince(
  tx: ConsumerTransaction,
  scope: Scope,
  since: string,
): Promise<number> {
  const { brand, store } = await scoped(tx, scope);
  const row = (
    await tx.query(
      "SELECT count(*)::int AS n FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND permission_code='ordering.order.accept' AND cancelled_at>=$3::timestamptz",
      [brand, store, instant(since)],
    )
  ).rows[0] as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface OpenAutoAcceptedBatch {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly acceptedAt: string;
  readonly acceptedOrderVersion: number;
}

/**
 * Automatically accepted batches accepted since `since` that are still open: not cancelled, the
 * Order neither terminated, closed nor fulfilled. Whether the kitchen touched them is Kitchen's.
 */
export async function listStoreOpenAutoAcceptedBatches(
  tx: ConsumerTransaction,
  scope: Scope,
  input: { readonly since: string; readonly limit: number; readonly onlyPickup?: boolean },
): Promise<readonly OpenAutoAcceptedBatch[]> {
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      "SELECT a.order_id::text AS order_id,a.order_batch_id::text AS batch,h.order_number,h.order_type,a.accepted_order_version::int AS accepted_order_version," +
        asInstant("a.accepted_at") +
        " AS accepted_at FROM rms_ordering.order_acceptance_record a JOIN rms_ordering.order_header h ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id " +
        "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.reason_code='STORE_AUTO_ACCEPT_PAID' AND a.accepted_at>=$3::timestamptz " +
        "AND ($5::boolean IS NOT TRUE OR h.order_type='Pickup') " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=a.brand_id AND c.store_id=a.store_id AND c.order_batch_id=a.order_batch_id) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=a.brand_id AND t.store_id=a.store_id AND t.order_id=a.order_id) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record f WHERE f.brand_id=a.brand_id AND f.store_id=a.store_id AND f.order_id=a.order_id) " +
        "AND coalesce((SELECT v.status FROM rms_ordering.order_closure_version v WHERE v.brand_id=a.brand_id AND v.store_id=a.store_id AND v.order_id=a.order_id ORDER BY v.closure_version DESC LIMIT 1),'Open')<>'Closed' " +
        "ORDER BY a.accepted_at LIMIT $4",
      [brand, store, instant(input.since), input.limit, input.onlyPickup === true],
    )
  ).rows as readonly {
    order_id: string;
    batch: string;
    order_number: string;
    order_type: "Pickup" | "DineIn";
    accepted_order_version: number;
    accepted_at: unknown;
  }[];
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        orderReference: row.order_id,
        orderBatchReference: row.batch,
        orderNumber: String(row.order_number),
        orderType: row.order_type,
        acceptedAt: instant(row.accepted_at),
        acceptedOrderVersion: row.accepted_order_version,
      }),
    ),
  );
}
