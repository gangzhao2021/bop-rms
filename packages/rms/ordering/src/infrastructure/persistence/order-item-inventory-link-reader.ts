import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, type OrderingReference } from "../../domain/cart.js";

export class OrderItemInventoryLinkError extends Error {
  readonly code = "ORDER_ITEM_INVENTORY_LINK_UNAVAILABLE" as const;
  constructor() {
    super("Order item inventory link is unavailable");
    this.name = "OrderItemInventoryLinkError";
  }
}
const fail = (): never => {
  throw new OrderItemInventoryLinkError();
};
export interface OrderItemInventoryLink {
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  /** The source Cart line, which Inventory reserved as the per-line demand identity. */
  readonly cartItemReference: OrderingReference;
  readonly quantity: number;
}

/**
 * WP-2423 public owner Query: resolves one submitted Order item to the submission and source Cart
 * line Inventory reserved for, so Inventory never reads Ordering tables. Bound to the caller's
 * transaction and fixed Brand/Store scope; the caller authorizes the purpose.
 */
export function createPostgresOrderItemInventoryLinkReader(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, orderItemReference: string): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async load(
      transaction: ConsumerTransaction,
      orderItem: string,
    ): Promise<OrderItemInventoryLink | null> {
      const orderItemReference = parseOrderingReference(orderItem);
      if ((await options.authorize(transaction, orderItemReference)) !== true) return fail();
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const result = await transaction.query<Record<string, unknown>>(
        "SELECT i.order_id::text AS order_id,i.order_batch_id::text AS batch_id," +
          "b.submission_id::text AS submission_id,i.source_cart_line_id::text AS cart_line_id," +
          "i.quantity FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b " +
          "ON b.order_batch_id=i.order_batch_id AND b.order_id=i.order_id " +
          "AND b.brand_id=i.brand_id AND b.store_id=i.store_id " +
          "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_item_id=$3",
        [brand, store, orderItemReference],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) return fail();
      const quantity = Number(row.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) return fail();
      return Object.freeze({
        orderReference: parseOrderingReference(row.order_id),
        orderBatchReference: parseOrderingReference(row.batch_id),
        submissionReference: parseOrderingReference(row.submission_id),
        cartItemReference: parseOrderingReference(row.cart_line_id),
        quantity,
      });
    },
  });
}
