import { t } from "./i18n/i18n.js";
export class CurrentOrderQueueError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotFound" | "Unavailable") {
    super(t("Current orders could not be loaded"));
    this.name = "CurrentOrderQueueError";
  }
}
const fail = (): never => {
  throw new CurrentOrderQueueError("Unavailable");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const minorAmount = /^(0|[1-9][0-9]{0,17})$/u;
function parseTableBill(
  value: unknown,
  orderType: unknown,
): {
  readonly totalMinor: string;
  readonly paid: {
    readonly amountMinor: string;
    /** WP-2423 item 8 ④: "Split" — paid part by part, every part paid. */
    readonly method: "CardMachine" | "Cash" | "Online" | "Split";
  } | null;
} | null {
  if (value === null) return null;
  const bill = exact(value, ["totalMinor", "paid"]);
  if (
    orderType !== "DineIn" ||
    typeof bill.totalMinor !== "string" ||
    !minorAmount.test(bill.totalMinor)
  )
    return fail();
  if (bill.paid === null) return Object.freeze({ totalMinor: bill.totalMinor, paid: null });
  const paid = exact(bill.paid, ["amountMinor", "method"]);
  if (
    typeof paid.amountMinor !== "string" ||
    !minorAmount.test(paid.amountMinor) ||
    (paid.method !== "CardMachine" &&
      paid.method !== "Cash" &&
      paid.method !== "Online" &&
      paid.method !== "Split")
  )
    return fail();
  return Object.freeze({
    totalMinor: bill.totalMinor,
    paid: Object.freeze({ amountMinor: paid.amountMinor, method: paid.method }),
  });
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !ref.test(value)) return fail();
  return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return fail();
      return [key, d.value as unknown];
    }),
  );
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    return fail();
  return value;
}
/** WP-2423 Q6: why the Store cancelled a paid order or batch before the kitchen started. */
export const staffCancellationReasons = [
  "CUSTOMER_REQUEST",
  "SOLD_OUT",
  "STORE_ERROR",
  "DUPLICATE_ORDER",
  // DEC-TABLE-CLOSE-GUESTS-LEFT: a manager closed the table after the guests left.
  "GUEST_LEFT",
] as const;
export type StaffCancellationReason = (typeof staffCancellationReasons)[number];
const minorPattern = /^(0|[1-9][0-9]{0,17})$/;
function parseStaffCancellation(value: unknown, submittedAt: string) {
  if (value === null) return null;
  // WP-2423 Q7: how the refund is made; older servers without the keys refund online.
  const withMethod =
    value !== null && typeof value === "object" && Object.hasOwn(value, "refundMethod");
  const raw = exact(value, [
    "reasonCode",
    "cancelledAt",
    "refundStatus",
    ...(withMethod ? ["refundMethod", "refundAmountMinor"] : []),
  ]);
  const cancelledAt = instant(raw.cancelledAt);
  const refundMethod = withMethod ? raw.refundMethod : "Online";
  const refundAmountMinor = withMethod ? raw.refundAmountMinor : null;
  if (
    !staffCancellationReasons.includes(raw.reasonCode as StaffCancellationReason) ||
    (raw.refundStatus !== "Pending" && raw.refundStatus !== "Refunded") ||
    cancelledAt < submittedAt ||
    (refundMethod !== "Online" && refundMethod !== "CardMachine") ||
    // 46940b76 L2: an online refund's amount once Payment's compensation case is open (else null).
    (refundMethod === "Online"
      ? refundAmountMinor !== null &&
        (typeof refundAmountMinor !== "string" || !minorPattern.test(refundAmountMinor))
      : typeof refundAmountMinor !== "string" || !minorPattern.test(refundAmountMinor))
  )
    return fail();
  return Object.freeze({
    reasonCode: raw.reasonCode as StaffCancellationReason,
    cancelledAt,
    refundStatus: raw.refundStatus as "Pending" | "Refunded",
    /** WP-2423 Q7: CardMachine — staff refund it on the Store's card machine and record it.
     * refundAmountMinor: the card-machine amount; online, what the refund returns (46940b76 L2),
     * null until Payment opens its refund. */
    refundMethod: refundMethod as "Online" | "CardMachine",
    refundAmountMinor: refundAmountMinor as string | null,
  });
}
/** WP-2423 Q7 slice 2: a dine-in round staff entered for the table, and its card-machine payment. */
function parseStaffRound(value: unknown, orderType: unknown) {
  if (value === null) return null;
  // WP-2423 D5: what to charge while unpaid (older servers don't send it).
  const withDue =
    value !== null && typeof value === "object" && Object.hasOwn(value, "amountDueMinor");
  const raw = exact(value, [
    "recordedAfterOutage",
    "paidOnCardMachine",
    ...(withDue ? ["amountDueMinor"] : []),
  ]);
  if (typeof raw.recordedAfterOutage !== "boolean" || orderType !== "DineIn") return fail();
  let paid = null;
  if (raw.paidOnCardMachine !== null) {
    // WP-2423: what was refunded on the machine for the round (older servers don't send it).
    const withRefunded =
      typeof raw.paidOnCardMachine === "object" &&
      Object.hasOwn(raw.paidOnCardMachine, "refundedMinor");
    const p = exact(raw.paidOnCardMachine, [
      "amountMinor",
      "takenAt",
      ...(withRefunded ? ["refundedMinor"] : []),
    ]);
    const refunded = withRefunded ? p.refundedMinor : "0";
    if (
      typeof p.amountMinor !== "string" ||
      !minorPattern.test(p.amountMinor) ||
      typeof refunded !== "string" ||
      !minorPattern.test(refunded) ||
      BigInt(refunded) > BigInt(p.amountMinor)
    )
      return fail();
    paid = Object.freeze({
      amountMinor: p.amountMinor,
      takenAt: instant(p.takenAt),
      refundedMinor: refunded,
    });
  }
  const due = raw.amountDueMinor ?? null;
  if (
    due !== null &&
    (typeof due !== "string" || !minorPattern.test(due) || due === "0" || paid !== null)
  )
    return fail();
  return Object.freeze({
    recordedAfterOutage: raw.recordedAfterOutage,
    paidOnCardMachine: paid,
    amountDueMinor: due as string | null,
  });
}
/** WP-2423 Q7: a pickup order staff took at the counter, and its card-machine payment. */
function parseCounter(value: unknown, sourceChannel: unknown) {
  if (value === null || value === undefined) return null;
  // WP-2423 (v15 751dd768): while unpaid, when it is released and (one-order read) what to charge
  // (older servers send neither, or only the amount).
  const withPayBy = typeof value === "object" && Object.hasOwn(value, "payBy");
  const withDue = typeof value === "object" && Object.hasOwn(value, "amountDueMinor");
  const raw = exact(value, [
    "recordedAfterOutage",
    "paidOnCardMachine",
    ...(withPayBy ? ["payBy"] : []),
    ...(withDue ? ["amountDueMinor"] : []),
  ]);
  if (typeof raw.recordedAfterOutage !== "boolean" || sourceChannel !== "Pos") return fail();
  let paid = null;
  if (raw.paidOnCardMachine !== null) {
    const p = exact(raw.paidOnCardMachine, [
      "amountMinor",
      "takenAt",
      "recordedAfterOutage",
      "refundedMinor",
    ]);
    if (
      typeof p.amountMinor !== "string" ||
      !minorPattern.test(p.amountMinor) ||
      typeof p.refundedMinor !== "string" ||
      !minorPattern.test(p.refundedMinor) ||
      BigInt(p.refundedMinor) > BigInt(p.amountMinor) ||
      typeof p.recordedAfterOutage !== "boolean"
    )
      return fail();
    paid = Object.freeze({
      amountMinor: p.amountMinor,
      /** When the card machine took it (a paper order's actual time). */
      takenAt: instant(p.takenAt),
      recordedAfterOutage: p.recordedAfterOutage,
      refundedMinor: p.refundedMinor,
    });
  }
  const payBy = withPayBy && raw.payBy !== null ? instant(raw.payBy) : null;
  const due = withDue ? raw.amountDueMinor : null;
  if (
    due !== null &&
    (typeof due !== "string" ||
      !minorPattern.test(due) ||
      due === "0" ||
      paid !== null ||
      (withPayBy && payBy === null))
  )
    return fail();
  if (paid !== null && payBy !== null) return fail();
  return Object.freeze({
    recordedAfterOutage: raw.recordedAfterOutage,
    paidOnCardMachine: paid,
    /** While unpaid: when the order is released if it is not paid (null when paid or unknown). */
    payBy,
    /** While unpaid, on the one-order read: what to charge on the card machine (else null). */
    amountDueMinor: due as string | null,
  });
}
/** WP-2423: the sum of an Order's succeeded online payments, from Payment. */
function parsePaidOnline(value: unknown) {
  if (value === null || value === undefined) return null;
  const raw = exact(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "string" ||
    !minorPattern.test(raw.amountMinor) ||
    raw.amountMinor === "0" ||
    raw.currencyCode !== "CAD"
  )
    return fail();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: "CAD" as const });
}
/** WP-2423: how much of an Order's online payment Payment has refunded or is refunding. */
function parsePaymentPosition(value: unknown) {
  if (value === null || value === undefined) return null;
  const raw = exact(value, ["refundedMinor", "refundPendingMinor"]);
  if (
    typeof raw.refundedMinor !== "string" ||
    !minorPattern.test(raw.refundedMinor) ||
    typeof raw.refundPendingMinor !== "string" ||
    !minorPattern.test(raw.refundPendingMinor)
  )
    return fail();
  return Object.freeze({
    refundedMinor: raw.refundedMinor,
    refundPendingMinor: raw.refundPendingMinor,
  });
}
/**
 * WP-2423: an unpaid dine-in round. When its payment failed it is cancelled automatically at
 * cancelsAt; the key is optional so older servers without it read as nothing due.
 */
