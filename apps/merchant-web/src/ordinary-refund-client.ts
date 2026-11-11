import { t } from "./i18n/i18n.js";
import {
  FULL_SIGN_IN_REQUIRED,
  responseNeedsFullSignIn,
  type FullSignInRequired,
} from "./full-sign-in.js";

export class OrdinaryRefundClientError extends Error {
  constructor(
    /** Changed: the order's refunds changed while a read was loading (it was read once more). */
    /** NotFound (M126 I.5): no such payment in this Store; it belongs to another Store. */
    readonly code:
      | "Denied"
      | FullSignInRequired
      | "Conflict"
      | "Changed"
      /** WP-2423 M10: every dish of an order nobody accepted yet: use Can't make it instead. */
      | "OrderNotAccepted"
      /** WP-2423 M163: more than the order's refunds (less what was taken back) is refused. */
      | "RecoveryAboveRefunded"
      /** WP-2423 M163: this attempt was already recorded with other details (nothing more is). */
      | "RecoveryConflict"
      /**
       * WP-2423 M10: "stop making it too" the kitchen or the counter can't do as asked (the refund
       * needs approval, part was handed over, every dish would be stopped, the kitchen just
       * started). Nothing was recorded.
       */
      | "WithdrawNeedsApproval"
      | "WithdrawHandedOver"
      | "WithdrawEverything"
      | "WithdrawKitchenChanged"
      | "Unavailable"
      | "OutcomeUnknown"
      | "NotFound",
  ) {
    super(t("Refund request could not be confirmed"));
  }
}
/** The server was briefly busy (503 retry_later): a read is tried once more. */
class RetryLater extends Error {}
/** The JSON `error` of a short failure reply, or null. */
const replyError = async (response: Response): Promise<string | null> => {
  try {
    const text = await response.text();
    if (text.length > 200) return null;
    const value: unknown = JSON.parse(text);
    const error =
      value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
};
const fail = (): never => {
  throw new OrdinaryRefundClientError("Unavailable");
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: readonly string[]) => {
  const raw = object(value);
  if (
    Reflect.ownKeys(raw).length !== keys.length ||
    keys.some((key) => {
      const property = Object.getOwnPropertyDescriptor(raw, key);
      return !property || !("value" in property) || !property.enumerable;
    })
  )
    return fail();
  return raw;
};
const ref = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
};
const count = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail();
  return value;
};
const money = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
};
const label = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  return value;
};
/**
 * WP-2423 Q5 / item 6: where one refund request stands. Recorded: nothing prepared or sent;
 * ReadyToSend: not sent yet on at least one payment (prepared or not); Sending: really sent and
 * waiting for the card provider's answer; Refunded: confirmed; Declined: an approver declined it.
 */
