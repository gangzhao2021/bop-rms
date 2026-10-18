import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { DigitalReceiptError } from "../../domain/digital-receipt.js";
import { parseReceiptOrderSnapshot } from "../../domain/receipt-order-snapshot.js";
import {
  decodeOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";
import {
  orderItemOptionLines,
  type OrderItemOptionLine,
} from "../../domain/order-item-option-lines.js";

const fail = (): never => {
  throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
};
/** Caller retains this transaction through receipt append. Header UPDATE lock
 * fences new FK-bound batches; batch UPDATE locks fence new FK-bound items.
 * No assumption that an initial submission represents all current batches.
 * Lock order: these Order row locks come after a receipt issuer's `OrderingReceipt` fence and
 * before any Payment refund fence (`OrdinaryRefundRequest`, `PaymentReceiptOrder`); never call
 * this while holding a Payment refund fence for the Order (see Payment's
 * acquireOrdinaryRefundRequestFences; v15 2026-10-18 40P01).
 */
export function createPostgresReceiptOrderSource(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    tx: ConsumerTransaction,
    request: {
      brandReference: string;
      storeReference: string;
      orderReference: string;
      observedAt: string;
    },
  ): Promise<boolean>;
}) {
  const brandReference = String(parseOrderingReference(options.brandReference));
  const storeReference = String(parseOrderingReference(options.storeReference));
  return async (tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) => {
    try {
      const request = {
        brandReference,
        storeReference,
        orderReference: String(parseOrderingReference(input.orderReference)),
        observedAt: String(parseOrderingInstant(input.observedAt)),
      };
      const authorize = async () => {
        if ((await options.authorize(tx, request)) !== true)
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      const parameters = [brandReference, storeReference, request.orderReference];
      const headers = await tx.query(
        "SELECT h.order_id,h.order_number,h.created_at,s.guest_session_id FROM rms_ordering.order_header h JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 FOR UPDATE OF h,s",
        parameters,
      );
      if (headers.rows.length !== 1) return fail();
      const header = headers.rows[0];
      if (!header) return fail();
      const instant = (value: unknown) =>
        parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
      const createdAt = instant(header.created_at);
      if (createdAt > request.observedAt) return fail();
      const batchRows = await tx.query(
        "SELECT order_batch_id,submitted_at FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY submitted_at,order_batch_id LIMIT 101 FOR UPDATE",
        parameters,
      );
      if (batchRows.rows.length < 1 || batchRows.rows.length > 100) return fail();
      const batches = batchRows.rows.map((row) => {
        const submittedAt = instant(row.submitted_at);
        if (submittedAt > request.observedAt) return fail();
        return { orderBatchReference: row.order_batch_id, submittedAt };
      });
      const itemRows = await tx.query(
        "SELECT order_item_id,order_batch_id,source_cart_line_id,ordinal,quantity,catalog_snapshot_digest,quote_input_digest,snapshot_captured_at,transaction_snapshot_json,transaction_snapshot_json#>>'{pricing,quoteVersion}' AS quote_version FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY order_batch_id,ordinal LIMIT 101 FOR SHARE",
        parameters,
      );
      if (itemRows.rows.length < 1 || itemRows.rows.length > 100) return fail();
      const ordinals = new Map<string, number>();
      const items = itemRows.rows.map((row) => {
        if (row.quote_version !== "1" && row.quote_version !== "2") return fail();
        const snapshotVersion = row.quote_version === "2" ? 2 : 1;
        const snapshot =
          snapshotVersion === 2
            ? decodeConfiguredOrderItemSnapshot(row.transaction_snapshot_json)
            : decodeOrderItemSnapshot(row.transaction_snapshot_json);
        const ordinal = (ordinals.get(snapshot.orderBatchReference) ?? 0) + 1;
        if (
          row.ordinal !== ordinal ||
          row.order_item_id !== snapshot.orderItemReference ||
          row.order_batch_id !== snapshot.orderBatchReference ||
          row.source_cart_line_id !== snapshot.cartItemReference ||
          row.quantity !== snapshot.quantity ||
          row.catalog_snapshot_digest !== snapshot.catalog.snapshotDigest ||
          row.quote_input_digest !== snapshot.pricing.quoteInputDigest ||
          instant(row.snapshot_captured_at) !== snapshot.snapshotCapturedAt
        )
          return fail();
        ordinals.set(snapshot.orderBatchReference, ordinal);
        return { snapshotVersion, snapshot };
      });
      const result = parseReceiptOrderSnapshot({
        brandReference,
        storeReference,
        orderReference: header.order_id,
        guestSessionReference: header.guest_session_id,
        orderNumber: header.order_number,
        createdAt,
        batches,
        items,
      });
      await authorize();
      return result;
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      return fail();
    }
  };
}

export interface OrderItemPrice {
  readonly orderItemReference: string;
  readonly orderBatchReference: string;
  /** Unit price × quantity, before discount, fees and tax (the price printed beside the item). */
  readonly subtotal: { readonly amountMinor: bigint; readonly currencyCode: string };
  readonly tax: { readonly amountMinor: bigint; readonly currencyCode: string };
  /** The item's frozen total after discount, fees and tax. */
  readonly total: { readonly amountMinor: bigint; readonly currencyCode: string };
  /** WP-2423: the chosen options and what each added to `subtotal` (empty for a plain item). */
  readonly options: readonly OrderItemOptionLine[];
  /** The guest's note for the kitchen as frozen at checkout (null when none was left). */
  readonly customerNote: string | null;
  /**
   * The dine-in participant who added the item (null for a pickup order, where the one guest
   * added every item). Callers show a note only to the guest who wrote it, as the cart does.
   */
  readonly addedByParticipantReference: string | null;
}

/**
 * WP-2423 D5: each Order item's frozen prices, for reads that print item prices before tax next to
 * the order's subtotal and tax. A plain read of the frozen transaction snapshots (no locks, no
 * current menu prices); the caller authorizes the Order before calling and keeps its own fences.
 */
export async function listOrderItemPrices(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
  /** The guest's language for option names (each option falls back to a name it has). */
  locale = "",
): Promise<readonly OrderItemPrice[]> {
  try {
    const brandReference = String(parseOrderingReference(scope.brandReference));
    const storeReference = String(parseOrderingReference(scope.storeReference));
    const order = String(parseOrderingReference(orderReference));
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
    const rows = (
      await tx.query(
        "SELECT order_item_id,order_batch_id,quantity,transaction_snapshot_json,transaction_snapshot_json#>>'{pricing,quoteVersion}' AS quote_version FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY order_batch_id,ordinal LIMIT 101",
        [brandReference, storeReference, order],
      )
    ).rows;
    if (rows.length > 100) return fail();
    return Object.freeze(
      rows.map((row) => {
        if (row.quote_version !== "1" && row.quote_version !== "2") return fail();
        const snapshot =
          row.quote_version === "2"
            ? decodeConfiguredOrderItemSnapshot(row.transaction_snapshot_json)
            : decodeOrderItemSnapshot(row.transaction_snapshot_json);
        if (
          row.order_item_id !== snapshot.orderItemReference ||
          row.order_batch_id !== snapshot.orderBatchReference ||
          row.quantity !== snapshot.quantity
        )
          return fail();
        const money = (value: { amountMinor: bigint; currencyCode: string }) =>
          Object.freeze({ amountMinor: value.amountMinor, currencyCode: value.currencyCode });
        return Object.freeze({
          orderItemReference: String(snapshot.orderItemReference),
          orderBatchReference: String(snapshot.orderBatchReference),
          subtotal: money(snapshot.pricing.subtotal),
          tax: money(snapshot.pricing.tax),
          total: money(snapshot.pricing.total),
          options: orderItemOptionLines(snapshot, locale),
          customerNote: snapshot.customerNote,
          addedByParticipantReference:
            snapshot.addedByParticipantReference === null
              ? null
              : String(snapshot.addedByParticipantReference),
        });
      }),
    );
  } catch (error) {
    if (error instanceof DigitalReceiptError) throw error;
    return fail();
  }
}
