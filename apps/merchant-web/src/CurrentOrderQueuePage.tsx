import { systemText, displayLocale, t } from "./i18n/i18n.js";
import {
  AcceptanceHoldDecision,
  AcceptanceHoldNotice,
  acceptanceHoldText,
  acceptanceHoldTier,
} from "./AcceptanceHoldActions.js";
import { paidRoundWait, paidRoundWaitText } from "./paid-round-wait.js";
import { OrderPaymentLinks } from "./OrderPaymentLinks.js";
import {
  DiningRoundItemState,
  DiningRoundProgressItems,
  DiningRoundServeAll,
  DiningRoundSummary,
  DiningRoundsProvider,
} from "./DiningRounds.js";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import {
  StaffOrderCancelAction,
  staffCancellationReasonLabel,
  staffCancellationSummary,
} from "./StaffOrderCancelAction.js";
import { TablePaymentPanel } from "./TablePaymentPanel.js";
import { UnpaidRoundCancelAction, isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { HeldStockReleaseAction, heldStockReleasedText } from "./HeldStockNotice.js";
import {
  ItemRefundCheck,
  StaffItemCancelAction,
  itemCancellationStatus,
} from "./StaffItemCancelAction.js";
import { PayLaterItemRemoveAction } from "./PayLaterItemRemoveAction.js";
import { orderMoney } from "./order-money.js";
export { orderMoney } from "./order-money.js";
import { CardMachineRefundAction } from "./CardMachineRefundAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { StatePanel } from "@bop-rms/ui";
import { playKitchenChime } from "./alert-chime.js";
import { storeTime } from "./StoreTime.js";
import {
  counterAwaitingCardMachine,
  counterPayByText,
  counterPayByTier,
} from "./counter-payment.js";
import { businessDateLabel, openedEarlierText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { WorkspacePage } from "./WorkspacePage.js";
export { storeTime } from "./StoreTime.js";
export { counterAwaitingCardMachine, counterPayByText, counterPayByTier };
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { Link, useParams } from "react-router";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";
import {
  orderChannel,
  orderChannelFilterOptions,
  orderChannelLabel,
  orderTypeLabel,
} from "./order-channel.js";
import {
  cancelledItemsRefund,
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  type CurrentOrderDetail,
  type CurrentOrderQueue,
  isAwaitingAcceptance,
  ordersAwaitingAcceptance,
  type OrderPickupContact,
} from "./current-order-queue-client.js";

/** WP-2423: the list orders staff opened, and how the rows change it. */
export interface ExpandedOrders {
  readonly opened: ReadonlySet<string>;
  readonly setOpened: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
}
export type OrderPageState =
  | { kind: "Loading" | "PermissionDenied" | "NotFound" | "Unavailable" }
  | { kind: "Ready"; view: CurrentOrderQueue; detail?: CurrentOrderDetail };
type State = OrderPageState;
/** WP-2423: what the Orders page reads: one page of the list, or the one order with its detail. */
export function readCurrentOrders(
  client: Pick<ReturnType<typeof createCurrentOrderQueueClient>, "load" | "loadDetail">,
  after: string | null,
  orderReference: string | undefined,
  signal: AbortSignal,
): Promise<{ view: CurrentOrderQueue; detail?: CurrentOrderDetail }> {
  return orderReference === undefined
    ? client.load(after, signal).then((view) => ({ view }))
    : client.loadDetail(orderReference, signal).then((detail) => ({ view: detail.view, detail }));
}
/**
 * WP-2423: a reread in place (the background poll, or after an action such as a recorded
 * card-machine refund) replaces the orders shown without passing through Loading, so the rows
 * stay mounted: opened orders stay open and the scroll position stays where staff left it.
 */
export function refreshedOrderState(
  previous: OrderPageState,
  next: { view: CurrentOrderQueue; detail?: CurrentOrderDetail },
): OrderPageState {
  if (previous.kind !== "Ready") return previous;
  const detail = next.detail ?? previous.detail;
  return detail === undefined
    ? { kind: "Ready", view: next.view }
    : { kind: "Ready", view: next.view, detail };
}
interface CurrentOrderFilters {
  readonly orderNumber: string;
  readonly type: string;
  readonly channel: string;
  readonly phase: string;
  /**
   * Owner 2026-10-25: "Today" shows the Store's current business day, plus earlier orders that
   * still need staff (held stock, a round to accept); omitted or "All": every loaded day.
   */
  readonly day?: "Today" | "All";
  readonly today?: string | null;
}
export function filterCurrentOrderItems(
  items: CurrentOrderQueue["items"],
  filters: CurrentOrderFilters,
) {
  const orderNumber = filters.orderNumber.trim().toLocaleLowerCase();
  return items.filter(
    (order) =>
      (!orderNumber || order.orderNumber.toLocaleLowerCase() === orderNumber) &&
      (filters.day !== "Today" ||
        filters.today == null ||
        orderNumber !== "" ||
        order.listedBusinessDate === filters.today ||
        order.heldStock !== null ||
        isAwaitingAcceptance(order)) &&
      (filters.type === "All" || order.orderType === filters.type) &&
      (filters.channel === "All" || orderChannel(order) === filters.channel) &&
      (filters.phase === "All" ||
        // Figma v1 "To accept": any round staff still have to accept, whatever the order's phase.
        (filters.phase === "AwaitingAcceptance"
          ? isAwaitingAcceptance(order)
          : filters.phase === "OutageHeld"
            ? order.acceptanceHold !== null
            : filters.phase === "Expired"
              ? order.unfulfillable !== null
              : filters.phase === "NotCollected"
                ? order.pickupNotCollected
                : filters.phase === "AwaitingPayment"
                  ? order.awaitingPayment
                  : order.unfulfillable === null &&
                    !order.pickupNotCollected &&
                    !order.awaitingPayment &&
                    // Orders v3: an accepted pickup counts where the kitchen has it (being made,
                    // ready), as its row says.
                    (order.currentPhase === "Accepted" && order.kitchenPhase !== null
                      ? order.kitchenPhase
                      : (order.currentPhase ?? "Unavailable")) === filters.phase)),
  );
}
/** WP-2423 Q6 step 2: what "Check refund" on a cancelled item needs (omitted: not offered). */
export interface ItemRefundCheckContext {
  readonly orderReference: string;
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
  /** Re-read the order once the refund completed. */
  readonly onChecked: () => void;
}
/**
 * Orders v3 (Owner 2026-10-26): a table's order read round by round. `head` is what the order
 * panel says and offers for the round (its acceptance, payment, cancellation); the serving state
 * comes from `DiningRoundsProvider` around the lines.
 */
export interface OrderLineRounds {
  readonly batches: readonly QueuedOrder["batches"][number][];
  readonly head?: ((batch: QueuedOrder["batches"][number]) => React.ReactNode) | undefined;
  readonly timeZone?: string | undefined;
  /** The Store's business date: a round sent today shows its time only. */
  readonly today?: string | null | undefined;
}
/** WP-2423 OPS-ORDER-DETAIL: what was ordered — items with options and notes, and the totals. */
export function CurrentOrderLines({
  lines,
  refundCheck,
  cancelledBatches,
  unpaidCancelledBatches,
  failedPaymentBatches,
  removedItems,
  refundRows,
  rounds,
}: {
  /** A table's rounds: the items are listed under the round they were ordered in. */
  readonly rounds?: OrderLineRounds | undefined;
  readonly lines: CurrentOrderDetail["lines"];
  readonly refundCheck?: ItemRefundCheckContext | undefined;
  /** WP-2423 Q6: batches the store cancelled as a whole; their remaining lines read as cancelled. */
  readonly cancelledBatches?: ReadonlySet<string> | undefined;
  /** WP-2423: rounds cancelled automatically because their payment failed; never owed. */
  readonly unpaidCancelledBatches?: ReadonlySet<string> | undefined;
  /** WP-2423: rounds whose payment failed and that are about to be cancelled automatically. */
  readonly failedPaymentBatches?: ReadonlySet<string> | undefined;
  /** DEC-DINE-IN-PAY-LATER: dishes taken off the bill before the table paid (never charged). */
  readonly removedItems?: ReadonlySet<string> | undefined;
  /**
   * 46940b76 L2: every refund on the order (items, whole order or round cancellations, others),
   * from orderRefundRows. Absent: only the cancelled items' refund is listed.
   */
  readonly refundRows?: readonly OrderRefundRow[] | undefined;
}) {
  const totals = lines.totals;
  const cancelledRefund = cancelledItemsRefund(lines.items);
  const refunds: readonly OrderRefundRow[] =
    refundRows ??
    (cancelledRefund === null
      ? []
      : [{ label: t("Cancelled items refund"), amount: cancelledRefund }]);
  const unpaid = unpaidCancelledTotal(lines, unpaidCancelledBatches);
  const unpaidLine = (item: CurrentOrderDetail["lines"]["items"][number]) =>
    item.cancellation === null && unpaidCancelledBatches?.has(item.orderBatchReference) === true;
  const removedLine = (item: CurrentOrderDetail["lines"]["items"][number]) =>
    removedItems?.has(item.orderItemReference) === true;
  const removed = removedItemsTotal(lines, removedItems);
  // One "Check refund" per pending cancellation, on its first line.
  const checkReferences = new Set<string>();
  const checkLines = new Map<string, string>();
  for (const item of lines.items) {
    const reference = item.cancellation?.cancellationReference ?? null;
    if (
      item.cancellation?.refundStatus !== "Pending" ||
      reference === null ||
      checkReferences.has(reference)
    )
      continue;
    checkReferences.add(reference);
    checkLines.set(item.orderItemReference, reference);
  }
  const lineItem = (item: CurrentOrderDetail["lines"]["items"][number]) => (
    <li
      key={item.orderItemReference}
      className={
        item.cancellation === null &&
        !cancelledBatches?.has(item.orderBatchReference) &&
        !unpaidLine(item) &&
        !removedLine(item)
          ? undefined
          : "order-line-cancelled"
      }
    >
      <span className="order-line-quantity">{item.quantity} ×</span>
      <span className="order-line-name">
        <span className="order-line-title">{item.name}</span>
        {item.options.length > 0 ? (
          <span className="order-line-options">
            {item.options
              .map((option) =>
                option.quantity > 1 ? `${option.name} × ${option.quantity}` : option.name,
              )
              .join(" · ")}
          </span>
        ) : null}
        {item.customerNote !== null ? (
          <span className="order-line-note">
            {t("Note: {customerNote}", { customerNote: item.customerNote })}
          </span>
        ) : null}
        {item.cancellation === null && cancelledBatches?.has(item.orderBatchReference) ? (
          <span className="order-line-cancellation">
            <strong>{t("Cancelled by store")}</strong>
          </span>
        ) : unpaidLine(item) ? (
          <span className="order-line-cancellation">
            <strong>{t("Cancelled · not paid")}</strong>
          </span>
        ) : removedLine(item) ? (
          <span className="order-line-cancellation">
            <strong>{t("Taken off the bill · not charged")}</strong>
          </span>
        ) : item.cancellation === null &&
          failedPaymentBatches?.has(item.orderBatchReference) === true ? (
          <span className="order-line-cancellation">
            <strong>{t("Payment failed · don't prepare")}</strong>
          </span>
        ) : null}
        {item.cancellation !== null ? (
          <span className="order-line-cancellation">
            <strong>{itemCancellationStatus(item.cancellation)}</strong>
            <span>
              {t("Reason: {value}", {
                value: staffCancellationReasonLabel[item.cancellation.reasonCode],
              })}
            </span>
            {refundCheck !== undefined && checkLines.has(item.orderItemReference) ? (
              <ItemRefundCheck
                orderReference={refundCheck.orderReference}
                cancellationReference={checkLines.get(item.orderItemReference) ?? ""}
                csrf={refundCheck.csrf}
                fetcher={refundCheck.fetcher}
                onChecked={refundCheck.onChecked}
              />
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="order-line-amount">{orderMoney(item.subtotal)}</span>
      {rounds === undefined ? null : (
        <DiningRoundItemState orderItemReference={item.orderItemReference} />
      )}
    </li>
  );
  return (
    <section className="order-lines" aria-label={t("Items ordered")}>
      {rounds === undefined ? (
        <>
          <h3>{t("Items")}</h3>
          <ul>{lines.items.map(lineItem)}</ul>
        </>
      ) : (
        [...rounds.batches]
          .sort((a, b) => a.sequence - b.sequence)
          .map((batch) => {
            const members = lines.items.filter(
              (item) => item.orderBatchReference === batch.orderBatchReference,
            );
            const amount = members
              .filter(
                (item) =>
                  item.cancellation === null &&
                  !cancelledBatches?.has(item.orderBatchReference) &&
                  !unpaidLine(item),
              )
              .reduce((sum, item) => sum + BigInt(item.subtotal.amountMinor), 0n);
            return (
              <section
                key={batch.orderBatchReference}
                className="order-round order-round--lines"
                aria-label={t("Round {sequence}", { sequence: batch.sequence })}
              >
                <header className="order-round__head">
                  <h3>
                    {t("Round {sequence}", { sequence: batch.sequence })}
                    {batch.staffRound !== null ? t(" · Entered by staff") : ""}
                    {batch.submittedAt === null ? null : (
                      <time className="order-round__time" dateTime={batch.submittedAt}>
                        {orderWhen(batch.submittedAt, rounds.timeZone, rounds.today ?? null)}
                      </time>
                    )}
                  </h3>
                  <DiningRoundSummary sequence={batch.sequence} />
                  <span className="order-round__amount">
                    {orderMoney({
                      amountMinor: amount.toString(),
                      currencyCode: lines.totals.total.currencyCode,
                    })}
                  </span>
                </header>
                {rounds.head?.(batch)}
                {members.length === 0 ? null : <ul>{members.map(lineItem)}</ul>}
                <DiningRoundServeAll sequence={batch.sequence} />
              </section>
            );
          })
      )}
      <dl className="order-lines-totals">
        <div>
          <dt>{t("Subtotal")}</dt>
          <dd>{orderMoney(totals.subtotal)}</dd>
        </div>
        {totals.discount.amountMinor !== "0" ? (
          <div>
            <dt>{t("Discount")}</dt>
            <dd>{orderMoney(totals.discount)}</dd>
          </div>
        ) : null}
        {totals.fee.amountMinor !== "0" ? (
          <div>
            <dt>{t("Fees")}</dt>
            <dd>{orderMoney(totals.fee)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Tax")}</dt>
          <dd>{orderMoney(totals.tax)}</dd>
        </div>
        {totals.tip !== null && totals.tip.amountMinor !== "0" ? (
          <div>
            <dt>{t("Tip")}</dt>
            <dd>{orderMoney(totals.tip)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Total")}</dt>
          <dd>{orderMoney(orderTotalWithTip(totals))}</dd>
        </div>
      </dl>
      {unpaid !== null ? (
        <dl className="order-lines-totals order-lines-cancelled-refund">
          <div>
            <dt>{t("Cancelled unpaid rounds")}</dt>
            <dd>−{orderMoney(unpaid.cancelled)}</dd>
          </div>
          <div>
            <dt>{t("Total after cancelled rounds")}</dt>
            <dd>{orderMoney(unpaid.remaining)}</dd>
          </div>
        </dl>
      ) : null}
      {removed !== null ? (
        <dl className="order-lines-totals order-lines-cancelled-refund">
          <div>
            <dt>{t("Taken off the bill")}</dt>
            <dd>−{orderMoney(removed.cancelled)}</dd>
          </div>
          <div>
            <dt>{t("Total after dishes taken off")}</dt>
            <dd>{orderMoney(removed.remaining)}</dd>
          </div>
        </dl>
      ) : null}
      {refunds.length > 0 ? (
        <dl className="order-lines-totals order-lines-cancelled-refund">
          {refunds.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                {row.amount === null ? t("Amount not known yet") : `−${orderMoney(row.amount)}`}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

export interface OrderRefundRow {
  readonly label: string;
  /** Null: the refund has started but Payment has not opened it yet (amount not known). */
  readonly amount: { readonly amountMinor: string; readonly currencyCode: string } | null;
}
/**
 * WP-2423 (46940b76 L2): every refund on the order, so the lines add up to what the payment line
 * says was refunded: the cancelled items' refunds, each whole-order (pickup) or round (dine-in)
 * cancellation's refund, and — when every amount is known — any other online refund (a refund at
 * the customer's request, or an automatic one), then the total when there is more than one.
 */
export function orderRefundRows(
  order: CurrentOrderQueue["items"][number],
  lines: CurrentOrderDetail["lines"],
  position: CurrentOrderDetail["paymentPosition"],
): readonly OrderRefundRow[] {
  const currencyCode = lines.totals.total.currencyCode;
  const money = (minor: bigint) => ({ amountMinor: minor.toString(), currencyCode });
  const rows: OrderRefundRow[] = [];
  const items = cancelledItemsRefund(lines.items);
  if (items !== null && items.amountMinor !== "0")
    rows.push({ label: t("Cancelled items refund"), amount: items });
  let online = items === null ? 0n : BigInt(items.amountMinor),
    known = true,
    total = online;
  for (const batch of [...order.batches].sort((a, b) => a.sequence - b.sequence)) {
    const cancellation = batch.staffCancellation;
    if (cancellation === null || cancellation.refundAmountMinor === "0") continue;
    const label =
      (order.orderType === "Pickup"
        ? t("Order cancellation refund")
        : t("Round {sequence} cancellation refund", { sequence: batch.sequence })) +
      (cancellation.refundMethod === "CardMachine" ? t(" (card machine)") : "");
    if (cancellation.refundAmountMinor === null) {
      known = false;
      rows.push({ label, amount: null });
      continue;
    }
    const amount = BigInt(cancellation.refundAmountMinor);
    if (cancellation.refundMethod === "Online") online += amount;
    total += amount;
    rows.push({ label, amount: money(amount) });
  }
  if (position !== null && known) {
    const other = BigInt(position.refundedMinor) + BigInt(position.refundPendingMinor) - online;
    if (other > 0n) {
      rows.push({ label: t("Other refunds"), amount: money(other) });
      total += other;
    }
  }
  if (rows.length > 1 && known) rows.push({ label: t("Total refunded"), amount: money(total) });
  return rows;
}

/**
 * WP-2423 (3cd0f8dd M1): the order's total with the tip its payments carried, so staff read what
 * was paid (as the guest's page and receipt do). Minor units only.
 */
export function orderTotalWithTip(totals: CurrentOrderDetail["lines"]["totals"]) {
  return Object.freeze({
    amountMinor: (
      BigInt(totals.total.amountMinor) + BigInt(totals.tip?.amountMinor ?? "0")
    ).toString(),
    currencyCode: totals.total.currencyCode,
  });
}
/**
 * WP-2423: what the rounds cancelled automatically for a failed payment came to, and the order total
 * without them (null when there are none). Minor units only; lines already cancelled one by one keep
 * their own refund line.
 */
export function unpaidCancelledTotal(
  lines: CurrentOrderDetail["lines"],
  batches: ReadonlySet<string> | undefined,
) {
  if (batches === undefined || batches.size === 0) return null;
  const currencyCode = lines.totals.total.currencyCode;
  const cancelled = lines.items.filter(
    (item) => item.cancellation === null && batches.has(item.orderBatchReference),
  );
  if (cancelled.length === 0 || cancelled.some((item) => item.total.currencyCode !== currencyCode))
    return null;
  const amount = cancelled.reduce((sum, item) => sum + BigInt(item.total.amountMinor), 0n);
  return Object.freeze({
    cancelled: Object.freeze({ amountMinor: amount.toString(), currencyCode }),
    remaining: Object.freeze({
      amountMinor: (BigInt(orderTotalWithTip(lines.totals).amountMinor) - amount).toString(),
      currencyCode,
    }),
  });
}

/** DEC-DINE-IN-PAY-LATER: what the dishes taken off an unpaid bill came to, and what is left. */
export function removedItemsTotal(
  lines: CurrentOrderDetail["lines"],
  items: ReadonlySet<string> | undefined,
) {
  if (items === undefined || items.size === 0) return null;
  const currencyCode = lines.totals.total.currencyCode;
  const removed = lines.items.filter((item) => items.has(item.orderItemReference));
  if (removed.length === 0 || removed.some((item) => item.total.currencyCode !== currencyCode))
    return null;
  const amount = removed.reduce((sum, item) => sum + BigInt(item.total.amountMinor), 0n);
  return Object.freeze({
    cancelled: Object.freeze({ amountMinor: amount.toString(), currencyCode }),
    remaining: Object.freeze({
      amountMinor: (BigInt(orderTotalWithTip(lines.totals).amountMinor) - amount).toString(),
      currencyCode,
    }),
  });
}

/** DEC-DINE-IN-PAY-LATER: every dish taken off an unpaid bill in this view. */
export function removedUnpaidItems(view: CurrentOrderQueue): ReadonlySet<string> {
  return new Set(
    view.items.flatMap((order) => order.batches.flatMap((batch) => batch.unpaidRemovedItems)),
  );
}

/** WP-2423: unpaid rounds whose payment failed and that are not cancelled yet. */
export function failedPaymentBatches(view: CurrentOrderQueue): ReadonlySet<string> {
  return new Set(
    view.items.flatMap((order) =>
      order.batches
        .filter((batch) => batch.paymentDue?.status === "Failed")
        .map((batch) => batch.orderBatchReference),
    ),
  );
}

/** WP-2423: rounds the System cancelled because their payment failed (not a store cancellation). */
export function unpaidCancelledBatches(view: CurrentOrderQueue): ReadonlySet<string> {
  return new Set(
    view.items.flatMap((order) =>
      order.batches
        .filter(
          (batch) => batch.acceptanceStatus === "Cancelled" && batch.staffCancellation === null,
        )
        .map((batch) => batch.orderBatchReference),
    ),
  );
}

/**
 * WP-2423 Q7: a paid counter order the store could not fulfil is refunded on the card machine by
 * staff (not automatically); what is still owed, or null when nothing is.
 */
export function cardMachineOwed(order: CurrentOrderQueue["items"][number]): string | null {
  const paid = order.counter?.paidOnCardMachine;
  if (order.unfulfillable === null || !paid) return null;
  const owed = BigInt(paid.amountMinor) - BigInt(paid.refundedMinor);
  return owed > 0n ? owed.toString() : null;
}
/**
 * WP-2423: a card-machine payment and its refunds as staff read them: "Paid on card machine
 * $46.81 · refunded in full", "· $12.00 refunded", and what staff cancellations still leave to
 * refund on the machine ("· $5.93 to refund on the card machine"). Refunded is what was recorded
 * as refunded on the machine (cancellations of rounds or items, and ordinary refunds), as the
 * order's settlement counts it.
 */
export function cardMachinePaymentText(paid: bigint, refunded: bigint, toRefund = 0n): string {
  const money = (minor: bigint) =>
    orderMoney({ amountMinor: minor.toString(), currencyCode: "CAD" });
  return (
    t("Paid on card machine ") +
    money(paid) +
    (refunded >= paid
      ? t(" · refunded in full")
      : refunded > 0n
        ? t(" · {refunded} refunded", { refunded: money(refunded) })
        : "") +
    (toRefund > 0n && refunded < paid
      ? t(" · {toRefund} to refund on the card machine", { toRefund: money(toRefund) })
      : "")
  );
}
/**
 * WP-2423 D5: what a table's staff-entered rounds took on the Store's card machine ("Paid on card
 * machine $24.86"), shown beside what guests paid online so the two add up to what was taken, with
 * what was refunded on the machine since. Null when no round was paid on the machine.
 */
export function cardMachineRoundsText(order: CurrentOrderQueue["items"][number]): string | null {
  let paid = 0n,
    refunded = 0n,
    toRefund = 0n;
  for (const batch of order.batches) {
    const machine = batch.staffRound?.paidOnCardMachine;
    if (machine == null) continue;
    paid += BigInt(machine.amountMinor);
    refunded += BigInt(machine.refundedMinor ?? "0");
    const cancellation = batch.staffCancellation;
    if (cancellation?.refundMethod === "CardMachine" && cancellation.refundStatus === "Pending")
      toRefund += BigInt(cancellation.refundAmountMinor ?? "0");
  }
  return paid === 0n ? null : cardMachinePaymentText(paid, refunded, toRefund);
}

/**
 * WP-2423: an online order's payment as staff read it ("Paid online $11.30 · partly refunded"),
 * like a counter order's "Paid on card machine". Payment's refund totals (read with the order
 * detail) decide the refund state whenever they are known: refunded equal to what was paid is
 * "refunded in full", less is "partly refunded", and money still on its way is "refund in
 * progress". Only without those totals (a list row never opened) does it follow the refunds the
 * queue itself shows: the store's online-refunded cancellations against the rounds paid online
 * (rounds paid or refunded on the card machine are not part of the online payment), and orders
 * refunded because they could not be fulfilled. Null when nothing was paid online.
 */
export function onlinePaymentText(
  order: CurrentOrderQueue["items"][number],
  position?: CurrentOrderDetail["paymentPosition"],
): string | null {
  const paid = order.paidOnline;
  if (paid === null) return null;
  const base = t("Paid online ") + orderMoney(paid);
  if (position !== undefined && position !== null) {
    const refunded = BigInt(position.refundedMinor),
      pending = BigInt(position.refundPendingMinor);
    if (pending > 0n)
      return (
        base +
        (refunded > 0n ? t(" · partly refunded, refund in progress") : t(" · refund in progress"))
      );
    if (refunded >= BigInt(paid.amountMinor)) return base + t(" · refunded in full");
    return refunded > 0n ? base + t(" · partly refunded") : base;
  }
  if (order.unfulfillable !== null) return base + t(" · refunded in full");
  const cancelled = order.batches.filter(
    (batch) =>
      batch.staffCancellation !== null && batch.staffCancellation.refundMethod === "Online",
  );
  if (cancelled.length === 0) return base;
  if (cancelled.some((batch) => batch.staffCancellation?.refundStatus === "Pending"))
    return base + t(" · refund in progress");
  // Rounds cancelled automatically because they were never paid were not part of the payment,
  // and neither were rounds paid on the store's card machine (refunded on that machine).
  const paidOnlineBatches = order.batches.filter(
    (batch) =>
      batch.paymentDue === null &&
      (batch.acceptanceStatus !== "Cancelled" || batch.staffCancellation !== null) &&
      batch.staffRound?.paidOnCardMachine == null &&
      batch.staffCancellation?.refundMethod !== "CardMachine",
  );
  return (
    base +
    (cancelled.length >= paidOnlineBatches.length
      ? t(" · refunded in full")
      : t(" · partly refunded"))
  );
}
/** WP-2423: the exact refunds of an online payment on the order detail, when Payment has any. */
function OnlineRefundNote({
  order,
  position,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly position: CurrentOrderDetail["paymentPosition"];
}) {
  if (order.paidOnline === null || position === null) return null;
  const refunded = BigInt(position.refundedMinor),
    pending = BigInt(position.refundPendingMinor);
  if (refunded === 0n && pending === 0n) return null;
  const amount = (minor: bigint) =>
    orderMoney({
      amountMinor: minor.toString(),
      currencyCode: order.paidOnline?.currencyCode ?? "CAD",
    });
  return (
    <p className="order-counter-note order-online-refunds" role="note">
      {refunded > 0n
        ? t("Refunded {refunded} of the online payment.", { refunded: amount(refunded) })
        : ""}
      {refunded > 0n && pending > 0n ? " " : ""}
      {pending > 0n
        ? t("A refund of {pending} is on its way to the customer.", { pending: amount(pending) })
        : ""}
    </p>
  );
}
/**
 * WP-2423: an order's current status in staff words. Dine-in is Fulfilled once every item not
 * cancelled was served at the table (Dining's served records over the kitchen's Ready), which
 * staff read as "Served"; a pickup order handed over reads "Picked up".
 */
export function orderPhaseLabel(
  order: Pick<CurrentOrderQueue["items"][number], "currentPhase" | "orderType"> & {
    readonly kitchenPhase?: CurrentOrderQueue["items"][number]["kitchenPhase"];
    readonly remakingItemCount?: number;
  },
): string {
  // WP-2423 (2026-10-18): a table whose dish the kitchen is making again is not ready (or served)
  // as a whole, as the serving page and the guest's page say.
  if (
    order.orderType === "DineIn" &&
    (order.remakingItemCount ?? 0) > 0 &&
    (order.currentPhase === "Ready" || order.currentPhase === "Fulfilled")
  )
    return t("Being remade");
  // WP-2423 (v15 2026-10-18): an accepted pickup reads what the kitchen shows now, as the
  // customer's page does, instead of "Accepted" until it is handed over.
  if (order.currentPhase === "Accepted" && order.kitchenPhase === "Ready")
    return t("Ready for pickup");
  if (order.currentPhase === "Accepted" && order.kitchenPhase === "InProgress")
    return t("In progress");
  switch (order.currentPhase) {
    case null:
      return t("Status not loaded · refresh");
    case "InProgress":
      return t("In progress");
    case "Fulfilled":
      return order.orderType === "DineIn" ? t("Served") : t("Picked up");
    default:
      return systemText(order.currentPhase);
  }
}
// WP-2423 (DEC-ORDER-CHANNEL-LABEL): one channel mapping, shared with the Operational dashboard.
export { orderChannel, orderChannelLabel, orderTypeLabel };

type QueuedOrder = CurrentOrderQueue["items"][number];
/** WP-2423 UI refresh: an order still being worked on (not finished, cancelled or closed). */
export function isActiveOrder(order: QueuedOrder): boolean {
  return (
    order.unfulfillable === null &&
    !order.pickupNotCollected &&
    order.currentPhase !== null &&
    order.currentPhase !== "Fulfilled" &&
    order.currentPhase !== "Cancelled" &&
    order.currentPhase !== "Rejected"
  );
}
/**
 * WP-2423 UI refresh: how long an active order has been in, from its submission and the page's
 * clock ("4 min", "1 h 05 min"); null for a finished order, a future time, or a day or more.
 */
export function orderAgeText(order: QueuedOrder, now: number): string | null {
  if (!isActiveOrder(order)) return null;
  const minutes = Math.floor((now - Date.parse(order.submittedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  if (minutes < 1) return t("Just now");
  if (minutes < 60) return t("{minutes} min", { minutes: minutes });
  return t("{value} h {value2} min", {
    value: Math.floor(minutes / 60),
    value2: String(minutes % 60).padStart(2, "0"),
  });
}
/**
 * WP-2423 UI refresh: how loud an order's status reads in the list. Waiting on staff or payment
 * is a warning, an order past its acceptance window or closed unfulfilled is danger, a finished
 * order is muted; the label always carries the meaning.
 */
export function orderStatusTone(
  order: QueuedOrder,
  now: number | undefined,
): "danger" | "warning" | "ready" | "done" | "cancelled" | "neutral" {
  if (order.unfulfillable !== null || order.pickupNotCollected) return "danger";
  if (order.acceptanceHold !== null) return "warning";
  if (isAwaitingAcceptance(order)) {
    const tier = now === undefined ? null : acceptanceWindow(order.acceptBy, now)?.tier;
    return tier === "urgent" || tier === "lapsed" ? "danger" : "warning";
  }
  if (order.awaitingPayment || order.currentPhase === null) return "warning";
  // Owner 2026-10-25: finished and cancelled orders no longer share one grey tag.
  if (order.currentPhase === "Fulfilled") return "done";
  if (order.currentPhase === "Cancelled" || order.currentPhase === "Rejected") return "cancelled";
  // Read from the phases, not the shown words, so it holds in every language (a dish being remade
  // is not ready).
  const remade = order.orderType === "DineIn" && (order.remakingItemCount ?? 0) > 0;
  return !remade &&
    (order.currentPhase === "Ready" ||
      (order.currentPhase === "Accepted" && order.kitchenPhase === "Ready"))
    ? "ready"
    : "neutral";
}
/**
 * WP-2423 UI refresh: what was taken for the order — paid online plus paid on the store's card
 * machine (a counter order, or rounds staff entered). Null when no payment is recorded; never a
 * guessed order total.
 */
export function orderAmountTaken(order: QueuedOrder) {
  const parts: { readonly amountMinor: string; readonly currencyCode: string }[] = [];
  if (order.paidOnline !== null) parts.push(order.paidOnline);
  if (order.counter?.paidOnCardMachine)
    parts.push({ amountMinor: order.counter.paidOnCardMachine.amountMinor, currencyCode: "CAD" });
  for (const batch of order.batches)
    if (batch.staffRound?.paidOnCardMachine != null)
      parts.push({
        amountMinor: batch.staffRound.paidOnCardMachine.amountMinor,
        currencyCode: "CAD",
      });
  const currencyCode = parts[0]?.currencyCode;
  if (currencyCode === undefined || parts.some((part) => part.currencyCode !== currencyCode))
    return null;
  return {
    amountMinor: parts.reduce((sum, part) => sum + BigInt(part.amountMinor), 0n).toString(),
    currencyCode,
  };
}
/**
 * WP-2423 (v15 751dd768): an order cancelled with no payment recorded (for example a table whose
 * rounds were never paid, or a counter order released unpaid); its row says so instead of a dash.
 */
export function cancelledUnpaid(order: QueuedOrder): boolean {
  return (
    order.currentPhase === "Cancelled" &&
    orderAmountTaken(order) === null &&
    order.unfulfillable === null &&
    order.batches.every((batch) => batch.staffCancellation === null)
  );
}
/**
 * WP-2423 (v15 751dd768): how many orders the list shows, in plain words. A page holds the 50
 * newest orders (or, after Next page, the next older ones); filters narrow that page only.
 */
export function orderCountText(input: {
  readonly shown: number;
  readonly total: number;
  readonly filtered: boolean;
  readonly olderPage: boolean;
  readonly morePages: boolean;
}): string {
  const orders = (count: number) =>
    count === 1 ? t("1 order") : t("{count} orders", { count: count });
  if (input.filtered)
    return input.morePages || input.olderPage
      ? t("{shown} of {total} {value}orders on this page match. Other pages are not searched.", {
          shown: input.shown,
          total: input.total,
          value: input.olderPage ? "older " : "",
        })
      : t("{shown} of {total} orders match.", { shown: input.shown, total: input.total });
  if (input.morePages)
    return t("{orders}{value}. Older orders are on the next page.", {
      orders: orders(input.total),
      value: input.olderPage ? t(" (older)") : t(", newest first"),
    });
  return input.olderPage
    ? t("{total} (the oldest).", { total: orders(input.total) })
    : `${orders(input.total)}.`;
}
/** WP-2423 item 5: minutes before an unpaid round's cancellation when staff are warned urgently. */
export const unpaidRoundUrgentMinutes = 10;

/**
 * WP-2423: an unpaid dine-in round. A failed payment — or, since item 5, a round with no payment
 * started (a round staff entered and nobody recorded as paid on the card machine) — is cancelled
 * automatically at its payment deadline; staff are told when, in Store time, before it happens, and
 * urgently in the last minutes.
 */
export function paymentDueText(
  due: NonNullable<CurrentOrderQueue["items"][number]["batches"][number]["paymentDue"]>,
  timeZone: string | undefined,
  now?: number,
  staffRound = false,
): string {
  if (due.cancelsAt === null)
    return staffRound
      ? t("Entered by staff · awaiting card-machine payment")
      : t("Awaiting payment");
  const passed = now !== undefined && Date.parse(due.cancelsAt) <= now;
  const at = storeTime(due.cancelsAt, timeZone);
  if (due.status === "Failed")
    return passed
      ? t("Payment failed · being cancelled automatically")
      : t("Payment failed · will be cancelled automatically at {at}", { at: at });
  if (!staffRound && isPaymentUnconfirmed(due.cancelsAt, now))
    return t(
      "Card payment not confirmed by the card provider (due {at}) · ask the guest if they were charged; if not, cancel the round (a later charge is refunded automatically)",
      { at: at },
    );
  if (passed) return t("Not paid in time · being cancelled automatically");
  const left =
    now === undefined ? null : Math.max(1, Math.ceil((Date.parse(due.cancelsAt) - now) / 60_000));
  const soon =
    left !== null && left <= unpaidRoundUrgentMinutes
      ? t(" ({left} min left)", { left: left })
      : "";
  return staffRound
    ? t("Entered by staff · record the card-machine payment by {at}{soon} or it is cancelled", {
        at: at,
        soon: soon,
      })
    : t("Not paid · cancelled automatically at {at}{soon} unless paid", { at: at, soon: soon });
}

/** WP-2423 item 5: how loud an unpaid round's notice is (urgent near and after its deadline). */
export function paymentDueTier(
  due: NonNullable<CurrentOrderQueue["items"][number]["batches"][number]["paymentDue"]>,
  now?: number,
): "urgent" | "warning" {
  if (due.status === "Failed") return "urgent";
  return due.cancelsAt !== null &&
    now !== undefined &&
    Date.parse(due.cancelsAt) - now <= unpaidRoundUrgentMinutes * 60_000
    ? "urgent"
    : "warning";
}

/** WP-2423 Q6: batches the store cancelled as a whole (staff cancellation of the batch). */
export function storeCancelledBatches(view: CurrentOrderQueue): ReadonlySet<string> {
  return new Set(
    view.items.flatMap((order) =>
      order.batches
        .filter((batch) => batch.staffCancellation !== null)
        .map((batch) => batch.orderBatchReference),
    ),
  );
}

/** "+14165550123" → "(416) 555-0123"; other countries keep the international form. */
export function formatContactPhone(phone: string): string {
  const match = /^\+1([2-9][0-9]{2})([0-9]{3})([0-9]{4})$/u.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

/**
 * WP-2423 Q10: who the pickup is for and how to reach them about this order — the contact the
 * customer gave for exactly that. Shown on the order detail only.
 */
export function PickupContactPanel({
  contact,
  timeZone,
}: {
  readonly contact: OrderPickupContact | null;
  readonly timeZone?: string | undefined;
}) {
  if (contact === null) return null;
  return (
    <section className="order-pickup-contact" aria-label={t("Pickup customer")}>
      {contact.status === "Available" ? (
        <p>
          <span>{t("Pickup for {name}", { name: contact.name })}</span>
          {" · "}
          {contact.channel === "Phone" ? (
            <a href={`tel:${contact.value}`}>
              {t("Call {value}", { value: formatContactPhone(contact.value) })}
            </a>
          ) : (
            <a href={`mailto:${contact.value}`}>{t("Email {value}", { value: contact.value })}</a>
          )}
        </p>
      ) : contact.status === "Removed" ? (
        <p>
          {t(
            "The customer's contact was removed on {value} (contacts are kept only for a limited time).",
            {
              value: new Date(contact.removedAt).toLocaleDateString(displayLocale(), {
                ...(timeZone ? { timeZone } : {}),
                dateStyle: "medium",
              }),
            },
          )}
        </p>
      ) : (
        <p>{t("No contact was given. Call out the order number at the counter.")}</p>
      )}
    </section>
  );
}

/** Reads an Order's lines when its queue entry is opened. */
function QueuedOrderLines({
  orderReference,
  client,
  refundCheck,
  revision = 0,
  onDetail,
  roundHead,
  timeZone,
  today = null,
  batches,
}: {
  /** The list's rounds: while the items are read (or can't be), each round still shows its head. */
  readonly batches?: readonly QueuedOrder["batches"][number][] | undefined;
  readonly today?: string | null;
  /** Orders v3: a table's order is listed round by round, each round with its panel head. */
  readonly roundHead?: ((batch: QueuedOrder["batches"][number]) => React.ReactNode) | undefined;
  readonly timeZone?: string | undefined;
  readonly orderReference: string;
  readonly client: ReturnType<typeof createCurrentOrderQueueClient>;
  readonly refundCheck?: ItemRefundCheckContext | undefined;
  /** WP-2423: changes when the page refreshed after an action; the lines are reread in place. */
  readonly revision?: number;
  /** WP-2423: the detail just read, so the order's header can show Payment's refund totals. */
  readonly onDetail?: ((detail: CurrentOrderDetail) => void) | undefined;
}) {
  const [state, setState] = useState<
    { kind: "Loading" | "Unavailable" } | { kind: "Ready"; detail: CurrentOrderDetail }
  >({ kind: "Loading" });
  const reported = useRef(onDetail);
  reported.current = onDetail;
  useEffect(() => {
    const controller = new AbortController();
    void client
      .loadDetail(orderReference, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setState({ kind: "Ready", detail });
        reported.current?.(detail);
      })
      .catch(() => {
        // A failed reread after an action keeps the lines already shown.
        if (!controller.signal.aborted)
          setState((previous) => (previous.kind === "Ready" ? previous : { kind: "Unavailable" }));
      });
    return () => controller.abort();
  }, [orderReference, client, revision]);
  return state.kind === "Ready" ? (
    <>
      <PickupContactPanel contact={state.detail.pickupContact} />
      <OnlineRefundNote order={state.detail.order} position={state.detail.paymentPosition} />
      <CurrentOrderLines
        lines={state.detail.lines}
        refundCheck={refundCheck}
        cancelledBatches={storeCancelledBatches(state.detail.view)}
        unpaidCancelledBatches={unpaidCancelledBatches(state.detail.view)}
        failedPaymentBatches={failedPaymentBatches(state.detail.view)}
        removedItems={removedUnpaidItems(state.detail.view)}
        refundRows={orderRefundRows(
          state.detail.order,
          state.detail.lines,
          state.detail.paymentPosition,
        )}
        rounds={
          state.detail.order.orderType === "DineIn"
            ? { batches: state.detail.order.batches, head: roundHead, timeZone, today }
            : undefined
        }
      />
    </>
  ) : (
    <>
      {roundHead !== undefined && batches !== undefined
        ? // A round's acceptance or payment step never waits for its items to be read.
          [...batches]
            .sort((a, b) => a.sequence - b.sequence)
            .map((batch) => (
              <section
                key={batch.orderBatchReference}
                className="order-round order-round--lines"
                aria-label={t("Round {sequence}", { sequence: batch.sequence })}
              >
                <header className="order-round__head">
                  <h3>{t("Round {sequence}", { sequence: batch.sequence })}</h3>
                </header>
                {roundHead(batch)}
                <DiningRoundProgressItems sequence={batch.sequence} />
              </section>
            ))
        : null}
      <p className="order-lines-state" role="status">
        {state.kind === "Loading"
          ? t("Reading items…")
          : t("Items could not be read. Open the order to retry.")}
      </p>
    </>
  );
}

/** WP-2423 Q1: the page re-reads current orders this often while it is open. */
export const ORDER_REFRESH_MS = 10_000;
/**
 * WP-2423 Q1: how close a paid pickup is to the end of its acceptance window (30 minutes after
 * payment; Payment refunds it afterwards). Warning from 10 minutes left, urgent from 5.
 */
export function acceptanceWindow(acceptBy: string | null, now: number) {
  if (acceptBy === null) return null;
  const left = Date.parse(acceptBy) - now;
  const minutes = Math.max(0, Math.ceil(left / 60_000));
  return {
    minutes,
    tier: (left <= 0 ? "lapsed" : minutes <= 5 ? "urgent" : minutes <= 10 ? "warning" : "ok") as
      "ok" | "warning" | "urgent" | "lapsed",
  };
}
/** WP-2423 Q1: batches staff can accept now, keyed by batch reference. */
export function awaitingBatchReferences(view: CurrentOrderQueue): ReadonlySet<string> {
  return new Set(
    view.items.flatMap((order) =>
      order.batches
        .filter((batch) => batch.canRequestAcceptance)
        .map((batch) => batch.orderBatchReference),
    ),
  );
}
function AcceptanceDeadline({
  order,
  now,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly now: number;
}) {
  // WP-2423 Q9-G1: paid while the Store was offline; held for a manager's decision.
  if (order.acceptanceHold !== null)
    return (
      <span className="order-accept-by" data-tier={acceptanceHoldTier(order.acceptanceHold, now)}>
        {acceptanceHoldText(order.acceptanceHold, now)}
      </span>
    );
  const window = isAwaitingAcceptance(order) ? acceptanceWindow(order.acceptBy, now) : null;
  return window === null ? null : (
    <span className="order-accept-by" data-tier={window.tier}>
      {window.tier === "lapsed"
        ? t("Acceptance window ended · refund pending")
        : t("Accept within {minutes} min", { minutes: window.minutes })}
    </span>
  );
}

const unfulfillableText = {
  CapacityExpired: t("Not accepted before its preparation slot expired."),
  SubmissionCancelled: t("The submission was cancelled after payment."),
  OrderNoLongerFulfillable: t("The order could no longer be fulfilled after payment."),
} as const;

/**
 * Figma v1 (2026-10-25): whether this round's only action is the plain "Accept" (no outage hold,
 * nothing to charge, refund or cancel first). On the list that button sits in the order's row.
 */
export function acceptsInRow(
  order: CurrentOrderQueue["items"][number],
  batch: CurrentOrderQueue["items"][number]["batches"][number],
  now: number,
): boolean {
  return (
    batch.canRequestAcceptance &&
    !(
      order.acceptanceHold !== null &&
      order.acceptanceHold.orderBatchReference === batch.orderBatchReference
    ) &&
    !(
      order.heldStock !== null &&
      order.heldStock.state === "Ended" &&
      !order.heldStock.productionStarted &&
      order.heldStock.orderBatchReference === batch.orderBatchReference
    ) &&
    !(
      batch.sequence === 1 &&
      order.canRecordCardMachinePayment &&
      counterAwaitingCardMachine(order, now)
    ) &&
    !(
      order.canRecordCardMachinePayment &&
      batch.staffRound != null &&
      batch.staffRound.paidOnCardMachine === null &&
      batch.acceptanceStatus === "NotAccepted" &&
      batch.paymentDue !== null &&
      batch.paymentDue.status === "Awaiting" &&
      (batch.paymentDue.cancelsAt === null || Date.parse(batch.paymentDue.cancelsAt) > now)
    ) &&
    !(
      (batch.staffCancellation?.refundMethod === "CardMachine" &&
        batch.staffCancellation.refundStatus === "Pending") ||
      (batch.sequence === 1 && cardMachineOwed(order) !== null)
    ) &&
    !(batch.canCancel || batch.canCancelItems)
  );
}
/** Orders v2 (Owner 2026-10-26): an order's status words, the same in its row and its panel. */
function OrderPhase({
  order,
  now,
  inPanel = false,
}: {
  readonly order: QueuedOrder;
  readonly now?: number | undefined;
  /** The open order's own status, apart from its row's. */
  readonly inPanel?: boolean;
}) {
  return (
    <span
      className={inPanel ? "order-panel__phase" : "order-workbench-phase"}
      data-tone={orderStatusTone(order, now)}
      data-phase={
        order.awaitingPayment
          ? "AwaitingPayment"
          : order.pickupNotCollected
            ? "NotCollected"
            : order.unfulfillable !== null
              ? "Expired"
              : (order.currentPhase ?? "Unavailable")
      }
    >
      {order.awaitingPayment
        ? order.counter !== null
          ? t("Awaiting card-machine payment")
          : t("Awaiting payment")
        : order.pickupNotCollected
          ? t("Not collected")
          : order.unfulfillable !== null
            ? cardMachineOwed(order) !== null
              ? t("Expired · refund on card machine")
              : t("Expired · refunded")
            : orderPhaseLabel(order)}
    </span>
  );
}

/**
 * Orders v2: what the row says under its status — deadlines, holds and closures, each one short
 * line. Payment and round counts live in the panel; routine payments are not repeated.
 */
function OrderStatusNotes({
  order,
  now,
  timeZone,
}: {
  readonly order: QueuedOrder;
  readonly now?: number | undefined;
  readonly timeZone?: string | undefined;
}) {
  return (
    <>
      {now === undefined ? null : <AcceptanceDeadline order={order} now={now} />}
      {/* WP-2423 (v15 751dd768): warn before a sent counter order is released unpaid. */}
      {counterAwaitingCardMachine(order, now ?? Date.now()) && order.counter?.payBy ? (
        <span className="order-accept-by" data-tier={counterPayByTier(order.counter.payBy, now)}>
          {counterPayByText(order.counter.payBy, timeZone, now)}
        </span>
      ) : null}
      {order.heldStock !== null ? (
        <span className="order-held-stock-tag">
          {order.heldStock.state === "Open"
            ? t("Still holds its ingredients")
            : t("Finished · ingredients still set aside")}
        </span>
      ) : null}
      {order.counter?.recordedAfterOutage ? (
        <span className="order-counter-outage" data-tier="warning">
          {t("Recorded after outage")}
        </span>
      ) : null}
      {order.orderType === "Pickup" && order.batches[0]?.staffCancellation ? (
        <span className="order-staff-cancelled">
          {staffCancellationSummary(order, order.batches[0])}
        </span>
      ) : null}
      {cancelledUnpaid(order) ? (
        <span className="order-staff-cancelled">{t("Cancelled before payment")}</span>
      ) : null}
      {order.batches.map((batch) =>
        batch.paymentDue === null ? null : (
          <span
            key={batch.orderBatchReference}
            className="order-accept-by"
            data-tier={paymentDueTier(batch.paymentDue, now)}
          >
            {order.batches.length > 1 ? t("Round {sequence}: ", { sequence: batch.sequence }) : ""}
            {paymentDueText(batch.paymentDue, timeZone, now, batch.staffRound !== null)}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Orders v2: the words under a row's amount, only when they say something the amount does not —
 * not paid, taken on the card machine, refunded. A plain online payment says nothing.
 */
export function orderAmountNote(
  order: QueuedOrder,
  position?: CurrentOrderDetail["paymentPosition"],
): string | null {
  // Only an order known to be waiting for its payment says "Not paid"; no payment on the list is
  // otherwise just not known here.
  if (orderAmountTaken(order) === null)
    return order.awaitingPayment || counterAwaitingCardMachine(order, Date.now())
      ? t("Not paid")
      : null;
  const online = onlinePaymentText(order, position);
  const plain = order.paidOnline === null ? "" : t("Paid online ") + orderMoney(order.paidOnline);
  const refund =
    online === null || online === plain ? null : online.slice(plain.length).replace(/^ · /u, "");
  const machine =
    order.counter?.paidOnCardMachine != null ||
    order.batches.some((batch) => batch.staffRound?.paidOnCardMachine != null);
  const parts = [machine ? t("Card machine") : null, refund].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Orders v2: how many rounds a table's order has, in its row ("2 rounds"); null for one. */
/** Orders v2 (Owner 2026-10-26): "10/24 · 1" for an order not of today's business day. */
export function orderLabel(
  order: Pick<QueuedOrder, "orderNumber" | "businessDate">,
  today: string | null,
): string {
  if (order.businessDate === null || today === null || order.businessDate === today)
    return order.orderNumber;
  const [, month, day] = order.businessDate.split("-");
  return t("{month}/{day} · {orderNumber}", {
    month: String(Number(month)),
    day: String(Number(day)),
    orderNumber: order.orderNumber,
  });
}

/**
 * Orders v2: when an order was placed, in one style — the time today, else the date with the
 * weekday ("Sat, Oct 24 20:00"), with the year only when it is not this year.
 */
export function orderWhen(instant: string, timeZone: string | undefined, today: string | null) {
  const time = storeTime(instant, timeZone);
  if (timeZone === undefined) return time;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
  if (date === today) return time;
  const label = new Intl.DateTimeFormat(displayLocale(), {
    timeZone,
    ...(today !== null && date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(instant));
  return `${label} ${time}`;
}

/** Orders v2: what the order is — "1× Latte (Small), 2× Mocha +1 more" (null when not read). */
export function orderItemsText(summary: QueuedOrder["summary"]): string | null {
  if (summary === null) return null;
  const shown = summary.items.slice(0, 2).map((item) =>
    t("{quantity}× {name}", {
      quantity: item.quantity,
      name:
        item.option === null
          ? item.name
          : t("{name} ({option})", { name: item.name, option: item.option }),
    }),
  );
  const more = summary.lineCount - shown.length;
  return shown.join(t(", ")) + (more > 0 ? t(" +{count} more", { count: more }) : "");
}

/** Orders v2: who the order is for — the pickup name, the table, else how it came in. */
export function orderWho(order: QueuedOrder): string {
  if (order.summary?.pickupName) return order.summary.pickupName;
  if (order.summary?.tableLabel) return t("Table {label}", { label: order.summary.tableLabel });
  return orderChannelLabel(orderChannel(order));
}

/**
 * Orders v3: a pickup staff can hand over now — ready (Ordering or the kitchen says so), paid or
 * recorded, not closed. Its next step is the handoff on Pickup, where the guest's code is checked.
 */
export function handoverReady(order: QueuedOrder, now: number): boolean {
  return (
    order.orderType === "Pickup" &&
    // Only once it is ready: before that the kitchen is still making it.
    (order.currentPhase === "Ready" ||
      (order.currentPhase === "Accepted" && order.kitchenPhase === "Ready")) &&
    order.unfulfillable === null &&
    !order.pickupNotCollected &&
    !order.awaitingPayment &&
    order.acceptanceHold === null &&
    !counterAwaitingCardMachine(order, now)
  );
}

/** Orders v2: the handoff on Pickup, with this order already searched. */
export function HandoverLink({
  order,
  className,
}: {
  readonly order: QueuedOrder;
  readonly className?: string;
}) {
  return (
    <Link
      className={className}
      to={`/operations/pickup?order=${encodeURIComponent(order.orderNumber)}`}
    >
      {t("Hand over to guest")}
    </Link>
  );
}

function roundCount(order: QueuedOrder): string | null {
  return order.orderType === "DineIn" && order.batches.length > 1
    ? t("{count} rounds", { count: order.batches.length })
    : null;
}

/** Orders v2: everything one order says and offers — the side panel, or the order page itself. */
function OrderDetailBody({
  order,
  single,
  headingId,
  onClose,
  now,
  timeZone,
  today,
  position,
  detail,
  action,
}: {
  readonly order: QueuedOrder;
  readonly single: boolean;
  readonly headingId: string;
  readonly onClose?: (() => void) | undefined;
  readonly now?: number | undefined;
  readonly timeZone?: string | undefined;
  readonly today: string | null;
  readonly position: CurrentOrderDetail["paymentPosition"] | undefined;
  readonly detail?:
    | ((
        order: QueuedOrder,
        open: boolean,
        roundHead?: (batch: QueuedOrder["batches"][number]) => React.ReactNode,
      ) => React.ReactNode)
    | undefined;
  readonly action?:
    ((order: QueuedOrder, batch: QueuedOrder["batches"][number]) => React.ReactNode) | undefined;
}) {
  // Orders v3 (Owner 2026-10-26): what the panel says and offers for one round — its staff
  // entry, cancellation, payment or acceptance, then its step. A table's rounds carry it above
  // their items (see CurrentOrderLines), a pickup's one batch here.
  const roundHead = (batch: QueuedOrder["batches"][number]) => (
    <>
      {batch.staffRound !== null &&
      (batch.staffRound.paidOnCardMachine !== null || batch.staffRound.recordedAfterOutage) ? (
        <p className="order-staff-round" role="note">
          {batch.staffRound.paidOnCardMachine !== null
            ? t("Paid on card machine {value} · {takenAt}", {
                value: orderMoney({
                  amountMinor: batch.staffRound.paidOnCardMachine.amountMinor,
                  currencyCode: "CAD",
                }),
                takenAt: storeTime(batch.staffRound.paidOnCardMachine.takenAt, timeZone, true),
              })
            : ""}
          {batch.staffRound.paidOnCardMachine !== null && batch.staffRound.recordedAfterOutage
            ? " · "
            : ""}
          {batch.staffRound.recordedAfterOutage ? t("Recorded after outage") : ""}
        </p>
      ) : null}
      {batch.staffCancellation !== null ? (
        <p className="order-workbench-closed order-staff-cancellation" role="note">
          {staffCancellationSummary(order, batch)}
          <span>
            {t("Reason: {value} ·", {
              value: staffCancellationReasonLabel[batch.staffCancellation.reasonCode],
            })}{" "}
            <time dateTime={batch.staffCancellation.cancelledAt}>
              {storeTime(batch.staffCancellation.cancelledAt, timeZone, true)}
            </time>
          </span>
          <span>
            {batch.staffCancellation.refundMethod === "CardMachine"
              ? batch.staffCancellation.refundStatus === "Refunded"
                ? t("Refunded in full on the store's card machine, including any tip.")
                : t("Refund {value} on the store's card machine, then record it here.", {
                    value: orderMoney({
                      amountMinor: batch.staffCancellation.refundAmountMinor ?? "0",
                      currencyCode: "CAD",
                    }),
                  })
              : batch.staffCancellation.refundAmountMinor !== null &&
                  batch.staffCancellation.refundAmountMinor !== "0"
                ? // 46940b76 L2: what is left of the payment (items refunded earlier are listed
                  // with the order's refunds).
                  t("{value} {value2}: everything left of the payment, including any tip left.", {
                    value:
                      batch.staffCancellation.refundStatus === "Refunded"
                        ? t("Refunded")
                        : "Refunding",
                    value2: orderMoney({
                      amountMinor: batch.staffCancellation.refundAmountMinor,
                      currencyCode: "CAD",
                    }),
                  })
                : batch.staffCancellation.refundStatus === "Refunded"
                  ? t("The payment, including any tip, was refunded in full.")
                  : t("The payment, including any tip, is being refunded in full.")}
          </span>
        </p>
      ) : batch.acceptanceStatus === "Cancelled" ? (
        // WP-2423: cancelled automatically because its payment failed (no store refund).
        <p className="order-workbench-closed" role="note">
          {t(
            "Round cancelled · not paid. It wasn't paid (cancelled when its payment time ended, or by a manager), so it never went to the kitchen and its items went back to stock. Nothing was charged for it in the system.{value}",
            {
              value:
                batch.staffRound !== null
                  ? t(
                      " If the card machine was charged for it, refund that payment on the machine.",
                    )
                  : "",
            },
          )}
        </p>
      ) : batch.paymentDue !== null ? (
        <p className="order-workbench-closed" role="note">
          <span className="order-accept-by" data-tier={paymentDueTier(batch.paymentDue, now)}>
            {paymentDueText(batch.paymentDue, timeZone, now, batch.staffRound !== null)}
          </span>
          {batch.paymentDue.status === "Failed"
            ? t(
                " Don't prepare it; it will not be charged. If the guest still wants these items, they can order them again.",
              )
            : batch.staffRound !== null
              ? t(
                  " Charge it on the card machine and record it below; the kitchen starts it once recorded. If it isn't recorded in time, it is cancelled and its items go back to stock.",
                )
              : batch.canCancelUnpaid
                ? t(
                    " Not accepted yet: the guest has not paid for this round. Ask them to finish paying on their phone (their table page has a pay button), or cancel it below.",
                  )
                : t(
                    " Not accepted yet: the guest has not paid for this round. Ask them to finish paying on their phone (their table page has a pay button), or ask a manager to cancel it.",
                  )}
        </p>
      ) : batch.awaitingAcceptanceSince !== null && now !== undefined ? (
        // WP-2423: a paid round waits for staff, never for a timer; say how long.
        <p role="note">
          <span
            className="order-accept-by"
            data-tier={paidRoundWait(batch.awaitingAcceptanceSince, now).tier}
          >
            {paidRoundWaitText(batch.awaitingAcceptanceSince, now)}
          </span>
        </p>
      ) : order.orderType === "Pickup" || batch.acceptanceStatus === "Accepted" ? null : (
        // Orders v3: only a round still to accept says so; an accepted round needs no line.
        <p className="order-round__acceptance">
          {t("Acceptance: {value}", { value: t("Not accepted") })}
        </p>
      )}
      {/* A pickup's one step is the panel's next step (below); a table's stays per round. */}
      {order.orderType === "Pickup" ? null : action?.(order, batch)}
    </>
  );
  const payment = [
    order.paidOnline === null ? null : onlinePaymentText(order, position),
    order.counter?.paidOnCardMachine
      ? cardMachinePaymentText(
          BigInt(order.counter.paidOnCardMachine.amountMinor),
          BigInt(order.counter.paidOnCardMachine.refundedMinor),
        )
      : null,
    cardMachineRoundsText(order),
  ].filter((text) => text !== null);
  return (
    <div className="order-workbench-detail">
      {single ? null : (
        <header className="order-panel__head">
          <div>
            <h2 id={headingId} tabIndex={-1}>
              {t("Order {orderNumber}", { orderNumber: orderLabel(order, today) })}
            </h2>
            <p className="order-panel__meta">
              {[
                orderWho(order) === orderChannelLabel(orderChannel(order)) ? null : orderWho(order),
                orderTypeLabel[order.orderType],
                orderChannelLabel(orderChannel(order)),
              ]
                .filter((part) => part !== null)
                .join(" · ")}{" "}
              ·{" "}
              <time dateTime={order.submittedAt}>
                {orderWhen(order.submittedAt, timeZone, today)}
              </time>
            </p>
          </div>
          <button type="button" className="order-panel__close" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">{t("Close details")}</span>
          </button>
        </header>
      )}
      <div className="order-panel__status">
        <OrderPhase order={order} now={now} inPanel={!single} />
        <OrderStatusNotes order={order} now={now} timeZone={timeZone} />
      </div>
      {order.heldStock === null ? null : (
        <p className="order-panel__hint">
          {order.heldStock.state === "Open"
            ? t(
                "If the guest doesn't come back, cancel it: they are refunded and the ingredients go back to stock.",
              )
            : t("It is finished; release its ingredients below.")}
        </p>
      )}
      {order.counter !== null && order.counter.paidOnCardMachine === null ? (
        <p className="order-counter-note" role="note">
          {counterAwaitingCardMachine(order, now ?? Date.now())
            ? t(
                "Not paid yet: charge it on the card machine, then record it below (or from Counter order).",
              )
            : t("Not paid on the card machine.")}
        </p>
      ) : null}
      {order.counter?.recordedAfterOutage ? (
        <p className="order-counter-note" role="note">
          {t(
            " Recorded after an outage from a paper order: it may already have been made and handed over.",
          ).trim()}
        </p>
      ) : null}
      {order.pickupNotCollected ? (
        <p className="order-workbench-closed" role="note">
          {t(
            "Closed as not collected after the pickup hold. It was not refunded automatically; a manager can still grant a refund from payments.",
          )}
        </p>
      ) : null}
      {order.unfulfillable !== null ? (
        <p className="order-workbench-closed" role="note">
          {unfulfillableText[order.unfulfillable]}{" "}
          {order.counter?.paidOnCardMachine
            ? cardMachineOwed(order) !== null
              ? t(
                  "It was paid on the store's card machine: refund {value} on the card machine, then record it here.",
                  {
                    value: orderMoney({
                      amountMinor: cardMachineOwed(order) ?? "0",
                      currencyCode: "CAD",
                    }),
                  },
                )
              : t("It was refunded on the store's card machine.")
            : t("The payment was refunded automatically; this order cannot be accepted.")}
        </p>
      ) : null}
      {order.orderType === "DineIn" && detail !== undefined
        ? null
        : order.batches.map((batch) => (
            <section
              key={batch.orderBatchReference}
              className="order-round"
              aria-label={
                order.orderType === "Pickup"
                  ? t("Order")
                  : t("Round {sequence}", { sequence: batch.sequence })
              }
            >
              {/* v15 1fc58e90 ⑧: a pickup order has one batch, so it reads as the order. */}
              {order.orderType === "Pickup" ? null : (
                <h3>
                  {t("Round {sequence}{value}", {
                    sequence: batch.sequence,
                    value: batch.sequence === 1 ? t(" · First round") : t(" · Added round"),
                  })}
                  {batch.staffRound !== null ? t(" · Entered by staff") : ""}
                </h3>
              )}
              {roundHead(batch)}
            </section>
          ))}
      {detail?.(order, true, order.orderType === "DineIn" ? roundHead : undefined)}
      {payment.length === 0 ? null : (
        <section className="order-panel__section" aria-label={t("Payment")}>
          <h3>{t("Payment")}</h3>
          <ul className="order-panel__payment">
            {payment.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="order-panel__section" aria-label={t("Record")}>
        <h3>{t("Record")}</h3>
        <dl className="order-panel__facts">
          <div>
            <dt>{t("Placed")}</dt>
            <dd>
              <time dateTime={order.submittedAt}>
                {orderWhen(order.submittedAt, timeZone, today)}
              </time>
            </dd>
          </div>
          {order.businessDate === null ? null : (
            <div>
              <dt>{t("Business day")}</dt>
              <dd>
                {order.heldStock === null &&
                order.listedBusinessDate !== null &&
                order.listedBusinessDate !== order.businessDate
                  ? openedEarlierText(order.businessDate, order.listedBusinessDate, today)
                  : businessDateLabel(order.businessDate, today)}
              </dd>
            </div>
          )}
          <div>
            <dt>{t("Last checked")}</dt>
            <dd>
              <time dateTime={order.observedAt} title={order.observedAt}>
                {orderWhen(order.observedAt, timeZone, today)}
              </time>
            </dd>
          </div>
        </dl>
      </section>
      {/* Orders v2 (Owner 2026-10-26): the order's one next step leads (the accent button), and
          cancelling sits under it as red words that ask before they act. */}
      {order.orderType === "Pickup" && order.batches[0] !== undefined ? (
        <div className="order-panel__next">
          {now !== undefined && handoverReady(order, now) ? (
            <HandoverLink order={order} className="order-next-primary" />
          ) : null}
          {action?.(order, order.batches[0])}
        </div>
      ) : null}
    </div>
  );
}

export function CurrentOrderQueueRows({
  single = false,
  view,
  visibleOrderReferences,
  action,
  detail,
  timeZone,
  now,
  paymentPosition,
  paymentPositions,
  expanded,
  rowAction,
  before,
  after,
}: {
  readonly view: CurrentOrderQueue;
  /** Figma v1: the order's next step, shown at the end of its row on the list (outside the row's
      button, so it is its own control). Kept while the panel shows the same order (Owner). */
  readonly rowAction?: ((order: CurrentOrderQueue["items"][number]) => React.ReactNode) | undefined;
  /** WP-2423: Payment's refund position of the one Order shown (the order detail page). */
  readonly paymentPosition?: CurrentOrderDetail["paymentPosition"] | undefined;
  /** WP-2423: on the list, the refund positions of the orders whose detail was read (opened). */
  readonly paymentPositions?: ReadonlyMap<string, CurrentOrderDetail["paymentPosition"]>;
  /**
   * Orders v2: the order open in the panel, kept by the page so a refresh after an action (a
   * recorded card-machine refund) never closes it. Omitted: the rows keep it themselves.
   */
  readonly expanded?: ExpandedOrders | undefined;
  /** WP-2423 Q1: the clock acceptance deadlines are shown against (omitted: not shown). */
  readonly now?: number | undefined;
  readonly timeZone?: string | undefined;
  readonly visibleOrderReferences?: ReadonlySet<string>;
  readonly detail?: (
    order: CurrentOrderQueue["items"][number],
    open: boolean,
    /** Orders v3: a table round's panel head, for the items listed under it. */
    roundHead?: (batch: QueuedOrder["batches"][number]) => React.ReactNode,
  ) => React.ReactNode;
  /** OPS-ORDER-DETAIL: one Order, no list. */
  readonly single?: boolean;
  readonly action?: (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => React.ReactNode;
  /** Orders v2: what sits above and below the list in its column (notices, filters, paging). */
  readonly before?: React.ReactNode;
  readonly after?: React.ReactNode;
}) {
  const [ownOpened, setOwnOpened] = useState<ReadonlySet<string>>(new Set());
  const opened = expanded?.opened ?? ownOpened;
  const setOpened = expanded?.setOpened ?? setOwnOpened;
  // An order shown only because it is the one match (search, filter) opens by itself; once
  // closed it stays closed until another order is the one match.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusPanel = useRef(false);
  const listScroll = useRef(0);
  const panelHeading = useId();
  const listed = (order: QueuedOrder) =>
    visibleOrderReferences === undefined || visibleOrderReferences.has(order.orderReference);
  const shown = view.items.filter(listed);
  const only = shown.length === 1 ? shown[0] : undefined;
  const selected = single
    ? view.items[0]
    : (shown.find((order) => opened.has(order.orderReference)) ??
      (only !== undefined && only.orderReference !== dismissed ? only : undefined));
  const positionOf = (order: QueuedOrder) =>
    single
      ? (paymentPosition ?? order.paymentPosition ?? undefined)
      : (order.paymentPosition ?? paymentPositions?.get(order.orderReference));
  // WP-2423 Q21: orders are grouped by the Store business day they belong to (order numbers restart
  // each business day; an order after midnight before the day's start belongs to the day before).
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const selectedReference = selected?.orderReference ?? null;
  useEffect(() => {
    if (selectedReference === null || !focusPanel.current) return;
    focusPanel.current = false;
    document.getElementById(panelHeading)?.focus();
  }, [selectedReference, panelHeading]);
  const open = (order: QueuedOrder) => {
    listScroll.current = typeof window === "undefined" ? 0 : window.scrollY;
    focusPanel.current = true;
    setOpened(new Set([order.orderReference]));
  };
  const close = () => {
    if (selected === undefined) return;
    const reference = selected.orderReference;
    if (reference === only?.orderReference) setDismissed(reference);
    setOpened(new Set());
    // On a phone the order replaced the list: back where staff left it, on the order's row.
    requestAnimationFrame(() => {
      if (window.matchMedia?.("(max-width: 48rem)").matches) window.scrollTo(0, listScroll.current);
      rowButtons.current.get(reference)?.focus({ preventScroll: true });
    });
  };
  if (single)
    return selected === undefined ? null : (
      <div className="order-workbench order-workbench--single">
        <OrderDetailBody
          order={selected}
          single
          headingId={panelHeading}
          now={now}
          timeZone={timeZone}
          today={today}
          position={positionOf(selected)}
          detail={detail}
          action={action}
        />
      </div>
    );
  const dayHeadings = new Map<string, string>();
  let previous: string | null = null;
  for (const order of shown) {
    // WP-2423 D4: an older table's Order with a round today is listed under today.
    const day = order.listedBusinessDate;
    if (day === null) continue;
    // WP-2423 (2026-10-16): earlier-day orders still holding stock lead the list as one group.
    const group = order.heldStock !== null ? "held" : day;
    if (group !== previous)
      dayHeadings.set(
        order.orderReference,
        order.heldStock !== null ? t("Earlier days · not finished") : businessDateLabel(day, today),
      );
    previous = group;
  }
  return (
    // "auto": open only because it is the one order shown; a phone then keeps the list in view.
    <div
      className="order-workbench"
      data-panel={
        selected === undefined ? undefined : opened.has(selected.orderReference) ? "open" : "auto"
      }
    >
      <div className="order-workbench-main">
        {before}
        {view.items.length === 0 ? (
          <StatePanel heading={t("No orders yet")} status>
            <p>{t("New orders appear here on their own.")}</p>
          </StatePanel>
        ) : (
          <ol className="order-list" aria-label={t("Current orders")}>
            {view.items.map((order) => {
              const isOpen = order.orderReference === selected?.orderReference;
              const note = orderAmountNote(order, positionOf(order));
              const amount = orderAmountTaken(order);
              const age = now === undefined ? null : orderAgeText(order, now);
              const earlier =
                order.businessDate !== null && today !== null && order.businessDate !== today;
              return (
                <Fragment key={order.orderReference}>
                  {dayHeadings.has(order.orderReference) ? (
                    <li className="order-list__day">
                      <h2 className="order-workbench-day">
                        {dayHeadings.get(order.orderReference)}
                      </h2>
                    </li>
                  ) : null}
                  <li
                    className="order-row"
                    data-open={isOpen ? "true" : undefined}
                    hidden={!listed(order)}
                  >
                    <div className="order-row__summary">
                      <h3 className="order-row__number">
                        <button
                          type="button"
                          className="order-row__open"
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? panelHeading + "-panel" : undefined}
                          ref={(node) => {
                            if (node) rowButtons.current.set(order.orderReference, node);
                            else rowButtons.current.delete(order.orderReference);
                          }}
                          onClick={() => (isOpen ? close() : open(order))}
                        >
                          {orderLabel(order, today)}
                        </button>
                      </h3>
                      <span className="order-row__what">
                        {/* Orders v2: what it is (its items), then who and when. */}
                        <span className="order-workbench-type">
                          {orderItemsText(order.summary) ??
                            [
                              orderTypeLabel[order.orderType],
                              orderChannelLabel(orderChannel(order)),
                              roundCount(order),
                            ]
                              .filter((part) => part !== null)
                              .join(" · ")}
                        </span>
                        <span className="order-row__when">
                          {order.summary === null
                            ? ""
                            : [
                                orderWho(order),
                                order.orderType === "Pickup" &&
                                orderWho(order) !== orderChannelLabel(orderChannel(order))
                                  ? orderTypeLabel[order.orderType]
                                  : null,
                                roundCount(order),
                              ]
                                .filter((part) => part !== null)
                                .join(" · ") + " · "}
                          {earlier && order.businessDate !== null
                            ? businessDateLabel(order.businessDate, today) + " "
                            : ""}
                          <time
                            className="order-workbench-time"
                            dateTime={order.submittedAt}
                            title={order.submittedAt}
                          >
                            {storeTime(order.submittedAt, timeZone)}
                          </time>
                          {age === null ? null : (
                            <>
                              {" · "}
                              <span
                                className="order-workbench-age"
                                data-tone={
                                  isAwaitingAcceptance(order)
                                    ? orderStatusTone(order, now)
                                    : "neutral"
                                }
                              >
                                {age}
                              </span>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="order-row__status">
                        <OrderPhase order={order} now={now} />
                        <OrderStatusNotes order={order} now={now} timeZone={timeZone} />
                      </span>
                      <span className="order-workbench-amount">
                        {amount === null ? (
                          <span aria-hidden="true">—</span>
                        ) : (
                          <span className="order-row__money">{orderMoney(amount)}</span>
                        )}
                        {note === null ? null : <span className="order-row__paid">{note}</span>}
                        {amount === null && note === null ? (
                          <span className="visually-hidden">{t("No payment recorded")}</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="order-workbench-next">{rowAction?.(order)}</div>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        )}
        {after}
      </div>
      {selected === undefined ? null : (
        <aside
          className="order-panel"
          id={panelHeading + "-panel"}
          aria-labelledby={panelHeading}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
        >
          <OrderDetailBody
            key={selected.orderReference}
            order={selected}
            single={false}
            headingId={panelHeading}
            onClose={close}
            now={now}
            timeZone={timeZone}
            today={today}
            position={positionOf(selected)}
            detail={detail}
            action={action}
          />
        </aside>
      )}
    </div>
  );
}
export function CurrentOrderDetails({
  order,
  csrf,
  locked,
  onBusy,
  onChanged,
  lines,
  fetcher,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  /** WP-2423: an item was served or the table closed; reread the order's status now. */
  readonly onChanged?: (() => void) | undefined;
  /** The Order's items, or null when they are not shown (the queue entry is closed). */
  readonly lines?: React.ReactNode;
  readonly fetcher?: typeof fetch | undefined;
}) {
  // Orders v3 (Owner 2026-10-26): a table's serving progress is under each round, read with the
  // order (no "View serving progress" switch); the page's own refresh rereads it.
  const dining = order.orderType === "DineIn" && order.currentPhase !== "Cancelled";
  return (
    <>
      {dining ? (
        <DiningRoundsProvider
          orderReference={order.orderReference}
          csrf={csrf}
          refreshKey={order.observedAt + ":" + String(order.currentVersion)}
          locked={locked}
          onBusy={onBusy}
          onChanged={onChanged}
          fetcher={fetcher}
        >
          {lines}
        </DiningRoundsProvider>
      ) : (
        lines
      )}
      {order.counter?.paidOnCardMachine ? (
        // WP-2423 Q7 / item 4: refunds of a card-machine payment are made on that machine and
        // recorded here: in full by cancelling before the kitchen starts, or by item afterwards.
        // Orders v2 (Owner 2026-10-26): the how-to waits behind a question, not in the way.
        <details className="order-refund-howto">
          <summary>{t("How do refunds work?")}</summary>
          <p>
            {t(
              "Paid on the store's card machine. To refund it in full before the kitchen starts, cancel the order. To refund some items, a manager opens Payments and refunds, records the refund, makes it on the card machine and records it there.",
            )}
          </p>
        </details>
      ) : null}
      {/* DEC-DINE-IN-PAY-LATER: a table that paid once at the end, and cash given back. */}
      {order.orderType === "DineIn" ? (
        <TablePaymentPanel
          orderReference={order.orderReference}
          csrf={csrf}
          {...(fetcher ? { fetcher } : {})}
        />
      ) : null}
      {/* WP-2423 (v15 751dd768): offered only to people the server lets read payments. */}
      {order.canViewPayments ? (
        <OrderPaymentLinks orderReference={order.orderReference} csrf={csrf} fetcher={fetcher} />
      ) : null}
    </>
  );
}

/**
 * Orders v2 (Owner 2026-10-26): the header's one line — today's orders, how many wait to be
 * accepted, and earlier-day orders the list still shows — so the counts match the rows.
 */
export function ordersSummary(
  view: CurrentOrderQueue,
  today: string | null,
  awaiting: number,
): string {
  const waiting = awaiting > 0 ? t(" · {count} to accept", { count: awaiting }) : "";
  if (today === null)
    return (
      (view.items.length === 1
        ? t("1 order on this page")
        : t("{count} orders on this page", { count: view.items.length })) + waiting
    );
  // An earlier-day order still holding stock is listed with today's but is not one of them.
  const todays = view.items.filter(
    (order) => order.listedBusinessDate === today && order.heldStock === null,
  ).length;
  const earlier =
    filterCurrentOrderItems(view.items, {
      orderNumber: "",
      type: "All",
      channel: "All",
      phase: "All",
      day: "Today",
      today,
    }).length - todays;
  return (
    (todays === 1 ? t("1 order today") : t("{count} orders today", { count: todays })) +
    waiting +
    (earlier > 0 ? t(" · {count} from earlier days", { count: earlier }) : "")
  );
}

/**
 * Orders v2: what needs staff that the rows cannot show — an earlier-day order still holding its
 * ingredients, and orders paid during an outage. Acceptance deadlines stay in their rows.
 */
function OrderAttention({
  view,
  today,
  onOpen,
  onShowHeld,
}: {
  readonly view: CurrentOrderQueue;
  readonly today: string | null;
  readonly onOpen: (order: QueuedOrder) => void;
  readonly onShowHeld: () => void;
}) {
  const holding = view.items.filter((order) => order.heldStock !== null);
  const outage = view.items.some((order) => order.acceptanceHold !== null);
  if (holding.length === 0 && !outage) return null;
  return (
    <section className="order-attention" aria-labelledby="order-attention-heading">
      <h2 id="order-attention-heading">{t("Needs attention")}</h2>
      {holding.length === 0 ? null : (
        <ul>
          {holding.map((order) => (
            <li key={order.orderReference}>
              <div>
                <p>
                  {t("Order {orderNumber} isn't finished and still holds its ingredients.", {
                    orderNumber: orderLabel(order, today),
                  })}
                </p>
                <p className="order-attention__hint">
                  {order.heldStock?.state === "Ended"
                    ? t(
                        "It is finished, but its ingredients are still set aside. Release them from the order.",
                      )
                    : t(
                        "Make it and hand it over if the guest comes back; otherwise cancel it — the guest is refunded and the ingredients go back to stock.",
                      )}
                </p>
              </div>
              <button type="button" onClick={() => onOpen(order)}>
                {t("Show order {orderNumber}", { orderNumber: orderLabel(order, today) })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <AcceptanceHoldNotice view={view} onShow={onShowHeld} />
    </section>
  );
}

/** Orders v2: the sound toggle's speaker, crossed out while sound is off. */
function SoundIcon({ on }: { readonly on: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 8v4h3l4 3.5v-11L6 8H3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {on ? (
        <path
          d="M13 7.5a3.5 3.5 0 0 1 0 5M15 5.5a6.5 6.5 0 0 1 0 9"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M13.5 7.5l4 5M17.5 7.5l-4 5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function CurrentOrderQueuePage({
  storeLabel,
  csrf,
  timeZone,
  orderReference,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
  /** WP-2423 OPS-ORDER-DETAIL (/operations/orders/:id): only this Order, with its items. */
  readonly orderReference?: string | undefined;
  /** WP-2423: the Store's IANA time zone; order times are shown in it. */
  readonly timeZone?: string | undefined;
  /** WP-2423 P5: the transport for every read and command on this page (the local demo injects one). */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createCurrentOrderQueueClient(fetcher), [fetcher]);
  const operations = useRef(
    new Map<string, ReturnType<ReturnType<typeof createOrderAcceptanceClient>["prepare"]>>(),
  );
  const servingOrders = useRef(new Set<string>());
  const [servingBusy, setServingBusy] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [after, setAfter] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [orderNumberSearch, setOrderNumberSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [channelFilter, setChannelFilter] = useState("All");
  const [phaseFilter, setPhaseFilter] = useState("All");
  const [dayFilter, setDayFilter] = useState<"Today" | "All">("Today");
  const [now, setNow] = useState(() => Date.now());
  const [stale, setStale] = useState(false);
  /** Orders v2: when the list was last read without error (the header's "Updated 9:40"). */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const closeFilters = () => {
    setFiltersOpen(false);
    filterButton.current?.focus();
  };
  // The filter panel takes focus when it opens and closes on a tap outside it.
  useEffect(() => {
    if (!filtersOpen) return;
    filterPanel.current?.querySelector<HTMLElement>("button[aria-pressed]")?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (filterPanel.current?.contains(target) || filterButton.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [filtersOpen]);
  /** WP-2423 (2026-10-16 v15): the last held-stock release, confirmed until the page changes. */
  const [released, setReleased] = useState<string | null>(null);
  const businessDay = useStoreBusinessDay()?.businessDate ?? null;
  // Owner 2026-10-25: "Today" applies once the page has an order of the Store's business day;
  // before the first order of the day every loaded day stays in view.
  const today =
    businessDay !== null &&
    state.kind === "Ready" &&
    state.view.items.some((order) => order.listedBusinessDate === businessDay)
      ? businessDay
      : null;
  // A confirmation belongs to the page it was given on.
  useEffect(() => setReleased(null), [after]);
  // WP-2423: opened list orders and the refund totals read for them outlive a refresh.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const expanded = useMemo(() => ({ opened, setOpened }), [opened]);
  const [positions, setPositions] = useState<
    ReadonlyMap<string, CurrentOrderDetail["paymentPosition"]>
  >(new Map());
  const [linesRevision, setLinesRevision] = useState(0);
  const background = useRef<AbortController | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seenAwaiting = useRef<ReadonlySet<string> | null>(null);
  const urgentAlerted = useRef(new Set<string>());
  const toggleSound = () => {
    setSoundOn((value) => {
      const next = !value;
      if (next) {
        // Created inside the operator's tap so the browser allows it to play later.
        try {
          const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
          audio.current ??= Audio ? new Audio() : null;
          if (audio.current) playKitchenChime(audio.current);
        } catch {
          audio.current = null;
        }
      }
      return next;
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "Loading" });
    void (
      orderReference === undefined
        ? client.load(after, controller.signal).then((view) => ({ kind: "Ready" as const, view }))
        : client
            .loadDetail(orderReference, controller.signal)
            .then((detail) => ({ kind: "Ready" as const, view: detail.view, detail }))
    )
      .then((ready) => {
        if (controller.signal.aborted) return;
        setState(ready);
        setUpdatedAt(Date.now());
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: error instanceof CurrentOrderQueueError ? error.code : "Unavailable" });
      });
    return () => controller.abort();
  }, [after, refresh, orderReference]);
  // WP-2423 Q1: re-read in the background so new and expiring orders surface without a tap. An
  // in-flight serving command pauses it; a failed read keeps the last view and says so.
  const ready = state.kind === "Ready";
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!ready || !live) return;
    const tick = () => {
      setNow(Date.now());
      if (servingOrders.current.size > 0 || background.current !== null) return;
      const controller = new AbortController();
      background.current = controller;
      void readCurrentOrders(client, after, orderReference, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setStale(false);
          setUpdatedAt(Date.now());
          setState((previous) => refreshedOrderState(previous, next));
          // Opened orders reread their lines and refund totals with the list.
          setLinesRevision((value) => value + 1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setStale(true);
        })
        .finally(() => {
          if (background.current === controller) background.current = null;
        });
    };
    const timer = setInterval(tick, ORDER_REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      background.current?.abort();
      background.current = null;
    };
  }, [ready, live, after, orderReference, client]);
  // WP-2423 Q1: chime for orders that arrived since the previous read and once when an order
  // enters its last five minutes, when the operator turned sound on.
  useEffect(() => {
    if (state.kind !== "Ready") return;
    const awaiting = awaitingBatchReferences(state.view);
    const arrived =
      seenAwaiting.current === null
        ? []
        : [...awaiting].filter((reference) => !seenAwaiting.current?.has(reference));
    seenAwaiting.current = awaiting;
    const urgent = state.view.items.filter(
      (order) =>
        isAwaitingAcceptance(order) &&
        acceptanceWindow(order.acceptBy, now)?.tier === "urgent" &&
        !urgentAlerted.current.has(order.orderReference),
    );
    for (const order of urgent) urgentAlerted.current.add(order.orderReference);
    if (soundOn && (arrived.length > 0 || urgent.length > 0) && audio.current)
      playKitchenChime(audio.current);
  }, [state, now, soundOn]);
  const awaitingCount = state.kind === "Ready" ? ordersAwaitingAcceptance(state.view) : 0;
  // WP-2423 Q1: a background tab still shows how many orders wait for acceptance.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /u, "");
    document.title = awaitingCount > 0 ? `(${awaitingCount}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [awaitingCount]);
  useEffect(() => {
    if (state.kind !== "Loading" && restoreFocus.current) {
      restoreFocus.current = false;
      refreshButton.current?.focus();
    }
  }, [state]);
  const reload = (cursor: string | null) => {
    if (servingOrders.current.size > 0) return;
    restoreFocus.current = true;
    // WP-2423 Q6: a fresh read replaces the "could not be refreshed" notice from earlier polls.
    setStale(false);
    setState({ kind: "Loading" });
    setAfter(cursor);
    setRefresh((value) => value + 1);
  };
  /**
   * WP-2423: after an action on an order already shown (a recorded card-machine refund), reread
   * the page in place: the order stays open where it is, its lines and refund totals are reread,
   * and focus stays with staff instead of jumping to Refresh. A poll in flight read before the
   * action, so it is replaced. A failed reread keeps the view and says it could not be refreshed.
   */
  const refreshInPlace = () => {
    if (state.kind !== "Ready") return reload(after);
    background.current?.abort();
    const controller = new AbortController();
    background.current = controller;
    setLinesRevision((value) => value + 1);
    void readCurrentOrders(client, after, orderReference, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setStale(false);
        setUpdatedAt(Date.now());
        setState((previous) => refreshedOrderState(previous, next));
      })
      .catch(() => {
        if (!controller.signal.aborted) setStale(true);
      })
      .finally(() => {
        if (background.current === controller) background.current = null;
      });
  };
  const filteredOrders = useMemo(() => {
    if (state.kind !== "Ready") return [];
    return filterCurrentOrderItems(state.view.items, {
      orderNumber: orderNumberSearch,
      type: typeFilter,
      channel: channelFilter,
      phase: phaseFilter,
      day: dayFilter,
      today,
    });
  }, [channelFilter, orderNumberSearch, phaseFilter, state, typeFilter, dayFilter, today]);
  const visibleOrderReferences = useMemo(
    () => new Set(filteredOrders.map((order) => order.orderReference)),
    [filteredOrders],
  );
  const hasOrderFilters =
    orderNumberSearch !== "" ||
    typeFilter !== "All" ||
    channelFilter !== "All" ||
    phaseFilter !== "All" ||
    dayFilter !== "Today";
  const clearOrderFilters = () => {
    setOrderNumberSearch("");
    setTypeFilter("All");
    setChannelFilter("All");
    setPhaseFilter("All");
    setDayFilter("Today");
  };
  const single = orderReference !== undefined;
  const detail = state.kind === "Ready" ? state.detail : undefined;
  const acceptAction = (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => (
    <OrderAcceptanceAction
      key={batch.orderBatchReference}
      resumeUnknown={operations.current.has(batch.orderBatchReference)}
      csrf={csrf}
      orderNumber={
        batch.sequence === 1 ? order.orderNumber : order.orderNumber + " · round " + batch.sequence
      }
      operation={() => {
        let operation = operations.current.get(batch.orderBatchReference);
        if (!operation) {
          operation = createOrderAcceptanceClient(fetcher).prepare({
            acceptanceReference: serviceOperationReference(),
            operationReference: serviceOperationReference(),
            orderReference: order.orderReference,
            orderBatchReference: batch.orderBatchReference,
            expectedOrderVersion: order.currentVersion ?? 0,
          });
          operations.current.set(batch.orderBatchReference, operation);
        }
        return operation;
      }}
      onRejected={() => operations.current.delete(batch.orderBatchReference)}
      onChanged={() => reload(after)}
      onAccepted={() => {
        operations.current.delete(batch.orderBatchReference);
        reload(after);
      }}
    />
  );
  const segments = [
    ["All", t("All")],
    ["AwaitingAcceptance", t("To accept")],
    ["InProgress", t("In progress")],
    ["Ready", t("Ready")],
    ["Fulfilled", t("Picked up / served")],
  ] as const;
  const segmentPhase = segments.some(([phase]) => phase === phaseFilter);
  const filtersApplied =
    (typeFilter !== "All" ? 1 : 0) +
    (channelFilter !== "All" ? 1 : 0) +
    (today !== null && dayFilter !== "Today" ? 1 : 0) +
    (segmentPhase ? 0 : 1);
  const openOrder = (order: CurrentOrderQueue["items"][number]) =>
    setOpened(new Set([order.orderReference]));
  const chips = (
    legend: string,
    value: string,
    choose: (value: string) => void,
    options: readonly (readonly [string, string])[],
  ) => (
    <fieldset className="order-filter__group">
      <legend>{legend}</legend>
      <div className="order-filter__chips">
        {options.map(([option, label]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => choose(option)}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <WorkspacePage
      className="orders-page"
      title={
        single
          ? detail === undefined
            ? t("Order")
            : t("Order {orderNumber}", { orderNumber: orderLabel(detail.order, businessDay) })
          : t("Orders")
      }
      meta={
        single
          ? detail === undefined
            ? storeLabel
            : `${orderTypeLabel[detail.order.orderType]} · ${orderChannelLabel(orderChannel(detail.order))}`
          : state.kind === "Ready"
            ? ordersSummary(state.view, today, awaitingCount)
            : null
      }
      status={
        updatedAt === null ? null : (
          <span className="orders-page__updated">
            {t("Updated {time}", {
              time: storeTime(new Date(updatedAt).toISOString(), timeZone),
            })}
          </span>
        )
      }
      actions={
        <>
          {single ? <Link to="/operations/orders">{t("All orders")}</Link> : null}
          <button
            ref={refreshButton}
            type="button"
            className="orders-page__quiet"
            aria-label={single ? t("Refresh order") : t("Refresh orders")}
            onClick={() => reload(null)}
            disabled={state.kind === "Loading" || servingBusy}
          >
            {t("Refresh")}
          </button>
          <button
            type="button"
            aria-pressed={soundOn}
            className="order-sound-toggle"
            onClick={toggleSound}
          >
            <SoundIcon on={soundOn} />
            {soundOn ? t("Sound on") : t("Sound off")}
          </button>
        </>
      }
    >
      <>
        {state.kind === "Ready" ? (
          <CurrentOrderQueueRows
            single={single}
            view={state.view}
            timeZone={timeZone}
            now={now}
            paymentPosition={detail?.paymentPosition}
            paymentPositions={positions}
            expanded={expanded}
            visibleOrderReferences={visibleOrderReferences}
            before={
              <>
                {released !== null ? (
                  <p className="order-queue-released" role="status">
                    {released}
                  </p>
                ) : null}
                {stale ? (
                  <p className="order-queue-stale" role="status">
                    {t(
                      "Orders could not be refreshed. Showing the last update; retrying automatically.",
                    )}
                  </p>
                ) : null}
                {single ? null : (
                  <OrderAttention
                    view={state.view}
                    today={businessDay}
                    onOpen={openOrder}
                    onShowHeld={() => setPhaseFilter("OutageHeld")}
                  />
                )}
                {single ? null : (
                  <div className="order-toolbar">
                    {/* Figma v2: the statuses staff switch between most, with how many are here. */}
                    <div
                      className="order-status-filters"
                      role="group"
                      aria-label={t("Show orders")}
                    >
                      {segments.map(([phase, label]) => (
                        <button
                          key={phase}
                          type="button"
                          aria-pressed={phaseFilter === phase}
                          onClick={() => setPhaseFilter(phase)}
                        >
                          {label}
                          <span className="order-status-filters__count">
                            {
                              filterCurrentOrderItems(state.view.items, {
                                orderNumber: orderNumberSearch,
                                type: typeFilter,
                                channel: channelFilter,
                                phase,
                                day: dayFilter,
                                today,
                              }).length
                            }
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="order-toolbar__tools">
                      <div className="order-filter">
                        <button
                          ref={filterButton}
                          type="button"
                          className="order-filter__toggle"
                          aria-expanded={filtersOpen}
                          aria-controls="order-filter-panel"
                          onClick={() => setFiltersOpen((value) => !value)}
                        >
                          {t("Filter")}
                          {filtersApplied === 0 ? null : (
                            <span className="order-filter__applied">{filtersApplied}</span>
                          )}
                        </button>
                        {filtersOpen ? (
                          <div
                            id="order-filter-panel"
                            ref={filterPanel}
                            className="order-filter__panel"
                            role="dialog"
                            aria-label={t("Filter orders on this page")}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return;
                              event.stopPropagation();
                              closeFilters();
                            }}
                          >
                            <div className="order-filter__head">
                              <h2>{t("Filter")}</h2>
                              <button
                                type="button"
                                className="order-panel__close"
                                onClick={closeFilters}
                              >
                                <span aria-hidden="true">×</span>
                                <span className="visually-hidden">{t("Close filters")}</span>
                              </button>
                            </div>
                            {today === null
                              ? null
                              : chips(
                                  t("Date"),
                                  dayFilter,
                                  (value) => setDayFilter(value === "All" ? "All" : "Today"),
                                  [
                                    ["Today", t("Today")],
                                    ["All", t("All days")],
                                  ],
                                )}
                            {chips(t("Order type"), typeFilter, setTypeFilter, [
                              ["All", t("All types")],
                              ["DineIn", t("Dine-in")],
                              ["Pickup", t("Pickup")],
                            ])}
                            {chips(t("Channel"), channelFilter, setChannelFilter, [
                              ["All", t("All channels")],
                              ...orderChannelFilterOptions.map(
                                (option) => [option.value, option.label] as const,
                              ),
                            ])}
                            {chips(t("Order status"), phaseFilter, setPhaseFilter, [
                              ["All", t("All statuses")],
                              ["Submitted", t("Submitted")],
                              ["Accepted", t("Accepted")],
                              ["Rejected", t("Rejected")],
                              ["Cancelled", t("Cancelled")],
                              ["OutageHeld", t("Paid during an outage — decide")],
                              ["Expired", t("Expired · refunded")],
                              ["AwaitingPayment", t("Awaiting payment")],
                              ["NotCollected", t("Not collected")],
                            ])}
                            <p className="order-filter__scope">
                              {t("Filters look only at the orders loaded on this page.")}
                            </p>
                            <div className="order-filter__actions">
                              <button
                                type="button"
                                onClick={clearOrderFilters}
                                disabled={!hasOrderFilters}
                              >
                                {t("Clear filters")}
                              </button>
                              <button
                                type="button"
                                className="order-filter__show"
                                onClick={closeFilters}
                              >
                                {filteredOrders.length === 1
                                  ? t("Show 1 order")
                                  : t("Show {count} orders", { count: filteredOrders.length })}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <input
                        className="order-toolbar__search"
                        type="search"
                        aria-label={t("Exact order number")}
                        placeholder={t("Search order number")}
                        value={orderNumberSearch}
                        maxLength={40}
                        autoComplete="off"
                        onChange={(event) => setOrderNumberSearch(event.target.value)}
                      />
                    </div>
                  </div>
                )}
                {!single && state.view.items.length > 0 && filteredOrders.length === 0 ? (
                  <StatePanel heading={t("No orders match these filters")} status>
                    <p>
                      {t(
                        "Filters look only at the orders loaded on this page. Clear the filters, or look for older orders on the next page.",
                      )}
                    </p>
                  </StatePanel>
                ) : null}
              </>
            }
            after={(() => {
              if (single) return null;
              // Orders v2 (Owner 2026-10-26): the count and the pager speak only where they add
              // something — history (all days, an older page), a filtered view, or a busy day whose
              // earlier orders run onto the next page. Today's view that fits says nothing.
              const history = today === null || dayFilter === "All" || after !== null;
              const last = state.view.items[state.view.items.length - 1];
              const todaySpills =
                !history &&
                state.view.nextAfterOrderReference !== null &&
                last?.listedBusinessDate === today;
              const pager = (history || todaySpills) && state.view.nextAfterOrderReference !== null;
              if (!history && !todaySpills && !hasOrderFilters) return null;
              return (
                <div className="order-paging">
                  <p className="order-queue-filter-count" aria-live="polite">
                    {todaySpills && !hasOrderFilters
                      ? t("Today's earlier orders are on the next page.")
                      : orderCountText({
                          shown: filteredOrders.length,
                          total: state.view.items.length,
                          filtered: hasOrderFilters,
                          olderPage: after !== null,
                          morePages: state.view.nextAfterOrderReference !== null,
                        })}
                  </p>
                  {hasOrderFilters ? (
                    <button type="button" onClick={clearOrderFilters}>
                      {t("Clear order filters")}
                    </button>
                  ) : null}
                  {after !== null ? (
                    <button type="button" onClick={() => reload(null)} disabled={servingBusy}>
                      {t("First page")}
                    </button>
                  ) : null}
                  {pager ? (
                    <button
                      type="button"
                      disabled={servingBusy}
                      onClick={() => reload(state.view.nextAfterOrderReference)}
                    >
                      {t("Next page")}
                    </button>
                  ) : null}
                </div>
              );
            })()}
            detail={(order, open, roundHead) => (
              <CurrentOrderDetails
                fetcher={fetcher}
                lines={
                  detail !== undefined ? (
                    <>
                      <PickupContactPanel contact={detail.pickupContact} timeZone={timeZone} />
                      <OnlineRefundNote order={detail.order} position={detail.paymentPosition} />
                      <CurrentOrderLines
                        lines={detail.lines}
                        cancelledBatches={storeCancelledBatches(detail.view)}
                        unpaidCancelledBatches={unpaidCancelledBatches(detail.view)}
                        failedPaymentBatches={failedPaymentBatches(detail.view)}
                        removedItems={removedUnpaidItems(detail.view)}
                        refundRows={orderRefundRows(
                          detail.order,
                          detail.lines,
                          detail.paymentPosition,
                        )}
                        rounds={
                          detail.order.orderType === "DineIn"
                            ? {
                                batches: detail.order.batches,
                                head: roundHead,
                                timeZone,
                                today: businessDay,
                              }
                            : undefined
                        }
                        refundCheck={{
                          orderReference: order.orderReference,
                          csrf,
                          fetcher,
                          onChecked: () => reload(after),
                        }}
                      />
                    </>
                  ) : open ? (
                    <>
                      <QueuedOrderLines
                        orderReference={order.orderReference}
                        client={client}
                        revision={linesRevision}
                        roundHead={roundHead}
                        timeZone={timeZone}
                        today={businessDay}
                        batches={order.batches}
                        onDetail={(read) =>
                          setPositions((current) =>
                            current.get(order.orderReference) === read.paymentPosition
                              ? current
                              : new Map(current).set(order.orderReference, read.paymentPosition),
                          )
                        }
                        refundCheck={{
                          orderReference: order.orderReference,
                          csrf,
                          fetcher,
                          onChecked: () => reload(after),
                        }}
                      />
                      <Link
                        className="order-panel__page-link"
                        to={`/operations/orders/${order.orderReference}`}
                      >
                        {t("Open full page")}
                      </Link>
                    </>
                  ) : null
                }
                order={order}
                csrf={csrf}
                locked={servingBusy}
                onChanged={refreshInPlace}
                onBusy={(busy) => {
                  if (busy) servingOrders.current.add(order.orderReference);
                  else servingOrders.current.delete(order.orderReference);
                  setServingBusy(servingOrders.current.size > 0);
                }}
              />
            )}
            rowAction={
              single
                ? undefined
                : (order) => {
                    const batches = order.batches.filter((batch) =>
                      acceptsInRow(order, batch, now ?? Date.now()),
                    );
                    if (batches.length > 0)
                      return (
                        <fieldset disabled={servingBusy}>
                          {batches.map((batch) => acceptAction(order, batch))}
                        </fieldset>
                      );
                    // Orders v2: a counter order to charge opens the order, where the payment is
                    // recorded with its amount.
                    if (
                      order.canRecordCardMachinePayment &&
                      counterAwaitingCardMachine(order, now ?? Date.now())
                    )
                      return (
                        <button
                          type="button"
                          className="order-next-fill"
                          onClick={() => openOrder(order)}
                        >
                          {t("Charge")}
                        </button>
                      );
                    // Orders v2: an accepted pickup is handed over on Pickup (the code is checked there).
                    return handoverReady(order, now ?? Date.now()) ? (
                      <HandoverLink order={order} className="order-next-text" />
                    ) : null;
                  }
            }
            action={(order, batch) => (
              <>
                {
                  // WP-2423 (2026-10-16): an ended earlier-day Order still holding stock.
                  order.heldStock !== null &&
                  order.heldStock.state === "Ended" &&
                  !order.heldStock.productionStarted &&
                  order.heldStock.orderBatchReference === batch.orderBatchReference ? (
                    <fieldset disabled={servingBusy}>
                      <HeldStockReleaseAction
                        key={"held-" + batch.orderBatchReference}
                        order={order}
                        csrf={csrf}
                        fetcher={fetcher}
                        onSettled={(outcome) => {
                          // WP-2423 (2026-10-16 v15): confirm the release; the reread then drops
                          // the order from "still holding stock".
                          if (outcome === "Released")
                            setReleased(
                              heldStockReleasedText(
                                order,
                                order.businessDate === null
                                  ? null
                                  : businessDateLabel(order.businessDate, businessDay),
                              ),
                            );
                          reload(after);
                        }}
                      />
                    </fieldset>
                  ) : // WP-2423 (v15 751dd768): a sent counter order not paid yet is charged and
                  // recorded here too (the counter page may have been reloaded or closed).
                  batch.sequence === 1 &&
                    order.canRecordCardMachinePayment &&
                    counterAwaitingCardMachine(order, now ?? Date.now()) ? (
                    <fieldset disabled={servingBusy}>
                      <StaffRoundPaymentAction
                        key={"counter-pay-" + batch.orderBatchReference}
                        subject="order"
                        label={t("Charge on card machine")}
                        csrf={csrf}
                        fetcher={fetcher}
                        orderReference={order.orderReference}
                        orderBatchReference={batch.orderBatchReference}
                        amountDueMinor={order.counter?.amountDueMinor ?? null}
                        payBy={order.counter?.payBy ?? null}
                        loadAmountDue={(signal) =>
                          client
                            .loadDetail(order.orderReference, signal)
                            .then((detail) => detail.order.counter?.amountDueMinor ?? null)
                        }
                        recordedAfterOutage={order.counter?.recordedAfterOutage ?? false}
                        timeZone={timeZone}
                        onRecorded={() => reload(after)}
                      />
                    </fieldset>
                  ) : // WP-2423 D5: an unpaid round staff entered is recorded as paid here too. The list
                  // leaves its amount out (the one-order read builds it when the form is opened).
                  order.canRecordCardMachinePayment &&
                    batch.staffRound != null &&
                    batch.staffRound.paidOnCardMachine === null &&
                    batch.acceptanceStatus === "NotAccepted" &&
                    batch.paymentDue !== null &&
                    batch.paymentDue.status === "Awaiting" &&
                    (batch.paymentDue.cancelsAt === null ||
                      Date.parse(batch.paymentDue.cancelsAt) > Date.now()) ? (
                    <fieldset disabled={servingBusy}>
                      <StaffRoundPaymentAction
                        key={"round-pay-" + batch.orderBatchReference}
                        csrf={csrf}
                        fetcher={fetcher}
                        orderReference={order.orderReference}
                        orderBatchReference={batch.orderBatchReference}
                        amountDueMinor={batch.staffRound.amountDueMinor}
                        loadAmountDue={(signal) =>
                          client
                            .loadDetail(order.orderReference, signal)
                            .then(
                              (detail) =>
                                detail.order.batches.find(
                                  (entry) =>
                                    entry.orderBatchReference === batch.orderBatchReference,
                                )?.staffRound?.amountDueMinor ?? null,
                            )
                        }
                        recordedAfterOutage={batch.staffRound.recordedAfterOutage}
                        timeZone={timeZone}
                        onRecorded={() => reload(after)}
                      />
                    </fieldset>
                  ) : (batch.staffCancellation?.refundMethod === "CardMachine" &&
                      batch.staffCancellation.refundStatus === "Pending") ||
                    (batch.sequence === 1 && cardMachineOwed(order) !== null) ? (
                    <fieldset disabled={servingBusy}>
                      <CardMachineRefundAction
                        key={"card-refund-" + batch.orderBatchReference}
                        order={order}
                        batch={batch}
                        owedMinor={cardMachineOwed(order)}
                        csrf={csrf}
                        fetcher={fetcher}
                        onSettled={refreshInPlace}
                      />
                    </fieldset>
                  ) : batch.unpaidRemovableItems.length > 0 ? (
                    // DEC-DINE-IN-PAY-LATER (rule 2): dishes come off an unpaid table's bill.
                    <fieldset disabled={servingBusy} className="order-cancel-actions">
                      {detail !== undefined ? (
                        <PayLaterItemRemoveAction
                          key={"remove-" + batch.orderBatchReference}
                          order={order}
                          batch={batch}
                          lines={detail.lines.items}
                          csrf={csrf}
                          fetcher={fetcher}
                          onSettled={() => reload(after)}
                        />
                      ) : (
                        <Link
                          className="order-cancel-items-link"
                          to={`/operations/orders/${order.orderReference}`}
                        >
                          {t("Take dishes off the bill")}
                        </Link>
                      )}
                    </fieldset>
                  ) : batch.canCancel || batch.canCancelItems ? (
                    <fieldset disabled={servingBusy} className="order-cancel-actions">
                      {batch.canCancel ? (
                        <StaffOrderCancelAction
                          key={batch.orderBatchReference}
                          order={order}
                          batch={batch}
                          csrf={csrf}
                          fetcher={fetcher}
                          onSettled={() => reload(after)}
                        />
                      ) : null}
                      {/* WP-2423 Q6 step 2: items are chosen from the order's lines (order detail). */}
                      {!batch.canCancelItems ? null : detail !== undefined ? (
                        <StaffItemCancelAction
                          key={"items-" + batch.orderBatchReference}
                          order={order}
                          batch={batch}
                          lines={detail.lines.items}
                          csrf={csrf}
                          fetcher={fetcher}
                          onSettled={() => reload(after)}
                        />
                      ) : (
                        <Link
                          className="order-cancel-items-link"
                          to={`/operations/orders/${order.orderReference}`}
                        >
                          {t("Cancel items")}
                        </Link>
                      )}
                    </fieldset>
                  ) : batch.canRequestAcceptance ? (
                    <fieldset disabled={servingBusy}>
                      {order.acceptanceHold !== null &&
                      order.acceptanceHold.orderBatchReference === batch.orderBatchReference ? (
                        // WP-2423 Q9-G1: paid during an outage — accept or refund.
                        <AcceptanceHoldDecision
                          order={order}
                          hold={order.acceptanceHold}
                          csrf={csrf}
                          timeZone={timeZone}
                          fetcher={fetcher}
                          onSettled={() => reload(after)}
                          accept={
                            <OrderAcceptanceAction
                              key={batch.orderBatchReference}
                              resumeUnknown={operations.current.has(batch.orderBatchReference)}
                              csrf={csrf}
                              orderNumber={
                                batch.sequence === 1
                                  ? order.orderNumber
                                  : order.orderNumber + " · round " + batch.sequence
                              }
                              operation={() => {
                                let operation = operations.current.get(batch.orderBatchReference);
                                if (!operation) {
                                  operation = createOrderAcceptanceClient(fetcher).prepare({
                                    acceptanceReference: serviceOperationReference(),
                                    operationReference: serviceOperationReference(),
                                    orderReference: order.orderReference,
                                    orderBatchReference: batch.orderBatchReference,
                                    expectedOrderVersion: order.currentVersion ?? 0,
                                  });
                                  operations.current.set(batch.orderBatchReference, operation);
                                }
                                return operation;
                              }}
                              onRejected={() =>
                                operations.current.delete(batch.orderBatchReference)
                              }
                              onChanged={() => reload(after)}
                              onAccepted={() => {
                                operations.current.delete(batch.orderBatchReference);
                                reload(after);
                              }}
                            />
                          }
                        />
                      ) : (
                        acceptAction(order, batch)
                      )}
                    </fieldset>
                  ) : null
                }
                {/* WP-2423 abandoned payment: a manager cancels a round nobody paid for. */}
                {batch.canCancelUnpaid ? (
                  <fieldset disabled={servingBusy}>
                    <UnpaidRoundCancelAction
                      key={"unpaid-" + batch.orderBatchReference}
                      orderReference={order.orderReference}
                      orderBatchReference={batch.orderBatchReference}
                      roundNumber={batch.sequence}
                      orderLabel={"order " + order.orderNumber}
                      csrf={csrf}
                      fetcher={fetcher}
                      paymentUnconfirmed={
                        batch.staffRound == null &&
                        batch.paymentDue?.status === "Awaiting" &&
                        isPaymentUnconfirmed(batch.paymentDue.cancelsAt, now)
                      }
                      onSettled={() => reload(after)}
                    />
                  </fieldset>
                ) : null}
              </>
            )}
          />
        ) : (
          <StatePanel
            heading={
              state.kind === "Loading"
                ? single
                  ? t("Loading order")
                  : t("Loading orders")
                : state.kind === "PermissionDenied"
                  ? t("Permission denied")
                  : state.kind === "NotFound"
                    ? t("Order not found")
                    : single
                      ? t("Order unavailable")
                      : t("Orders unavailable")
            }
            status
          >
            <p>
              {state.kind === "Loading"
                ? single
                  ? t("Reading the order…")
                  : t("Reading current orders…")
                : state.kind === "PermissionDenied"
                  ? t("Your current session or Store permissions do not allow this queue.")
                  : state.kind === "NotFound"
                    ? t("This order is not at the selected Store.")
                    : t("Orders could not be refreshed. Check your connection and try again.")}
            </p>
          </StatePanel>
        )}
      </>
    </WorkspacePage>
  );
}

const orderRoute = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** WP-2423 OPS-ORDER-DETAIL at /operations/orders/:id. */
export function CurrentOrderDetailRoute(props: {
  readonly storeLabel: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const id = useParams().id;
  return id === undefined || !orderRoute.test(id) ? (
    <WorkspacePage title={t("Order")} meta={props.storeLabel}>
      <StatePanel heading={t("Order not found")} status>
        <p>{t("This order link is not valid.")}</p>
        <Link to="/operations/orders">{t("All orders")}</Link>
      </StatePanel>
    </WorkspacePage>
  ) : (
    <CurrentOrderQueuePage key={id} {...props} orderReference={id} />
  );
}