export const refundRequestProgress = [
  "Recorded",
  "ReadyToSend",
  "Sending",
  "Refunded",
  "Declined",
] as const;
export type RefundRequestProgress = (typeof refundRequestProgress)[number];
/** WP-2423 Q5: why an Owner/Finance approval is needed (RF-D01–D03, manual allocation). */
export const escalationReasons = [
  "DifferentBusinessDate",
  "MoreThan24Hours",
  "OrderOrdinaryTotalAboveCad100",
  "ManualAllocationOverride",
] as const;
export type EscalationReason = (typeof escalationReasons)[number];
const escalation = (required: unknown, reasons: unknown) => {
  if (
    (required !== null && typeof required !== "boolean") ||
    !Array.isArray(reasons) ||
    reasons.length > escalationReasons.length ||
    new Set(reasons).size !== reasons.length ||
    reasons.some((reason) => !escalationReasons.includes(reason as EscalationReason)) ||
    (required !== true && reasons.length > 0) ||
    (required === true && reasons.length === 0)
  )
    return fail();
  return Object.freeze({
    approvalRequired: required,
    escalationReasons: Object.freeze([...reasons] as EscalationReason[]),
  });
};
const components = [
  "netAmountMinor",
  "taxAmountMinor",
  "tipAmountMinor",
  "serviceChargeAmountMinor",
  "serviceChargeTaxAmountMinor",
] as const;
export interface RefundItem {
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly label: string;
  readonly quantity: number;
  readonly unclaimedQuantity: number;
  readonly paymentCaptured: boolean;
  /** The round was cancelled and refunded whole by that cancellation; no unit is refundable. */
  readonly refundedByCancellation: boolean;
  readonly paymentIntentReference: string | null;
  readonly paymentMethod: "Online" | "CardMachine" | null;
  /**
   * WP-2423 M10: the kitchen's state of this dish (null: no kitchen work yet, or not known; an
   * older server also reads null), and how many units staff already said not to make.
   */
  readonly kitchen: "NotStarted" | "Started" | "Cancelled" | null;
  readonly withdrawnQuantity: number;
}
export interface RefundRequestCommand {
  readonly orderReference: string;
  readonly requestReference: string;
  readonly operationReference: string;
  readonly expectedClaimVersion: number;
  readonly reasonCode: string;
  /** WP-2423 Q5: required for reason "OTHER" only (1–200 characters). */
  readonly note?: string;
  readonly items: readonly {
    readonly orderBatchReference: string;
    readonly orderItemReference: string;
    readonly quantity: number;
  }[];
  /**
   * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): "stop making it too", per refunded item
   * (at most the units refunded); left out when none.
   */
  readonly withdraw?: readonly {
    readonly orderItemReference: string;
    readonly quantity: number;
  }[];
}
function command(value: RefundRequestCommand) {
  const withNote = Object.prototype.hasOwnProperty.call(value, "note");
  const withWithdraw = Object.prototype.hasOwnProperty.call(value, "withdraw");
  const raw = exact(value, [
    "orderReference",
    "requestReference",
    "operationReference",
    "expectedClaimVersion",
    "reasonCode",
    "items",
    ...(withNote ? ["note"] : []),
    ...(withWithdraw ? ["withdraw"] : []),
  ]);
  if (
    (raw.reasonCode === "OTHER") !== withNote ||
    (withNote &&
      (typeof raw.note !== "string" ||
        raw.note.trim().length < 1 ||
        [...raw.note.trim()].length > 200))
  )
    return fail();
  if (
    typeof raw.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > 1000
  )
    return fail();
  const items = Array.from(raw.items, (value) => {
    const item = exact(value, ["orderBatchReference", "orderItemReference", "quantity"]);
    return Object.freeze({
      orderBatchReference: ref(item.orderBatchReference),
      orderItemReference: ref(item.orderItemReference),
      quantity: count(item.quantity, 1, 999),
    });
  });
  if (
    new Set(items.map((item) => item.orderItemReference)).size !== items.length ||
    new Set(items.map((item) => item.orderBatchReference)).size > 100
  )
    return fail();
  // WP-2423 M10: "stop making it too" only for refunded items, never more units than refunded.
  const withdraw = !withWithdraw
    ? []
    : Array.isArray(raw.withdraw) && raw.withdraw.length >= 1 && raw.withdraw.length <= 100
      ? Array.from(raw.withdraw, (value) => {
          const entry = exact(value, ["orderItemReference", "quantity"]);
          const orderItemReference = ref(entry.orderItemReference);
          const refunded = items.find((item) => item.orderItemReference === orderItemReference);
          if (refunded === undefined) return fail();
          return Object.freeze({
            orderItemReference,
            quantity: count(entry.quantity, 1, refunded.quantity),
          });
        })
      : fail();
  if (new Set(withdraw.map((entry) => entry.orderItemReference)).size !== withdraw.length)
    return fail();
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    requestReference: ref(raw.requestReference),
    operationReference: ref(raw.operationReference),
    expectedClaimVersion: count(raw.expectedClaimVersion, 0, 999),
    reasonCode: raw.reasonCode,
    items: Object.freeze(items),
    ...(withNote ? { note: String(raw.note).trim() } : {}),
    ...(withdraw.length > 0 ? { withdraw: Object.freeze(withdraw) } : {}),
  });
}
/** A card-machine refund slip's approval/reference code; too many digits could be a card number. */
const slipReferenceShape = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(value) &&
  value.replace(/[^0-9]/gu, "").length <= 12;
