import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

/**
 * WP-2423 item 8 ① segment 2 (Owner decision 2, DEC-TABLES-SERVER-MAIN): a manager comps or
 * discounts dishes the kitchen started or the table was served, before the table pays. One
 * append-only record per dish — who, which dish, how much, why — as a compensating operation on
 * the sale: the dish stays sold at its price, the reduction comes off the Order's priced total
 * (the table's bill) and is reported on its own line. The amounts are computed here from the
 * dish's frozen price snapshot and checked again by the database. The caller checks the table has
 * not paid (Payment) and the kitchen started the dish (Kitchen), under this store's Order fence.
 */
export const orderPriceReductionPermission = "ordering.order.comp" as const;
export const orderPriceReductionReasonCodes = [
  "QUALITY",
  "WRONG_DISH",
  "LONG_WAIT",
  "GOODWILL",
] as const;
export type OrderPriceReductionReasonCode = (typeof orderPriceReductionReasonCodes)[number];
export type OrderPriceReductionKind = "Comp" | "Percent" | "Amount";
export type OrderPriceReductionChoice =
  | { readonly kind: "Comp" }
  | { readonly kind: "Percent"; readonly percent: number }
  | { readonly kind: "Amount"; readonly netMinor: bigint };

export interface OrderPriceReductionRecord {
  readonly reductionReference: string;
  readonly operationReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly kind: OrderPriceReductionKind;
  readonly percent: number | null;
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalMinor: bigint;
  readonly reasonCode: OrderPriceReductionReasonCode;
  readonly actorReference: string;
  readonly decidedAt: string;
}
export interface OrderPriceReductionPlan {
  readonly orderReference: string;
  readonly choice: { readonly kind: OrderPriceReductionKind; readonly percent: number | null };
  readonly lines: readonly {
    readonly orderBatchReference: string;
    readonly orderItemReference: string;
    readonly netMinor: bigint;
    readonly taxMinor: bigint;
    readonly feeMinor: bigint;
    readonly totalMinor: bigint;
  }[];
  readonly totalMinor: bigint;
}
export type OrderPriceReductionNotEligibleReason =
  "NotFound" | "NotPayLater" | "Closed" | "ItemCancelled" | "AlreadyReduced" | "InvalidAmount";

export class OrderPriceReductionError extends Error {
  constructor(
    readonly code: "ORDER_PRICE_REDUCTION_CONFLICT" | "ORDER_PRICE_REDUCTION_UNAVAILABLE",
  ) {
    super(code);
    this.name = "OrderPriceReductionError";
  }
}
const unavailable = (): never => {
  throw new OrderPriceReductionError("ORDER_PRICE_REDUCTION_UNAVAILABLE");
};
const conflict = (): never => {
  throw new OrderPriceReductionError("ORDER_PRICE_REDUCTION_CONFLICT");
};
const instant = (value: unknown) =>
  String(parseOrderingInstant(value instanceof Date ? value.toISOString() : value));
const minor = (value: unknown) => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(text)) return unavailable();
  return BigInt(text);
};
/** Half up to the cent: share of `amount` in proportion `part / whole` (whole > 0). */
const proportion = (amount: bigint, part: bigint, whole: bigint) =>
  (amount * part * 2n + whole) / (2n * whole);

/** The reduction of one dish: net off its price, tax and fee in proportion (the database's rule). */
export function orderPriceReductionAmounts(
  price: { readonly netMinor: bigint; readonly taxMinor: bigint; readonly feeMinor: bigint },
  choice: OrderPriceReductionChoice,
): { netMinor: bigint; taxMinor: bigint; feeMinor: bigint; totalMinor: bigint } | null {
  const whole = price.netMinor;
  if (whole <= 0n) return null;
  const net =
    choice.kind === "Comp"
      ? whole
      : choice.kind === "Percent"
        ? Number.isInteger(choice.percent) && choice.percent >= 1 && choice.percent <= 99
          ? (whole * BigInt(choice.percent) + 50n) / 100n
          : -1n
        : choice.netMinor;
  if (net < 1n || net > whole || (choice.kind === "Amount" && net >= whole)) return null;
  const tax = net === whole ? price.taxMinor : proportion(price.taxMinor, net, whole);
  const fee = net === whole ? price.feeMinor : proportion(price.feeMinor, net, whole);
  return { netMinor: net, taxMinor: tax, feeMinor: fee, totalMinor: net + tax + fee };
}

