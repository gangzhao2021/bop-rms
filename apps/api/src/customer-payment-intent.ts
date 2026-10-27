import { CustomerStoreClosedError } from "./customer-store-open-gate.js";
import { CustomerDiningPayLaterError } from "./customer-dining-pay-later-round.js";
import { GuestSessionError, readClosedRecord } from "@bop/identity";
import {
  CartError,
  CheckoutValidationError,
  OrderCreationError,
  CheckoutSessionServiceError,
  parseCheckoutSession,
} from "@rms/ordering";
import {
  PaymentTipSelectionError,
  PaymentIntentCreationError,
  parsePaymentIntentCreationRecord,
} from "@rms/payment";
import { createMoney, parseCurrencyCode, type Money } from "@rms/pricing";
import type { Request, RequestHandler, Response } from "express";

export const customerPaymentIntentRoute =
  "/api/v1/checkout-sessions/:checkout_session_id/payment-intents";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
export interface CustomerPaymentIntentInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly checkoutSessionReference: string;
  readonly selectionReference: string;
  readonly tip: Money;
}
/** WP-2423 Q20: another card for the checkout's existing payment after a decline. */
export interface CustomerPaymentRetryInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly checkoutSessionReference: string;
}
/** DEC-DINE-IN-PAY-LATER: send the checkout's round to the kitchen at a table that pays later. */
export interface CustomerPayLaterRoundInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly checkoutSessionReference: string;
  readonly selectionReference: string;
}
export interface CustomerPaymentIntentPort {
  create(input: CustomerPaymentIntentInput): Promise<unknown>;
  sendToKitchen?(input: CustomerPayLaterRoundInput): Promise<{
    readonly status: "Sent" | "AlreadySent";
    readonly orderReference: string;
    readonly totalMinor: bigint;
  }>;
  retry?(input: CustomerPaymentRetryInput): Promise<unknown>;
  /** WP-2423 abandoned payment: the same guest returns to the checkout's open payment. */
  resume?(input: CustomerPaymentRetryInput): Promise<unknown>;
}
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
type ExplicitRejection =
  | "store_closed"
  | "retry_limit"
  | "retry_pending"
  | "already_paid"
  | "window_ended"
  /** WP-2423: items ran out after checkout; no order was placed and nothing was charged. */
  | "items_short"
  /** DEC-DINE-IN-PAY-LATER: this table pays at the end; rounds are sent, not paid. */
  | "pay_later_table"
  /** DEC-DINE-IN-PAY-LATER: this table pays each round as it is sent. */
  | "pay_first_table";
function reject(response: Response, status: number, explicit?: ExplicitRejection) {
  const code =
    explicit ??
    (status === 400
      ? "request_invalid"
      : status === 404
        ? "not_found"
        : status === 409
          ? "intent_conflict"
          : status === 422
            ? "not_ready"
            : "service_unavailable");
  if (status === 503) response.setHeader("Retry-After", "5");
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "payment_" + code, messageKey: "customer.payment." + code },
  });
}
function readCredentials(request: Request) {
  const cookie = request.headers.cookie;
  if (typeof cookie !== "string") throw new Error("invalid credential");
  const parts = cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .filter(([name]) => name === "__Host-bop-guest");
  if (parts.length !== 1 || parts[0]?.length !== 2 || !credential.test(parts[0]?.[1] ?? ""))
    throw new Error("invalid credential");
  const csrf = request.headers["x-csrf-token"];
  if (typeof csrf !== "string" || !credential.test(csrf)) throw new Error("invalid credential");
  return { sessionCredential: parts[0]?.[1] as string, csrfCredential: csrf };
}

