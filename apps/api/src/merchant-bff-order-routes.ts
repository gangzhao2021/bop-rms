/** Merchant BFF routes: order queue, counter orders, card machine, cancellation, acceptance and close. Registered by createMerchantBffRouter (merchant-bff.ts). */
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  refundReadFailure,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { CounterMenuError } from "./merchant-counter-menu.js";
import express, { type Router } from "express";
import { CounterOrderError } from "./merchant-counter-order.js";
import { StaffDiningRoundError } from "./merchant-staff-dining-round.js";
import { CardMachinePaymentCommandError } from "./merchant-card-machine-payment.js";
import { CardMachineRefundCommandError } from "./merchant-card-machine-refund.js";
import { AcceptanceHoldRefundError } from "./merchant-order-acceptance-hold-refund.js";
import { StaffOrderCancellationError } from "./merchant-order-staff-cancellation.js";
import { UnpaidRoundCancellationError } from "./merchant-unpaid-round-cancellation.js";
import { EndedOrderStockReleaseError } from "./merchant-stock-holding-orders.js";
import { StaffItemCancellationError } from "./merchant-order-item-staff-cancellation.js";
import { OrderCloseCommandError } from "./merchant-dining-order-close-command.js";
import { MerchantOrderAcceptanceError } from "./merchant-order-acceptance-command.js";

type MerchantOrderQueueItem = Awaited<
  ReturnType<NonNullable<MerchantBffRouterOptions["orderQueue"]>>
>["items"][number];

/**
 * WP-2423: one Order as the Orders list, Home and the order detail answer it. The browser's
 * Orders/Home/detail parsers read this row; `tooling/e2e/merchant-bff-response-contract` runs this
 * mapping over the read model's full output and fails when a field the browser parses is dropped
 * (v15 2026-10-16: `awaitingAcceptanceSince` was, so no paid round ever showed its wait).
 */
function orderQueueRow(item: MerchantOrderQueueItem) {
  return {
    orderReference: item.orderReference,
    orderNumber: item.orderNumber,
    orderType: item.orderType,
    sourceChannel: item.sourceChannel,
    // WP-2423 Q21: the Store business day the Order belongs to (order numbers restart daily).
    businessDate: item.businessDate,
    // WP-2423 D4: the day it is listed under (today when an older table ordered today).
    listedBusinessDate: item.listedBusinessDate,
    // WP-2423 (2026-10-16): stock still set aside for an Order of an earlier day.
    heldStock: item.heldStock,
    submittedAt: item.submittedAt,
    initialBatchReference: item.initialBatchReference,
    canRequestAcceptance: item.canRequestAcceptance,
    unfulfillable: item.unfulfillable,
    pickupNotCollected: item.pickupNotCollected,
    acceptBy: item.acceptBy,
    // WP-2423 Q9-G1: paid while the Store was offline; held for a manager's decision.
    acceptanceHold: item.acceptanceHold,
    awaitingPayment: item.awaitingPayment,
    // WP-2423 Q7: a staff-taken counter order and its card-machine payment.
    counter: item.counter,
    // WP-2423: what the Order was paid online (null for counter or unpaid orders).
    paidOnline: item.paidOnline,
    // WP-2423: refunds of that online payment (the detail's position) when it has any.
    paymentPosition: item.paymentPosition,
    batches: item.batches.map((batch) => ({
      orderBatchReference: batch.orderBatchReference,
      sequence: batch.sequence,
      acceptanceStatus: batch.acceptanceStatus,
      canRequestAcceptance: batch.canRequestAcceptance,
      canCancel: batch.canCancel,
      canCancelItems: batch.canCancelItems,
      // WP-2423 abandoned payment: a manager may cancel this unpaid round.
      canCancelUnpaid: batch.canCancelUnpaid,
      paymentDue:
        batch.paymentDue === null
          ? null
          : { status: batch.paymentDue.status, cancelsAt: batch.paymentDue.cancelsAt },
      staffCancellation:
        batch.staffCancellation === null
          ? null
          : {
              reasonCode: batch.staffCancellation.reasonCode,
              cancelledAt: batch.staffCancellation.cancelledAt,
              refundStatus: batch.staffCancellation.refundStatus,
              refundMethod: batch.staffCancellation.refundMethod,
              refundAmountMinor: batch.staffCancellation.refundAmountMinor,
            },
      // WP-2423 Q7 slice 2: a round staff entered for the table and its card-machine payment.
      staffRound: batch.staffRound,
      // WP-2423 (v15 2026-10-16): when this paid dine-in round, still waiting for staff, was
      // paid; Orders, Home and Tables warn at 5 and 10 minutes (it is never refunded on its own).
      awaitingAcceptanceSince: batch.awaitingAcceptanceSince,
    })),
    currentPhase: item.currentPhase,
    currentVersion: item.currentVersion,
    // WP-2423: dine-in items ready at the pass and not yet served (the Home's count).
    ...(item.readyToServeItemCount === undefined
      ? {}
      : { readyToServeItemCount: item.readyToServeItemCount }),
    // WP-2423 (2026-10-18): dine-in portions the kitchen is remaking ("Being remade").
    ...(item.remakingItemCount === undefined ? {} : { remakingItemCount: item.remakingItemCount }),
    // WP-2423 (v15 2026-10-18): a pickup's kitchen state on the detail before Ordering records it.
    ...(item.kitchenPhase === undefined ? {} : { kitchenPhase: item.kitchenPhase }),
    observedAt: item.observedAt,
  };
}

