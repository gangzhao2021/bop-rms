import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";
import { listOrderPriceReductions } from "./order-item-price-reduction-store.js";
import { createPostgresPayLaterItemCancellationStore } from "./pay-later-item-cancellation-store.js";

/** One priced line as the customer was charged for it (immutable snapshot, minor units). */
export interface StoreSalesOrderItem {
  readonly orderItemReference: string;
  readonly quantity: number;
  readonly productReference: string;
  readonly skuReference: string;
  /** The sellable's name at the time of sale, size included ("Flat White — Small"). */
  readonly name: string;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  /**
   * WP-2423 item 8 ① segment 2: what a manager comped or discounted off the net before the table
   * paid (0 when none). `taxMinor`, `feeMinor`, `totalMinor` and `taxComponents` are as charged,
   * after it; `subtotalMinor` and `discountMinor` stay as sold.
   */
  readonly compMinor: bigint;
  readonly taxMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalMinor: bigint;
  readonly taxComponents: readonly { readonly code: string; readonly amountMinor: bigint }[];
}
export interface StoreSalesOrder {
  readonly orderReference: string;
  readonly orderType: "DineIn" | "Pickup";
  /** `Pos` is an order staff took at the counter. */
  readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web";
  readonly businessDate: string;
  readonly batches: readonly {
    readonly orderBatchReference: string;
    readonly items: readonly StoreSalesOrderItem[];
  }[];
}

const fail = (): never => {
  throw new Error("STORE_SALES_ORDER_SOURCE_UNAVAILABLE");
};

/**
 * WP-2423 Q14 (store reports): the Store's Orders by reference with each Batch's priced lines from
 * their immutable snapshots — what was sold, at which price, discount and tax. No guest, contact,
 * note or staff fields leave the owner. The caller authorizes the Store in this transaction.
 */
export function createPostgresStoreSalesOrderSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly locale: string;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const brand = String(parseOrderingReference(options.brandReference)),
    store = String(parseOrderingReference(options.storeReference));
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(options.locale)) return fail();
  return async (
    tx: ConsumerTransaction,
    orderReferences: readonly string[],
  ): Promise<readonly StoreSalesOrder[]> => {
    const wanted = [
      ...new Set(orderReferences.map((value) => String(parseOrderingReference(value)))),
    ];
    if (wanted.length > 20000) return fail();
    if ((await options.authorize(tx)) !== true) return fail();
    const orders: StoreSalesOrder[] = [];
    for (let index = 0; index < wanted.length; index += 500) {
      const chunk = wanted.slice(index, index + 500);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const headers = await tx.query(
        "SELECT order_id::text AS order_id,order_type,source_channel,business_date::text AS business_date FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        [brand, store, chunk],
      );
      const items = await tx.query(
        "SELECT i.order_id::text AS order_id,i.order_batch_id::text AS batch_id,i.order_item_id::text AS item_id,i.ordinal,i.quantity,i.transaction_snapshot_json AS snapshot,i.transaction_snapshot_json#>>'{pricing,quoteVersion}' AS quote_version FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=ANY($3::uuid[]) ORDER BY i.order_id,b.submitted_at,i.order_batch_id,i.ordinal LIMIT 200001",
        [brand, store, chunk],
      );
      if (items.rows.length > 200000) return fail();
      // DEC-DINE-IN-PAY-LATER (rule 2): dishes taken off an unpaid table's bill were never sold or
      // charged (the kitchen stopped them), so they are not lines of the sale.
      const removals = createPostgresPayLaterItemCancellationStore({
        brandReference: brand,
        storeReference: store,
        authorize: async (t) => (await options.authorize(t)) === true,
      });
      const removed = new Set<string>();
      for (let part = 0; part < chunk.length; part += 200)
        for (const record of await removals.listByOrders(tx, chunk.slice(part, part + 200)))
          for (const line of record.orderItemReferences) removed.add(line);
      const reductions = new Map(
        (
          await listOrderPriceReductions(
            tx,
            { brandReference: brand, storeReference: store },
            chunk,
          )
        ).map((record) => [record.orderItemReference, record]),
      );
      const byOrder = new Map<string, Map<string, StoreSalesOrderItem[]>>();
      for (const row of items.rows as readonly Record<string, unknown>[]) {
        const snapshot =
          row.quote_version === "2"
            ? decodeConfiguredOrderItemSnapshot(row.snapshot)
            : row.quote_version === "1"
              ? decodeOrderItemSnapshot(row.snapshot)
              : fail();
        if (
          snapshot.orderItemReference !== row.item_id ||
          snapshot.orderBatchReference !== row.batch_id ||
          snapshot.quantity !== row.quantity ||
          snapshot.catalog.brandReference !== brand ||
          snapshot.catalog.storeReference !== store
        )
          return fail();
        const pricing = snapshot.pricing;
        const currency = [
          pricing.subtotal,
          pricing.discount,
          pricing.tax,
          pricing.fee,
          pricing.total,
        ].every((amount) => amount.currencyCode === "CAD");
        if (!currency) return fail();
        const names = snapshot.catalog.localizedNames;
        const name = names[options.locale] ?? Object.values(names)[0] ?? fail();
        const batches =
          byOrder.get(String(row.order_id)) ?? new Map<string, StoreSalesOrderItem[]>();
        byOrder.set(String(row.order_id), batches);
        const lines = batches.get(String(row.batch_id)) ?? [];
        batches.set(String(row.batch_id), lines);
        if (removed.has(String(snapshot.orderItemReference))) continue;
        const off = reductions.get(String(snapshot.orderItemReference)) ?? null;
        const taxOff = off?.taxMinor ?? 0n;
        // The tax taken off is spread over the tax lines in proportion; the last line takes the
        // remainder, so they still add up to the tax charged.
        let spread = 0n;
        const components = pricing.taxComponents.map((component, index, all) => {
          const share =
            index === all.length - 1
              ? taxOff - spread
              : pricing.tax.amountMinor === 0n
                ? 0n
                : (component.taxAmount.amountMinor * taxOff * 2n + pricing.tax.amountMinor) /
                  (2n * pricing.tax.amountMinor);
          spread += share;
          return Object.freeze({
            code: component.taxComponentCode,
            amountMinor: component.taxAmount.amountMinor - share,
          });
        });
        if (off !== null && (components.some((c) => c.amountMinor < 0n) || spread !== taxOff))
          return fail();
        lines.push(
          Object.freeze({
            orderItemReference: String(snapshot.orderItemReference),
            quantity: snapshot.quantity,
            productReference: String(snapshot.catalog.productReference),
            skuReference: String(snapshot.catalog.skuReference),
            name,
            subtotalMinor: pricing.subtotal.amountMinor,
            discountMinor: pricing.discount.amountMinor,
            compMinor: off?.netMinor ?? 0n,
            taxMinor: pricing.tax.amountMinor - taxOff,
            feeMinor: pricing.fee.amountMinor - (off?.feeMinor ?? 0n),
            totalMinor: pricing.total.amountMinor - (off?.totalMinor ?? 0n),
            taxComponents: Object.freeze(components),
          }),
        );
      }
      for (const row of headers.rows as readonly Record<string, unknown>[]) {
        const orderReference = String(parseOrderingReference(row.order_id));
        if (
          (row.order_type !== "DineIn" && row.order_type !== "Pickup") ||
          !["Api", "Pos", "Qr", "Web"].includes(String(row.source_channel)) ||
          typeof row.business_date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date)
        )
          return fail();
        const batches = byOrder.get(orderReference) ?? new Map<string, StoreSalesOrderItem[]>();
        orders.push(
          Object.freeze({
            orderReference,
            orderType: row.order_type,
            sourceChannel: row.source_channel as StoreSalesOrder["sourceChannel"],
            businessDate: row.business_date,
            batches: Object.freeze(
              [...batches].map(([orderBatchReference, lines]) =>
                Object.freeze({ orderBatchReference, items: Object.freeze(lines) }),
              ),
            ),
          }),
        );
      }
    }
    if ((await options.authorize(tx)) !== true) return fail();
    return Object.freeze(orders);
  };
}