function parsePaymentDue(value: unknown, submittedAt: string) {
  if (value === null || value === undefined) return null;
  const raw = exact(value, ["status", "cancelsAt"]);
  if (raw.status !== "Failed" && raw.status !== "Awaiting") return fail();
  // An awaiting round has a cancellation time only when no payment was started (WP-2423 item 5).
  if (raw.status === "Awaiting" && raw.cancelsAt === null)
    return Object.freeze({ status: "Awaiting" as const, cancelsAt: null as string | null });
  const cancelsAt = instant(raw.cancelsAt);
  if (cancelsAt <= submittedAt) return fail();
  return Object.freeze({ status: raw.status as "Failed" | "Awaiting", cancelsAt });
}
/** WP-2423 Q9-G1: a held order (paid while the Store was offline). */
function parseAcceptanceHold(
  value: unknown,
  orderType: unknown,
  currentPhase: unknown,
  acceptBy: string | null,
) {
  if (value === null) return null;
  const raw = exact(value, [
    "holdReference",
    "orderBatchReference",
    "heldAt",
    "lapsedDeadline",
    "storeLastSeenAt",
    "decideBy",
    "refundChosen",
    "canRefund",
  ]);
  const decideBy = raw.decideBy === null ? null : instant(raw.decideBy);
  const lapsedDeadline = instant(raw.lapsedDeadline);
  const heldAt = instant(raw.heldAt);
  const storeLastSeenAt = raw.storeLastSeenAt === null ? null : instant(raw.storeLastSeenAt);
  if (
    orderType !== "Pickup" ||
    currentPhase !== "Submitted" ||
    typeof raw.refundChosen !== "boolean" ||
    typeof raw.canRefund !== "boolean" ||
    (raw.refundChosen && raw.canRefund) ||
    acceptBy !== decideBy ||
    heldAt < lapsedDeadline ||
    (storeLastSeenAt !== null && storeLastSeenAt >= lapsedDeadline)
  )
    return fail();
  return Object.freeze({
    holdReference: reference(raw.holdReference),
    orderBatchReference: reference(raw.orderBatchReference),
    heldAt,
    lapsedDeadline,
    storeLastSeenAt,
    /** Null while the Store is still offline; then back online + 15 minutes. */
    decideBy,
    refundChosen: raw.refundChosen,
    canRefund: raw.canRefund,
  });
}
export interface HeldStock {
  readonly since: string;
  readonly state: "Open" | "Ended";
  readonly orderBatchReference: string;
  readonly productionStarted: boolean;
}
function parseHeldStock(value: unknown): HeldStock | null {
  if (value === null) return null;
  const raw = exact(value, ["since", "state", "orderBatchReference", "productionStarted"]);
  if ((raw.state !== "Open" && raw.state !== "Ended") || typeof raw.productionStarted !== "boolean")
    return fail();
  return Object.freeze({
    since: instant(raw.since),
    state: raw.state,
    orderBatchReference: reference(raw.orderBatchReference),
    productionStarted: raw.productionStarted,
  });
}
/** Orders v2: a list row's summary — strict, so an unexpected field fails closed. */
function parseOrderSummary(value: unknown, orderType: unknown) {
  if (value === null) return null;
  const raw = exact(value, ["items", "lineCount", "pickupName", "tableLabel"]);
  const text = (entry: unknown, max: number) =>
    typeof entry === "string" &&
    entry.length <= max &&
    entry.trim() === entry &&
    !/[\p{Cc}\p{Cf}]/u.test(entry)
      ? entry
      : fail();
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 3) return fail();
  const items = raw.items.map((entry: unknown) => {
    const line = exact(entry, ["name", "option", "quantity"]);
    if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) < 1) return fail();
    return Object.freeze({
      name: text(line.name, 200),
      option: line.option === null ? null : text(line.option, 200),
      quantity: Number(line.quantity),
    });
  });
  if (!Number.isSafeInteger(raw.lineCount) || Number(raw.lineCount) < items.length) return fail();
  const pickupName = raw.pickupName === null ? null : text(raw.pickupName, 120);
  const tableLabel = raw.tableLabel === null ? null : text(raw.tableLabel, 40);
  if (
    (pickupName !== null && orderType !== "Pickup") ||
    (tableLabel !== null && orderType !== "DineIn")
  )
    return fail();
  return Object.freeze({
    items: Object.freeze(items),
    lineCount: Number(raw.lineCount),
    pickupName,
    tableLabel,
  });
}
export function parseCurrentOrderQueue(value: unknown, after: string | null = null) {
  // WP-2423 (2026-10-16 v15): earlier-day Orders listed with today's (older tables with a round
  // today, Orders still holding stock) come apart from the page (absent from an older server).
  const withEarlier =
    value !== null && typeof value === "object" && Object.hasOwn(value, "earlierDayItems");
  const raw = exact(value, [
    ...(withEarlier ? ["earlierDayItems"] : []),
    "items",
    "nextAfterOrderReference",
  ]);
  // The page holds up to 50 Orders; earlier-day Orders (first page only) up to 50 more. An older
  // server mixed both in `items`.
  if (
    !Array.isArray(raw.items) ||
    raw.items.length > (withEarlier ? 50 : 100) ||
    (withEarlier &&
      (!Array.isArray(raw.earlierDayItems) ||
        raw.earlierDayItems.length > 50 ||
        (after !== null && raw.earlierDayItems.length > 0)))
  )
    return fail();
  let previous = after;
  // Orders of the page in their newest-first sequence (earlier-day Orders are outside it).
  let paged = 0;
  const seen = new Set<string>();
  const parseItem = (value: unknown, earlierDay: boolean) => {
    const withCounter =
      value !== null && typeof value === "object" && Object.hasOwn(value, "counter");
    const withHold =
      value !== null && typeof value === "object" && Object.hasOwn(value, "acceptanceHold");
    // WP-2423 Q21: the Store business day the Order belongs to (order numbers restart daily).
    const withBusinessDate =
      value !== null && typeof value === "object" && Object.hasOwn(value, "businessDate");
    // WP-2423 D4: the day the Order is listed under (absent from an older server).
    const withListedDate =
      withBusinessDate &&
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "listedBusinessDate");
    // WP-2423: what the Order was paid online (absent from an older server).
    const withPaidOnline =
      value !== null && typeof value === "object" && Object.hasOwn(value, "paidOnline");
    // WP-2423: the refunds of that online payment on a list row (absent from an older server).
    const withPosition =
      value !== null && typeof value === "object" && Object.hasOwn(value, "paymentPosition");
    // WP-2423 (2026-10-16): stock still set aside for an earlier-day Order (absent from an older server).
    const withHeldStock =
      value !== null && typeof value === "object" && Object.hasOwn(value, "heldStock");
    // WP-2423 item 8 ⑤: a dine-in Order's table session (absent from an older server).
    const withSession =
      value !== null && typeof value === "object" && Object.hasOwn(value, "diningSessionReference");
    const withReady =
      value !== null && typeof value === "object" && Object.hasOwn(value, "readyToServeItemCount");
    // WP-2423 (2026-10-18): dine-in portions the kitchen is remaking (absent from an older server).
    const withRemaking =
      value !== null && typeof value === "object" && Object.hasOwn(value, "remakingItemCount");
    // WP-2423 (v15 2026-10-18): a pickup's kitchen state on the detail (absent from an older server).
    const withKitchen =
      value !== null && typeof value === "object" && Object.hasOwn(value, "kitchenPhase");
    // Orders v2 (2026-10-26): what the order is and who it is for (absent from an older server).
    const withSummary =
      value !== null && typeof value === "object" && Object.hasOwn(value, "summary");
    // WP-2423 (v15 751dd768): what this person may do with the payment (absent from an older server).
    const withCapabilities =
      value !== null && typeof value === "object" && Object.hasOwn(value, "canViewPayments");
    // DEC-DINE-IN-PAY-LATER: a pay-later table's bill (absent from an older server).
    const withTableBill =
      value !== null && typeof value === "object" && Object.hasOwn(value, "tableBill");
    const item = exact(value, [
      ...(withSummary ? ["summary"] : []),
      ...(withTableBill ? ["tableBill"] : []),
      ...(withCapabilities ? ["canRecordCardMachinePayment", "canViewPayments"] : []),
      ...(withReady ? ["readyToServeItemCount"] : []),
      ...(withRemaking ? ["remakingItemCount"] : []),
      ...(withKitchen ? ["kitchenPhase"] : []),
      ...(withHeldStock ? ["heldStock"] : []),
      ...(withSession ? ["diningSessionReference"] : []),
      ...(withCounter ? ["counter"] : []),
      ...(withPaidOnline ? ["paidOnline"] : []),
      ...(withPosition ? ["paymentPosition"] : []),
      ...(withHold ? ["acceptanceHold"] : []),
      ...(withBusinessDate ? ["businessDate"] : []),
      ...(withListedDate ? ["listedBusinessDate"] : []),
      "orderReference",
      "orderNumber",
      "orderType",
      "sourceChannel",
      "submittedAt",
      "initialBatchReference",
      "canRequestAcceptance",
      "unfulfillable",
      "pickupNotCollected",
      "acceptBy",
      "awaitingPayment",
      "currentPhase",
      "currentVersion",
      "observedAt",
      "batches",
    ]);
    const orderReference = reference(item.orderReference);
    const businessDate = withBusinessDate ? date(item.businessDate) : null;
    const listedBusinessDate = withListedDate ? date(item.listedBusinessDate) : businessDate;
    // WP-2423 D4: an Order opened on an earlier day with a round today is listed later than it
    // was opened (first, with today's orders); it is outside the newest-first sequence.
    const carriedOver =
      businessDate !== null && listedBusinessDate !== null && listedBusinessDate > businessDate;
    // An Order listed twice is a broken answer.
    if (seen.has(orderReference)) return fail();
    seen.add(orderReference);
    // WP-2423: newest first; a following page continues with older Orders.
    if (!earlierDay && !carriedOver) {
      if (previous !== null && orderReference >= previous) return fail();
      previous = orderReference;
      paged += 1;
    }
    if (
      typeof item.pickupNotCollected !== "boolean" ||
      (item.unfulfillable !== null &&
        !["CapacityExpired", "SubmissionCancelled", "OrderNoLongerFulfillable"].includes(
          String(item.unfulfillable),
        )) ||
      (item.unfulfillable !== null && item.canRequestAcceptance !== false) ||
      typeof item.canRequestAcceptance !== "boolean" ||
      (item.canRequestAcceptance === true &&
        (item.currentPhase !== "Submitted" || item.currentVersion !== 1)) ||
      typeof item.orderNumber !== "string" ||
      !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(item.orderNumber) ||
      (item.orderType !== "DineIn" && item.orderType !== "Pickup") ||
      !["Api", "Pos", "Qr", "Web"].includes(String(item.sourceChannel)) ||
      (item.currentPhase !== null &&
        ![
          "Submitted",
          "Accepted",
          "InProgress",
          "Ready",
          "Rejected",
          "Cancelled",
          "Fulfilled",
        ].includes(String(item.currentPhase))) ||
      (item.currentPhase === null) !== (item.currentVersion === null) ||
      (item.currentVersion !== null &&
        (typeof item.currentVersion !== "number" ||
          !Number.isInteger(item.currentVersion) ||
          item.currentVersion < 1 ||
          item.currentVersion > 2147483647))
    )
      return fail();
    // WP-2423: dine-in items ready at the pass and not yet served (null from an older server).
    if (
      withReady &&
      (!Number.isSafeInteger(item.readyToServeItemCount) ||
        Number(item.readyToServeItemCount) < 0 ||
        (item.orderType !== "DineIn" && item.readyToServeItemCount !== 0))
    )
      return fail();
    const readyToServeItemCount = withReady ? Number(item.readyToServeItemCount) : null;
    if (
      withRemaking &&
      (!Number.isSafeInteger(item.remakingItemCount) ||
        Number(item.remakingItemCount) < 0 ||
        (item.orderType !== "DineIn" && item.remakingItemCount !== 0))
    )
      return fail();
    const remakingItemCount = withRemaking ? Number(item.remakingItemCount) : 0;
    const kitchenPhase = withKitchen ? item.kitchenPhase : null;
    if (
      kitchenPhase !== null &&
      (!(kitchenPhase === "InProgress" || kitchenPhase === "Ready") ||
        item.orderType !== "Pickup" ||
        item.currentPhase !== "Accepted")
    )
      return fail();
    const submittedAt = instant(item.submittedAt),
      observedAt = instant(item.observedAt);
    const heldStock = withHeldStock ? parseHeldStock(item.heldStock) : null;
    const summary = withSummary ? parseOrderSummary(item.summary, item.orderType) : null;
    if (observedAt < submittedAt) return fail();
    // WP-2423 Q1: only a paid pickup still awaiting acceptance has a deadline.
    const acceptBy = item.acceptBy === null ? null : instant(item.acceptBy);
    if (
      acceptBy !== null &&
      (item.orderType !== "Pickup" ||
        item.currentPhase !== "Submitted" ||
        item.unfulfillable !== null ||
        acceptBy <= submittedAt)
    )
      return fail();
    // WP-2423 Q9-G1: paid while the Store was offline and held for a manager's decision.
    const acceptanceHold = withHold
      ? parseAcceptanceHold(item.acceptanceHold, item.orderType, item.currentPhase, acceptBy)
      : null;
    // WP-2423 Q1: no payment recorded yet — the customer has not paid, so nothing is acceptable.
    if (
      typeof item.awaitingPayment !== "boolean" ||
      (item.awaitingPayment &&
        (item.currentPhase !== "Submitted" ||
          item.unfulfillable !== null ||
          item.canRequestAcceptance !== false ||
          acceptBy !== null))
    )
      return fail();
    if (!Array.isArray(item.batches) || item.batches.length > 10000) return fail();
    const seenBatches = new Set<string>();
    let previousSequence = 0;
    const batches = item.batches.map((value) => {
      const withPaymentDue =
        value !== null && typeof value === "object" && Object.hasOwn(value, "paymentDue");
      const withStaffRound =
        value !== null && typeof value === "object" && Object.hasOwn(value, "staffRound");
      // WP-2423 abandoned payment: absent from an older server (no cancel action then).
      const withCancelUnpaid =
        value !== null && typeof value === "object" && Object.hasOwn(value, "canCancelUnpaid");
      // WP-2423 (v15 2026-10-16): absent from an older server (no wait warning then).
      const withWaitingSince =
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, "awaitingAcceptanceSince");
      // Orders v3 (Owner 2026-10-26): when the round was sent (absent from an older server).
      const withSubmittedAt =
        value !== null && typeof value === "object" && Object.hasOwn(value, "submittedAt");
      // DEC-DINE-IN-PAY-LATER (rule 2): absent from an older server (no removal then).
      const withUnpaidRemoval =
        value !== null && typeof value === "object" && Object.hasOwn(value, "unpaidRemovableItems");
      // WP-2423 item 8 ① segment 2: absent from an older server (no comps then).
      const withComps =
        value !== null && typeof value === "object" && Object.hasOwn(value, "compableItems");
      const batch = exact(value, [
        "orderBatchReference",
        "sequence",
        ...(withSubmittedAt ? ["submittedAt"] : []),
        "acceptanceStatus",
        "canRequestAcceptance",
        "canCancel",
        "staffCancellation",
        "canCancelItems",
        ...(withPaymentDue ? ["paymentDue"] : []),
        ...(withStaffRound ? ["staffRound"] : []),
        ...(withCancelUnpaid ? ["canCancelUnpaid"] : []),
        ...(withWaitingSince ? ["awaitingAcceptanceSince"] : []),
        ...(withUnpaidRemoval ? ["unpaidRemovableItems", "unpaidRemovedItems"] : []),
        ...(withComps ? ["compableItems", "compedItems"] : []),
      ]);
      const references = (list: unknown) =>
        Array.isArray(list) && list.length <= 500
          ? Object.freeze(list.map((entry) => reference(entry)))
          : fail();
      const unpaidRemovableItems = withUnpaidRemoval
        ? references(batch.unpaidRemovableItems)
        : Object.freeze([] as string[]);
      const unpaidRemovedItems = withUnpaidRemoval
        ? references(batch.unpaidRemovedItems)
        : Object.freeze([] as string[]);
      if (
        // Only an accepted dine-in round, never cancelled by the Store, has dishes to take off.
        (unpaidRemovableItems.length > 0 &&
          (item.orderType !== "DineIn" ||
            batch.acceptanceStatus !== "Accepted" ||
            item.currentVersion === null)) ||
        (unpaidRemovedItems.length > 0 && item.orderType !== "DineIn") ||
        unpaidRemovableItems.some((line) => unpaidRemovedItems.includes(line))
      )
        return fail();
      const compableItems = withComps ? references(batch.compableItems) : Object.freeze([]);
      const compedItems = withComps
        ? Array.isArray(batch.compedItems) && batch.compedItems.length <= 500
          ? Object.freeze(
              batch.compedItems.map((entry: unknown) => {
                const comp = exact(entry, ["orderItemReference", "kind", "percent", "amountMinor"]);
                if (
                  (comp.kind !== "Comp" && comp.kind !== "Percent" && comp.kind !== "Amount") ||
                  (comp.kind === "Percent"
                    ? typeof comp.percent !== "number" ||
                      !Number.isInteger(comp.percent) ||
                      comp.percent < 1 ||
                      comp.percent > 99
                    : comp.percent !== null) ||
                  typeof comp.amountMinor !== "string" ||
                  !/^[1-9][0-9]{0,15}$/u.test(comp.amountMinor)
                )
                  return fail();
                return Object.freeze({
                  orderItemReference: reference(comp.orderItemReference),
                  kind: comp.kind as "Comp" | "Percent" | "Amount",
                  percent: comp.percent as number | null,
                  amountMinor: comp.amountMinor,
                });
              }),
            )
          : fail()
        : Object.freeze([]);
      if ((compableItems.length > 0 || compedItems.length > 0) && item.orderType !== "DineIn")
        return fail();
      const awaitingAcceptanceSince = withWaitingSince ? batch.awaitingAcceptanceSince : null;
      const canCancelUnpaid = withCancelUnpaid ? batch.canCancelUnpaid : false;
      const staffRound = parseStaffRound(batch.staffRound ?? null, item.orderType);
      const orderBatchReference = reference(batch.orderBatchReference);
      const staffCancellation = parseStaffCancellation(batch.staffCancellation, submittedAt);
      if (withPaymentDue && batch.paymentDue === undefined) return fail();
      const paymentDue = parsePaymentDue(batch.paymentDue, submittedAt);
      if (
        // WP-2423: only an unpaid, not accepted, not cancelled dine-in round has a payment due.
        (paymentDue !== null &&
          (item.orderType !== "DineIn" ||
            batch.acceptanceStatus !== "NotAccepted" ||
            staffCancellation !== null ||
            batch.canRequestAcceptance !== false ||
            batch.canCancel !== false ||
            batch.canCancelItems !== false)) ||
        (item.awaitingPayment === true && batch.canRequestAcceptance !== false) ||
        typeof canCancelUnpaid !== "boolean" ||
        // Only a paid dine-in round staff can accept now says when it was paid.
        (awaitingAcceptanceSince !== null &&
          (typeof awaitingAcceptanceSince !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(awaitingAcceptanceSince) ||
            !Number.isFinite(Date.parse(awaitingAcceptanceSince)) ||
            item.orderType !== "DineIn" ||
            batch.canRequestAcceptance !== true)) ||
        (canCancelUnpaid && paymentDue === null) ||
        typeof batch.sequence !== "number" ||
        !Number.isSafeInteger(batch.sequence) ||
        batch.sequence <= previousSequence ||
        seenBatches.has(orderBatchReference) ||
        (batch.sequence === 1) !== (orderBatchReference === item.initialBatchReference) ||
        !["Accepted", "NotAccepted", "Cancelled"].includes(String(batch.acceptanceStatus)) ||
        typeof batch.canRequestAcceptance !== "boolean" ||
        (batch.canRequestAcceptance &&
          (item.unfulfillable !== null ||
            batch.acceptanceStatus !== "NotAccepted" ||
            item.currentVersion === null ||
            !["Submitted", "Accepted", "InProgress", "Ready"].includes(String(item.currentPhase)) ||
            // WP-2423: a table's first round stays acceptable after later rounds changed the
            // Order (any order of acceptance); a pickup order's only round only as submitted.
            (batch.sequence === 1 &&
              item.orderType !== "DineIn" &&
              (item.currentVersion !== 1 || item.currentPhase !== "Submitted")))) ||
        typeof batch.canCancel !== "boolean" ||
        // WP-2423 Q6: only a paid, accepted batch the kitchen has not started can be cancelled.
        (batch.canCancel &&
          (staffCancellation !== null ||
            batch.acceptanceStatus !== "Accepted" ||
            batch.canRequestAcceptance ||
            item.unfulfillable !== null ||
            item.pickupNotCollected !== false ||
            item.currentVersion === null ||
            !(item.orderType === "Pickup"
              ? item.currentPhase === "Accepted"
              : ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                  String(item.currentPhase),
                )))) ||
        typeof batch.canCancelItems !== "boolean" ||
        // WP-2423 Q6: items can be cancelled only in a paid, accepted batch the Store has not cancelled.
        (batch.canCancelItems &&
          (staffCancellation !== null ||
            batch.acceptanceStatus !== "Accepted" ||
            batch.canRequestAcceptance ||
            item.unfulfillable !== null ||
            item.pickupNotCollected !== false ||
            item.currentVersion === null)) ||
        // A pickup cancelled by the Store is a cancelled Order; a dine-in batch is a cancelled batch.
        (staffCancellation !== null &&
          (batch.canRequestAcceptance ||
            (item.orderType === "DineIn"
              ? batch.acceptanceStatus !== "Cancelled"
              : item.currentPhase !== "Cancelled")))
      )
        return fail();
      previousSequence = batch.sequence;
      seenBatches.add(orderBatchReference);
      const batchSubmittedAt = withSubmittedAt ? instant(batch.submittedAt) : null;
      return Object.freeze({
        orderBatchReference,
        sequence: batch.sequence,
        /** Orders v3: when this round was sent; null from an older server. */
        submittedAt: batchSubmittedAt,
        acceptanceStatus: batch.acceptanceStatus as "Accepted" | "NotAccepted" | "Cancelled",
        canRequestAcceptance: batch.canRequestAcceptance,
        /** WP-2423 Q6: the caller may cancel this paid batch before the kitchen starts. */
        canCancel: batch.canCancel,
        /** WP-2423 Q6: the Store cancelled this batch; the payment is refunded in full. */
        staffCancellation,
        /** WP-2423 Q6 step 2: at least one item of this batch can be cancelled on its own now. */
        canCancelItems: batch.canCancelItems,
        /** WP-2423: this dine-in round is unpaid; when its payment failed, when it is cancelled. */
        paymentDue,
        /** WP-2423 abandoned payment: the caller may cancel this unpaid round now. */
        canCancelUnpaid: canCancelUnpaid as boolean,
        /** WP-2423 Q7 slice 2: staff entered this round for the table; its card-machine payment. */
        staffRound,
        /** WP-2423: when this paid dine-in round, awaiting acceptance, was paid (else null). */
        awaitingAcceptanceSince: awaitingAcceptanceSince as string | null,
        /** DEC-DINE-IN-PAY-LATER: dishes of this unpaid pay-later round staff may take off now. */
        unpaidRemovableItems,
        /** DEC-DINE-IN-PAY-LATER: dishes taken off this round's bill before the table paid. */
        unpaidRemovedItems,
        /** WP-2423 item 8 ① segment 2: dishes a manager may comp or discount now. */
        compableItems,
        /** Comps and discounts on this round (tax included), never removed. */
        compedItems,
      });
    });
    const counter = parseCounter(item.counter, item.sourceChannel);
    if (
      withCapabilities &&
      (typeof item.canRecordCardMachinePayment !== "boolean" ||
        typeof item.canViewPayments !== "boolean")
    )
      return fail();
    const paidOnline = parsePaidOnline(item.paidOnline);
    if (paidOnline !== null && counter !== null) return fail();
    const paymentPosition = parsePaymentPosition(item.paymentPosition);
    if (
      paymentPosition !== null &&
      (paidOnline === null ||
        BigInt(paymentPosition.refundedMinor) + BigInt(paymentPosition.refundPendingMinor) >
          BigInt(paidOnline.amountMinor))
    )
      return fail();
    if (
      item.currentVersion !== null &&
      batches[0]?.sequence !== 1 &&
      !(item.currentPhase === "Cancelled" && batches.length === 0)
    )
      return fail();
    return Object.freeze({
      batches: Object.freeze(batches),
      /** WP-2423 Q7: staff took this pickup at the counter (null for customer orders). */
      counter,
      /** WP-2423: what the customer paid online (null when unpaid, a counter order, or unknown). */
      paidOnline,
      /**
       * WP-2423: Payment's refunded and refunding amounts of that payment — the same position the
       * order detail reads — on a list row whose order has a refund (null when none or not read).
       */
      paymentPosition,
      orderReference,
      orderNumber: item.orderNumber,
      orderType: item.orderType,
      sourceChannel: item.sourceChannel as string,
      /** WP-2423 Q21: the Store business date of the Order (null from an older server). */
      businessDate,
      /**
       * WP-2423 D4: the business date the Order is listed under — today for an Order opened on an
       * earlier day that had a round today; otherwise its own business date.
       */
      listedBusinessDate,
      /**
       * WP-2423 (2026-10-16): this Order is from an earlier business day and still has stock set
       * aside — Open (still to make and hand over, or cancel) or Ended (only the stock is left).
       */
      heldStock,
      /** WP-2423 item 8 ⑤: the table's session of a dine-in Order (which phone sent each round). */
      diningSessionReference:
        !withSession || item.diningSessionReference === null || item.orderType !== "DineIn"
          ? null
          : reference(item.diningSessionReference),
      submittedAt,
      observedAt,
      initialBatchReference: reference(item.initialBatchReference),
      canRequestAcceptance: item.canRequestAcceptance,
      /** WP-2423: paid but no longer fulfillable; Payment refunds it (never accepted). */
      unfulfillable: item.unfulfillable as
        "CapacityExpired" | "SubmissionCancelled" | "OrderNoLongerFulfillable" | null,
      /** WP-2423: the Store closed this pickup as not collected (not refunded automatically). */
      pickupNotCollected: item.pickupNotCollected as boolean,
      /** WP-2423 Q1: when this paid pickup stops being acceptable (then Payment refunds it). */
      acceptBy,
      /** WP-2423 Q9-G1: paid while the Store was offline; a manager accepts or refunds it. */
      acceptanceHold,
      /** WP-2423 Q1: submitted but the customer's payment is not recorded yet. */
      awaitingPayment: item.awaitingPayment as boolean,
      /**
       * WP-2423 (v15 751dd768): this person may record a card-machine payment (counter order,
       * staff-entered round) and open Payments and refunds. An older server leaves them out: the
       * actions are offered and the server's refusal is explained.
       */
      canRecordCardMachinePayment: withCapabilities
        ? (item.canRecordCardMachinePayment as boolean)
        : true,
      canViewPayments: withCapabilities ? (item.canViewPayments as boolean) : true,
      /** DEC-DINE-IN-PAY-LATER: what a pay-later table owes on its bill, or what it paid. */
      tableBill: withTableBill ? parseTableBill(item.tableBill, item.orderType) : null,
      currentPhase: item.currentPhase as string | null,
      currentVersion: item.currentVersion as number | null,
      /**
       * WP-2423: dine-in items the kitchen marked ready that nobody served yet, in any round (the
       * Tables close dialog's rule); null from an older server.
       */
      readyToServeItemCount,
      /** WP-2423 (2026-10-18): dine-in portions the kitchen is remaking (0 when none or unknown). */
      remakingItemCount,
      /**
       * WP-2423 (v15 2026-10-18): what the kitchen shows for an accepted pickup ("InProgress" or
       * "Ready") before Ordering records it — on the list and the detail; null otherwise.
       */
      kitchenPhase: kitchenPhase as "InProgress" | "Ready" | null,
      /**
       * Orders v2: the first items (name, first option, quantity), how many lines, and who it is for
       * — the pickup name or the table; never a phone or email. Null from an older server.
       */
      summary,
    });
  };
  const earlier = withEarlier
    ? (raw.earlierDayItems as unknown[]).map((value) => parseItem(value, true))
    : [];
  const page = raw.items.map((value) => parseItem(value, false));
  const next = raw.nextAfterOrderReference === null ? null : reference(raw.nextAfterOrderReference);
  // A following page continues after the page's last Order. The current server answers exactly 50
  // Orders then; an older one left earlier-day Orders out of a fetched page (fewer than 50).
  if (
    next !== null &&
    (withEarlier
      ? page.length !== 50 || paged !== 50 || next !== previous
      : paged > 50 || previous === null || next > previous)
  )
    return fail();
  // Earlier-day Orders are listed first, with today's.
  return Object.freeze({
    items: Object.freeze([...earlier, ...page]),
    nextAfterOrderReference: next,
  });
}
export type CurrentOrderQueue = ReturnType<typeof parseCurrentOrderQueue>;
/**
 * WP-2423 follow-up: an order waits for acceptance when any of its rounds does (a pickup's only
 * round, or a table's later round). Home, the Orders page, its tab title and its chime all use this.
 */