/** WP-2423 M163: money taken back after a refund made by mistake. */
export interface RefundRecoveryCommand {
  readonly orderReference: string;
  readonly operationReference: string;
  readonly method: "Cash" | "CardMachine";
  readonly amountMinor: string;
  readonly reasonCode: "REFUNDED_TOO_MUCH" | "WRONG_ITEM_REFUNDED" | "OTHER";
  /** The card machine's slip reference (required on the card machine, never for cash). */
  readonly slipReference?: string;
}
export interface RefundRecoveryView {
  readonly recoveryReference: string;
  readonly method: "Cash" | "CardMachine";
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
  readonly reasonCode: "REFUNDED_TOO_MUCH" | "WRONG_ITEM_REFUNDED" | "OTHER";
  readonly businessDate: string;
  readonly recordedAt: string;
  readonly recordedByName: string | null;
}
function parseRefundRecovery(value: unknown): RefundRecoveryView {
  const raw = exact(value, [
    "recoveryReference",
    "method",
    "amountMinor",
    "currencyCode",
    "reasonCode",
    "businessDate",
    "recordedAt",
    "recordedByName",
  ]);
  if (
    (raw.method !== "Cash" && raw.method !== "CardMachine") ||
    raw.currencyCode !== "CAD" ||
    typeof raw.amountMinor !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.amountMinor) ||
    !["REFUNDED_TOO_MUCH", "WRONG_ITEM_REFUNDED", "OTHER"].includes(String(raw.reasonCode)) ||
    typeof raw.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(raw.businessDate) ||
    typeof raw.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.recordedAt)) ||
    (raw.recordedByName !== null &&
      (typeof raw.recordedByName !== "string" || raw.recordedByName.length > 200))
  )
    return fail();
  return Object.freeze({
    recoveryReference: ref(raw.recoveryReference),
    method: raw.method,
    amountMinor: raw.amountMinor,
    currencyCode: "CAD" as const,
    reasonCode: raw.reasonCode as RefundRecoveryView["reasonCode"],
    businessDate: raw.businessDate,
    recordedAt: raw.recordedAt,
    recordedByName: raw.recordedByName as string | null,
  });
}
export function createOrdinaryRefundClient(fetcher: typeof fetch = fetch) {
  const send = async (
    path: string,
    body: string,
    csrf: string,
    status: number,
    signal?: AbortSignal,
  ) => {
    if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted)
      return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
      });
      if (controller.signal.aborted) return fail();
      if (await responseNeedsFullSignIn(response))
        throw new OrdinaryRefundClientError(FULL_SIGN_IN_REQUIRED);
      if (response.status === 401 || response.status === 403)
        throw new OrdinaryRefundClientError("Denied");
      // M126 I.5: a payment this Store has no record of (another Store's): never "try again".
      if (response.status === 404 && (await replyError(response)) === "refund_payment_not_found")
        throw new OrdinaryRefundClientError("NotFound");
      // v15 2026-10-18: a read that met a refund recorded while it was loading answers 409
      // changed_while_loading; a busy server answers 503 retry_later. Neither is a refusal.
      if (response.status === 409 || response.status === 503) {
        const error = await replyError(response);
        if (response.status === 409)
          throw new OrdinaryRefundClientError(
            error === "changed_while_loading"
              ? "Changed"
              : error === "refund_order_not_accepted"
                ? "OrderNotAccepted"
                : error === "recovery_above_refunded"
                  ? "RecoveryAboveRefunded"
                  : error === "recovery_conflict"
                    ? "RecoveryConflict"
                    : error === "refund_withdraw_needs_approval"
                      ? "WithdrawNeedsApproval"
                      : error === "refund_withdraw_handed_over"
                        ? "WithdrawHandedOver"
                        : error === "refund_withdraw_everything"
                          ? "WithdrawEverything"
                          : error === "refund_withdraw_kitchen_changed"
                            ? "WithdrawKitchenChanged"
                            : "Conflict",
          );
        if (error === "retry_later") throw new RetryLater();
        return fail();
      }
      if (
        response.status !== status ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (text.length > 300000 || controller.signal.aborted) return fail();
      return object(JSON.parse(text));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const attempts = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return fail();
    const parsed = value.map(ref);
    if (new Set(parsed).size !== parsed.length) return fail();
    return Object.freeze(parsed);
  };
  const boundary = async <T>(work: () => Promise<T>, mutation: boolean): Promise<T> => {
    // A read that changed while loading, or met a busy server, is read once more by itself
    // (after a short pause) before staff are told anything; a command is never resent here.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const retryable =
          error instanceof RetryLater ||
          (error instanceof OrdinaryRefundClientError && error.code === "Changed");
        if (!mutation && retryable && attempt === 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, error instanceof RetryLater ? 800 : 200),
          );
          continue;
        }
        if (
          error instanceof OrdinaryRefundClientError &&
          (error.code === "Denied" ||
            error.code === "NotFound" ||
            error.code === FULL_SIGN_IN_REQUIRED ||
            error.code === "Conflict" ||
            error.code === "OrderNotAccepted" ||
            error.code === "RecoveryAboveRefunded" ||
            error.code === "RecoveryConflict" ||
            error.code === "WithdrawNeedsApproval" ||
            error.code === "WithdrawHandedOver" ||
            error.code === "WithdrawEverything" ||
            error.code === "WithdrawKitchenChanged" ||
            (!mutation && error.code === "Changed"))
        )
          throw error;
        throw new OrdinaryRefundClientError(mutation ? "OutcomeUnknown" : "Unavailable");
      }
    }
  };
  return Object.freeze({
    async context(paymentIntentReference: string, csrf: string, signal?: AbortSignal) {
      ref(paymentIntentReference);
      return boundary(async () => {
        const reply = await send(
          "/merchant/payments/refunds/context",
          JSON.stringify({ paymentIntentReference }),
          csrf,
          200,
          signal,
        );
        const withBlocked = Object.hasOwn(reply, "requestBlocked");
        const withSend = Object.hasOwn(reply, "canSend");
        const withRecovery = Object.hasOwn(reply, "recoveries");
        const data = exact(reply, [
          "paymentIntentReference",
          "paymentAttemptReference",
          "orderReference",
          "orderBatchReference",
          "observedAt",
          "paymentState",
          "paymentMethod",
          "currencyCode",
          "capturedAmountMinor",
          "confirmedRefundMinor",
          "pendingRefundMinor",
          "canRequest",
          ...(withBlocked ? ["requestBlocked"] : []),
          ...(withSend ? ["canSend"] : []),
          ...(withRecovery ? ["canRecover", "recoveries"] : []),
        ]);
        // WP-2423 M163: money taken back on the order (absent from an older server: none).
        if (
          withRecovery &&
          (typeof data.canRecover !== "boolean" ||
            !Array.isArray(data.recoveries) ||
            data.recoveries.length > 1000)
        )
          return fail();
        const recoveries = withRecovery
          ? (data.recoveries as unknown[]).map(parseRefundRecovery)
          : [];
        if (typeof data.canRequest !== "boolean") return fail();
        if (withSend && typeof data.canSend !== "boolean") return fail();
        // WP-2423 M13: why they may not record a request (absent from an older server).
        const requestBlocked = withBlocked ? data.requestBlocked : null;
        if (requestBlocked !== null && requestBlocked !== "SoleOperatorOff") return fail();
        // WP-2423 item 4: a payment taken on the store's card machine is refunded on that machine.
        if (
          data.paymentMethod !== "Online" &&
          (data.paymentMethod !== "CardMachine" || data.paymentState !== "Captured")
        )
          return fail();
        if (
          data.paymentIntentReference !== paymentIntentReference ||
          typeof data.observedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(data.observedAt) ||
          !Number.isFinite(Date.parse(data.observedAt))
        )
          return fail();
        if (
          data.paymentState !== "Captured" &&
          data.paymentState !== "Unresolved" &&
          data.paymentState !== "Failed"
        )
          return fail();
        let capturedAmountMinor: string | null = null,
          confirmedRefundMinor: string | null = null,
          pendingRefundMinor: string | null = null;
        if (data.paymentState === "Captured") {
          if (data.currencyCode !== "CAD") return fail();
          capturedAmountMinor = money(data.capturedAmountMinor);
          confirmedRefundMinor = money(data.confirmedRefundMinor);
          pendingRefundMinor = money(data.pendingRefundMinor);
          if (
            BigInt(capturedAmountMinor) <= 0n ||
            BigInt(confirmedRefundMinor) + BigInt(pendingRefundMinor) > BigInt(capturedAmountMinor)
          )
            return fail();
        } else if (
          data.currencyCode !== null ||
          data.capturedAmountMinor !== null ||
          data.confirmedRefundMinor !== null ||
          data.pendingRefundMinor !== null
        )
          return fail();
        return Object.freeze({
          paymentIntentReference,
          paymentAttemptReference: ref(data.paymentAttemptReference),
          orderReference: ref(data.orderReference),
          orderBatchReference: ref(data.orderBatchReference),
          observedAt: data.observedAt,
          paymentState: data.paymentState,
          paymentMethod: data.paymentMethod as "Online" | "CardMachine",
          currencyCode: data.paymentState === "Captured" ? ("CAD" as const) : null,
          capturedAmountMinor,
          confirmedRefundMinor,
          pendingRefundMinor,
          /** WP-2423 Q5: only a Store Manager records refund requests. */
          canRequest: data.canRequest,
          /** WP-2423 M13: an Owner whose sole operator is off approves, and is told how to record. */
          requestBlocked: requestBlocked as "SoleOperatorOff" | null,
          /**
           * WP-2423 M14: they send what they request; a cashier's request is recorded only and a
           * manager or the owner sends it. An older server: whoever may request sends.
           */
          canSend: withSend ? (data.canSend as boolean) : data.canRequest,
          /** WP-2423 M163: may record money taken back (a Store Manager or the Owner). */
          canRecover: withRecovery ? (data.canRecover as boolean) : false,
          recoveries: Object.freeze(recoveries),
        });
      }, false);
    },
    /**
     * WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5): record money taken back on an order
     * after a refund made by mistake. One operation per attempt: after an unknown result, retry
     * with the same operation and the server answers the same record.
     */
    async recover(command: RefundRecoveryCommand, csrf: string, signal?: AbortSignal) {
      ref(command.orderReference);
      ref(command.operationReference);
      if (
        (command.method !== "Cash" && command.method !== "CardMachine") ||
        !/^[1-9][0-9]{0,8}$/u.test(command.amountMinor) ||
        !["REFUNDED_TOO_MUCH", "WRONG_ITEM_REFUNDED", "OTHER"].includes(command.reasonCode) ||
        (command.method === "CardMachine") !== (command.slipReference !== undefined) ||
        (command.slipReference !== undefined && !slipReferenceShape(command.slipReference))
      )
        return fail();
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/recover",
            JSON.stringify({
              orderReference: command.orderReference,
              operationReference: command.operationReference,
              method: command.method,
              amountMinor: command.amountMinor,
              reasonCode: command.reasonCode,
              ...(command.slipReference === undefined
                ? {}
                : { slipReference: command.slipReference }),
            }),
            csrf,
            200,
            signal,
          ),
          ["status", "orderReference", "recovery"],
        );
        if (
          (data.status !== "Recorded" && data.status !== "AlreadyRecorded") ||
          data.orderReference !== command.orderReference
        )
          return fail();
        const recovery = parseRefundRecovery(data.recovery);
        if (recovery.amountMinor !== command.amountMinor || recovery.method !== command.method)
          return fail();
        return Object.freeze({ status: data.status, recovery });
      }, true);
    },
    async status(
      orderReference: string,
      operationReference: string,
      csrf: string,
      signal?: AbortSignal,
    ) {
      ref(orderReference);
      ref(operationReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/status",
            JSON.stringify({ orderReference, operationReference }),
            csrf,
            200,
            signal,
          ),
          [
            "orderReference",
            "requestReference",
            "operationReference",
            "observedAt",
            "currencyCode",
            "amountMinor",
            "payments",
          ],
        );
        if (
          data.orderReference !== orderReference ||
          data.operationReference !== operationReference ||
          data.currencyCode !== "CAD" ||
          typeof data.observedAt !== "string" ||
          !Number.isFinite(Date.parse(data.observedAt)) ||
          new Date(data.observedAt).toISOString() !== data.observedAt ||
          !Array.isArray(data.payments) ||
          data.payments.length < 1 ||
          data.payments.length > 100
        )
          return fail();
        const payments = data.payments.map((value) => {
          const entry = exact(value, [
            "paymentAttemptReference",
            "paymentIntentReference",
            "state",
            "method",
            "refundedOnCardMachineAt",
            "cardMachineSlipReference",
            "executionOperationReference",
            "executionApprovalReference",
            "amountMinor",
            "confirmedMinor",
            "pendingMinor",
          ]);
          // WP-2423 item 4: refunded on the store's card machine (recorded there) or online.
          if (entry.method !== "Online" && entry.method !== "CardMachine") return fail();
          const cardMachine = entry.method === "CardMachine";
          if (
            (cardMachine &&
              (entry.executionOperationReference !== null ||
                (entry.state !== "NotDispatched" && entry.state !== "Confirmed"))) ||
            ((!cardMachine || entry.state !== "Confirmed") &&
              entry.refundedOnCardMachineAt !== null) ||
            (cardMachine &&
              entry.state === "Confirmed" &&
              (typeof entry.refundedOnCardMachineAt !== "string" ||
                !Number.isFinite(Date.parse(entry.refundedOnCardMachineAt)))) ||
            // The slip reference of a recorded card-machine refund (optional, never a card number).
            (entry.cardMachineSlipReference !== null &&
              (!cardMachine ||
                entry.state !== "Confirmed" ||
                !slipReferenceShape(entry.cardMachineSlipReference)))
          )
            return fail();
          if (
            entry.state !== "NotDispatched" &&
            entry.state !== "Prepared" &&
            entry.state !== "NeedsReconciliation" &&
            entry.state !== "Confirmed"
          )
            return fail();
          const amountMinor = money(entry.amountMinor),
            confirmedMinor = money(entry.confirmedMinor),
            pendingMinor = money(entry.pendingMinor);
          if (
            amountMinor === "0" ||
            BigInt(confirmedMinor) + BigInt(pendingMinor) !== BigInt(amountMinor) ||
            (entry.state === "Confirmed"
              ? confirmedMinor !== amountMinor || pendingMinor !== "0"
              : confirmedMinor !== "0" || pendingMinor !== amountMinor)
          )
            return fail();
          const executionOperationReference =
            entry.state === "NotDispatched" || cardMachine
              ? entry.executionOperationReference === null
                ? null
                : fail()
              : ref(entry.executionOperationReference);
          const executionApprovalReference =
            entry.executionApprovalReference === null || executionOperationReference === null
              ? entry.executionApprovalReference === null
                ? null
                : fail()
              : ref(entry.executionApprovalReference);
          return Object.freeze({
            executionOperationReference,
            executionApprovalReference,
            paymentAttemptReference: ref(entry.paymentAttemptReference),
            paymentIntentReference: ref(entry.paymentIntentReference),
            state: entry.state,
            method: entry.method as "Online" | "CardMachine",
            refundedOnCardMachineAt: entry.refundedOnCardMachineAt as string | null,
            cardMachineSlipReference: entry.cardMachineSlipReference as string | null,
            amountMinor,
            confirmedMinor,
            pendingMinor,
          });
        });
        if (
          new Set(payments.map((p) => p.paymentAttemptReference)).size !== payments.length ||
          new Set(payments.map((p) => p.paymentIntentReference)).size !== payments.length ||
          payments.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n) !==
            BigInt(money(data.amountMinor))
        )
          return fail();
        return Object.freeze({
          orderReference,
          operationReference,
          requestReference: ref(data.requestReference),
          observedAt: data.observedAt,
          currencyCode: "CAD" as const,
          amountMinor: money(data.amountMinor),
          payments: Object.freeze(payments),
        });
      }, false);
    },
    /** WP-2423 Q5: where one refund request stands (see RefundRequestProgress). */
    async progress(
      orderReference: string,
      requestReference: string,
      csrf: string,
      signal?: AbortSignal,
    ) {
      ref(orderReference);
      ref(requestReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/progress",
            JSON.stringify({ orderReference, requestReference }),
            csrf,
            200,
            signal,
          ),
          ["requestReference", "progress", "observedAt"],
        );
        if (
          data.requestReference !== requestReference ||
          !refundRequestProgress.includes(data.progress as RefundRequestProgress)
        )
          return fail();
        return data.progress as RefundRequestProgress;
      }, false);
    },
    async items(orderReference: string, csrf: string, signal?: AbortSignal) {
      ref(orderReference);
      return boundary(async () => {
        const rawItems = (await send(
          "/merchant/payments/refunds/items",
          JSON.stringify({ orderReference }),
          csrf,
          200,
          signal,
        )) as Record<string, unknown> | null;
        const data = exact(rawItems, [
          "orderReference",
          "orderNumber",
          "canRequest",
          "claimVersion",
          "items",
          "recentRequests",
          ...("canWithdraw" in (rawItems ?? {}) ? ["canWithdraw"] : []),
        ]);
        if (typeof data.canRequest !== "boolean") return fail();
        if ("canWithdraw" in data && typeof data.canWithdraw !== "boolean") return fail();
        if (
          data.orderReference !== orderReference ||
          !Array.isArray(data.items) ||
          data.items.length > 1000
        )
          return fail();
        const items = data.items.map((value) => {
          const withKitchen = value !== null && typeof value === "object" && "kitchen" in value;
          const item = exact(value, [
              "orderBatchReference",
              "orderItemReference",
              "label",
              "quantity",
              "unclaimedQuantity",
              "paymentCaptured",
              "refundedByCancellation",
              "paymentIntentReference",
              "paymentMethod",
              ...(withKitchen ? ["kitchen", "withdrawnQuantity"] : []),
            ]),
            quantity = count(item.quantity, 1, 999),
            unclaimedQuantity = count(item.unclaimedQuantity, 0, quantity),
            withdrawnQuantity = withKitchen ? count(item.withdrawnQuantity, 0, quantity) : 0;
          if (
            withKitchen &&
            item.kitchen !== null &&
            item.kitchen !== "NotStarted" &&
            item.kitchen !== "Started" &&
            item.kitchen !== "Cancelled"
          )
            return fail();
          if (
            typeof item.paymentCaptured !== "boolean" ||
            typeof item.refundedByCancellation !== "boolean" ||
            (item.refundedByCancellation && (!item.paymentCaptured || unclaimedQuantity !== 0)) ||
            (!item.paymentCaptured && unclaimedQuantity !== 0) ||
            (item.paymentCaptured
              ? item.paymentMethod !== "Online" && item.paymentMethod !== "CardMachine"
              : item.paymentMethod !== null)
          )
            return fail();
          return Object.freeze({
            orderBatchReference: ref(item.orderBatchReference),
            orderItemReference: ref(item.orderItemReference),
            label: label(item.label),
            quantity,
            unclaimedQuantity,
            paymentCaptured: item.paymentCaptured,
            refundedByCancellation: item.refundedByCancellation,
            paymentIntentReference: item.paymentCaptured
              ? ref(item.paymentIntentReference)
              : item.paymentIntentReference === null
                ? null
                : fail(),
            /** WP-2423 item 4: refunded on the store's card machine, or online. */
            paymentMethod: item.paymentMethod as "Online" | "CardMachine" | null,
            kitchen: withKitchen
              ? (item.kitchen as "NotStarted" | "Started" | "Cancelled" | null)
              : null,
            withdrawnQuantity,
          });
        });
        if (new Set(items.map((item) => item.orderItemReference)).size !== items.length)
          return fail();
        const claimVersion = count(data.claimVersion, 0, 1000);
        if (
          !Array.isArray(data.recentRequests) ||
          data.recentRequests.length !== Math.min(20, claimVersion)
        )
          return fail();
        const recentRequests = data.recentRequests.map((value, index) => {
          const entry = exact(value, [
            "requestReference",
            "operationReference",
            "claimVersion",
            "requestedAt",
            "reasonCode",
            "currencyCode",
            "amountMinor",
            "decline",
            "progress",
            "paymentMethod",
          ]);
          if (
            (entry.paymentMethod !== "Online" && entry.paymentMethod !== "CardMachine") ||
            !refundRequestProgress.includes(entry.progress as RefundRequestProgress) ||
            (entry.progress === "Declined") !== (entry.decline !== null)
          )
            return fail();
          const decline =
            entry.decline === null
              ? null
              : (() => {
                  const raw = exact(entry.decline, [
                    "reasonCode",
                    "declinedAt",
                    "declinerName",
                    "declinedByYou",
                  ]);
                  if (
                    typeof raw.reasonCode !== "string" ||
                    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
                    typeof raw.declinedAt !== "string" ||
                    new Date(raw.declinedAt).toISOString() !== raw.declinedAt ||
                    typeof raw.declinedByYou !== "boolean" ||
                    (raw.declinerName !== null && label(raw.declinerName) !== raw.declinerName)
                  )
                    return fail();
                  return Object.freeze({
                    reasonCode: raw.reasonCode,
                    declinedAt: raw.declinedAt,
                    declinerName: raw.declinerName as string | null,
                    declinedByYou: raw.declinedByYou,
                  });
                })();
          if (
            entry.claimVersion !== claimVersion - Math.min(20, claimVersion) + index + 1 ||
            typeof entry.requestedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.requestedAt)) ||
            new Date(entry.requestedAt).toISOString() !== entry.requestedAt ||
            typeof entry.reasonCode !== "string" ||
            !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.reasonCode) ||
            entry.currencyCode !== "CAD" ||
            money(entry.amountMinor) === "0"
          )
            return fail();
          return Object.freeze({
            requestReference: ref(entry.requestReference),
            operationReference: ref(entry.operationReference),
            claimVersion: count(entry.claimVersion, 1, 1000),
            requestedAt: entry.requestedAt,
            reasonCode: entry.reasonCode,
            currencyCode: "CAD" as const,
            amountMinor: money(entry.amountMinor),
            decline,
            progress: entry.progress as RefundRequestProgress,
            paymentMethod: entry.paymentMethod as "Online" | "CardMachine",
          });
        });
        if (
          new Set(recentRequests.map((entry) => entry.requestReference)).size !==
            recentRequests.length ||
          new Set(recentRequests.map((entry) => entry.operationReference)).size !==
            recentRequests.length
        )
          return fail();
        return Object.freeze({
          recentRequests: Object.freeze(recentRequests),
          orderReference,
          canRequest: data.canRequest,
          /** WP-2423 M10: may say "stop making it too" (false from an older server). */
          canWithdraw: data.canWithdraw === true,
          orderNumber: label(data.orderNumber),
          claimVersion: count(data.claimVersion, 0, 1000),
          items: Object.freeze(items),
        });
      }, false);
    },
    /**
     * WP-2423 item 4: the refund of a request was made on the store's card machine; record it.
     * One operation per attempt (retry with the same operation after an unknown result).
     */
    async recordCardMachineRefund(
      value: {
        readonly operationReference: string;
        readonly orderReference: string;
        readonly requestReference: string;
        readonly slipReference: string | null;
        readonly refundedAt: string | null;
      },
      csrf: string,
      signal?: AbortSignal,
    ) {
      const body = {
        operationReference: ref(value.operationReference),
        orderReference: ref(value.orderReference),
        requestReference: ref(value.requestReference),
        slipReference: value.slipReference,
        refundedAt: value.refundedAt,
      };
      if (
        (body.slipReference !== null && !slipReferenceShape(body.slipReference)) ||
        (body.refundedAt !== null && !Number.isFinite(Date.parse(body.refundedAt)))
      )
        return fail();
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/card-machine-record",
            JSON.stringify(body),
            csrf,
            200,
            signal,
          ),
          ["status", "orderReference", "requestReference", "amountMinor", "refundedAt", "receipt"],
        );
        if (
          (data.status !== "Recorded" && data.status !== "AlreadyRecorded") ||
          data.orderReference !== body.orderReference ||
          data.requestReference !== body.requestReference ||
          typeof data.refundedAt !== "string" ||
          !Number.isFinite(Date.parse(data.refundedAt)) ||
          (data.receipt !== "Issued" &&
            data.receipt !== "NoDigitalReceipt" &&
            data.receipt !== "NotIssued")
        )
          return fail();
        return Object.freeze({
          status: data.status as "Recorded" | "AlreadyRecorded",
          amountMinor: money(data.amountMinor),
          refundedAt: data.refundedAt,
          receipt: data.receipt as "Issued" | "NoDigitalReceipt" | "NotIssued",
        });
      }, true);
    },
    prepareRequest(value: RefundRequestCommand) {
      const snapshot = command(value),
        body = JSON.stringify(snapshot);
      let submitted = false;
      let confirmed: Readonly<{
        amountMinor: string;
        paymentAttemptReferences: readonly string[];
        components: Readonly<Record<string, string>>;
        approvalRequired: boolean | null;
        escalationReasons: readonly EscalationReason[];
        approveAlone: boolean;
      }> | null = null;
      // WP-2423 Q19: whether the requester may approve this refund alone (sole operator). Older
      // servers do not send it; it then reads as false.
      const alone = (data: Record<string, unknown>) => {
        if (!Object.hasOwn(data, "approveAlone")) return false;
        if (typeof data.approveAlone !== "boolean") return fail();
        return data.approveAlone;
      };
      const withAlone = (value: unknown, keys: string[]) =>
        value !== null && typeof value === "object" && Object.hasOwn(value, "approveAlone")
          ? [...keys, "approveAlone"]
          : keys;
      return Object.freeze({
        async preview(csrf: string, signal?: AbortSignal) {
          if (submitted) return fail();
          confirmed = null;
          return boundary(async () => {
            const previewed = await send(
              "/merchant/payments/refunds/preview",
              body,
              csrf,
              200,
              signal,
            );
            const data = exact(
              previewed,
              withAlone(previewed, [
                "status",
                "requestReference",
                "operationReference",
                "claimVersion",
                "currencyCode",
                "amountMinor",
                "paymentAttemptReferences",
                "approvalRequired",
                "escalationReasons",
                "components",
              ]),
            );
            if (
              data.status !== "Previewed" ||
              data.requestReference !== snapshot.requestReference ||
              data.operationReference !== snapshot.operationReference ||
              data.claimVersion !== snapshot.expectedClaimVersion ||
              data.currencyCode !== "CAD"
            )
              return fail();
            const amountMinor = money(data.amountMinor),
              raw = exact(data.components, components);
            const allocation = Object.freeze(
              Object.fromEntries(components.map((key) => [key, money(raw[key])])),
            );
            if (
              BigInt(amountMinor) <= 0n ||
              Object.values(allocation).reduce((sum, part) => sum + BigInt(part), 0n) !==
                BigInt(amountMinor)
            )
              return fail();
            confirmed = Object.freeze({
              amountMinor,
              components: allocation,
              paymentAttemptReferences: attempts(data.paymentAttemptReferences),
              ...escalation(data.approvalRequired, data.escalationReasons),
              approveAlone: alone(data),
            });
            return Object.freeze({
              status: "Previewed" as const,
              currencyCode: "CAD" as const,
              ...confirmed,
            });
          }, false);
        },
        async submit(csrf: string, signal?: AbortSignal) {
          if (!confirmed) return fail();
          const preview = confirmed;
          submitted = true;
          return boundary(async () => {
            const recorded = await send(
              "/merchant/payments/refunds/request",
              body,
              csrf,
              202,
              signal,
            );
            const data = exact(
              recorded,
              withAlone(recorded, [
                "status",
                "requestReference",
                "operationReference",
                "claimVersion",
                "currencyCode",
                "amountMinor",
                "paymentAttemptReferences",
                "approvalRequired",
                "escalationReasons",
                "replayed",
                ...(recorded !== null && typeof recorded === "object" && "prepared" in recorded
                  ? ["prepared"]
                  : []),
              ]),
            );
            // WP-2423 M16: payments the server prepared with the request (sent next from here).
            const prepared = !("prepared" in data)
              ? []
              : Array.isArray(data.prepared) && data.prepared.length <= 100
                ? data.prepared.map((value: unknown) => {
                    const leg = exact(value, ["paymentAttemptReference", "operationReference"]);
                    const attempt = ref(leg.paymentAttemptReference);
                    if (!preview.paymentAttemptReferences.includes(attempt)) return fail();
                    return Object.freeze({
                      paymentAttemptReference: attempt,
                      operationReference: ref(leg.operationReference),
                    });
                  })
                : fail();
            if (
              data.status !== "RequestRecorded" ||
              data.requestReference !== snapshot.requestReference ||
              data.operationReference !== snapshot.operationReference ||
              data.claimVersion !== snapshot.expectedClaimVersion + 1 ||
              data.currencyCode !== "CAD" ||
              data.amountMinor !== preview.amountMinor ||
              typeof data.replayed !== "boolean" ||
              JSON.stringify([...attempts(data.paymentAttemptReferences)].sort()) !==
                JSON.stringify([...preview.paymentAttemptReferences].sort())
            )
              return fail();
            return Object.freeze({
              status: "RequestRecorded" as const,
              requestReference: snapshot.requestReference,
              operationReference: snapshot.operationReference,
              claimVersion: snapshot.expectedClaimVersion + 1,
              currencyCode: "CAD" as const,
              amountMinor: preview.amountMinor,
              paymentAttemptReferences: preview.paymentAttemptReferences,
              ...escalation(data.approvalRequired, data.escalationReasons),
              approveAlone: alone(data),
              replayed: data.replayed,
              prepared: Object.freeze(prepared),
            });
          }, true);
        },
      });
    },
  });
}
