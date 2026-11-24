import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import { billTaxRoundingShareLimitMinor } from "../../application/bill-tax-rounding.js";
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
/** WP-2423 取舍 18: a guest's points on the bill. Never a reason a manager can choose. */
export const orderPointsRedemptionReason = "POINTS_REDEMPTION" as const;
export const orderPointsRedemptionPermission = "loyalty.points.redeem" as const;
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
  /**
   * v15 b16 (DEC-COMP-BILL-CENT): the part of `taxMinor` that is the whole bill's tax cent this
   * reduction took off beyond the dish's own tax share (0 for most; signed).
   */
  readonly taxRoundingMinor: bigint;
  readonly reasonCode: OrderPriceReductionReasonCode | typeof orderPointsRedemptionReason;
  readonly actorReference: string;
  readonly decidedAt: string;
  /**
   * Batch 60: how many of the line's dishes this comp covers ("1 of 2 × Beef noodles"); null for
   * a reduction of the whole line recorded before batch 60, a percentage, an amount off or points.
   */
  readonly compedQuantity: number | null;
  /** Batch 60: how many dishes the line has (its order quantity). */
  readonly lineQuantity: number;
}
export interface OrderPriceReductionPlan {
  readonly orderReference: string;
  readonly choice: { readonly kind: OrderPriceReductionKind; readonly percent: number | null };
  readonly lines: readonly {
    readonly orderBatchReference: string;
    readonly orderItemReference: string;
    readonly netMinor: bigint;
    /** The dish's share of its tax plus `taxRoundingMinor`. */
    readonly taxMinor: bigint;
    readonly feeMinor: bigint;
    readonly totalMinor: bigint;
    /** v15 b16: the whole bill's tax cent on this dish (see {@link withBillTaxRoundingShares}). */
    readonly taxRoundingMinor: bigint;
    /** Batch 60: the dishes of the line a manager's comp covers (null: the whole line). */
    readonly compedQuantity: number | null;
    readonly lineQuantity: number;
  }[];
  readonly totalMinor: bigint;
}

/**
 * Batch 60: "NotThatMany" — a comp asked for more of a line's dishes than are left to comp (another
 * comp took some meanwhile). "AlreadyReduced" — nothing is left to comp on the line, or it has a
 * percentage, an amount off or points (which cover the line alone).
 */
export type OrderPriceReductionNotEligibleReason =
  | "NotFound"
  | "NotPayLater"
  | "Closed"
  | "ItemCancelled"
  | "AlreadyReduced"
  | "NotThatMany"
  | "InvalidAmount";

/**
 * Batch 61 (v15 b60 live, order 54): why a line can't take a reduction now (null: it can).
 * `asked` is the dishes a manager's comp names for the line (null: a whole-line reduction or the
 * dishes left). A comp names a count only while more dishes are left than it names (the dialog
 * sends none for "all left"), so a named count that finds nothing left lost a race with another
 * part comp: "NotThatMany" (fewer are left than chosen), never "AlreadyReduced" (a comp already
 * covers the dish), which stays for a line with nothing left that was asked as a whole.
 */
export function orderItemCompLineRefusal(line: {
  readonly lineQuantity: number;
  readonly reducedCount: number;
  readonly compedQuantity: number;
  readonly reducedWhole: boolean;
  /** Only a manager's comp naming its dishes may join a comp of some of the line's dishes. */
  readonly byDishes: boolean;
  readonly asked: number | null;
}): "AlreadyReduced" | "NotThatMany" | null {
  if (line.reducedCount > 0 && (!line.byDishes || line.reducedWhole)) return "AlreadyReduced";
  const left = line.lineQuantity - line.compedQuantity;
  if (left < 1) return line.byDishes && line.asked !== null ? "NotThatMany" : "AlreadyReduced";
  if (line.asked !== null && line.asked > left) return "NotThatMany";
  return null;
}

