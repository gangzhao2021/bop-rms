import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresFulfillmentItemCancellation,
  createPostgresFulfillmentItemWithdrawal,
  readPickupOwedUnits,
} from "@rms/fulfillment";
import {
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
  listStoreKitchenOrderItemStates,
} from "@rms/kitchen";
import {
  createPostgresOrderItemInventoryLinkReader,
  listOrderItemRefundWithdrawals,
  type OrderItemRefundWithdrawal,
} from "@rms/ordering";
import { listDeclinedOrdinaryRefundRequests } from "@rms/payment";
import { readRefundWithdrawnUnits } from "./order-refund-withdrawal.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";

interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}

/** Refusals the refund page explains; each rolls the whole refund request back. */
export type RefundWithdrawalRecordsRefusal =
  /** Something of the pickup was already handed over: what the guest has can't be stopped. */
  | "ORDINARY_REFUND_WITHDRAW_HANDED_OVER"
  /** Every dish of the pickup would be refunded and stopped: Cancel order closes it instead. */
  | "ORDINARY_REFUND_WITHDRAW_EVERYTHING"
  /** The kitchen started the dish while the refund was being recorded. */
  | "ORDINARY_REFUND_WITHDRAW_KITCHEN_CHANGED"
  /**
   * The dish's stock can't be returned line by line (stock was offline when the order was placed,
   * reserved before per-dish tracking, has no record, or was partly returned already). Retrying
   * never helps: staff untick "stop making it too" (the guest keeps the food) or use Cancel items.
   */
  | "ORDINARY_REFUND_WITHDRAW_STOCK_NOT_RELEASABLE";
const refuse = (code: RefundWithdrawalRecordsRefusal): never => {
  throw new Error(code);
};

export interface RefundWithdrawalRecordsResult {
  /** Lines the kitchen had not started, taken off the ticket and the bag, stock returned. */
  readonly kitchenCancelled: readonly string[];
  /** Lines started (or refunded in part): the ticket marks the refunded units, the bag leaves them out. */
  readonly markedOnTicket: readonly string[];
}

/**
 * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): makes "stop making it too" true in the
 * kitchen's, the counter's and the stock's own records, inside the refund request's transaction,
 * right after Ordering recorded the withdrawals. Lock order (v15 40P01 history): the caller took
 * the Order's disposition fence before Payment's refund fence, so this request and a staff item
 * cancellation (Ordering fence, Kitchen, Payment, Fulfillment, Inventory) never interleave on one
 * Order; here Kitchen rows, then the pickup, then stock reservations are locked, the order every
 * other writer of those three uses.
 *
 * - A whole line the kitchen has not started (every unit refunded, this request and earlier
 *   ones): its kitchen work is cancelled, its pickup line cancelled and its stock reservation
 *   released, exactly as a staff item cancellation does.
 * - Any other line (refunded in part, or already being made): Kitchen is not written (started work
 *   used its ingredients); Fulfillment records the units as withdrawn, so the bag and the handover
 *   count ordered minus refunded units. The ticket reads Ordering's withdrawal.
 */
