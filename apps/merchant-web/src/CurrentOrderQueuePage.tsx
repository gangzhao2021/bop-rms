import {
  AcceptanceHoldDecision,
  AcceptanceHoldNotice,
  acceptanceHoldText,
  acceptanceHoldTier,
} from "./AcceptanceHoldActions.js";
import { OrderPaymentLinks } from "./RefundPaymentPage.js";
import { DiningOrderProgress } from "./DiningOrderProgress.js";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import {
  StaffOrderCancelAction,
  staffCancellationReasonLabel,
  staffCancellationSummary,
} from "./StaffOrderCancelAction.js";
import {
  ItemRefundCheck,
  StaffItemCancelAction,
  itemCancellationStatus,
} from "./StaffItemCancelAction.js";
import { orderMoney } from "./order-money.js";
export { orderMoney } from "./order-money.js";
import { CardMachineRefundAction } from "./CardMachineRefundAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { StatePanel } from "@bop-rms/ui";
import { playKitchenChime } from "./alert-chime.js";
import { storeTime } from "./StoreTime.js";
import { businessDateLabel, openedEarlierText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { WorkspacePage } from "./WorkspacePage.js";
export { storeTime } from "./StoreTime.js";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";
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
}
export function filterCurrentOrderItems(
  items: CurrentOrderQueue["items"],
  filters: CurrentOrderFilters,
) {
  const orderNumber = filters.orderNumber.trim().toLocaleLowerCase();
  return items.filter(
    (order) =>
      (!orderNumber || order.orderNumber.toLocaleLowerCase() === orderNumber) &&
      (filters.type === "All" || order.orderType === filters.type) &&
      (filters.channel === "All" || orderChannel(order) === filters.channel) &&
      (filters.phase === "All" ||
        (filters.phase === "OutageHeld"
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
                  (order.currentPhase ?? "Unavailable") === filters.phase)),
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
/** WP-2423 OPS-ORDER-DETAIL: what was ordered — items with options and notes, and the totals. */
export function CurrentOrderLines({
  lines,
  refundCheck,
  cancelledBatches,
  unpaidCancelledBatches,
  failedPaymentBatches,
}: {
  readonly lines: CurrentOrderDetail["lines"];
  readonly refundCheck?: ItemRefundCheckContext | undefined;
  /** WP-2423 Q6: batches the store cancelled as a whole; their remaining lines read as cancelled. */
  readonly cancelledBatches?: ReadonlySet<string> | undefined;
  /** WP-2423: rounds cancelled automatically because their payment failed; never owed. */
  readonly unpaidCancelledBatches?: ReadonlySet<string> | undefined;
  /** WP-2423: rounds whose payment failed and that are about to be cancelled automatically. */
  readonly failedPaymentBatches?: ReadonlySet<string> | undefined;
}) {
  const t = lines.totals;
  const cancelledRefund = cancelledItemsRefund(lines.items);
  const unpaid = unpaidCancelledTotal(lines, unpaidCancelledBatches);
  const unpaidLine = (item: CurrentOrderDetail["lines"]["items"][number]) =>
    item.cancellation === null && unpaidCancelledBatches?.has(item.orderBatchReference) === true;
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
  return (
    <section className="order-lines" aria-label="Items ordered">
      <h3>Items</h3>
      <ul>
        {lines.items.map((item) => (
          <li
            key={item.orderItemReference}
            className={
              item.cancellation === null &&
              !cancelledBatches?.has(item.orderBatchReference) &&
              !unpaidLine(item)
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
                <span className="order-line-note">Note: {item.customerNote}</span>
              ) : null}
              {item.cancellation === null && cancelledBatches?.has(item.orderBatchReference) ? (
                <span className="order-line-cancellation">
                  <strong>Cancelled by store</strong>
                </span>
              ) : unpaidLine(item) ? (
                <span className="order-line-cancellation">
                  <strong>Cancelled · not paid</strong>
                </span>
              ) : item.cancellation === null &&
                failedPaymentBatches?.has(item.orderBatchReference) === true ? (
                <span className="order-line-cancellation">
                  <strong>Payment failed · don't prepare</strong>
                </span>
              ) : null}
              {item.cancellation !== null ? (
                <span className="order-line-cancellation">
                  <strong>{itemCancellationStatus(item.cancellation)}</strong>
                  <span>Reason: {staffCancellationReasonLabel[item.cancellation.reasonCode]}</span>
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
          </li>
        ))}
      </ul>
      <dl className="order-lines-totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{orderMoney(t.subtotal)}</dd>
        </div>
        {t.discount.amountMinor !== "0" ? (
          <div>
            <dt>Discount</dt>
            <dd>{orderMoney(t.discount)}</dd>
          </div>
        ) : null}
        {t.fee.amountMinor !== "0" ? (
          <div>
            <dt>Fees</dt>
            <dd>{orderMoney(t.fee)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Tax</dt>
          <dd>{orderMoney(t.tax)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{orderMoney(t.total)}</dd>
        </div>
      </dl>
      {unpaid !== null ? (
        <dl className="order-lines-totals order-lines-cancelled-refund">
          <div>
            <dt>Cancelled unpaid rounds</dt>
            <dd>−{orderMoney(unpaid.cancelled)}</dd>
          </div>
          <div>
            <dt>Total after cancelled rounds</dt>
            <dd>{orderMoney(unpaid.remaining)}</dd>
          </div>
        </dl>
      ) : null}
      {cancelledRefund !== null ? (
        <dl className="order-lines-totals order-lines-cancelled-refund">
          <div>
            <dt>Cancelled items refund</dt>
            <dd>−{orderMoney(cancelledRefund)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
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
      amountMinor: (BigInt(lines.totals.total.amountMinor) - amount).toString(),
      currencyCode,
    }),
  });
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
    "Paid on card machine " +
    money(paid) +
    (refunded >= paid
      ? " · refunded in full"
      : refunded > 0n
        ? ` · ${money(refunded)} refunded`
        : "") +
    (toRefund > 0n && refunded < paid ? ` · ${money(toRefund)} to refund on the card machine` : "")
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
  const base = "Paid online " + orderMoney(paid);
  if (position !== undefined && position !== null) {
    const refunded = BigInt(position.refundedMinor),
      pending = BigInt(position.refundPendingMinor);
    if (pending > 0n)
      return (
        base + (refunded > 0n ? " · partly refunded, refund in progress" : " · refund in progress")
      );
    if (refunded >= BigInt(paid.amountMinor)) return base + " · refunded in full";
    return refunded > 0n ? base + " · partly refunded" : base;
  }
  if (order.unfulfillable !== null) return base + " · refunded in full";
  const cancelled = order.batches.filter(
    (batch) =>
      batch.staffCancellation !== null && batch.staffCancellation.refundMethod === "Online",
  );
  if (cancelled.length === 0) return base;
  if (cancelled.some((batch) => batch.staffCancellation?.refundStatus === "Pending"))
    return base + " · refund in progress";
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
    (cancelled.length >= paidOnlineBatches.length ? " · refunded in full" : " · partly refunded")
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
      {refunded > 0n ? `Refunded ${amount(refunded)} of the online payment.` : ""}
      {refunded > 0n && pending > 0n ? " " : ""}
      {pending > 0n ? `A refund of ${amount(pending)} is on its way to the customer.` : ""}
    </p>
  );
}
/**
 * WP-2423: an order's current status in staff words. Dine-in is Fulfilled once every item not
 * cancelled was served at the table (Dining's served records over the kitchen's Ready), which
 * staff read as "Served"; a pickup order handed over reads "Picked up".
 */
export function orderPhaseLabel(
  order: Pick<CurrentOrderQueue["items"][number], "currentPhase" | "orderType">,
): string {
  switch (order.currentPhase) {
    case null:
      return "Status not loaded · refresh";
    case "InProgress":
      return "In progress";
    case "Fulfilled":
      return order.orderType === "DineIn" ? "Served" : "Picked up";
    default:
      return order.currentPhase;
  }
}
/**
 * WP-2423: the channel an order is listed and filtered under. A table's Order takes the channel of
 * its first round: when staff entered that round for the table it is "Staff" (taken by staff),
 * not the guests' QR code. Later rounds keep their own "Entered by staff" marker on the order.
 */
export function orderChannel(
  order: Pick<CurrentOrderQueue["items"][number], "orderType" | "sourceChannel" | "batches">,
): string {
  return order.orderType === "DineIn" &&
    order.batches.find((batch) => batch.sequence === 1)?.staffRound != null
    ? "Staff"
    : order.sourceChannel;
}
/** Staff-facing words for an order's type and the channel it came in through (never codes). */
export const orderTypeLabel = { DineIn: "Dine-in", Pickup: "Pickup" } as const;
export function orderChannelLabel(channel: string): string {
  return channel === "Staff"
    ? "Taken by staff"
    : channel === "Qr"
      ? "QR code"
      : channel === "Web"
        ? "Website"
        : channel === "Pos"
          ? "Counter"
          : channel === "Api"
            ? "Partner integration"
            : "Other";
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
    return staffRound ? "Entered by staff · awaiting card-machine payment" : "Awaiting payment";
  const passed = now !== undefined && Date.parse(due.cancelsAt) <= now;
  const at = storeTime(due.cancelsAt, timeZone);
  if (due.status === "Failed")
    return passed
      ? "Payment failed · being cancelled automatically"
      : `Payment failed · will be cancelled automatically at ${at}`;
  if (passed) return "Not paid in time · being cancelled automatically";
  const left =
    now === undefined ? null : Math.max(1, Math.ceil((Date.parse(due.cancelsAt) - now) / 60_000));
  const soon = left !== null && left <= unpaidRoundUrgentMinutes ? ` (${left} min left)` : "";
  return staffRound
    ? `Entered by staff · record the card-machine payment by ${at}${soon} or it is cancelled`
    : `Not paid · cancelled automatically at ${at}${soon} unless paid`;
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
    <section className="order-pickup-contact" aria-label="Pickup customer">
      {contact.status === "Available" ? (
        <p>
          <span>Pickup for {contact.name}</span>
          {" · "}
          {contact.channel === "Phone" ? (
            <a href={`tel:${contact.value}`}>Call {formatContactPhone(contact.value)}</a>
          ) : (
            <a href={`mailto:${contact.value}`}>Email {contact.value}</a>
          )}
        </p>
      ) : contact.status === "Removed" ? (
        <p>
          The customer&apos;s contact was removed on{" "}
          {new Date(contact.removedAt).toLocaleDateString("en-CA", {
            ...(timeZone ? { timeZone } : {}),
            dateStyle: "medium",
          })}{" "}
          (contacts are kept only for a limited time).
        </p>
      ) : (
        <p>No contact was given. Call out the order number at the counter.</p>
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
}: {
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
      />
    </>
  ) : (
    <p className="order-lines-state" role="status">
      {state.kind === "Loading"
        ? "Reading items…"
        : "Items could not be read. Open the order to retry."}
    </p>
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
        ? "Acceptance window ended · refund pending"
        : `Accept within ${window.minutes} min`}
    </span>
  );
}

const unfulfillableText = {
  CapacityExpired: "Not accepted before its preparation slot expired.",
  SubmissionCancelled: "The submission was cancelled after payment.",
  OrderNoLongerFulfillable: "The order could no longer be fulfilled after payment.",
} as const;

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
}: {
  readonly view: CurrentOrderQueue;
  /** WP-2423: Payment's refund position of the one Order shown (the order detail page). */
  readonly paymentPosition?: CurrentOrderDetail["paymentPosition"] | undefined;
  /** WP-2423: on the list, the refund positions of the orders whose detail was read (opened). */
  readonly paymentPositions?: ReadonlyMap<string, CurrentOrderDetail["paymentPosition"]>;
  /**
   * WP-2423: the orders staff opened, kept by the page so a refresh after an action (a recorded
   * card-machine refund) never collapses them. Omitted: the rows keep it themselves.
   */
  readonly expanded?: ExpandedOrders | undefined;
  /** WP-2423 Q1: the clock acceptance deadlines are shown against (omitted: not shown). */
  readonly now?: number | undefined;
  readonly timeZone?: string | undefined;
  readonly visibleOrderReferences?: ReadonlySet<string>;
  readonly detail?: (order: CurrentOrderQueue["items"][number], open: boolean) => React.ReactNode;
  /** OPS-ORDER-DETAIL: one Order, no page count. */
  readonly single?: boolean;
  readonly action?: (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => React.ReactNode;
}) {
  const [ownOpened, setOwnOpened] = useState<ReadonlySet<string>>(new Set());
  const opened = expanded?.opened ?? ownOpened;
  const setOpened = expanded?.setOpened ?? setOwnOpened;
  // Orders opened only because they are the one match (search, filter): they close again when the
  // filter changes; only orders staff opened themselves stay open across a refresh.
  const autoOpened = useRef(new Set<string>());
  const autoOpen = view.items.length === 1 || visibleOrderReferences?.size === 1;
  // WP-2423: the list row reads the order's refund position with the list (orders with a refund),
  // the same position the detail reads; an opened order's detail read fills in the rest.
  const positionOf = (order: CurrentOrderQueue["items"][number]) =>
    single
      ? (paymentPosition ?? order.paymentPosition ?? undefined)
      : (order.paymentPosition ?? paymentPositions?.get(order.orderReference));
  // WP-2423 Q21: orders are grouped by the Store business day they belong to (order numbers restart
  // each business day; an order after midnight before the day's start belongs to the day before).
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const dayHeadings = new Map<string, string>();
  if (!single) {
    let previous: string | null = null;
    for (const order of view.items) {
      // WP-2423 D4: an older table's Order with a round today is listed under today.
      const listed = order.listedBusinessDate;
      if (
        listed === null ||
        (visibleOrderReferences !== undefined && !visibleOrderReferences.has(order.orderReference))
      )
        continue;
      if (listed !== previous)
        dayHeadings.set(order.orderReference, businessDateLabel(listed, today));
      previous = listed;
    }
  }
  return view.items.length === 0 ? (
    <StatePanel heading="No orders on this page" status>
      <p>No orders were returned for this page.</p>
    </StatePanel>
  ) : (
    <div className="order-workbench" aria-label="Current orders">
      <p className="order-workbench-count" hidden={single}>
        {visibleOrderReferences?.size ?? view.items.length} matching orders on this page
      </p>
      {view.items.map((order) => (
        <Fragment key={order.orderReference}>
          {dayHeadings.has(order.orderReference) ? (
            <h2 className="order-workbench-day">{dayHeadings.get(order.orderReference)}</h2>
          ) : null}
          <details
            className="order-workbench-entry"
            hidden={
              visibleOrderReferences !== undefined &&
              !visibleOrderReferences.has(order.orderReference)
            }
            open={
              autoOpen ||
              (opened.has(order.orderReference) && !autoOpened.current.has(order.orderReference))
            }
            onToggle={(event) => {
              const open = event.currentTarget.open;
              if (!open) autoOpened.current.delete(order.orderReference);
              else if (autoOpen && !opened.has(order.orderReference))
                autoOpened.current.add(order.orderReference);
              setOpened((current) => {
                if (open === current.has(order.orderReference)) return current;
                const next = new Set(current);
                if (open) next.add(order.orderReference);
                else next.delete(order.orderReference);
                return next;
              });
            }}
          >
            <summary>
              <span className="order-workbench-identity">
                <h2>
                  {order.orderNumber}{" "}
                  <span className="order-workbench-disclosure" aria-hidden="true">
                    ⌄
                  </span>
                </h2>
                <span>
                  {orderTypeLabel[order.orderType]} · {orderChannelLabel(orderChannel(order))}
                </span>
              </span>
              <span
                className="order-workbench-phase"
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
                    ? "Awaiting card-machine payment"
                    : "Awaiting payment"
                  : order.pickupNotCollected
                    ? "Not collected"
                    : order.unfulfillable !== null
                      ? cardMachineOwed(order) !== null
                        ? "Expired · refund on card machine"
                        : "Expired · refunded"
                      : orderPhaseLabel(order)}
              </span>
              <span className="order-workbench-batches">
                {
                  order.batches.filter(
                    (batch) => batch.acceptanceStatus === "Accepted" && !batch.staffCancellation,
                  ).length
                }{" "}
                accepted ·{" "}
                {order.batches.filter((batch) => batch.acceptanceStatus === "NotAccepted").length}{" "}
                not accepted
                {/* WP-2423 Q6: a batch the store cancelled after accepting counts as cancelled. */}
                {order.batches.some(
                  (batch) => batch.acceptanceStatus === "Cancelled" || batch.staffCancellation,
                )
                  ? ` · ${
                      order.batches.filter(
                        (batch) =>
                          batch.acceptanceStatus === "Cancelled" || batch.staffCancellation,
                      ).length
                    } cancelled`
                  : ""}
                {order.orderType === "Pickup" && order.batches[0]?.staffCancellation ? (
                  <span className="order-staff-cancelled">
                    {staffCancellationSummary(order, order.batches[0])}
                  </span>
                ) : null}
                {/* WP-2423 Q7: a counter order — paid on the Store's card machine, or a paper order. */}
                {order.counter?.paidOnCardMachine ? (
                  <span className="order-counter-paid">
                    {cardMachinePaymentText(
                      BigInt(order.counter.paidOnCardMachine.amountMinor),
                      BigInt(order.counter.paidOnCardMachine.refundedMinor),
                    )}
                  </span>
                ) : null}
                {/* WP-2423: an online order — paid online, and any refund of that payment. */}
                {order.paidOnline !== null ? (
                  <span className="order-counter-paid order-online-paid">
                    {onlinePaymentText(order, positionOf(order))}
                  </span>
                ) : null}
                {cardMachineRoundsText(order) !== null ? (
                  <span className="order-counter-paid">{cardMachineRoundsText(order)}</span>
                ) : null}
                {order.counter?.recordedAfterOutage ? (
                  <span className="order-counter-outage" data-tier="warning">
                    Recorded after outage
                  </span>
                ) : null}
                {now === undefined ? null : <AcceptanceDeadline order={order} now={now} />}
                {order.batches.map((batch) =>
                  batch.paymentDue === null ? null : (
                    <span
                      key={batch.orderBatchReference}
                      className="order-accept-by"
                      data-tier={paymentDueTier(batch.paymentDue, now)}
                    >
                      {order.batches.length > 1 ? `Batch ${batch.sequence}: ` : ""}
                      {paymentDueText(batch.paymentDue, timeZone, now, batch.staffRound !== null)}
                    </span>
                  ),
                )}
              </span>
              <time
                className="order-workbench-time"
                dateTime={order.submittedAt}
                title={order.submittedAt}
              >
                {storeTime(order.submittedAt, timeZone)}
              </time>
            </summary>
            <div className="order-workbench-detail">
              <dl>
                <div>
                  <dt>Order type</dt>
                  <dd>{orderTypeLabel[order.orderType]}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{orderChannelLabel(orderChannel(order))}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>
                    <time dateTime={order.submittedAt}>
                      {storeTime(order.submittedAt, timeZone, true)}
                    </time>
                  </dd>
                </div>
                {order.paidOnline === null && cardMachineRoundsText(order) === null ? null : (
                  <div>
                    <dt>Payment</dt>
                    <dd>
                      {[
                        order.paidOnline === null
                          ? null
                          : onlinePaymentText(order, positionOf(order)),
                        cardMachineRoundsText(order),
                      ]
                        .filter((text) => text !== null)
                        .join(" · ")}
                    </dd>
                  </div>
                )}
                {order.businessDate === null ? null : (
                  <div>
                    <dt>Business day</dt>
                    <dd>
                      {order.listedBusinessDate !== null &&
                      order.listedBusinessDate !== order.businessDate
                        ? openedEarlierText(order.businessDate, order.listedBusinessDate, today)
                        : businessDateLabel(order.businessDate, today)}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Last checked</dt>
                  <dd>
                    <time dateTime={order.observedAt} title={order.observedAt}>
                      {storeTime(order.observedAt, timeZone, true)}
                    </time>
                  </dd>
                </div>
              </dl>
              {order.counter !== null ? (
                <p className="order-counter-note" role="note">
                  Taken at the counter.{" "}
                  {order.counter.paidOnCardMachine === null
                    ? "Not paid yet: charge it on the card machine from Counter order."
                    : `Paid on the store's card machine (${orderMoney({
                        amountMinor: order.counter.paidOnCardMachine.amountMinor,
                        currencyCode: "CAD",
                      })}) at ${storeTime(order.counter.paidOnCardMachine.takenAt, timeZone, true)}.`}
                  {order.counter.recordedAfterOutage
                    ? " Recorded after an outage from a paper order: it may already have been made and handed over."
                    : ""}
                </p>
              ) : null}
              {order.pickupNotCollected ? (
                <p className="order-workbench-closed" role="note">
                  Closed as not collected after the pickup hold. It was not refunded automatically;
                  a manager can still grant a refund from payments.
                </p>
              ) : null}
              {order.unfulfillable !== null ? (
                <p className="order-workbench-closed" role="note">
                  {unfulfillableText[order.unfulfillable]}{" "}
                  {order.counter?.paidOnCardMachine
                    ? cardMachineOwed(order) !== null
                      ? `It was paid on the store's card machine: refund ${orderMoney({
                          amountMinor: cardMachineOwed(order) ?? "0",
                          currencyCode: "CAD",
                        })} on the card machine, then record it here.`
                      : "It was refunded on the store's card machine."
                    : "The payment was refunded automatically; this order cannot be accepted."}
                </p>
              ) : null}
              {detail?.(order, opened.has(order.orderReference) || view.items.length === 1)}
              {order.batches.map((batch) => (
                <section key={batch.orderBatchReference} aria-label={"Batch " + batch.sequence}>
                  <h3>
                    Batch {batch.sequence}
                    {batch.sequence === 1 ? " · Initial" : " · Additional"}
                    {batch.staffRound !== null ? " · Entered by staff" : ""}
                  </h3>
                  {batch.staffRound !== null &&
                  (batch.staffRound.paidOnCardMachine !== null ||
                    batch.staffRound.recordedAfterOutage) ? (
                    <p className="order-staff-round" role="note">
                      {batch.staffRound.paidOnCardMachine !== null
                        ? `Paid on card machine ${orderMoney({
                            amountMinor: batch.staffRound.paidOnCardMachine.amountMinor,
                            currencyCode: "CAD",
                          })} · ${storeTime(batch.staffRound.paidOnCardMachine.takenAt, timeZone, true)}`
                        : ""}
                      {batch.staffRound.paidOnCardMachine !== null &&
                      batch.staffRound.recordedAfterOutage
                        ? " · "
                        : ""}
                      {batch.staffRound.recordedAfterOutage ? "Recorded after outage" : ""}
                    </p>
                  ) : null}
                  {batch.staffCancellation !== null ? (
                    <p className="order-workbench-closed order-staff-cancellation" role="note">
                      {staffCancellationSummary(order, batch)}
                      <span>
                        Reason: {staffCancellationReasonLabel[batch.staffCancellation.reasonCode]} ·{" "}
                        <time dateTime={batch.staffCancellation.cancelledAt}>
                          {storeTime(batch.staffCancellation.cancelledAt, timeZone, true)}
                        </time>
                      </span>
                      <span>
                        {batch.staffCancellation.refundMethod === "CardMachine"
                          ? batch.staffCancellation.refundStatus === "Refunded"
                            ? "Refunded in full on the store's card machine, including any tip."
                            : `Refund ${orderMoney({
                                amountMinor: batch.staffCancellation.refundAmountMinor ?? "0",
                                currencyCode: "CAD",
                              })} on the store's card machine, then record it here.`
                          : batch.staffCancellation.refundStatus === "Refunded"
                            ? "The payment, including any tip, was refunded in full."
                            : "The payment, including any tip, is being refunded in full."}
                      </span>
                    </p>
                  ) : batch.acceptanceStatus === "Cancelled" ? (
                    // WP-2423: cancelled automatically because its payment failed (no store refund).
                    <p className="order-workbench-closed" role="note">
                      Batch cancelled · not paid. It wasn&apos;t paid by the end of its payment
                      time, so it was cancelled automatically and never went to the kitchen. Nothing
                      was charged for it in the system.
                      {batch.staffRound !== null
                        ? " If the card machine was charged for it, refund that payment on the machine."
                        : ""}
                    </p>
                  ) : batch.paymentDue !== null ? (
                    <p className="order-workbench-closed" role="note">
                      <span
                        className="order-accept-by"
                        data-tier={paymentDueTier(batch.paymentDue, now)}
                      >
                        {paymentDueText(batch.paymentDue, timeZone, now, batch.staffRound !== null)}
                      </span>
                      {batch.paymentDue.status === "Failed"
                        ? " Don't prepare it; it will not be charged. If the guest still wants these items, they can order them again."
                        : batch.staffRound !== null
                          ? " Charge it on the card machine and record it below; the kitchen starts it once recorded. If it isn't recorded in time, it is cancelled and its items go back to stock."
                          : " Not accepted yet: the guest has not paid for this round."}
                    </p>
                  ) : (
                    <p>
                      {"Acceptance: " +
                        (batch.acceptanceStatus === "Accepted" ? "Accepted" : "Not accepted")}
                    </p>
                  )}
                  {action?.(order, batch)}
                </section>
              ))}
            </div>
          </details>
        </Fragment>
      ))}
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
  return (
    <>
      {lines}
      {order.counter?.paidOnCardMachine ? (
        // WP-2423 Q7 / item 4: refunds of a card-machine payment are made on that machine and
        // recorded here: in full by cancelling before the kitchen starts, or by item afterwards.
        <p className="order-counter-note" role="note">
          Paid on the store&apos;s card machine. To refund it in full before the kitchen starts,
          cancel the order. To refund some items, a manager opens Payments and refunds, records the
          refund, makes it on the card machine and records it there.
        </p>
      ) : null}
      <OrderPaymentLinks orderReference={order.orderReference} csrf={csrf} fetcher={fetcher} />
      {order.orderType === "DineIn" && order.currentPhase !== "Cancelled" ? (
        <DiningOrderProgress
          orderReference={order.orderReference}
          csrf={csrf}
          locked={locked}
          onBusy={onBusy}
          onChanged={onChanged}
          fetcher={fetcher}
        />
      ) : null}
    </>
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
  const [now, setNow] = useState(() => Date.now());
  const [stale, setStale] = useState(false);
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
        if (!controller.signal.aborted) setState(ready);
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
  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      setNow(Date.now());
      if (servingOrders.current.size > 0 || background.current !== null) return;
      const controller = new AbortController();
      background.current = controller;
      void readCurrentOrders(client, after, orderReference, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setStale(false);
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
  }, [ready, after, orderReference, client]);
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
    });
  }, [channelFilter, orderNumberSearch, phaseFilter, state, typeFilter]);
  const visibleOrderReferences = useMemo(
    () => new Set(filteredOrders.map((order) => order.orderReference)),
    [filteredOrders],
  );
  const hasOrderFilters =
    orderNumberSearch !== "" ||
    typeFilter !== "All" ||
    channelFilter !== "All" ||
    phaseFilter !== "All";
  const clearOrderFilters = () => {
    setOrderNumberSearch("");
    setTypeFilter("All");
    setChannelFilter("All");
    setPhaseFilter("All");
  };
  const single = orderReference !== undefined;
  const detail = state.kind === "Ready" ? state.detail : undefined;
  return (
    <WorkspacePage
      className="orders-page"
      title={
        single ? (detail === undefined ? "Order" : `Order ${detail.order.orderNumber}`) : "Orders"
      }
      meta={storeLabel}
      actions={
        <>
          {single ? <Link to="/operations/orders">All orders</Link> : null}
          <button aria-pressed={soundOn} className="order-sound-toggle" onClick={toggleSound}>
            {soundOn ? "Sound on" : "Sound off"}
          </button>
          {after !== null ? (
            <button onClick={() => reload(null)} disabled={state.kind === "Loading" || servingBusy}>
              First page
            </button>
          ) : null}
          <button
            ref={refreshButton}
            onClick={() => reload(null)}
            disabled={state.kind === "Loading" || servingBusy}
          >
            {single ? "Refresh order" : "Refresh orders"}
          </button>
        </>
      }
    >
      <>
        {state.kind === "Ready" ? (
          <>
            {stale ? (
              <p className="order-queue-stale" role="status">
                Orders could not be refreshed. Showing the last update; retrying automatically.
              </p>
            ) : null}
            {!single && awaitingCount > 0 ? (
              <p className="order-queue-awaiting" role="status">
                {awaitingCount === 1
                  ? "1 order is waiting to be accepted."
                  : `${awaitingCount} orders are waiting to be accepted.`}
                {soundOn ? "" : " Turn sound on to hear new orders."}
              </p>
            ) : null}
            {single ? null : (
              <AcceptanceHoldNotice view={state.view} onShow={() => setPhaseFilter("OutageHeld")} />
            )}
            <div
              hidden={single}
              className="list-filters order-queue-filters"
              role="search"
              aria-label="Filter orders on this page"
            >
              <label>
                Exact order number
                <input
                  type="search"
                  value={orderNumberSearch}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(event) => setOrderNumberSearch(event.target.value)}
                />
              </label>
              <label>
                Order type
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="All">All types</option>
                  <option value="DineIn">Dine-in</option>
                  <option value="Pickup">Pickup</option>
                </select>
              </label>
              <label>
                Channel
                <select
                  value={channelFilter}
                  onChange={(event) => setChannelFilter(event.target.value)}
                >
                  <option value="All">All channels</option>
                  <option value="Api">Partner integration</option>
                  <option value="Pos">Counter</option>
                  <option value="Qr">QR code</option>
                  <option value="Staff">Taken by staff</option>
                  <option value="Web">Website</option>
                </select>
              </label>
              <label>
                Order status
                <select
                  value={phaseFilter}
                  onChange={(event) => setPhaseFilter(event.target.value)}
                >
                  <option value="All">All statuses</option>
                  <option value="Submitted">Submitted</option>
                  <option value="Accepted">Accepted</option>
                  <option value="InProgress">In progress</option>
                  <option value="Ready">Ready</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="Fulfilled">Served or picked up</option>
                  <option value="OutageHeld">Paid during an outage — decide</option>
                  <option value="Expired">Expired · refunded</option>
                  <option value="AwaitingPayment">Awaiting payment</option>
                  <option value="NotCollected">Not collected</option>
                </select>
              </label>
              <p className="order-queue-filter-count" aria-live="polite">
                Showing {filteredOrders.length} of {state.view.items.length} orders on this page.
              </p>
              {hasOrderFilters ? (
                <button type="button" onClick={clearOrderFilters}>
                  Clear order filters
                </button>
              ) : null}
            </div>
            {state.view.items.length > 0 && filteredOrders.length === 0 ? (
              <StatePanel heading="No orders match these filters" status>
                <p>Clear the filters or load another server page.</p>
              </StatePanel>
            ) : null}
            <CurrentOrderQueueRows
              single={single}
              view={state.view}
              timeZone={timeZone}
              now={now}
              paymentPosition={detail?.paymentPosition}
              paymentPositions={positions}
              expanded={expanded}
              visibleOrderReferences={visibleOrderReferences}
              detail={(order, open) => (
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
                        <Link to={`/operations/orders/${order.orderReference}`}>Open order</Link>
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
              action={(order, batch) =>
                // WP-2423 D5: an unpaid round staff entered is recorded as paid here too. The list
                // leaves its amount out (the one-order read builds it when the form is opened).
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
                                (entry) => entry.orderBatchReference === batch.orderBatchReference,
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
                        Cancel items
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
                            csrf={csrf}
                            orderNumber={
                              batch.sequence === 1
                                ? order.orderNumber
                                : order.orderNumber + " · batch " + batch.sequence
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
                        }
                      />
                    ) : (
                      <OrderAcceptanceAction
                        key={batch.orderBatchReference}
                        csrf={csrf}
                        orderNumber={
                          batch.sequence === 1
                            ? order.orderNumber
                            : order.orderNumber + " · batch " + batch.sequence
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
                    )}
                  </fieldset>
                ) : null
              }
            />
            {!single && state.view.nextAfterOrderReference !== null ? (
              <button
                disabled={servingBusy}
                onClick={() => reload(state.view.nextAfterOrderReference)}
              >
                Next page
              </button>
            ) : null}
          </>
        ) : (
          <StatePanel
            heading={
              state.kind === "Loading"
                ? single
                  ? "Loading order"
                  : "Loading orders"
                : state.kind === "PermissionDenied"
                  ? "Permission denied"
                  : state.kind === "NotFound"
                    ? "Order not found"
                    : single
                      ? "Order unavailable"
                      : "Orders unavailable"
            }
            status
          >
            <p>
              {state.kind === "Loading"
                ? single
                  ? "Reading the order…"
                  : "Reading current orders…"
                : state.kind === "PermissionDenied"
                  ? "Your current session or Store permissions do not allow this queue."
                  : state.kind === "NotFound"
                    ? "This order is not at the selected Store."
                    : "Orders could not be refreshed. Check your connection and try again."}
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
    <WorkspacePage title="Order" meta={props.storeLabel}>
      <StatePanel heading="Order not found" status>
        <p>This order link is not valid.</p>
        <Link to="/operations/orders">All orders</Link>
      </StatePanel>
    </WorkspacePage>
  ) : (
    <CurrentOrderQueuePage key={id} {...props} orderReference={id} />
  );
}
