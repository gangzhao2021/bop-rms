export class CurrentOrderQueueError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotFound" | "Unavailable") {
    super("Current orders could not be loaded");
    this.name = "CurrentOrderQueueError";
  }
}
const fail = (): never => {
  throw new CurrentOrderQueueError("Unavailable");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
/** WP-2423 Q6: why the Store cancelled a paid order or batch before the kitchen started. */
export const staffCancellationReasons = [
  "CUSTOMER_REQUEST",
  "SOLD_OUT",
  "STORE_ERROR",
  "DUPLICATE_ORDER",
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
    (refundMethod === "Online"
      ? refundAmountMinor !== null
      : typeof refundAmountMinor !== "string" || !minorPattern.test(refundAmountMinor))
  )
    return fail();
  return Object.freeze({
    reasonCode: raw.reasonCode as StaffCancellationReason,
    cancelledAt,
    refundStatus: raw.refundStatus as "Pending" | "Refunded",
    /** WP-2423 Q7: CardMachine — staff refund it on the Store's card machine and record it. */
    refundMethod: refundMethod as "Online" | "CardMachine",
    refundAmountMinor: refundAmountMinor as string | null,
  });
}
/** WP-2423 Q7: a pickup order staff took at the counter, and its card-machine payment. */
function parseCounter(value: unknown, sourceChannel: unknown) {
  if (value === null || value === undefined) return null;
  const raw = exact(value, ["recordedAfterOutage", "paidOnCardMachine"]);
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
  return Object.freeze({ recordedAfterOutage: raw.recordedAfterOutage, paidOnCardMachine: paid });
}
/**
 * WP-2423: an unpaid dine-in round. When its payment failed it is cancelled automatically at
 * cancelsAt; the key is optional so older servers without it read as nothing due.
 */
function parsePaymentDue(value: unknown, submittedAt: string) {
  if (value === null || value === undefined) return null;
  const raw = exact(value, ["status", "cancelsAt"]);
  if (raw.status === "Awaiting" && raw.cancelsAt === null)
    return Object.freeze({ status: "Awaiting" as const, cancelsAt: null });
  if (raw.status !== "Failed") return fail();
  const cancelsAt = instant(raw.cancelsAt);
  if (cancelsAt <= submittedAt) return fail();
  return Object.freeze({ status: "Failed" as const, cancelsAt });
}
export function parseCurrentOrderQueue(value: unknown, after: string | null = null) {
  const raw = exact(value, ["items", "nextAfterOrderReference"]);
  if (!Array.isArray(raw.items) || raw.items.length > 50) return fail();
  let previous = after;
  const items = raw.items.map((value) => {
    const withCounter =
      value !== null && typeof value === "object" && Object.hasOwn(value, "counter");
    const item = exact(value, [
      ...(withCounter ? ["counter"] : []),
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
    // WP-2423: newest first; a following page continues with older Orders.
    if (previous !== null && orderReference >= previous) return fail();
    previous = orderReference;
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
    const submittedAt = instant(item.submittedAt),
      observedAt = instant(item.observedAt);
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
      const batch = exact(value, [
        "orderBatchReference",
        "sequence",
        "acceptanceStatus",
        "canRequestAcceptance",
        "canCancel",
        "staffCancellation",
        "canCancelItems",
        ...(withPaymentDue ? ["paymentDue"] : []),
      ]);
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
            (batch.sequence === 1 &&
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
      return Object.freeze({
        orderBatchReference,
        sequence: batch.sequence,
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
      });
    });
    if (
      item.currentVersion !== null &&
      batches[0]?.sequence !== 1 &&
      !(item.currentPhase === "Cancelled" && batches.length === 0)
    )
      return fail();
    return Object.freeze({
      batches: Object.freeze(batches),
      /** WP-2423 Q7: staff took this pickup at the counter (null for customer orders). */
      counter: parseCounter(item.counter, item.sourceChannel),
      orderReference,
      orderNumber: item.orderNumber,
      orderType: item.orderType,
      sourceChannel: item.sourceChannel as string,
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
      /** WP-2423 Q1: submitted but the customer's payment is not recorded yet. */
      awaitingPayment: item.awaitingPayment as boolean,
      currentPhase: item.currentPhase as string | null,
      currentVersion: item.currentVersion as number | null,
    });
  });
  const next = raw.nextAfterOrderReference === null ? null : reference(raw.nextAfterOrderReference);
  if (next !== null && (items.length !== 50 || next !== previous)) return fail();
  return Object.freeze({ items: Object.freeze(items), nextAfterOrderReference: next });
}
export type CurrentOrderQueue = ReturnType<typeof parseCurrentOrderQueue>;
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
export function parseCurrentOrderDetail(value: unknown, orderReference: string) {
  const raw = exact(value, ["screenId", "order", "lines"]);
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
  const totals = exact(lines.totals, ["subtotal", "discount", "tax", "fee", "total"]);
  return Object.freeze({
    view: queue,
    order,
    lines: Object.freeze({
      items: Object.freeze(items),
      totals: Object.freeze({
        subtotal: money(totals.subtotal),
        discount: money(totals.discount),
        tax: money(totals.tax),
        fee: money(totals.fee),
        total: money(totals.total),
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
    if (controller.signal.aborted || text.length > 65536) return fail();
    return parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof CurrentOrderQueueError) throw error;
    return fail();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