function parse(
  request: Request,
  origin: string,
):
  | CustomerPaymentIntentInput
  | (CustomerPaymentRetryInput & { readonly retry: true })
  | (CustomerPaymentRetryInput & { readonly resume: true })
  | (CustomerPayLaterRoundInput & { readonly sendToKitchen: true }) {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json" ||
    Object.keys(request.query).length !== 0
  )
    throw new Error("invalid request");
  const params = request.params as Record<string, unknown>;
  // WP-2423 Q20: `{"retry":true}` asks for another card on the existing payment; the amount and
  // tip come from that payment, never from this request.
  if (
    request.body !== null &&
    typeof request.body === "object" &&
    Object.hasOwn(request.body as object, "retry")
  ) {
    const body = readClosedRecord(request.body, ["retry"]);
    if (body.retry !== true || request.headers["idempotency-key"] !== undefined)
      throw new Error("invalid retry");
    const checkoutSessionReference = params.checkout_session_id;
    if (typeof checkoutSessionReference !== "string" || !uuid.test(checkoutSessionReference))
      throw new Error("invalid reference");
    return { ...readCredentials(request), checkoutSessionReference, retry: true };
  }
  // WP-2423 abandoned payment: `{"resume":true}` returns to the checkout's open payment (same
  // attempt, amount and tip); nothing about the payment comes from this request.
  if (
    request.body !== null &&
    typeof request.body === "object" &&
    Object.hasOwn(request.body as object, "resume")
  ) {
    const body = readClosedRecord(request.body, ["resume"]);
    if (body.resume !== true || request.headers["idempotency-key"] !== undefined)
      throw new Error("invalid resume");
    const checkoutSessionReference = params.checkout_session_id;
    if (typeof checkoutSessionReference !== "string" || !uuid.test(checkoutSessionReference))
      throw new Error("invalid reference");
    return { ...readCredentials(request), checkoutSessionReference, resume: true };
  }
  // DEC-DINE-IN-PAY-LATER: `{"sendToKitchen":true}` sends the round with no payment and no tip;
  // the idempotency key names the attempt, as for a payment.
  if (
    request.body !== null &&
    typeof request.body === "object" &&
    Object.hasOwn(request.body as object, "sendToKitchen")
  ) {
    const body = readClosedRecord(request.body, ["sendToKitchen"]);
    if (body.sendToKitchen !== true) throw new Error("invalid send");
    const checkoutSessionReference = params.checkout_session_id;
    const selectionReference = request.headers["idempotency-key"];
    if (
      typeof checkoutSessionReference !== "string" ||
      !uuid.test(checkoutSessionReference) ||
      typeof selectionReference !== "string" ||
      !uuid.test(selectionReference)
    )
      throw new Error("invalid reference");
    return {
      ...readCredentials(request),
      checkoutSessionReference,
      selectionReference,
      sendToKitchen: true,
    };
  }
  const body = readClosedRecord(request.body, ["tip"]);
  const tip = readClosedRecord(body.tip, ["amountMinor", "currency"]);
  if (
    typeof tip.amountMinor !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(tip.amountMinor) ||
    tip.currency !== "CAD" ||
    BigInt(tip.amountMinor) > 9223372036854775807n
  )
    throw new Error("invalid amount");
  const reference = (value: unknown) => {
    if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid reference");
    return value;
  };
  return {
    ...readCredentials(request),
    checkoutSessionReference: reference(request.params.checkout_session_id),
    selectionReference: reference(request.headers["idempotency-key"]),
    tip: createMoney({
      amountMinor: BigInt(tip.amountMinor),
      currencyCode: parseCurrencyCode("CAD"),
    }),
  };
}
function failure(error: unknown) {
  if (error instanceof GuestSessionError) return 404;
  if (error instanceof CustomerDiningPayLaterError)
    return (
      { PayFirst: 409, PayLater: 409, NotJoined: 404, Invalid: 400, Unavailable: 503 } as const
    )[error.code];
  if (error instanceof CheckoutSessionServiceError)
    return (
      {
        INPUT_INVALID: 400,
        PERMISSION_DENIED: 404,
        INTENT_CONFLICT: 409,
        DEPENDENCY_UNAVAILABLE: 503,
        STORE_CLOSED: 409,
        CHECKOUT_IN_PROGRESS: 409,
        ITEM_UNAVAILABLE: 409,
        ITEM_SHORT: 409,
      } as const
    )[error.code];
  if (error instanceof PaymentTipSelectionError)
    return { PAYMENT_TIP_INVALID: 400, PAYMENT_TIP_CONFLICT: 409, PAYMENT_TIP_UNAVAILABLE: 503 }[
      error.code
    ];
  if (
    error instanceof OrderCreationError ||
    error instanceof CheckoutValidationError ||
    error instanceof CartError
  ) {
    const codes: Partial<
      Record<
        OrderCreationError["code"] | CheckoutValidationError["code"] | CartError["code"],
        number
      >
    > = {
      ORDER_CREATE_PERMISSION_DENIED: 404,
      CHECKOUT_PERMISSION_DENIED: 404,
      CART_PERMISSION_DENIED: 404,
      ORDER_CREATE_INPUT_INVALID: 400,
      ORDER_CREATE_IDEMPOTENCY_CONFLICT: 409,
      CART_IDEMPOTENCY_CONFLICT: 409,
      CART_VERSION_CONFLICT: 409,
      CHECKOUT_CART_VERSION_CONFLICT: 409,
      ORDER_CREATE_VALIDATION_EXPIRED: 422,
      CHECKOUT_REQUOTE_REQUIRED: 422,
      CHECKOUT_ITEM_UNAVAILABLE: 422,
      CHECKOUT_STOCK_SHORT: 409,
      ORDER_CREATE_STOCK_SHORT: 409,
      CHECKOUT_QUOTE_EXPIRED: 422,
      CHECKOUT_QUOTE_MISSING: 422,
      CHECKOUT_SELECTION_INVALID: 422,
      CHECKOUT_INPUT_INVALID: 400,
      CHECKOUT_CART_UNAVAILABLE: 404,
      CHECKOUT_CART_EMPTY: 409,
      CHECKOUT_CART_NOT_ACTIVE: 409,
      CART_INPUT_INVALID: 400,
      CART_UNAVAILABLE: 404,
      CART_QUOTE_EXPIRED: 422,
      CART_QUOTE_INVALID: 422,
      CART_SELECTION_INVALID: 422,
      CART_EXPIRED: 409,
      CART_ABANDONED: 409,
    };
    return codes[error.code] ?? 503;
  }
  if (error instanceof PaymentIntentCreationError)
    return (
      {
        PAYMENT_INTENT_INPUT_INVALID: 400,
        PAYMENT_INTENT_PERMISSION_DENIED: 404,
        PAYMENT_INTENT_IDEMPOTENCY_CONFLICT: 409,
        PAYMENT_INTENT_ORDER_NOT_READY: 422,
        PAYMENT_INTENT_PREPARATION_EXPIRED: 422,
        PAYMENT_INTENT_PROVIDER_DISABLED: 503,
        PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE: 503,
        PAYMENT_INTENT_PROVIDER_RESULT_INVALID: 503,
        PAYMENT_INTENT_RETRY_NOT_ALLOWED: 409,
        PAYMENT_INTENT_RETRY_LIMIT_REACHED: 409,
        PAYMENT_INTENT_ALREADY_PAID: 409,
      } as const
    )[error.code];
  return 503;
}
/**
 * WP-2423: the Store's stock no longer covers the order (found again when the order is submitted,
 * before any payment is started), so the guest changes their cart; nothing was charged.
 */
