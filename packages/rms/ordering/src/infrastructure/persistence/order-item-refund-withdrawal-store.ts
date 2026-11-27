import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

/**
 * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): units of an order item staff refunded and
 * chose not to make or hand over ("stop making it too"). Recorded with the Payment refund request
 * that returns the money, in that transaction; it never changes the refund or the sale. Readers
 * count a withdrawal only while its refund request is not declined (Payment's own read).
 */
export interface OrderItemRefundWithdrawal {
  readonly withdrawalReference: string;
  readonly operationReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly refundRequestReference: string;
  readonly withdrawnQuantity: number;
  readonly actorReference: string;
  readonly recordedAt: string;
}
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const unavailable = (): never => {
  throw new Error("ORDER_REFUND_WITHDRAWAL_UNAVAILABLE");
};
const invalid = (): never => {
  throw new Error("ORDER_REFUND_WITHDRAWAL_INPUT_INVALID");
};
export const orderItemRefundWithdrawalMaximumLines = 100;
const selection =
  'withdrawal_id::text AS "withdrawalReference",operation_id::text AS "operationReference",' +
  'order_id::text AS "orderReference",order_batch_id::text AS "orderBatchReference",' +
  'order_item_id::text AS "orderItemReference",refund_request_id::text AS "refundRequestReference",' +
  'withdrawn_quantity AS "withdrawnQuantity",actor_id::text AS "actorReference",' +
  'to_char(recorded_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "recordedAt"';

function bind(row: Record<string, unknown>): OrderItemRefundWithdrawal {
  const quantity = row.withdrawnQuantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999)
    return unavailable();
  return Object.freeze({
    withdrawalReference: String(parseOrderingReference(row.withdrawalReference)),
    operationReference: String(parseOrderingReference(row.operationReference)),
    orderReference: String(parseOrderingReference(row.orderReference)),
    orderBatchReference: String(parseOrderingReference(row.orderBatchReference)),
    orderItemReference: String(parseOrderingReference(row.orderItemReference)),
    refundRequestReference: String(parseOrderingReference(row.refundRequestReference)),
    withdrawnQuantity: quantity,
    actorReference: String(parseOrderingReference(row.actorReference)),
    recordedAt: String(parseOrderingInstant(row.recordedAt)),
  });
}
async function setScope(tx: ConsumerTransaction, brand: string, store: string) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
}

/** Every withdrawal of the given Orders of the Store, oldest first. Caller authorizes. */
export async function listOrderItemRefundWithdrawals(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<readonly OrderItemRefundWithdrawal[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 100) return unavailable();
  const brand = String(parseOrderingReference(scope.brandReference)),
    store = String(parseOrderingReference(scope.storeReference));
  const orders = [
    ...new Set(orderReferences.map((value) => String(parseOrderingReference(value)))),
  ];
  await setScope(tx, brand, store);
  const found = await tx.query<Record<string, unknown>>(
    "SELECT " +
      selection +
      " FROM rms_ordering.order_item_refund_withdrawal WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) ORDER BY recorded_at,withdrawal_id LIMIT 10001",
    [brand, store, orders],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 10000) return unavailable();
  return Object.freeze(found.rows.map(bind));
}

/**
 * Records the withdrawals of one refund request (one row per order item), or answers the rows
 * already recorded for its operation when it is replayed with the same lines. Caller authorizes
 * `ordering.order.cancel` and checks each quantity against the units this request refunds.
 */
export async function recordOrderItemRefundWithdrawals(
  tx: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly orderReference: string;
    readonly refundRequestReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly recordedAt: string;
    readonly nextReference: () => string;
    readonly lines: readonly {
      readonly orderBatchReference: string;
      readonly orderItemReference: string;
      readonly quantity: number;
    }[];
  },
): Promise<readonly OrderItemRefundWithdrawal[]> {
  const brand = String(parseOrderingReference(scope.brandReference)),
    store = String(parseOrderingReference(scope.storeReference));
  const order = String(parseOrderingReference(input.orderReference)),
    request = String(parseOrderingReference(input.refundRequestReference)),
    operation = String(parseOrderingReference(input.operationReference)),
    actor = String(parseOrderingReference(input.actorReference)),
    at = String(parseOrderingInstant(input.recordedAt));
  if (
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > orderItemRefundWithdrawalMaximumLines
  )
    return invalid();
  const lines = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999)
      return invalid();
    return {
      batch: String(parseOrderingReference(line.orderBatchReference)),
      item: String(parseOrderingReference(line.orderItemReference)),
      quantity: line.quantity,
    };
  });
  if (new Set(lines.map((line) => line.item)).size !== lines.length) return invalid();
  await setScope(tx, brand, store);
  const prior = await tx.query<Record<string, unknown>>(
    "SELECT " +
      selection +
      " FROM rms_ordering.order_item_refund_withdrawal WHERE brand_id=$1 AND store_id=$2 AND refund_request_id=$3 ORDER BY order_item_id",
    [brand, store, request],
  );
  if (prior.rows.length > 0) {
    const recorded = prior.rows.map(bind);
    const same =
      recorded.length === lines.length &&
      recorded.every(
        (row) =>
          row.operationReference === operation &&
          row.orderReference === order &&
          lines.some(
            (line) =>
              line.item === row.orderItemReference &&
              line.batch === row.orderBatchReference &&
              line.quantity === row.withdrawnQuantity,
          ),
      );
    if (!same) throw new Error("ORDER_REFUND_WITHDRAWAL_CONFLICT");
    return Object.freeze(recorded);
  }
  const written: OrderItemRefundWithdrawal[] = [];
  for (const line of lines) {
    const result = await tx.query<Record<string, unknown>>(
      "INSERT INTO rms_ordering.order_item_refund_withdrawal (withdrawal_id,operation_id,brand_id,store_id,order_id,order_batch_id,order_item_id,refund_request_id,withdrawn_quantity,reason_code,actor_type,actor_id,permission_code,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REFUNDED_NOT_PROVIDED','User',$10,'ordering.order.cancel',$11::timestamptz) RETURNING " +
        selection,
      [
        String(parseOrderingReference(input.nextReference())),
        operation,
        brand,
        store,
        order,
        line.batch,
        line.item,
        request,
        line.quantity,
        actor,
        at,
      ],
    );
    if (result.rows.length !== 1) return unavailable();
    written.push(bind(result.rows[0] as Record<string, unknown>));
  }
  return Object.freeze(written);
}