export class OrderPriceReductionError extends Error {
  constructor(
    readonly code:
      | "ORDER_PRICE_REDUCTION_CONFLICT"
      | "ORDER_PRICE_REDUCTION_UNAVAILABLE"
      /** Batch 61: the database refused comps covering more dishes than the line has. */
      | "ORDER_PRICE_REDUCTION_NOT_THAT_MANY",
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
const signedCents = (value: unknown) => {
  const text = String(value);
  if (!/^-?[0-9]$/u.test(text) || text === "-0") return unavailable();
  return BigInt(text);
};
/** Half up to the cent: share of `amount` in proportion `part / whole` (whole > 0). */
const proportion = (amount: bigint, part: bigint, whole: bigint) =>
  (amount * part * 2n + whole) / (2n * whole);

/** The reduction of one dish: net off its price, tax and fee in proportion (the database's rule). */
export function orderPriceReductionAmounts(
  price: { readonly netMinor: bigint; readonly taxMinor: bigint; readonly feeMinor: bigint },
  choice: OrderPriceReductionChoice,
): {
  netMinor: bigint;
  taxMinor: bigint;
  feeMinor: bigint;
  totalMinor: bigint;
  taxRoundingMinor: bigint;
} | null {
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
  return {
    netMinor: net,
    taxMinor: tax,
    feeMinor: fee,
    totalMinor: net + tax + fee,
    taxRoundingMinor: 0n,
  };
}

/**
 * Batch 60: a comp of `quantity` dishes of a line of `lineQuantity`, after `priorQuantity` of them
 * were comped: net, tax and fee each in proportion to the dishes covered so far, half up to the
 * cent (dishes 1..c come to round(amount × c / lineQuantity)), so the whole line comes to its
 * price exactly and comps of each of its dishes add up to it (the database's rule, 2000_998).
 * Null when the line has nothing left to comp of that size, or the comp would take nothing off.
 */
export function orderItemCompAmounts(
  price: { readonly netMinor: bigint; readonly taxMinor: bigint; readonly feeMinor: bigint },
  line: {
    readonly lineQuantity: number;
    readonly priorQuantity: number;
    readonly quantity: number;
  },
): {
  netMinor: bigint;
  taxMinor: bigint;
  feeMinor: bigint;
  totalMinor: bigint;
  taxRoundingMinor: bigint;
} | null {
  const { lineQuantity, priorQuantity, quantity } = line;
  if (
    ![lineQuantity, priorQuantity, quantity].every(Number.isSafeInteger) ||
    lineQuantity < 1 ||
    lineQuantity > 999 ||
    priorQuantity < 0 ||
    quantity < 1 ||
    priorQuantity + quantity > lineQuantity ||
    price.netMinor <= 0n ||
    price.taxMinor < 0n ||
    price.feeMinor < 0n
  )
    return null;
  const q = BigInt(lineQuantity);
  const upTo = (amount: bigint, covered: number) => (amount * BigInt(covered) * 2n + q) / (2n * q);
  const part = (amount: bigint) =>
    upTo(amount, priorQuantity + quantity) - upTo(amount, priorQuantity);
  const net = part(price.netMinor);
  if (net < 1n) return null;
  const tax = part(price.taxMinor),
    fee = part(price.feeMinor);
  return {
    netMinor: net,
    taxMinor: tax,
    feeMinor: fee,
    totalMinor: net + tax + fee,
    taxRoundingMinor: 0n,
  };
}

/**
 * Batch 60: a line's reductions as one, by dish line — what the bill, the split, the reports and
 * the receipts take off the line. A line has one reduction, or (since batch 60) one comp or more,
 * each covering some of its dishes; their amounts add up. The latest decides the kind, reason,
 * actor and time said for the line; `compedQuantity` is the dishes the comps cover (null: the
 * whole line, by a reduction that names no dishes) and `remainingQuantity` what is left to comp.
 */
export interface OrderItemReduction {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly kind: OrderPriceReductionKind;
  readonly percent: number | null;
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalMinor: bigint;
  readonly taxRoundingMinor: bigint;
  readonly reasonCode: OrderPriceReductionRecord["reasonCode"];
  readonly actorReference: string;
  readonly decidedAt: string;
  readonly compedQuantity: number | null;
  readonly lineQuantity: number;
  readonly remainingQuantity: number;
  readonly records: readonly OrderPriceReductionRecord[];
}
export function orderItemReductions(
  records: readonly OrderPriceReductionRecord[],
): ReadonlyMap<string, OrderItemReduction> {
  const byItem = new Map<string, OrderPriceReductionRecord[]>();
  for (const record of records)
    byItem.set(record.orderItemReference, [
      ...(byItem.get(record.orderItemReference) ?? []),
      record,
    ]);
  const merged = new Map<string, OrderItemReduction>();
  for (const [item, list] of byItem) {
    const ordered = [...list].sort((a, b) =>
      a.decidedAt === b.decidedAt
        ? a.reductionReference < b.reductionReference
          ? -1
          : 1
        : a.decidedAt < b.decidedAt
          ? -1
          : 1,
    );
    const latest = ordered[ordered.length - 1] as OrderPriceReductionRecord;
    const sum = (field: "netMinor" | "taxMinor" | "feeMinor" | "totalMinor" | "taxRoundingMinor") =>
      ordered.reduce((total, record) => total + record[field], 0n);
    const compedQuantity = ordered.every((record) => record.compedQuantity !== null)
      ? ordered.reduce((total, record) => total + (record.compedQuantity ?? 0), 0)
      : null;
    merged.set(
      item,
      Object.freeze({
        orderReference: latest.orderReference,
        orderBatchReference: latest.orderBatchReference,
        orderItemReference: item,
        kind: latest.kind,
        percent: latest.percent,
        netMinor: sum("netMinor"),
        taxMinor: sum("taxMinor"),
        feeMinor: sum("feeMinor"),
        totalMinor: sum("totalMinor"),
        taxRoundingMinor: sum("taxRoundingMinor"),
        reasonCode: latest.reasonCode,
        actorReference: latest.actorReference,
        decidedAt: latest.decidedAt,
        compedQuantity,
        lineQuantity: latest.lineQuantity,
        remainingQuantity:
          compedQuantity === null ? 0 : Math.max(0, latest.lineQuantity - compedQuantity),
        records: Object.freeze(ordered),
      }),
    );
  }
  return merged;
}

/**
 * v15 b16 (DEC-COMP-BILL-CENT, docs/spec/design/comp-bill-cent-b16.md): the plan with the whole
 * bill's tax cent on its dishes (from `billReductionTaxRoundingShares`), so what it records is what
 * the bill goes down by. A share is a few cents at most and never makes a dish's tax negative.
 */
export function withBillTaxRoundingShares(
  plan: OrderPriceReductionPlan,
  shares: ReadonlyMap<string, bigint>,
): OrderPriceReductionPlan {
  const lines = plan.lines.map((line) => {
    const base = line.taxMinor - line.taxRoundingMinor;
    const share = shares.get(line.orderItemReference) ?? 0n;
    if (
      share < -billTaxRoundingShareLimitMinor ||
      share > billTaxRoundingShareLimitMinor ||
      base + share < 0n
    )
      return unavailable();
    return Object.freeze({
      ...line,
      taxMinor: base + share,
      totalMinor: line.netMinor + base + share + line.feeMinor,
      taxRoundingMinor: share,
    });
  });
  return Object.freeze({
    ...plan,
    lines: Object.freeze(lines),
    totalMinor: lines.reduce((sum, line) => sum + line.totalMinor, 0n),
  });
}
const recordSelect = `SELECT reduction_id::text AS reduction,operation_id::text AS operation,order_id::text AS "order",
 order_batch_id::text AS batch,order_item_id::text AS item,kind,percent,net_minor::text AS net,tax_minor::text AS tax,
 fee_minor::text AS fee,total_minor::text AS total,tax_rounding_minor::text AS tax_rounding,reason_code,actor_id::text AS actor,decided_at,
 comped_quantity,(SELECT i.quantity FROM rms_ordering.order_item i WHERE i.brand_id=r.brand_id AND i.store_id=r.store_id
  AND i.order_id=r.order_id AND i.order_item_id=r.order_item_id) AS line_quantity
 FROM rms_ordering.order_item_price_reduction r WHERE brand_id=$1 AND store_id=$2`;
const dishCount = (value: unknown) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 999) return unavailable();
  return count;
};
function recordFrom(row: Record<string, unknown>): OrderPriceReductionRecord {
  const kind = row.kind;
  const reason = row.reason_code;
  if (
    (kind !== "Comp" && kind !== "Percent" && kind !== "Amount") ||
    !(
      (orderPriceReductionReasonCodes as readonly unknown[]).includes(reason) ||
      reason === orderPointsRedemptionReason
    )
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
    taxRoundingMinor: signedCents(row.tax_rounding),
    reasonCode: reason as OrderPriceReductionRecord["reasonCode"],
    actorReference: String(parseOrderingReference(row.actor)),
    decidedAt: instant(row.decided_at),
    compedQuantity: row.comped_quantity === null ? null : dishCount(row.comped_quantity),
    lineQuantity: dishCount(row.line_quantity),
  };
  if (
    record.totalMinor !== record.netMinor + record.taxMinor + record.feeMinor ||
    (record.compedQuantity !== null &&
      (record.kind !== "Comp" || record.compedQuantity > record.lineQuantity))
  )
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
    /**
     * Batch 60: a manager's comp names how many of each line's dishes it covers (absent from the
     * map: every dish still left on the line). Undefined: a reduction of the whole line (points).
     */
    quantities?: ReadonlyMap<string, number>,
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
          "i.quantity AS line_quantity," +
          "(SELECT count(*) FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id)::int AS reduced," +
          "(SELECT bool_or(r.comped_quantity IS NULL) FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id) AS reduced_whole," +
          "(SELECT COALESCE(sum(r.comped_quantity),0) FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id)::int AS comped " +
          "FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.order_item_id=ANY($4::uuid[]) ORDER BY i.order_item_id",
        [brand, store, order, selected],
      )
    ).rows as Record<string, unknown>[];
    if (items.length !== selected.length) return notEligible("NotFound");
    const lines: OrderPriceReductionPlan["lines"][number][] = [];
    for (const row of items) {
      if (row.pay_later !== true) return notEligible("NotPayLater");
      if (row.cancelled === true) return notEligible("ItemCancelled");
      const lineQuantity = dishCount(row.line_quantity);
      const reducedCount = Number(row.reduced);
      const comped = Number(row.comped);
      if (!Number.isSafeInteger(reducedCount) || !Number.isSafeInteger(comped))
        return unavailable();
      // Batch 60: only a manager's comp may join a comp of some of the line's dishes; a
      // reduction of the whole line (an older comp, a percentage, an amount off, points) stands
      // alone.
      const byDishes = choice.kind === "Comp" && quantities !== undefined;
      const left = lineQuantity - comped;
      const named = byDishes ? quantities.get(String(row.item)) : undefined;
      if (named !== undefined && (!Number.isSafeInteger(named) || named < 1)) return unavailable();
      // Batch 61: a count named while dishes were left that finds none now is "fewer are left".
      const refusal = orderItemCompLineRefusal({
        lineQuantity,
        reducedCount,
        compedQuantity: comped,
        reducedWhole: row.reduced_whole === true,
        byDishes,
        asked: named ?? null,
      });
      if (refusal !== null) return notEligible(refusal);
      const asked = byDishes ? (named ?? left) : null;
      if (row.quote_version !== "1" && row.quote_version !== "2") return unavailable();
      const snapshot = (
        row.quote_version === "2" ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot
      )(row.snapshot);
      if (snapshot.orderItemReference !== String(row.item)) return unavailable();
      const price = {
        netMinor: snapshot.pricing.subtotal.amountMinor - snapshot.pricing.discount.amountMinor,
        taxMinor: snapshot.pricing.tax.amountMinor,
        feeMinor: snapshot.pricing.fee.amountMinor,
      };
      const amounts =
        asked === null
          ? orderPriceReductionAmounts(price, choice)
          : orderItemCompAmounts(price, { lineQuantity, priorQuantity: comped, quantity: asked });
      if (amounts === null) return notEligible("InvalidAmount");
      lines.push(
        Object.freeze({
          orderBatchReference: String(parseOrderingReference(row.batch)),
          orderItemReference: String(parseOrderingReference(row.item)),
          ...amounts,
          compedQuantity: asked,
          lineQuantity,
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
  // Batch 60: a manager's comp always names the dishes it covers (every dish left by default).
  const compQuantitiesOf = (
    choice: OrderPriceReductionChoice,
    selected: readonly string[],
    given: ReadonlyMap<string, number> | undefined,
  ): ReadonlyMap<string, number> | undefined => {
    if (choice.kind !== "Comp") {
      if (given !== undefined && given.size > 0) return unavailable();
      return undefined;
    }
    const quantities = new Map<string, number>();
    for (const [item, quantity] of given ?? new Map<string, number>()) {
      const reference = String(parseOrderingReference(item));
      if (!selected.includes(reference) || !Number.isSafeInteger(quantity) || quantity < 1)
        return unavailable();
      quantities.set(reference, quantity);
    }
    return quantities;
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

    /**
     * What these Orders' dishes can still take off: every dish of a pay-later round that isn't
     * cancelled or already reduced, largest first. Under each Order's fence (held to commit).
     */
    async listRedeemableDishes(tx: ConsumerTransaction, orderReferences: readonly string[]) {
      const orders = [
        ...new Set(orderReferences.map((o) => String(parseOrderingReference(o)))),
      ].sort();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const dishes: {
        orderReference: string;
        orderBatchReference: string;
        orderItemReference: string;
        productReference: string | null;
        netMinor: bigint;
        taxMinor: bigint;
        feeMinor: bigint;
      }[] = [];
      for (const order of orders) {
        await allowed(tx, order);
        await fence(tx, order);
        const rows = (
          await tx.query(
            "SELECT i.order_item_id::text AS item FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 " +
              "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id) " +
              "ORDER BY i.order_item_id LIMIT 500",
            [brand, store, order],
          )
        ).rows as Record<string, unknown>[];
        for (const row of rows) {
          const item = String(parseOrderingReference(row.item));
          const checked = await evaluate(tx, order, [item], { kind: "Comp" });
          if (checked.status !== "Ready") continue;
          const line = checked.plan.lines[0];
          if (line === undefined) continue;
          const product = (
            await tx.query(
              "SELECT transaction_snapshot_json->'catalog'->>'productReference' AS product FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_item_id=$3",
              [brand, store, item],
            )
          ).rows[0] as Record<string, unknown> | undefined;
          dishes.push(
            Object.freeze({
              orderReference: order,
              orderBatchReference: line.orderBatchReference,
              orderItemReference: line.orderItemReference,
              productReference: typeof product?.product === "string" ? product.product : null,
              netMinor: line.netMinor,
              taxMinor: line.taxMinor,
              feeMinor: line.feeMinor,
            }),
          );
        }
      }
      return Object.freeze(
        dishes.sort((a, b) =>
          a.netMinor === b.netMinor
            ? a.orderItemReference.localeCompare(b.orderItemReference)
            : a.netMinor > b.netMinor
              ? -1
              : 1,
        ),
      );
    },

    /**
     * WP-2423 取舍 18: points off the bill, as a reduction on each dish like any other discount: the
     * dish stays sold at its price. Whole dishes while the amount lasts, then part of the next; each
     * dish's tax follows it. A dish left free carries no tax; points never pay tax on their own.
     */
    async commitPointsRedemption(
      tx: ConsumerTransaction,
      input: {
        lines: readonly { orderItemReference: string; orderReference: string; netMinor: bigint }[];
        operationReference: string;
        accountReference: string;
        decidedAt: string;
        nextReference(): string;
        /** v15 b16: the whole bill's tax cent on these dishes (absent: none). */
        billTaxRoundingShares?: (
          lines: readonly OrderPriceReductionPlan["lines"][number][],
        ) => Promise<ReadonlyMap<string, bigint>>;
      },
    ): Promise<readonly OrderPriceReductionRecord[]> {
      const operation = String(parseOrderingReference(input.operationReference)),
        actor = String(parseOrderingReference(input.accountReference)),
        decidedAt = String(parseOrderingInstant(input.decidedAt));
      const records: OrderPriceReductionRecord[] = [];
      await tx.query("SAVEPOINT ordering_points_redemption", []);
      try {
        const planned: {
          orderReference: string;
          choice: OrderPriceReductionChoice;
          line: OrderPriceReductionPlan["lines"][number];
        }[] = [];
        for (const wanted of input.lines) {
          await allowed(tx, wanted.orderReference);
          await fence(tx, wanted.orderReference);
          const whole = await evaluate(tx, wanted.orderReference, [wanted.orderItemReference], {
            kind: "Comp",
          });
          if (whole.status !== "Ready") return conflict();
          const wholeLine = whole.plan.lines[0];
          if (wholeLine === undefined) return conflict();
          const choice: OrderPriceReductionChoice =
            wanted.netMinor === wholeLine.netMinor
              ? { kind: "Comp" }
              : { kind: "Amount", netMinor: wanted.netMinor };
          const checked = await evaluate(
            tx,
            wanted.orderReference,
            [wanted.orderItemReference],
            choice,
          );
          if (checked.status !== "Ready") return conflict();
          const line = checked.plan.lines[0];
          if (line === undefined) return conflict();
          planned.push({ orderReference: wanted.orderReference, choice, line });
        }
        // v15 b16 (DEC-COMP-BILL-CENT): the whole bill's tax cent, so the points take off exactly
        // what the bill goes down by.
        const shares =
          input.billTaxRoundingShares === undefined
            ? new Map<string, bigint>()
            : await input.billTaxRoundingShares(planned.map((entry) => entry.line));
        for (const entry of planned) {
          const [line] = withBillTaxRoundingShares(
            {
              orderReference: entry.orderReference,
              choice: { kind: entry.choice.kind, percent: null },
              lines: [entry.line],
              totalMinor: entry.line.totalMinor,
            },
            shares,
          ).lines;
          if (line === undefined) return conflict();
          const choice = entry.choice;
          const wanted = { orderReference: entry.orderReference };
          const reduction = String(parseOrderingReference(input.nextReference()));
          const audit = String(parseOrderingReference(input.nextReference()));
          await tx.query(
            "INSERT INTO rms_ordering.order_item_price_reduction (reduction_id,operation_id,brand_id,store_id,order_id,order_batch_id,order_item_id," +
              "kind,percent,net_minor,tax_minor,fee_minor,total_minor,currency_code,reason_code,actor_id,permission_code,audit_id,decided_at,tax_rounding_minor) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,'CAD',$13,$14,$15,$16,$17,$18)",
            [
              reduction,
              operation,
              brand,
              store,
              wanted.orderReference,
              line.orderBatchReference,
              line.orderItemReference,
              choice.kind,
              line.netMinor.toString(),
              line.taxMinor.toString(),
              line.feeMinor.toString(),
              line.totalMinor.toString(),
              orderPointsRedemptionReason,
              actor,
              orderPointsRedemptionPermission,
              audit,
              decidedAt,
              line.taxRoundingMinor.toString(),
            ],
          );
          await appendAuditRecordInTransaction(
            tx,
            validateAuditRecord({
              auditId: audit,
              brandId: brand,
              storeId: store,
              actor: { type: "System" },
              actionCode: "ORDER_ITEM_POINTS_REDEEMED",
              targetType: "OrderItem",
              targetId: line.orderItemReference,
              correlationId: operation,
              reasonCode: orderPointsRedemptionReason,
              occurredAt: decidedAt,
              sourceChannel: "CUSTOMER_PWA",
              afterSummary: {
                kind: choice.kind,
                reductionMinor: line.totalMinor.toString(),
              },
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          );
          records.push(
            Object.freeze({
              reductionReference: reduction,
              operationReference: operation,
              orderReference: wanted.orderReference,
              orderBatchReference: line.orderBatchReference,
              orderItemReference: line.orderItemReference,
              kind: choice.kind,
              percent: null,
              netMinor: line.netMinor,
              taxMinor: line.taxMinor,
              feeMinor: line.feeMinor,
              totalMinor: line.totalMinor,
              taxRoundingMinor: line.taxRoundingMinor,
              reasonCode: orderPointsRedemptionReason,
              actorReference: actor,
              decidedAt,
              compedQuantity: null,
              lineQuantity: line.lineQuantity,
            }),
          );
        }
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_points_redemption", []);
        throw error;
      }
      return Object.freeze(records);
    },

    /** Under the Order's fence (held to commit): the table's pay check runs after this. */
    async prepare(
      tx: ConsumerTransaction,
      input: {
        orderReference: string;
        orderItemReferences: readonly string[];
        choice: OrderPriceReductionChoice;
        /**
         * Batch 60: for a comp, how many of each line's dishes (absent: every dish left on it).
         * Only for a comp; a percentage or an amount off covers a whole line.
         */
        compQuantities?: ReadonlyMap<string, number>;
      },
    ) {
      const order = String(parseOrderingReference(input.orderReference));
      const selected = parseSelection(input.orderItemReferences, input.choice);
      const quantities = compQuantitiesOf(input.choice, selected, input.compQuantities);
      await allowed(tx, order);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await fence(tx, order);
      const result = await evaluate(tx, order, selected, input.choice, quantities);
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
      // Batch 60: a manager's comp names the dishes of each line it covers (every comp since).
      const current = await evaluate(
        tx,
        plan.orderReference,
        plan.lines.map((line) => line.orderItemReference),
        choice,
        choice.kind === "Comp"
          ? new Map(
              plan.lines.map((line) => [
                line.orderItemReference,
                line.compedQuantity ?? unavailable(),
              ]),
            )
          : undefined,
      );
      const digest = (value: OrderPriceReductionPlan) =>
        JSON.stringify(value, (_key, entry: unknown) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        );
      // v15 b16: the plan may carry the whole bill's tax cent on its dishes (worked out by the
      // caller from the bill); everything else must be what the dishes give now.
      if (current.status !== "Ready") return conflict();
      const settled = withBillTaxRoundingShares(
        current.plan,
        new Map(plan.lines.map((line) => [line.orderItemReference, line.taxRoundingMinor])),
      );
      if (digest(settled) !== digest(plan)) return conflict();
      await tx.query("SAVEPOINT ordering_price_reduction", []);
      try {
        for (const line of plan.lines) {
          const reduction = String(parseOrderingReference(input.nextReference()));
          const audit = String(parseOrderingReference(input.nextReference()));
          const inserted = await tx.query(
            "INSERT INTO rms_ordering.order_item_price_reduction (reduction_id,operation_id,brand_id,store_id,order_id,order_batch_id,order_item_id," +
              "kind,percent,net_minor,tax_minor,fee_minor,total_minor,currency_code,reason_code,actor_id,permission_code,audit_id,decided_at,tax_rounding_minor,comped_quantity) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CAD',$14,$15,$16,$17,$18,$19,$20)",
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
              line.taxRoundingMinor.toString(),
              line.compedQuantity,
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
                ...(line.compedQuantity === null
                  ? {}
                  : { compedQuantity: line.compedQuantity, lineQuantity: line.lineQuantity }),
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
        // Batch 61: the line's own check (after the insert) refused more dishes than it has.
        if (
          error instanceof Error &&
          error.message.includes("price reduction covers more dishes than the line has")
        )
          throw new OrderPriceReductionError("ORDER_PRICE_REDUCTION_NOT_THAT_MANY");
        return conflict();
      }
      return this.loadByOperation(tx, operation);
    },
  });
}

/**
 * WP-2423 取舍 18: what the dishes of each round of this Order cost before tax, less any discount
 * and reduction on them; what points earn on.
 */
export async function listOrderRoundDishes(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<ReadonlyMap<string, bigint>> {
  const brand = String(parseOrderingReference(scope.brandReference)),
    store = String(parseOrderingReference(scope.storeReference)),
    order = String(parseOrderingReference(orderReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const rows = (
    await tx.query(
      "SELECT i.order_batch_id::text AS batch,sum(((i.transaction_snapshot_json->'pricing'->'subtotal'->>'amountMinor')::bigint)-" +
        "((i.transaction_snapshot_json->'pricing'->'discount'->>'amountMinor')::bigint)-" +
        "COALESCE((SELECT sum(r.net_minor) FROM rms_ordering.order_item_price_reduction r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.order_item_id=i.order_item_id),0))::text AS net " +
        "FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 GROUP BY i.order_batch_id",
      [brand, store, order],
    )
  ).rows as Record<string, unknown>[];
  return new Map(rows.map((row) => [String(row.batch), minor(row.net)]));
}