export async function applyRefundWithdrawalRecords(
  tx: ConsumerTransaction,
  input: {
    readonly scope: Scope;
    readonly orderReference: string;
    readonly actorReference: string;
    /** The refund request instant (the withdrawals' recorded instant). */
    readonly recordedAt: string;
    readonly operationReference: string;
    readonly withdrawals: readonly OrderItemRefundWithdrawal[];
    readonly nextReference: () => string;
    readonly now: () => string;
    /** The command's current authority; checked by each owner before it writes. */
    readonly allowed: () => Promise<boolean>;
  },
): Promise<RefundWithdrawalRecordsResult> {
  const { scope, orderReference, actorReference } = input;
  const owned = async (
    _t: ConsumerTransaction,
    identity: { orderReference: string; actorReference: string },
  ) =>
    identity.orderReference === orderReference &&
    identity.actorReference === actorReference &&
    (await input.allowed());
  // Every unit refunded and stopped so far, this request included (declined requests excluded).
  const total = await readRefundWithdrawnUnits(tx, scope, [orderReference]);
  const links = createPostgresOrderItemInventoryLinkReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async () => input.allowed(),
  });
  const batches = [...new Set(input.withdrawals.map((row) => row.orderBatchReference))].sort();
  const states = await listStoreKitchenOrderItemStates(tx, scope, batches);
  const whole: { row: OrderItemRefundWithdrawal; cart: string; submission: string }[] = [];
  const partial: OrderItemRefundWithdrawal[] = [];
  for (const row of input.withdrawals) {
    const link = await links.load(tx, row.orderItemReference);
    if (
      link === null ||
      String(link.orderReference) !== orderReference ||
      String(link.orderBatchReference) !== row.orderBatchReference
    )
      throw new Error("ORDINARY_REFUND_COMMAND_UNAVAILABLE");
    if (
      (total.get(row.orderItemReference) ?? 0) >= link.quantity &&
      states.get(row.orderItemReference) === "NotStarted"
    )
      whole.push({
        row,
        cart: String(link.cartItemReference),
        submission: String(link.submissionReference),
      });
    else partial.push(row);
  }
  const at = input.recordedAt;
  try {
    for (const batch of batches) {
      const lines = whole.filter((entry) => entry.row.orderBatchReference === batch);
      const first = lines[0];
      if (first === undefined) continue;
      const items = lines.map((entry) => entry.row.orderItemReference);
      // The request's first withdrawal in this round names the cancellation in Kitchen and
      // Fulfillment (each withdrawal row names its own line).
      await createPostgresKitchenBatchCancellation({
        ...scope,
        authorize: owned,
      }).cancelItems(tx, {
        orderReference,
        orderBatchReference: batch,
        orderItemReferences: items,
        operationReference: input.nextReference(),
        orderCancellationReference: first.row.withdrawalReference,
        actorReference,
        cancelledAt: at,
        auditReference: input.nextReference(),
        eventReference: input.nextReference(),
        nextReference: input.nextReference,
      });
      await createPostgresFulfillmentItemCancellation({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: owned,
      }).cancelItems(tx, {
        orderReference,
        orderBatchReference: batch,
        orderItemReferences: items,
        orderCancellationReference: first.row.withdrawalReference,
        operationReference: input.nextReference(),
        auditReference: input.nextReference(),
        actorReference,
        cancelledAt: at,
        nextReference: input.nextReference,
      });
    }
    for (const entry of whole) {
      // Stock reserved for the line returns in this transaction, or nothing is recorded.
      const released = await createSubmissionInventoryRelease({
        scope,
        systemActorReference: actorReference,
        reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
        now: input.now,
      }).releaseLines(tx, {
        source: {
          kind: "RefundWithdrawalInventory/v1",
          reference: entry.row.withdrawalReference,
          submissionReference: entry.submission,
          orderReference,
          occurredAt: at,
        },
        releasedAt: at,
        authorize: input.allowed,
        cartLineReferences: [entry.cart],
      });
      if (released.status === "NotReleasable")
        refuse(
          released.reason === "ProductionStarted"
            ? "ORDINARY_REFUND_WITHDRAW_KITCHEN_CHANGED"
            : "ORDINARY_REFUND_WITHDRAW_STOCK_NOT_RELEASABLE",
        );
    }
  } catch (error) {
    if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
      return refuse("ORDINARY_REFUND_WITHDRAW_KITCHEN_CHANGED");
    throw error;
  }
  for (const batch of batches) {
    const lines = partial.filter((row) => row.orderBatchReference === batch);
    if (lines.length === 0) continue;
    const result = await createPostgresFulfillmentItemWithdrawal({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: owned,
    }).withdrawItems(tx, {
      orderReference,
      orderBatchReference: batch,
      lines: lines.map((row) => ({
        orderItemReference: row.orderItemReference,
        quantity: row.withdrawnQuantity,
        orderWithdrawalReference: row.withdrawalReference,
      })),
      operationReference: input.operationReference,
      auditReference: input.nextReference(),
      actorReference,
      withdrawnAt: at,
      nextReference: input.nextReference,
    });
    if (result.status === "NotWithdrawable") refuse("ORDINARY_REFUND_WITHDRAW_HANDED_OVER");
  }
  // A pickup left with nothing to hand over would stay open with nothing to close it: the whole
  // order is cancelled and refunded with Cancel order instead (it closes the order).
  const owed = await readPickupOwedUnits(tx, scope, orderReference, input.now());
  if (owed !== null && owed === 0) refuse("ORDINARY_REFUND_WITHDRAW_EVERYTHING");
  return Object.freeze({
    kitchenCancelled: Object.freeze(whole.map((entry) => entry.row.orderItemReference)),
    markedOnTicket: Object.freeze(partial.map((row) => row.orderItemReference)),
  });
}

/**
 * WP-2423 M10: before a pickup is handed over, Fulfillment records any refunded units staff said
 * not to hand over that it does not hold yet (a refund made before the order was accepted, when
 * there was no pickup to record them on), in the handoff's transaction. So the handover never
 * records refunded units as handed over. Each fact keeps the name of who refunded the units. The
 * caller holds the Order's disposition fence and authorized the handoff; nothing is written once
 * the pickup was handed over (in part) or for a line cancelled meanwhile.
 */
export async function catchUpPickupWithdrawals(
  tx: ConsumerTransaction,
  input: {
    readonly scope: { readonly brandReference: string; readonly storeReference: string };
    readonly orderReference: string;
    readonly now: () => string;
    readonly nextReference: () => string;
  },
): Promise<void> {
  const { scope, orderReference } = input;
  const withdrawals = await listOrderItemRefundWithdrawals(tx, scope, [orderReference]);
  if (withdrawals.length === 0) return;
  const declined = await listDeclinedOrdinaryRefundRequests(
    tx,
    scope,
    withdrawals.map((row) => row.refundRequestReference),
  );
  const groups = new Map<string, OrderItemRefundWithdrawal[]>();
  for (const row of withdrawals) {
    if (declined.has(row.refundRequestReference)) continue;
    const key = row.orderBatchReference + ":" + row.actorReference;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const at = input.now();
  for (const rows of groups.values()) {
    const first = rows[0];
    if (first === undefined) continue;
    // One fact per withdrawal row; a line refunded by two requests keeps two facts.
    for (const row of rows)
      await createPostgresFulfillmentItemWithdrawal({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async (_t, identity) =>
          identity.orderReference === orderReference &&
          identity.actorReference === first.actorReference,
      }).withdrawItems(tx, {
        mode: "CatchUp",
        orderReference,
        orderBatchReference: row.orderBatchReference,
        lines: [
          {
            orderItemReference: row.orderItemReference,
            quantity: row.withdrawnQuantity,
            orderWithdrawalReference: row.withdrawalReference,
          },
        ],
        operationReference: input.nextReference(),
        auditReference: input.nextReference(),
        actorReference: row.actorReference,
        withdrawnAt: at,
        nextReference: input.nextReference,
      });
  }
}