export function isAwaitingAcceptance(order: CurrentOrderQueue["items"][number]): boolean {
  return order.batches.some((batch) => batch.canRequestAcceptance);
}
export function ordersAwaitingAcceptance(view: Pick<CurrentOrderQueue, "items">): number {
  return view.items.filter(isAwaitingAcceptance).length;
}
/**
 * WP-2423 (v15 2026-10-16): rounds awaiting acceptance across the orders, and how many of them are
 * paid dine-in rounds that waited `urgentMinutes` or longer (Home's count).
 */
export function roundsAwaitingAcceptance(
  view: Pick<CurrentOrderQueue, "items">,
  now: number,
  urgentMinutes: number,
): { readonly rounds: number; readonly urgentRounds: number } {
  const batches = view.items.flatMap((order) =>
    order.batches.filter((batch) => batch.canRequestAcceptance),
  );
  return {
    rounds: batches.length,
    urgentRounds: batches.filter(
      (batch) =>
        batch.awaitingAcceptanceSince !== null &&
        now - Date.parse(batch.awaitingAcceptanceSince) >= urgentMinutes * 60_000,
    ).length,
  };
}
const money = (value: unknown) => {
  const raw = exact(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "string" ||
    !/^-?(0|[1-9][0-9]{0,17})$/.test(raw.amountMinor) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/.test(raw.currencyCode)
  )
    return fail();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
};
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : fail();
/**
 * WP-2423 Q6 step 2: the Store cancelled this item line; refund is the line's net + tax (never the
 * tip). The cancellation reference is present when the server exposes it (used to check the refund).
 */
