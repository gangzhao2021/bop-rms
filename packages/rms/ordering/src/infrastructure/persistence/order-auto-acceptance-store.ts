import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import type {
  OrderAutoAcceptanceSkipReason,
  OrderAutoAcceptanceSwitch,
} from "../../domain/order-auto-acceptance.js";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the Store's switch (Ordering's fact, because acceptance is)
 * and the per-batch record of why a paid batch was not sent, which switch version sent it, and who
 * said a pickup sent that way is being made by hand. Append-only; no row reads as off, so no Store
 * changes until its owner turns it on.
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
      "SELECT reason_code FROM rms_ordering.order_auto_acceptance_decision WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3 AND outcome<>'Kept' ORDER BY decided_at DESC,decision_id DESC LIMIT 1",
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
  | {
      readonly kind: "Accepted";
      readonly acceptedAt: string;
      /** Staff said they are making it by hand: it is not refunded automatically. */
      readonly kept: boolean;
    }
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
        " AS decided_at,EXISTS (SELECT 1 FROM rms_ordering.order_auto_acceptance_decision k WHERE k.brand_id=d.brand_id AND k.store_id=d.store_id AND k.order_batch_id=d.order_batch_id AND k.outcome='Kept') AS kept" +
        " FROM rms_ordering.order_auto_acceptance_decision d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[]) AND d.outcome<>'Kept' ORDER BY d.order_batch_id,d.decided_at DESC,d.decision_id DESC",
      [brand, store, orderReferences.map((value) => String(parseOrderingReference(value)))],
    )
  ).rows as readonly {
    batch: string;
    outcome: string;
    reason_code: OrderAutoAcceptanceSkipReason | null;
    item_count: number | null;
    decided_at: unknown;
    kept: unknown;
  }[];
  return new Map(
    rows.map((row) => [
      row.batch,
      row.outcome === "Accepted"
        ? Object.freeze({
            kind: "Accepted" as const,
            acceptedAt: instant(row.decided_at),
            kept: row.kept === true,
          })
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
  /** Staff said they are making it by hand: it is not refunded automatically. */
  readonly kept: boolean;
}

/** Where a pass over the Store's open batches stopped, for the next one to carry on from. */
export interface OpenAutoAcceptedBatchCursor {
  readonly acceptedAt: string;
  readonly orderBatchReference: string;
}

const openAutoAcceptedColumns =
  "SELECT a.order_id::text AS order_id,a.order_batch_id::text AS batch,h.order_number,h.order_type,a.accepted_order_version::int AS accepted_order_version," +
  asInstant("a.accepted_at") +
  " AS accepted_at,EXISTS (SELECT 1 FROM rms_ordering.order_auto_acceptance_decision k WHERE k.brand_id=d.brand_id AND k.store_id=d.store_id AND k.order_batch_id=d.order_batch_id AND k.outcome='Kept') AS kept" +
  " FROM rms_ordering.order_auto_acceptance_decision d JOIN rms_ordering.order_acceptance_record a ON a.acceptance_id=d.acceptance_id JOIN rms_ordering.order_header h ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id ";
const stillOpen =
  "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=a.brand_id AND c.store_id=a.store_id AND c.order_batch_id=a.order_batch_id) " +
  "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=a.brand_id AND t.store_id=a.store_id AND t.order_id=a.order_id) " +
  "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record f WHERE f.brand_id=a.brand_id AND f.store_id=a.store_id AND f.order_id=a.order_id) " +
  "AND coalesce((SELECT v.status FROM rms_ordering.order_closure_version v WHERE v.brand_id=a.brand_id AND v.store_id=a.store_id AND v.order_id=a.order_id ORDER BY v.closure_version DESC LIMIT 1),'Open')<>'Closed' ";

/**
 * Automatically accepted batches accepted since `since` that are still open: not cancelled, the
 * Order neither terminated, closed nor fulfilled. Whether the kitchen touched them is Kitchen's.
 * Oldest first from `after`, for a pass that must reach every one; `newestFirst` for a screen, so
 * a day's open tickets never push out the order that needs saying.
 */
export async function listStoreOpenAutoAcceptedBatches(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly since: string;
    readonly limit: number;
    readonly onlyPickup?: boolean;
    readonly after?: OpenAutoAcceptedBatchCursor | null;
    readonly newestFirst?: boolean;
  },
): Promise<readonly OpenAutoAcceptedBatch[]> {
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      openAutoAcceptedColumns +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.outcome='Accepted' AND d.decided_at>=$3::timestamptz " +
        "AND ($5::boolean IS NOT TRUE OR h.order_type='Pickup') " +
        "AND ($6::timestamptz IS NULL OR (d.decided_at,d.order_batch_id)>($6::timestamptz,$7::uuid)) " +
        stillOpen +
        (input.newestFirst === true
          ? "ORDER BY d.decided_at DESC,d.order_batch_id DESC LIMIT $4"
          : "ORDER BY d.decided_at,d.order_batch_id LIMIT $4"),
      [
        brand,
        store,
        instant(input.since),
        input.limit,
        input.onlyPickup === true,
        input.after === undefined || input.after === null ? null : instant(input.after.acceptedAt),
        input.after === undefined || input.after === null
          ? null
          : String(parseOrderingReference(input.after.orderBatchReference)),
      ],
    )
  ).rows as readonly {
    order_id: string;
    batch: string;
    order_number: string;
    order_type: "Pickup" | "DineIn";
    accepted_order_version: number;
    accepted_at: unknown;
    kept: unknown;
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
        kept: row.kept === true,
      }),
    ),
  );
}

