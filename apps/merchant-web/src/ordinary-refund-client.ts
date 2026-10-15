import {
  FULL_SIGN_IN_REQUIRED,
  responseNeedsFullSignIn,
  type FullSignInRequired,
} from "./full-sign-in.js";

export class OrdinaryRefundClientError extends Error {
  constructor(
    readonly code: "Denied" | FullSignInRequired | "Conflict" | "Unavailable" | "OutcomeUnknown",
  ) {
    super("Refund request could not be confirmed");
  }
}
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
  readonly paymentIntentReference: string | null;
  readonly paymentMethod: "Online" | "CardMachine" | null;
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
}
function command(value: RefundRequestCommand) {
  const withNote = Object.prototype.hasOwnProperty.call(value, "note");
  const raw = exact(value, [
    "orderReference",
    "requestReference",
    "operationReference",
    "expectedClaimVersion",
    "reasonCode",
    "items",
    ...(withNote ? ["note"] : []),
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
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    requestReference: ref(raw.requestReference),
    operationReference: ref(raw.operationReference),
    expectedClaimVersion: count(raw.expectedClaimVersion, 0, 999),
    reasonCode: raw.reasonCode,
    items: Object.freeze(items),
    ...(withNote ? { note: String(raw.note).trim() } : {}),
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
      if (response.status === 409) throw new OrdinaryRefundClientError("Conflict");
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
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof OrdinaryRefundClientError &&
        (error.code === "Denied" ||
          error.code === FULL_SIGN_IN_REQUIRED ||
          error.code === "Conflict")
      )
        throw error;
      throw new OrdinaryRefundClientError(mutation ? "OutcomeUnknown" : "Unavailable");
    }
  };
  return Object.freeze({
    async context(paymentIntentReference: string, csrf: string, signal?: AbortSignal) {
      ref(paymentIntentReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/context",
            JSON.stringify({ paymentIntentReference }),
            csrf,
            200,
            signal,
          ),
          [
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
          ],
        );
        if (typeof data.canRequest !== "boolean") return fail();
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
        });
      }, false);
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
                !Number.isFinite(Date.parse(entry.refundedOnCardMachineAt))))
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
    /** WP-2423 Q5: where one refund request stands (Recorded, Sending, Refunded, Declined). */
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
          !["Recorded", "Sending", "Refunded", "Declined"].includes(String(data.progress))
        )
          return fail();
        return data.progress as "Recorded" | "Sending" | "Refunded" | "Declined";
      }, false);
    },
    async items(orderReference: string, csrf: string, signal?: AbortSignal) {
      ref(orderReference);
      return boundary(async () => {
        const data = exact(
          await send(
            "/merchant/payments/refunds/items",
            JSON.stringify({ orderReference }),
            csrf,
            200,
            signal,
          ),
          [
            "orderReference",
            "orderNumber",
            "canRequest",
            "claimVersion",
            "items",
            "recentRequests",
          ],
        );
        if (typeof data.canRequest !== "boolean") return fail();
        if (
          data.orderReference !== orderReference ||
          !Array.isArray(data.items) ||
          data.items.length > 1000
        )
          return fail();
        const items = data.items.map((value) => {
          const item = exact(value, [
              "orderBatchReference",
              "orderItemReference",
              "label",
              "quantity",
              "unclaimedQuantity",
              "paymentCaptured",
              "paymentIntentReference",
              "paymentMethod",
            ]),
            quantity = count(item.quantity, 1, 999),
            unclaimedQuantity = count(item.unclaimedQuantity, 0, quantity);
          if (
            typeof item.paymentCaptured !== "boolean" ||
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
            paymentIntentReference: item.paymentCaptured
              ? ref(item.paymentIntentReference)
              : item.paymentIntentReference === null
                ? null
                : fail(),
            /** WP-2423 item 4: refunded on the store's card machine, or online. */
            paymentMethod: item.paymentMethod as "Online" | "CardMachine" | null,
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
            !["Recorded", "Sending", "Refunded", "Declined"].includes(String(entry.progress)) ||
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
            progress: entry.progress as "Recorded" | "Sending" | "Refunded" | "Declined",
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
        (body.slipReference !== null &&
          (!/^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(body.slipReference) ||
            body.slipReference.replace(/[^0-9]/gu, "").length > 12)) ||
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
              ]),
            );
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
            });
          }, true);
        },
      });
    },
  });
}