function parseItemCancellation(value: unknown, submittedAt: string, currencyCode: string) {
  if (value === null) return null;
  const withReference =
    value !== null && typeof value === "object" && Object.hasOwn(value, "cancellationReference");
  const raw = exact(value, [
    "reasonCode",
    "cancelledAt",
    "refundStatus",
    "refund",
    ...(withReference ? ["cancellationReference"] : []),
  ]);
  const cancelledAt = instant(raw.cancelledAt);
  const refund = money(raw.refund);
  if (
    !staffCancellationReasons.includes(raw.reasonCode as StaffCancellationReason) ||
    (raw.refundStatus !== "Pending" && raw.refundStatus !== "Refunded") ||
    cancelledAt < submittedAt ||
    refund.amountMinor.startsWith("-") ||
    refund.currencyCode !== currencyCode
  )
    return fail();
  return Object.freeze({
    reasonCode: raw.reasonCode as StaffCancellationReason,
    cancelledAt,
    refundStatus: raw.refundStatus as "Pending" | "Refunded",
    refund,
    cancellationReference: withReference ? reference(raw.cancellationReference) : null,
  });
}
/** WP-2423 OPS-ORDER-DETAIL: one Order with what was ordered (names, options, notes, amounts). */
/**
 * WP-2423 Q10: the contact a pickup customer gave so the Store can reach them about this order
 * (detail only), or that it was removed after the retention period, or that none was given.
 */