const recordSelect = `SELECT reduction_id::text AS reduction,operation_id::text AS operation,order_id::text AS "order",
 order_batch_id::text AS batch,order_item_id::text AS item,kind,percent,net_minor::text AS net,tax_minor::text AS tax,
 fee_minor::text AS fee,total_minor::text AS total,reason_code,actor_id::text AS actor,decided_at
 FROM rms_ordering.order_item_price_reduction WHERE brand_id=$1 AND store_id=$2`;
function recordFrom(row: Record<string, unknown>): OrderPriceReductionRecord {
  const kind = row.kind;
  const reason = row.reason_code;
  if (
    (kind !== "Comp" && kind !== "Percent" && kind !== "Amount") ||
    !(orderPriceReductionReasonCodes as readonly unknown[]).includes(reason)
  )
    return unavailable();
  const record: OrderPriceReductionRecord = {
    reductionReference: String(parseOrderingReference(row.reduction)),
    operationReference: String(parseOrderingReference(row.operation)),
    orderReference: String(parseOrderingReference(row.order)),
    orderBatchReference: String(parseOrderingReference(row.batch)),
    orderItemReference: String(parseOrderingReference(row.item)),
    kind: kind as OrderPriceReductionKind,
    percent: row.percent === null ? null : Number(row.percent),
    netMinor: minor(row.net),
    taxMinor: minor(row.tax),
    feeMinor: minor(row.fee),
    totalMinor: minor(row.total),
    reasonCode: reason as OrderPriceReductionReasonCode,
    actorReference: String(parseOrderingReference(row.actor)),
    decidedAt: instant(row.decided_at),
  };
  if (record.totalMinor !== record.netMinor + record.taxMinor + record.feeMinor)
    return unavailable();
  return Object.freeze(record);
}

/**
 * The reductions of these Orders, in the caller's authorized transaction (the bill, the priced
 * total, the order list and the sales reports read them this way). At most 200 Orders.
 */
export async function listOrderPriceReductions(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
  decidedBy?: string,
): Promise<readonly OrderPriceReductionRecord[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 2000) return unavailable();
  const brand = String(parseOrderingReference(scope.brandReference)),
    store = String(parseOrderingReference(scope.storeReference));
  const orders = [
    ...new Set(orderReferences.map((value) => String(parseOrderingReference(value)))),
  ];
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const rows = (
    await tx.query(
      `${recordSelect} AND order_id=ANY($3::uuid[])${decidedBy === undefined ? "" : " AND decided_at<=$4"} ORDER BY decided_at,reduction_id LIMIT 10001`,
      decidedBy === undefined
        ? [brand, store, orders]
        : [brand, store, orders, String(parseOrderingInstant(decidedBy))],
    )
  ).rows as Record<string, unknown>[];
  if (rows.length > 10000) return unavailable();
  return Object.freeze(rows.map(recordFrom));
}