export class OrderAutoAcceptedKeepError extends Error {
  readonly code = "ORDER_AUTO_ACCEPTED_NOT_KEEPABLE";
  constructor() {
    super("this order can no longer be kept");
    this.name = "OrderAutoAcceptedKeepError";
  }
}

/**
 * "Making it by hand": a person says an automatically accepted batch is being made without the
 * kitchen screen (a dead board, or a ticket that never arrived). For a pickup the automatic refund
 * must not give away food the guest may already have; a table round (never refunded on its own)
 * leaves the Store-level kitchen warnings. Under the Order's fence, so it is settled against the
 * System close. Only an open batch the System accepted; the first person's name stays. Moves no
 * money, and it can still be given back with "Can't make it" while the kitchen has not marked it.
 */
export async function keepOrderAutoAcceptedPickup(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly decisionReference: string;
    readonly auditReference: string;
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<"Kept" | "AlreadyKept"> {
  const { brand, store } = await scoped(tx, scope);
  const order = String(parseOrderingReference(input.orderReference));
  const batch = String(parseOrderingReference(input.orderBatchReference));
  const actor = String(parseOrderingReference(input.actorReference));
  const at = instant(input.observedAt);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OrderingOrderDisposition:" + brand + ":" + store + ":" + order,
  ]);
  const accepted = (
    await tx.query(
      "SELECT d.acceptance_id::text AS acceptance,d.item_count::int AS item_count,d.setting_version::int AS setting_version,h.order_type FROM rms_ordering.order_auto_acceptance_decision d " +
        "JOIN rms_ordering.order_acceptance_record a ON a.acceptance_id=d.acceptance_id JOIN rms_ordering.order_header h ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=$3 AND d.order_batch_id=$4 AND d.outcome='Accepted' " +
        stillOpen,
      [brand, store, order, batch],
    )
  ).rows[0] as
    | {
        acceptance: string;
        item_count: number | null;
        setting_version: number;
        order_type: "Pickup" | "DineIn";
      }
    | undefined;
  if (accepted === undefined) throw new OrderAutoAcceptedKeepError();
  const inserted = await tx.query(
    "INSERT INTO rms_ordering.order_auto_acceptance_decision (decision_id,brand_id,store_id,order_id,order_batch_id,outcome,reason_code,item_count,setting_version,acceptance_id,actor_id,decided_at) VALUES ($1,$2,$3,$4,$5,'Kept',NULL,$6,$7,$8,$9,$10) ON CONFLICT (brand_id,store_id,order_batch_id) WHERE outcome='Kept' DO NOTHING",
    [
      String(parseOrderingReference(input.decisionReference)),
      brand,
      store,
      order,
      batch,
      accepted.item_count,
      accepted.setting_version,
      accepted.acceptance,
      actor,
      at,
    ],
  );
  if (inserted.rowCount !== 1) return "AlreadyKept";
  await appendAuditRecordInTransaction(
    tx,
    validateAuditRecord({
      auditId: String(parseOrderingReference(input.auditReference)),
      brandId: brand,
      storeId: store,
      actor: { type: "User", reference: actor },
      // Only a pickup is ever refunded automatically; a table round only leaves the warnings.
      actionCode:
        accepted.order_type === "Pickup"
          ? "ORDER_AUTOMATIC_REFUND_STOPPED"
          : "ORDER_KITCHEN_WARNING_CLEARED_BY_HAND",
      targetType: "Order",
      targetId: order,
      correlationId: String(parseOrderingReference(input.decisionReference)),
      reasonCode: "STAFF_MAKING_BY_HAND",
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { orderBatchReference: batch },
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  );
  return "Kept";
}

/**
 * What a closing manager should see named: a person's refund, the System's, a pickup a person said
 * they made by hand (its automatic refund stopped), a table round made by hand (no refund involved).
 */
export interface OrderAutoAcceptanceEvent {
  readonly kind: "CantMake" | "AutomaticRefund" | "KeptByHand" | "RoundMadeByHand";
  readonly orderNumber: string;
  /** The table round, for RoundMadeByHand only (one Order has several); else null. */
  readonly roundSequence: number | null;
  /** Null for the System. */
  readonly actorReference: string | null;
  readonly reasonCode: string | null;
  readonly at: string;
}

/** Oldest first, at most 100, in the window (the Store's business day). Whoever asks authorizes. */
export async function listStoreOrderAutoAcceptanceEvents(
  tx: ConsumerTransaction,
  scope: Scope,
  window: { readonly startsAt: string; readonly endsAt: string },
): Promise<readonly OrderAutoAcceptanceEvent[]> {
  const { brand, store } = await scoped(tx, scope);
  const rows = (
    await tx.query(
      "SELECT kind,order_number,round_sequence,actor,reason_code," +
        asInstant("at") +
        " AS at FROM (" +
        "SELECT CASE WHEN t.actor_type='System' THEN 'AutomaticRefund' ELSE 'CantMake' END AS kind,h.order_number,NULL::int AS round_sequence,CASE WHEN t.actor_type='System' THEN NULL ELSE c.actor_id::text END AS actor,c.reason_code,c.cancelled_at AS at " +
        "FROM rms_ordering.order_staff_cancellation c JOIN rms_ordering.order_header h ON h.brand_id=c.brand_id AND h.store_id=c.store_id AND h.order_id=c.order_id " +
        "LEFT JOIN rms_ordering.order_termination_record t ON t.brand_id=c.brand_id AND t.store_id=c.store_id AND t.termination_id=c.cancellation_id " +
        "WHERE c.brand_id=$1 AND c.store_id=$2 AND c.cancelled_at>=$3::timestamptz AND c.cancelled_at<$4::timestamptz AND (c.permission_code='ordering.order.accept' OR t.actor_type='System') " +
        "UNION ALL SELECT CASE WHEN h.order_type='Pickup' THEN 'KeptByHand' ELSE 'RoundMadeByHand' END,h.order_number," +
        "CASE WHEN h.order_type='Pickup' THEN NULL ELSE coalesce((SELECT r.batch_sequence FROM rms_ordering.additional_dining_batch_record r WHERE r.brand_id=d.brand_id AND r.store_id=d.store_id AND r.order_id=d.order_id AND r.order_batch_id=d.order_batch_id),1) END," +
        "d.actor_id::text,NULL,d.decided_at " +
        "FROM rms_ordering.order_auto_acceptance_decision d JOIN rms_ordering.order_header h ON h.brand_id=d.brand_id AND h.store_id=d.store_id AND h.order_id=d.order_id " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.outcome='Kept' AND d.decided_at>=$3::timestamptz AND d.decided_at<$4::timestamptz" +
        ") events ORDER BY at LIMIT 100",
      [brand, store, instant(window.startsAt), instant(window.endsAt)],
    )
  ).rows as readonly {
    kind: OrderAutoAcceptanceEvent["kind"];
    order_number: unknown;
    round_sequence: number | null;
    actor: string | null;
    reason_code: string | null;
    at: unknown;
  }[];
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        kind: row.kind,
        orderNumber: String(row.order_number),
        roundSequence: row.kind === "RoundMadeByHand" ? Number(row.round_sequence) : null,
        actorReference: row.actor,
        reasonCode: row.reason_code,
        at: instant(row.at),
      }),
    ),
  );
}