export function installMerchantOrderRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  // WP-2423 OPS-ORDER-DETAIL: one Order of the selected Store with what was ordered.
  router.get("/orders/detail", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const order = request.query.order;
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).some((key) => key !== "order") ||
      typeof order !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(order) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderQueue) {
      response.status(503).json({ error: "order_queue_unavailable" });
      return;
    }
    const orderQueue = options.orderQueue;
    // A deadlock with a concurrent pickup/order read (each fences several Orders) is retried.
    void retryTransactionConflict(() =>
      orderQueue({ sessionCookie, afterOrderReference: null, orderReference: order }),
    )
      .then((view) => {
        const item = view.items[0];
        if (item === undefined || view.lines === null) {
          response.status(404).json({ error: "order_not_found" });
          return;
        }
        response.json({
          screenId: "OPS-ORDER-DETAIL",
          // The same Order row as the list (one mapping, so the two answers cannot drift apart).
          order: orderQueueRow(item),
          lines: view.lines,
          // WP-2423: refunds of the online payment, when Payment's position could be read.
          paymentPosition: view.paymentPosition,
          // WP-2423 Q10: the pickup customer's contact for this order (detail only).
          pickupContact:
            view.pickupContact === null
              ? null
              : view.pickupContact.status === "Available"
                ? {
                    status: "Available",
                    name: view.pickupContact.name,
                    channel: view.pickupContact.channel,
                    value: view.pickupContact.value,
                  }
                : view.pickupContact.status === "Removed"
                  ? { status: "Removed", removedAt: view.pickupContact.removedAt }
                  : { status: "NotGiven" },
        });
      })
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.get("/orders", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const after = request.query.after;
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).some((key) => key !== "after") ||
      (after !== undefined &&
        (typeof after !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after))) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderQueue) {
      response.status(503).json({ error: "order_queue_unavailable" });
      return;
    }
    const orderQueue = options.orderQueue;
    // WP-2423: the Orders list and the pickup queue each fence several Orders in their own order;
    // on a first load they run together and may deadlock. The read is rerun (nothing committed);
    // a conflict that persists is "retry later", never a permission refusal.
    void retryTransactionConflict(() =>
      orderQueue({ sessionCookie, afterOrderReference: after ?? null }),
    )
      .then((view) => {
        const row = orderQueueRow;
        // WP-2423 (2026-10-16 v15): earlier-day Orders listed with today's (first page only) are
        // returned apart from the page, which holds exactly the page size whenever a next page follows.
        response.json({
          earlierDayItems: view.items.filter((item) => item.earlierDay === true).map(row),
          items: view.items.filter((item) => item.earlierDay !== true).map(row),
          nextAfterOrderReference: view.nextAfterOrderReference,
        });
      })
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  // WP-2423 Q7: the counter item picker — the pickup menu customers see now, under staff ordering.
  router.get("/counter/menu", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      // WP-2423 Q7 slice 2: ?orderType=DineIn for a staff-entered table round.
      Object.keys(request.query).some((key) => key !== "orderType") ||
      (request.query.orderType !== undefined && request.query.orderType !== "DineIn") ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.counterMenu) {
      response.status(503).json({ error: "counter_menu_unavailable" });
      return;
    }
    void options
      .counterMenu({
        sessionCookie,
        orderType: request.query.orderType === "DineIn" ? "DineIn" : "Pickup",
      })
      .then((menu) => {
        response.set("Cache-Control", NO_STORE);
        response.json({ screenId: "OPS-ORDER-ENTRY", menu });
      })
      .catch((error: unknown) => {
        if (error instanceof CounterMenuError && error.code === "COUNTER_MENU_UNAVAILABLE") {
          response
            .status(503)
            .set("Cache-Control", NO_STORE)
            .json({ error: "counter_menu_unavailable" });
          return;
        }
        denied(response);
      });
  });
  const mutation = (
    request: express.Request,
    response: express.Response,
  ): { sessionCookie: string; csrf: string } | null => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return null;
    }
    return { sessionCookie, csrf };
  };
  // WP-2423 Q7: staff take a pickup order at the counter (or a paper order after an outage); the
  // reply is the amount to charge on the Store's card machine.
  router.post("/counter/orders", sameOriginMutation(options), (request, response) => {
    const auth = mutation(request, response);
    if (auth === null) return;
    if (!options.counterOrder) {
      response.status(503).json({ error: "counter_order_unavailable" });
      return;
    }
    void options
      .counterOrder({ ...auth, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          status: result.status,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          orderNumber: result.orderNumber,
          orderVersion: result.orderVersion,
          orderMinor: result.orderMinor,
          tipMinor: result.tipMinor,
          totalMinor: result.totalMinor,
          payBy: result.payBy,
          recordedAfterOutage: result.recordedAfterOutage,
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof CounterOrderError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            COUNTER_ORDER_INPUT_INVALID: [400, "counter_order_input_invalid"],
            COUNTER_ORDER_PERMISSION_DENIED: [403, "counter_order_permission_denied"],
            COUNTER_ORDER_STORE_NOT_TAKING_ORDERS: [409, "store_not_taking_pickup_orders"],
            COUNTER_ORDER_ITEM_UNAVAILABLE: [409, "item_unavailable"],
            COUNTER_ORDER_STOCK_SHORT: [409, "item_short"],
            COUNTER_ORDER_NOT_PRICED: [409, "order_not_priced"],
            COUNTER_ORDER_NOT_FINISHED: [409, "counter_order_not_finished"],
            COUNTER_ORDER_IN_PROGRESS: [409, "counter_order_in_progress"],
            COUNTER_ORDER_IDEMPOTENCY_CONFLICT: [409, "counter_order_conflict"],
            COUNTER_ORDER_NO_PICKUP_TIMES: [409, "counter_order_no_pickup_times"],
            COUNTER_ORDER_UNAVAILABLE: [503, "counter_order_unavailable"],
          } as const
        )[error.code];
        response
          .status(status)
          .set("Cache-Control", NO_STORE)
          .json(
            error.code === "COUNTER_ORDER_ITEM_UNAVAILABLE"
              ? { error: code, lineIndex: error.lineIndex, sharedStock: error.sharedStock }
              : error.code === "COUNTER_ORDER_STOCK_SHORT"
                ? {
                    error: code,
                    lineIndex: error.lineIndex,
                    available: error.available,
                    sharedStock: error.sharedStock,
                  }
                : { error: code },
          );
      });
  });
  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): staff enter a round for a table on behalf of its
  // guests (or a paper round after an outage); the reply is the amount to charge on the card machine.
  router.post("/dining/staff-rounds", sameOriginMutation(options), (request, response) => {
    const auth = mutation(request, response);
    if (auth === null) return;
    if (!options.staffDiningRound) {
      response.status(503).json({ error: "staff_round_unavailable" });
      return;
    }
    void options
      .staffDiningRound({ ...auth, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          status: result.status,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          orderNumber: result.orderNumber,
          orderVersion: result.orderVersion,
          tableLabel: result.tableLabel,
          orderMinor: result.orderMinor,
          tipMinor: result.tipMinor,
          totalMinor: result.totalMinor,
          payBy: result.payBy,
          recordedAfterOutage: result.recordedAfterOutage,
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof StaffDiningRoundError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            STAFF_ROUND_INPUT_INVALID: [400, "staff_round_input_invalid"],
            STAFF_ROUND_PERMISSION_DENIED: [403, "staff_round_permission_denied"],
            STAFF_ROUND_STORE_NOT_TAKING_ORDERS: [409, "store_not_taking_dine_in_orders"],
            STAFF_ROUND_TABLE_UNAVAILABLE: [409, "table_unavailable"],
            STAFF_ROUND_TABLE_QR_MISSING: [409, "table_qr_missing"],
            STAFF_ROUND_TABLE_CART_HAS_ITEMS: [409, "table_cart_has_items"],
            STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS: [409, "table_checkout_in_progress"],
            STAFF_ROUND_ITEM_UNAVAILABLE: [409, "item_unavailable"],
            STAFF_ROUND_STOCK_SHORT: [409, "item_short"],
            STAFF_ROUND_NOT_PRICED: [409, "order_not_priced"],
            STAFF_ROUND_NOT_FINISHED: [409, "staff_round_not_finished"],
            STAFF_ROUND_IN_PROGRESS: [409, "staff_round_in_progress"],
            STAFF_ROUND_IDEMPOTENCY_CONFLICT: [409, "staff_round_conflict"],
            STAFF_ROUND_UNAVAILABLE: [503, "staff_round_unavailable"],
          } as const
        )[error.code];
        response
          .status(status)
          .set("Cache-Control", NO_STORE)
          .json(
            error.code === "STAFF_ROUND_ITEM_UNAVAILABLE"
              ? { error: code, lineIndex: error.lineIndex, sharedStock: error.sharedStock }
              : error.code === "STAFF_ROUND_STOCK_SHORT"
                ? {
                    error: code,
                    lineIndex: error.lineIndex,
                    available: error.available,
                    sharedStock: error.sharedStock,
                  }
                : error.code === "STAFF_ROUND_TABLE_CART_HAS_ITEMS"
                  ? { error: code, items: error.pendingItems.slice(0, 30) }
                  : { error: code },
          );
      });
  });
  // WP-2423 Q7: the Store's card machine approved the payment of a counter order; staff record it.
  router.post("/orders/card-machine-payment", sameOriginMutation(options), (request, response) => {
    const auth = mutation(request, response);
    if (auth === null) return;
    if (!options.cardMachinePayment) {
      response.status(503).json({ error: "card_machine_payment_unavailable" });
      return;
    }
    void options
      .cardMachinePayment({ ...auth, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          status: result.status,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          amountMinor: result.amountMinor,
          recordingReason: result.recordingReason,
          takenAt: result.takenAt,
          recordedAt: result.recordedAt,
          // D1: whether the server accepted it with the payment (it is then in the kitchen).
          acceptance: result.acceptance ?? "NotAccepted",
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof CardMachinePaymentCommandError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            CARD_MACHINE_INPUT_INVALID: [400, "card_machine_input_invalid"],
            CARD_MACHINE_PERMISSION_DENIED: [403, "card_machine_permission_denied"],
            CARD_MACHINE_NOT_FOUND: [404, "counter_order_not_found"],
            CARD_MACHINE_NOT_PAYABLE: [409, "order_not_payable"],
            CARD_MACHINE_AMOUNT_CHANGED: [409, "amount_changed"],
            CARD_MACHINE_PAYMENT_WINDOW_CLOSED: [409, "payment_window_closed"],
            CARD_MACHINE_ALREADY_PAID: [409, "already_paid"],
            CARD_MACHINE_IDEMPOTENCY_CONFLICT: [409, "card_machine_conflict"],
            CARD_MACHINE_UNAVAILABLE: [503, "card_machine_payment_unavailable"],
          } as const
        )[error.code];
        response
          .status(status)
          .set("Cache-Control", NO_STORE)
          .json(
            error.code === "CARD_MACHINE_AMOUNT_CHANGED"
              ? { error: code, totalMinor: error.totalMinor }
              : { error: code },
          );
      });
  });
  // WP-2423 Q7: staff refunded a cancelled card-machine order on the machine and record it.
  router.post("/orders/card-machine-refund", sameOriginMutation(options), (request, response) => {
    const auth = mutation(request, response);
    if (auth === null) return;
    if (!options.cardMachineRefund) {
      response.status(503).json({ error: "card_machine_refund_unavailable" });
      return;
    }
    void options
      .cardMachineRefund({ ...auth, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          status: result.status,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          amountMinor: result.amountMinor,
          refundedAt: result.refundedAt,
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof CardMachineRefundCommandError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            CARD_MACHINE_REFUND_INPUT_INVALID: [400, "card_machine_refund_input_invalid"],
            CARD_MACHINE_REFUND_PERMISSION_DENIED: [403, "card_machine_refund_permission_denied"],
            CARD_MACHINE_REFUND_NOT_FOUND: [404, "card_machine_refund_not_found"],
            CARD_MACHINE_REFUND_NOTHING_OWED: [409, "nothing_to_refund"],
            CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT: [409, "card_machine_refund_conflict"],
            CARD_MACHINE_REFUND_APPROVAL_REQUIRED: [409, "approval_required"],
            CARD_MACHINE_REFUND_UNAVAILABLE: [503, "card_machine_refund_unavailable"],
          } as const
        )[error.code];
        response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
      });
  });
  // WP-2423 item 4: an ordinary (item) refund of a card-machine payment was made on the Store's
  // machine; staff record it (after the approval, when one is needed).
  router.post(
    "/payments/refunds/card-machine-record",
    sameOriginMutation(options),
    (request, response) => {
      const auth = mutation(request, response);
      if (auth === null) return;
      if (!options.cardMachineOrdinaryRefund) {
        response.status(503).json({ error: "card_machine_refund_unavailable" });
        return;
      }
      void options
        .cardMachineOrdinaryRefund({ ...auth, command: request.body })
        .then((result) => {
          response.set("Cache-Control", NO_STORE);
          response.json({
            status: result.status,
            orderReference: result.orderReference,
            requestReference: result.requestReference,
            amountMinor: result.amountMinor,
            refundedAt: result.refundedAt,
            receipt: result.receipt,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof CardMachineRefundCommandError)) {
            denied(response);
            return;
          }
          const [status, code] = (
            {
              CARD_MACHINE_REFUND_INPUT_INVALID: [400, "card_machine_refund_input_invalid"],
              CARD_MACHINE_REFUND_PERMISSION_DENIED: [403, "card_machine_refund_permission_denied"],
              CARD_MACHINE_REFUND_NOT_FOUND: [404, "card_machine_refund_not_found"],
              CARD_MACHINE_REFUND_NOTHING_OWED: [409, "nothing_to_refund"],
              CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT: [409, "card_machine_refund_conflict"],
              CARD_MACHINE_REFUND_APPROVAL_REQUIRED: [409, "approval_required"],
              CARD_MACHINE_REFUND_UNAVAILABLE: [503, "card_machine_refund_unavailable"],
            } as const
          )[error.code];
          response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
        });
    },
  );
  // WP-2423 Q9-G1: a manager decides to refund an order paid online while the Store was offline.
  router.post(
    "/orders/acceptance-hold/refund",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.orderAcceptanceHoldRefund) {
        response.status(503).json({ error: "acceptance_hold_refund_unavailable" });
        return;
      }
      void options
        .orderAcceptanceHoldRefund({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          response.set("Cache-Control", NO_STORE);
          response.json({
            status: result.status,
            orderReference: result.orderReference,
            decidedAt: result.decidedAt,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof AcceptanceHoldRefundError)) {
            denied(response);
            return;
          }
          const [status, code] = (
            {
              ACCEPTANCE_HOLD_REFUND_INPUT_INVALID: [400, "acceptance_hold_refund_input_invalid"],
              ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED: [
                403,
                "acceptance_hold_refund_permission_denied",
              ],
              ACCEPTANCE_HOLD_REFUND_NOT_HELD: [409, "order_not_held"],
              ACCEPTANCE_HOLD_REFUND_UNAVAILABLE: [503, "acceptance_hold_refund_unavailable"],
            } as const
          )[error.code];
          response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
        });
    },
  );
  const staffCancellationError = (response: express.Response, error: unknown) => {
    if (!(error instanceof StaffOrderCancellationError)) {
      denied(response);
      return;
    }
    const [status, code] = (
      {
        ORDER_CANCELLATION_INPUT_INVALID: [400, "order_cancellation_input_invalid"],
        ORDER_CANCELLATION_PERMISSION_DENIED: [403, "order_cancellation_permission_denied"],
        ORDER_CANCELLATION_NOT_FOUND: [404, "order_cancellation_not_found"],
        ORDER_CANCELLATION_VERSION_CONFLICT: [409, "order_version_conflict"],
        ORDER_CANCELLATION_PREPARATION_STARTED: [409, "order_preparation_started"],
        ORDER_CANCELLATION_NOT_CANCELLABLE: [409, "order_not_cancellable"],
        ORDER_CANCELLATION_STOCK_NOT_RELEASABLE: [409, "order_stock_not_releasable"],
        ORDER_CANCELLATION_UNAVAILABLE: [503, "order_cancellation_unavailable"],
      } as const
    )[error.code];
    response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
  };
  // WP-2423 Q6: staff cancel a paid order or batch before the kitchen starts it; refunded in full.
  router.post("/orders/cancel", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderStaffCancellation) {
      response.status(503).json({ error: "order_cancellation_unavailable" });
      return;
    }
    void options
      .orderStaffCancellation({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          status: result.status,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          cancelledAt: result.cancelledAt,
          refundStatus: result.refundStatus,
          refundMethod: result.refundMethod,
          refundAmountMinor: result.refundAmountMinor,
        });
      })
      .catch((error: unknown) => staffCancellationError(response, error));
  });
  // WP-2423 (v15 2026-10-18): what cancelling the order or round would refund, read-only.
  router.post("/orders/cancel/preview", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderStaffCancellationPreview) {
      response.status(503).json({ error: "order_cancellation_unavailable" });
      return;
    }
    void options
      .orderStaffCancellationPreview({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          refundMethod: result.refundMethod,
          paidMinor: result.paidMinor,
          refundMinor: result.refundMinor,
          currencyCode: result.currencyCode,
        });
      })
      .catch((error: unknown) => staffCancellationError(response, error));
  });
  // WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): a manager cancels a dine-in round
  // nobody paid for, before its payment window ends. Nothing was charged, so nothing is refunded.
  router.post("/orders/cancel-unpaid-round", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.unpaidRoundCancellation) {
      response.status(503).json({ error: "unpaid_round_cancellation_unavailable" });
      return;
    }
    void options
      .unpaidRoundCancellation({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({ status: result.status, cancelledAt: result.cancelledAt });
      })
      .catch((error: unknown) => {
        if (!(error instanceof UnpaidRoundCancellationError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            UNPAID_ROUND_INPUT_INVALID: [400, "unpaid_round_input_invalid"],
            UNPAID_ROUND_PERMISSION_DENIED: [403, "order_cancellation_permission_denied"],
            UNPAID_ROUND_NOT_FOUND: [404, "unpaid_round_not_found"],
            UNPAID_ROUND_PAID: [409, "unpaid_round_paid"],
            UNPAID_ROUND_PAYMENT_IN_PROGRESS: [409, "unpaid_round_payment_in_progress"],
            UNPAID_ROUND_NOT_CANCELLABLE: [409, "unpaid_round_not_cancellable"],
            UNPAID_ROUND_VERSION_CONFLICT: [409, "order_version_conflict"],
            UNPAID_ROUND_UNAVAILABLE: [503, "unpaid_round_cancellation_unavailable"],
          } as const
        )[error.code];
        response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
      });
  });
  // WP-2423 (2026-10-16 v15 stock leak): return stock still set aside for an Order of an earlier
  // day that already ended. Same managers who may cancel orders.
  router.post("/orders/release-stock", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.endedOrderStockRelease) {
      response.status(503).json({ error: "stock_release_unavailable" });
      return;
    }
    void options
      .endedOrderStockRelease({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        response.json({ status: result.status });
      })
      .catch((error: unknown) => {
        if (!(error instanceof EndedOrderStockReleaseError)) {
          denied(response);
          return;
        }
        const [status, code] = (
          {
            ENDED_ORDER_STOCK_INPUT_INVALID: [400, "stock_release_input_invalid"],
            ENDED_ORDER_STOCK_PERMISSION_DENIED: [403, "stock_release_permission_denied"],
            ENDED_ORDER_STOCK_NOT_RELEASABLE: [409, "stock_not_releasable"],
            ENDED_ORDER_STOCK_PRODUCTION_STARTED: [409, "order_preparation_started"],
            ENDED_ORDER_STOCK_UNAVAILABLE: [503, "stock_release_unavailable"],
          } as const
        )[error.code];
        response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
      });
  });
  // WP-2423 Q6 step 2a: staff cancel item lines before the kitchen starts them; those items'
  // net and tax are refunded (the last remaining lines cancel the whole order or batch).
  const itemCancellationError = (response: express.Response, error: unknown) => {
    if (!(error instanceof StaffItemCancellationError)) {
      denied(response);
      return;
    }
    const [status, code] = (
      {
        ORDER_CANCELLATION_INPUT_INVALID: [400, "order_cancellation_input_invalid"],
        ORDER_CANCELLATION_PERMISSION_DENIED: [403, "order_cancellation_permission_denied"],
        ORDER_CANCELLATION_NOT_FOUND: [404, "order_cancellation_not_found"],
        ORDER_CANCELLATION_VERSION_CONFLICT: [409, "order_version_conflict"],
        ORDER_CANCELLATION_PREPARATION_STARTED: [409, "order_preparation_started"],
        ORDER_CANCELLATION_NOT_CANCELLABLE: [409, "order_not_cancellable"],
        ORDER_CANCELLATION_STOCK_NOT_RELEASABLE: [409, "order_stock_not_releasable"],
        ORDER_ITEM_CANCELLATION_STOCK_LEGACY: [409, "order_item_stock_legacy"],
        ORDER_ITEM_CANCELLATION_CARD_MACHINE: [409, "order_paid_on_card_machine"],
        ORDER_CANCELLATION_UNAVAILABLE: [503, "order_cancellation_unavailable"],
      } as const
    )[error.code];
    response.status(status).set("Cache-Control", NO_STORE).json({ error: code });
  };
  const itemCancellationRoute = (
    path: string,
    run: (
      service: NonNullable<MerchantBffRouterOptions["orderItemStaffCancellation"]>,
      input: { sessionCookie: string; csrf: string; command: unknown },
    ) => Promise<unknown>,
  ) =>
    router.post(path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      const service = options.orderItemStaffCancellation;
      if (!service) {
        response.status(503).json({ error: "order_cancellation_unavailable" });
        return;
      }
      void run(service, { sessionCookie, csrf, command: request.body })
        .then((result) => {
          response.set("Cache-Control", NO_STORE);
          response.json(result);
        })
        .catch((error: unknown) => itemCancellationError(response, error));
    });
  itemCancellationRoute("/orders/cancel-items/preview", (service, input) => service.preview(input));
  itemCancellationRoute("/orders/cancel-items", (service, input) => service.cancel(input));
  itemCancellationRoute("/orders/cancel-items/refund", (service, input) => service.refund(input));
  router.post("/orders/close", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderClosure) {
      response.status(503).json({ error: "order_closure_unavailable" });
      return;
    }
    void options
      .orderClosure({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Committed", "AlreadyCommitted"].includes(result.status) ||
          !Number.isSafeInteger(result.closedOrderVersion) ||
          result.closedOrderVersion < 1 ||
          !Number.isSafeInteger(result.closureVersion) ||
          result.closureVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          closedOrderVersion: result.closedOrderVersion,
          closureVersion: result.closureVersion,
        });
      })
      .catch((error: unknown) => {
        // WP-2423 (B759): only a missing permission is a 403; an Order that is not ready, changed
        // or already closed is a 409 naming why, and a failure to decide is a 503.
        if (!(error instanceof OrderCloseCommandError)) {
          response
            .status(503)
            .set("Cache-Control", NO_STORE)
            .json({ error: "order_closure_unavailable" });
          return;
        }
        const [status, code] = (
          {
            ORDER_CLOSE_INPUT_INVALID: [400, "order_close_input_invalid"],
            ORDER_CLOSE_PERMISSION_DENIED: [403, "order_close_permission_denied"],
            ORDER_CLOSE_VERSION_CONFLICT: [409, "order_version_conflict"],
            ORDER_CLOSE_ALREADY_CLOSED: [409, "order_already_closed"],
            ORDER_CLOSE_NOT_READY: [409, "order_not_ready"],
            ORDER_CLOSE_UNAVAILABLE: [503, "order_closure_unavailable"],
          } as const
        )[error.code];
        response
          .status(status)
          .set("Cache-Control", NO_STORE)
          .json(
            error.code === "ORDER_CLOSE_NOT_READY"
              ? { error: code, reasons: error.reasons.slice(0, 16) }
              : { error: code },
          );
      });
  });

  router.post("/orders/accept", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderAcceptance) {
      response.status(503).json({ error: "order_acceptance_unavailable" });
      return;
    }
    void options
      .orderAcceptance({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          acceptedOrderVersion: result.acceptedOrderVersion,
        }),
      )
      .catch((error: unknown) => {
        // WP-2423 D1: an authorized acceptance that did not happen is a conflict the page explains
        // (the order changed, someone accepted it already, or it can no longer be accepted), not a
        // permission refusal.
        if (!(error instanceof MerchantOrderAcceptanceError)) {
          denied(response);
          return;
        }
        response
          .status(409)
          .set("Cache-Control", NO_STORE)
          .json({
            error: (
              {
                ORDER_ACCEPTANCE_VERSION_CONFLICT: "order_changed",
                ORDER_ACCEPTANCE_ALREADY_ACCEPTED: "already_accepted",
                ORDER_ACCEPTANCE_NOT_ACCEPTABLE: "order_not_acceptable",
              } as const
            )[error.code],
          });
      });
  });
}