/** Reductions decided in [startsAt, endsAt) at the Store (the day-end settlement's line). */
export async function listStorePriceReductionsDecided(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  window: { readonly startsAt: string; readonly endsAt: string },
): Promise<readonly OrderPriceReductionRecord[]> {
  const brand = String(parseOrderingReference(scope.brandReference)),
    store = String(parseOrderingReference(scope.storeReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const rows = (
    await tx.query(
      `${recordSelect} AND decided_at>=$3 AND decided_at<$4 ORDER BY decided_at,reduction_id LIMIT 10001`,
      [
        brand,
        store,
        String(parseOrderingInstant(window.startsAt)),
        String(parseOrderingInstant(window.endsAt)),
      ],
    )
  ).rows as Record<string, unknown>[];
  if (rows.length > 10000) return unavailable();
  return Object.freeze(rows.map(recordFrom));
}

export function createPostgresOrderPriceReductionStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, input: { orderReference: string }): Promise<boolean>;
}) {
  const brand = String(parseOrderingReference(options.brandReference)),
    store = String(parseOrderingReference(options.storeReference));
  const scope = { brandReference: brand, storeReference: store };
  const allowed = async (tx: ConsumerTransaction, orderReference: string) => {
    if ((await options.authorize(tx, { orderReference })) !== true) unavailable();
  };
  const fence = (tx: ConsumerTransaction, order: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + order,
    ]);

  async function evaluate(
    tx: ConsumerTransaction,
    order: string,
    selected: readonly string[],
    choice: OrderPriceReductionChoice,
  ): Promise<
    | { status: "Ready"; plan: OrderPriceReductionPlan }
    | { status: "NotEligible"; reason: OrderPriceReductionNotEligibleReason }
  > {
    const notEligible = (reason: OrderPriceReductionNotEligibleReason) =>
      ({ status: "NotEligible", reason }) as const;
    const header = (
      await tx.query(
        "SELECT order_type," +
          "COALESCE((SELECT status FROM rms_ordering.order_closure_version c WHERE c.brand_id=h.brand_id AND c.store_id=h.store_id AND c.order_id=h.order_id ORDER BY closure_version DESC LIMIT 1),'Open') AS closure," +
          "EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=h.brand_id AND t.store_id=h.store_id AND t.order_id=h.order_id) AS terminated " +
          "FROM rms_ordering.order_header h WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
        [brand, store, order],
      )
    ).rows[0] as Record<string, unknown> | undefined;
    if (!header) return notEligible("NotFound");
    if (header.order_type !== "DineIn") return notEligible("NotPayLater");
    if (header.closure !== "Open" || header.terminated === true) return notEligible("Closed");
    const items = (
      await tx.query(
        "SELECT i.order_item_id::text AS item,i.order_batch_id::text AS batch,i.transaction_snapshot_json AS snapshot," +
          "i.transaction_snapshot_json->'pricing'->>'quoteVersion' AS quote_version," +
          "EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p JOIN rms_ordering.order_batch b " +
          " ON b.brand_id=p.brand_id AND b.store_id=p.store_id AND b.order_id=p.order_id AND b.order_batch_id=p.order_batch_id AND b.submission_id=p.submission_id " +
          " WHERE p.brand_id=i.brand_id AND p.store_id=i.store_id AND p.order_id=i.order_id AND p.order_batch_id=i.order_batch_id) AS pay_later," +
          "EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation c WHERE c.brand_id=i.brand_id AND c.store_id=i.store_id AND c.order_id=i.order_id AND i.order_item_id::uuid=ANY(c.order_item_ids)) " +
          "OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=i.brand_id AND c.store_id=i.store_id AND c.order_id=i.order_id AND c.order_batch_id=i.order_batch_id) " +
          "OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=i.brand_id AND c.store_id=i.store_id AND c.order_id=i.order_id AND c.order_batch_id=i.order_batch_id) AS cancelled," +
          "EXISTS (SELECT 1 FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id) AS reduced " +
          "FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.order_item_id=ANY($4::uuid[]) ORDER BY i.order_item_id",
        [brand, store, order, selected],
      )
    ).rows as Record<string, unknown>[];
    if (items.length !== selected.length) return notEligible("NotFound");
    const lines: OrderPriceReductionPlan["lines"][number][] = [];
    for (const row of items) {
      if (row.pay_later !== true) return notEligible("NotPayLater");
      if (row.cancelled === true) return notEligible("ItemCancelled");
      if (row.reduced === true) return notEligible("AlreadyReduced");
      if (row.quote_version !== "1" && row.quote_version !== "2") return unavailable();
      const snapshot = (
        row.quote_version === "2" ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot
      )(row.snapshot);
      if (snapshot.orderItemReference !== String(row.item)) return unavailable();
      const amounts = orderPriceReductionAmounts(
        {
          netMinor: snapshot.pricing.subtotal.amountMinor - snapshot.pricing.discount.amountMinor,
          taxMinor: snapshot.pricing.tax.amountMinor,
          feeMinor: snapshot.pricing.fee.amountMinor,
        },
        choice,
      );
      if (amounts === null) return notEligible("InvalidAmount");
      lines.push(
        Object.freeze({
          orderBatchReference: String(parseOrderingReference(row.batch)),
          orderItemReference: String(parseOrderingReference(row.item)),
          ...amounts,
        }),
      );
    }
    return {
      status: "Ready",
      plan: Object.freeze({
        orderReference: order,
        choice: Object.freeze({
          kind: choice.kind,
          percent: choice.kind === "Percent" ? choice.percent : null,
        }),
        lines: Object.freeze(lines),
        totalMinor: lines.reduce((sum, line) => sum + line.totalMinor, 0n),
      }),
    };
  }

  const parseSelection = (values: readonly string[], choice: OrderPriceReductionChoice) => {
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) return unavailable();
    const selected = [...new Set(values.map((value) => String(parseOrderingReference(value))))];
    if (selected.length !== values.length) return unavailable();
    // An amount off is for one dish; a comp or a percentage may cover several.
    if (choice.kind === "Amount" && selected.length !== 1) return unavailable();
    return selected.sort();
  };

  return Object.freeze({
    async listByOrders(tx: ConsumerTransaction, orderReferences: readonly string[]) {
      for (const order of orderReferences) await allowed(tx, order);
      return listOrderPriceReductions(tx, scope, orderReferences);
    },

    async loadByOperation(tx: ConsumerTransaction, operationReference: string) {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const rows = (
        await tx.query(`${recordSelect} AND operation_id=$3 ORDER BY order_item_id LIMIT 51`, [
          brand,
          store,
          String(parseOrderingReference(operationReference)),
        ])
      ).rows as Record<string, unknown>[];
      if (rows.length > 50) return unavailable();
      const records = rows.map(recordFrom);
      if (records[0] !== undefined) await allowed(tx, records[0].orderReference);
      return Object.freeze(records);
    },

    /** Under the Order's fence (held to commit): the table's pay check runs after this. */
    async prepare(
      tx: ConsumerTransaction,
      input: {
        orderReference: string;
        orderItemReferences: readonly string[];
        choice: OrderPriceReductionChoice;
      },
    ) {
      const order = String(parseOrderingReference(input.orderReference));
      const selected = parseSelection(input.orderItemReferences, input.choice);
      await allowed(tx, order);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await fence(tx, order);
      const result = await evaluate(tx, order, selected, input.choice);
      await allowed(tx, order);
      return Object.freeze(result);
    },

    async commit(
      tx: ConsumerTransaction,
      input: {
        plan: OrderPriceReductionPlan;
        operationReference: string;
        actorReference: string;
        reasonCode: OrderPriceReductionReasonCode;
        decidedAt: string;
        nextReference(): string;
      },
    ): Promise<readonly OrderPriceReductionRecord[]> {
      const plan = input.plan;
      const operation = String(parseOrderingReference(input.operationReference)),
        actor = String(parseOrderingReference(input.actorReference)),
        decidedAt = String(parseOrderingInstant(input.decidedAt));
      if (!(orderPriceReductionReasonCodes as readonly string[]).includes(input.reasonCode))
        return unavailable();
      await allowed(tx, plan.orderReference);
      await fence(tx, plan.orderReference);
      const choice: OrderPriceReductionChoice =
        plan.choice.kind === "Percent"
          ? { kind: "Percent", percent: plan.choice.percent ?? 0 }
          : plan.choice.kind === "Amount"
            ? { kind: "Amount", netMinor: plan.lines[0]?.netMinor ?? 0n }
            : { kind: "Comp" };
      const current = await evaluate(
        tx,
        plan.orderReference,
        plan.lines.map((line) => line.orderItemReference),
        choice,
      );
      const digest = (value: OrderPriceReductionPlan) =>
        JSON.stringify(value, (_key, entry: unknown) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        );
      if (current.status !== "Ready" || digest(current.plan) !== digest(plan)) return conflict();
      await tx.query("SAVEPOINT ordering_price_reduction", []);
      try {
        for (const line of plan.lines) {
          const reduction = String(parseOrderingReference(input.nextReference()));
          const audit = String(parseOrderingReference(input.nextReference()));
          const inserted = await tx.query(
            "INSERT INTO rms_ordering.order_item_price_reduction (reduction_id,operation_id,brand_id,store_id,order_id,order_batch_id,order_item_id," +
              "kind,percent,net_minor,tax_minor,fee_minor,total_minor,currency_code,reason_code,actor_id,permission_code,audit_id,decided_at) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CAD',$14,$15,$16,$17,$18)",
            [
              reduction,
              operation,
              brand,
              store,
              plan.orderReference,
              line.orderBatchReference,
              line.orderItemReference,
              plan.choice.kind,
              plan.choice.percent,
              line.netMinor.toString(),
              line.taxMinor.toString(),
              line.feeMinor.toString(),
              line.totalMinor.toString(),
              input.reasonCode,
              actor,
              orderPriceReductionPermission,
              audit,
              decidedAt,
            ],
          );
          if (inserted.rowCount !== 1) return conflict();
          await appendAuditRecordInTransaction(
            tx,
            validateAuditRecord({
              auditId: audit,
              brandId: brand,
              storeId: store,
              actor: { type: "User", reference: actor },
              actionCode:
                plan.choice.kind === "Comp" ? "ORDER_ITEM_COMPED" : "ORDER_ITEM_DISCOUNTED",
              targetType: "OrderItem",
              targetId: line.orderItemReference,
              correlationId: operation,
              reasonCode: input.reasonCode,
              occurredAt: decidedAt,
              sourceChannel: "MERCHANT_WEB",
              afterSummary: {
                kind: plan.choice.kind,
                percent: plan.choice.percent,
                reductionMinor: line.totalMinor.toString(),
                sourceDigest: "sha256:" + createHash("sha256").update(digest(plan)).digest("hex"),
              },
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          );
        }
        await tx.query("RELEASE SAVEPOINT ordering_price_reduction", []);
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_price_reduction", []);
        await tx.query("RELEASE SAVEPOINT ordering_price_reduction", []);
        if (error instanceof OrderPriceReductionError) throw error;
        return conflict();
      }
      return this.loadByOperation(tx, operation);
    },
  });
}