function stockRejection(error: unknown): ExplicitRejection | undefined {
  if (error instanceof CustomerDiningPayLaterError && error.code === "PayLater")
    return "pay_later_table";
  if (error instanceof CustomerDiningPayLaterError && error.code === "PayFirst")
    return "pay_first_table";
  if (
    (error instanceof CheckoutValidationError && error.code === "CHECKOUT_STOCK_SHORT") ||
    (error instanceof OrderCreationError && error.code === "ORDER_CREATE_STOCK_SHORT") ||
    (error instanceof CheckoutSessionServiceError && error.code === "ITEM_SHORT")
  )
    return "items_short";
  return undefined;
}
/** WP-2423 Q20: what the customer needs to know when another card cannot be tried. */
function retryRejection(error: unknown): ExplicitRejection | undefined {
  if (!(error instanceof PaymentIntentCreationError)) return undefined;
  return (
    {
      PAYMENT_INTENT_RETRY_LIMIT_REACHED: "retry_limit",
      PAYMENT_INTENT_RETRY_NOT_ALLOWED: "retry_pending",
      PAYMENT_INTENT_ALREADY_PAID: "already_paid",
      PAYMENT_INTENT_PREPARATION_EXPIRED: "window_ended",
    } as const satisfies Partial<Record<PaymentIntentCreationError["code"], ExplicitRejection>>
  )[error.code as never];
}
export class CustomerPaymentIntentHandler {
  readonly #port: CustomerPaymentIntentPort;
  readonly #origin: string;
  constructor(options: { port: CustomerPaymentIntentPort; allowedOrigin: string }) {
    this.#port = options.port;
    this.#origin = new URL(options.allowedOrigin).origin;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: ReturnType<typeof parse>;
      try {
        input = parse(request, this.#origin);
      } catch {
        reject(response, 400);
        return;
      }
      const retry = "retry" in input || "resume" in input;
      if ("sendToKitchen" in input) {
        if (this.#port.sendToKitchen === undefined) {
          reject(response, 503);
          return;
        }
        let sent: Awaited<ReturnType<NonNullable<CustomerPaymentIntentPort["sendToKitchen"]>>>;
        try {
          sent = await this.#port.sendToKitchen({
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            checkoutSessionReference: input.checkoutSessionReference,
            selectionReference: input.selectionReference,
          });
        } catch (error) {
          if (error instanceof CustomerStoreClosedError) {
            reject(response, 409, "store_closed");
            return;
          }
          reject(response, failure(error), stockRejection(error));
          return;
        }
        if (
          (sent.status !== "Sent" && sent.status !== "AlreadySent") ||
          typeof sent.totalMinor !== "bigint" ||
          sent.totalMinor <= 0n ||
          !uuid.test(sent.orderReference)
        ) {
          reject(response, 503);
          return;
        }
        response.status(sent.status === "Sent" ? 201 : 200).json({
          schemaVersion: 1,
          round: {
            checkoutSessionReference: input.checkoutSessionReference,
            orderReference: sent.orderReference,
            status: sent.status,
            total: { amountMinor: sent.totalMinor.toString(), currency: "CAD" },
          },
        });
        return;
      }
      let result: unknown;
      try {
        if ("resume" in input) {
          if (this.#port.resume === undefined) {
            reject(response, 503);
            return;
          }
          result = await this.#port.resume({
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            checkoutSessionReference: input.checkoutSessionReference,
          });
        } else if ("retry" in input) {
          if (this.#port.retry === undefined) {
            reject(response, 503);
            return;
          }
          result = await this.#port.retry({
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            checkoutSessionReference: input.checkoutSessionReference,
          });
        } else result = await this.#port.create(input);
      } catch (error) {
        // WP-2423 Q4: the Store stopped taking orders before payment started; nothing was charged.
        if (error instanceof CustomerStoreClosedError) {
          reject(response, 409, "store_closed");
          return;
        }
        const explicit = retry ? retryRejection(error) : stockRejection(error);
        reject(response, failure(error), explicit);
        return;
      }
      try {
        const envelope = readClosedRecord(result, ["status", "record", "session"]);
        if (
          envelope.status !== "Created" &&
          envelope.status !== "AlreadyCreated" &&
          envelope.status !== "Processing"
        )
          throw new Error("invalid status");
        const session = parseCheckoutSession(envelope.session);
        const record = parsePaymentIntentCreationRecord(envelope.record);
        const prepared = record.intent.preparation,
          v = session.validation;
        if (
          session.checkoutSessionReference !== input.checkoutSessionReference ||
          String(record.intent.paymentOperationReference) !== session.paymentOperationReference ||
          String(prepared.submissionReference) !== session.submissionReference ||
          String(prepared.sourceCartReference) !== v.cartReference ||
          prepared.sourceCartVersion !== v.cartVersion ||
          String(prepared.quoteReference) !== v.quoteReference ||
          String(prepared.guestSessionReference) !== v.guestSessionReference ||
          String(prepared.brandReference) !== v.brandReference ||
          String(prepared.storeReference) !== v.storeReference ||
          ("tip" in input &&
            (prepared.tip.amountMinor !== input.tip.amountMinor ||
              prepared.tip.currencyCode !== input.tip.currencyCode))
        )
          throw new Error("invalid binding");
        response
          .status(
            envelope.status === "Processing" ? 202 : envelope.status === "Created" ? 201 : 200,
          )
          .json({
            schemaVersion: 1,
            payment: {
              checkoutSessionReference: session.checkoutSessionReference,
              paymentIntentReference: record.intent.paymentIntentReference,
              orderReference: prepared.orderReference,
              creationStatus: envelope.status,
              total: { amountMinor: prepared.total.amountMinor.toString(), currency: "CAD" },
            },
          });
      } catch {
        reject(response, 503);
      }
    };
  }
}
export const unavailableCustomerPaymentIntentHandler: RequestHandler = (_request, response) => {
  protect(response);
  reject(response, 503);
};