export type OrderPickupContact =
  | {
      readonly status: "Available";
      readonly name: string;
      readonly channel: "Phone" | "Email";
      readonly value: string;
    }
  | { readonly status: "Removed"; readonly removedAt: string }
  | { readonly status: "NotGiven" };
function parsePickupContact(value: unknown, orderType: string): OrderPickupContact | null {
  if (value === null) return null;
  if (orderType !== "Pickup") return fail();
  const status =
    value !== null && typeof value === "object" ? (value as { status?: unknown }).status : null;
  if (status === "NotGiven") {
    exact(value, ["status"]);
    return Object.freeze({ status: "NotGiven" });
  }
  if (status === "Removed") {
    const raw = exact(value, ["status", "removedAt"]);
    if (typeof raw.removedAt !== "string" || !Number.isFinite(Date.parse(raw.removedAt)))
      return fail();
    return Object.freeze({ status: "Removed", removedAt: raw.removedAt });
  }
  const raw = exact(value, ["status", "name", "channel", "value"]);
  if (raw.status !== "Available" || (raw.channel !== "Phone" && raw.channel !== "Email"))
    return fail();
  const contact = text(raw.value, 254);
  if (
    raw.channel === "Phone"
      ? !/^\+[1-9][0-9]{6,14}$/u.test(contact)
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact)
  )
    return fail();
  const name = text(raw.name, 120);
  if (name.length < 1) return fail();
  return Object.freeze({ status: "Available", name, channel: raw.channel, value: contact });
}
export function parseCurrentOrderDetail(value: unknown, orderReference: string) {
  // WP-2423: refunds of the online payment (absent from an older server).
  const withPosition =
    value !== null && typeof value === "object" && Object.hasOwn(value, "paymentPosition");
  const raw = exact(value, [
    "screenId",
    "order",
    "lines",
    "pickupContact",
    ...(withPosition ? ["paymentPosition"] : []),
  ]);
  if (raw.screenId !== "OPS-ORDER-DETAIL") return fail();
  const queue = parseCurrentOrderQueue({ items: [raw.order], nextAfterOrderReference: null });
  const order = queue.items[0];
  if (!order || order.orderReference !== orderReference) return fail();
  const lines = exact(raw.lines, ["items", "totals"]);
  if (!Array.isArray(lines.items) || lines.items.length < 1 || lines.items.length > 100)
    return fail();
  const batches = new Set(order.batches.map((batch) => batch.orderBatchReference));
  const items = lines.items.map((value) => {
    const item = exact(value, [
      "orderItemReference",
      "orderBatchReference",
      "name",
      "options",
      "quantity",
      "customerNote",
      "unitPrice",
      "subtotal",
      "discount",
      "tax",
      "fee",
      "total",
      "canCancel",
      "cancellation",
    ]);
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999 ||
      !Array.isArray(item.options) ||
      item.options.length > 100 ||
      typeof item.canCancel !== "boolean"
    )
      return fail();
    const total = money(item.total);
    const cancellation = parseItemCancellation(
      item.cancellation,
      order.submittedAt,
      total.currencyCode,
    );
    const batch = order.batches.find(
      (entry) => entry.orderBatchReference === item.orderBatchReference,
    );
    // WP-2423 Q6 step 2: only an uncancelled item of a batch that offers item cancellation.
    if (item.canCancel && (cancellation !== null || batch?.canCancelItems !== true)) return fail();
    return Object.freeze({
      orderItemReference: reference(item.orderItemReference),
      orderBatchReference: reference(item.orderBatchReference),
      /** Sequence of the batch the item was submitted in, when the Order still has that batch. */
      batchKnown: batches.has(String(item.orderBatchReference)),
      name: text(item.name, 500),
      options: Object.freeze(
        item.options.map((option: unknown) => {
          const o = exact(option, ["name", "quantity"]);
          if (typeof o.quantity !== "number" || !Number.isInteger(o.quantity) || o.quantity < 1)
            return fail();
          return Object.freeze({ name: text(o.name, 500), quantity: o.quantity });
        }),
      ),
      quantity: item.quantity,
      customerNote: item.customerNote === null ? null : text(item.customerNote, 2000),
      unitPrice: money(item.unitPrice),
      subtotal: money(item.subtotal),
      discount: money(item.discount),
      tax: money(item.tax),
      fee: money(item.fee),
      total,
      /** WP-2423 Q6 step 2: this line may be cancelled now (kitchen not started, caller allowed). */
      canCancel: item.canCancel,
      cancellation,
    });
  });
  // A batch offers item cancellation exactly when one of its lines can be cancelled.
  for (const batch of order.batches)
    if (
      batch.canCancelItems !==
      items.some((item) => item.canCancel && item.orderBatchReference === batch.orderBatchReference)
    )
      return fail();
  // WP-2423 (3cd0f8dd M1): the tip the order's payments carried (absent from an older server).
  const withTip =
    lines.totals !== null && typeof lines.totals === "object" && Object.hasOwn(lines.totals, "tip");
  const totals = exact(lines.totals, [
    "subtotal",
    "discount",
    "tax",
    "fee",
    "total",
    ...(withTip ? ["tip"] : []),
  ]);
  const tip = withTip ? money(totals.tip) : null;
  if (
    tip !== null &&
    (tip.amountMinor.startsWith("-") || tip.currencyCode !== money(totals.total).currencyCode)
  )
    return fail();
  const paymentPosition = parsePaymentPosition(raw.paymentPosition);
  if (
    paymentPosition !== null &&
    (order.paidOnline === null ||
      BigInt(paymentPosition.refundedMinor) + BigInt(paymentPosition.refundPendingMinor) >
        BigInt(order.paidOnline.amountMinor))
  )
    return fail();
  return Object.freeze({
    view: queue,
    order,
    /** WP-2423: refunded and refunding amounts of the online payment (null when not read). */
    paymentPosition,
    pickupContact: parsePickupContact(raw.pickupContact, order.orderType),
    lines: Object.freeze({
      items: Object.freeze(items),
      totals: Object.freeze({
        subtotal: money(totals.subtotal),
        discount: money(totals.discount),
        tax: money(totals.tax),
        fee: money(totals.fee),
        total: money(totals.total),
        /** What the order's payments carried as tip (null from an older server). */
        tip,
      }),
    }),
  });
}
export type CurrentOrderDetail = ReturnType<typeof parseCurrentOrderDetail>;
export type CurrentOrderLine = CurrentOrderDetail["lines"]["items"][number];
/** WP-2423 Q6 step 2: what the cancelled items refund in total (null when nothing was cancelled). */
export function cancelledItemsRefund(items: readonly CurrentOrderLine[]) {
  const refunds = items.flatMap((item) => (item.cancellation ? [item.cancellation.refund] : []));
  const first = refunds[0];
  if (first === undefined) return null;
  if (refunds.some((refund) => refund.currencyCode !== first.currencyCode)) return null;
  return Object.freeze({
    amountMinor: refunds.reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n).toString(),
    currencyCode: first.currencyCode,
  });
}
export function createCurrentOrderQueueClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    load(after: string | null, signal: AbortSignal) {
      if (after !== null) reference(after);
      return get(
        fetcher,
        "/merchant/orders" + (after === null ? "" : "?after=" + encodeURIComponent(after)),
        signal,
        (value) => parseCurrentOrderQueue(value, after),
      );
    },
    /** WP-2423 OPS-ORDER-DETAIL; NotFound when the Order is not at the selected Store. */
    loadDetail(orderReference: string, signal: AbortSignal) {
      reference(orderReference);
      return get(
        fetcher,
        "/merchant/orders/detail?order=" + encodeURIComponent(orderReference),
        signal,
        (value) => parseCurrentOrderDetail(value, orderReference),
      );
    },
  });
}
export const orderQueueMaximumResponseBytes = 1048576;
async function get<T>(
  fetcher: typeof fetch,
  path: string,
  signal: AbortSignal,
  parse: (value: unknown) => T,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    if (controller.signal.aborted) return fail();
    const response = await fetcher(path, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403)
      throw new CurrentOrderQueueError("PermissionDenied");
    if (response.status === 404) throw new CurrentOrderQueueError("NotFound");
    if (
      !response.ok ||
      response.headers.get("cache-control") !== "no-store" ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    )
      return fail();
    const text = await response.text();
    // A full page (50 Orders, each with its rounds and up to three summary lines) passes 64 KiB on
    // an ordinary busy day (v15 2026-10-27: 67,530 bytes); the bound only stops a runaway body.
    if (controller.signal.aborted || text.length > orderQueueMaximumResponseBytes) return fail();
    return parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof CurrentOrderQueueError) throw error;
    return fail();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
