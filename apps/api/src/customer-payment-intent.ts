import { CustomerStoreClosedError } from "./customer-store-open-gate.js";
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
export interface CustomerPaymentIntentPort {
  create(input: CustomerPaymentIntentInput): Promise<unknown>;
}
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, status: number, explicit?: "store_closed") {
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

function parse(request: Request, origin: string): CustomerPaymentIntentInput {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json" ||
    Object.keys(request.query).length !== 0
  )
    throw new Error("invalid request");
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
  if (error instanceof CheckoutSessionServiceError)
    return (
      {
        INPUT_INVALID: 400,
        PERMISSION_DENIED: 404,
        INTENT_CONFLICT: 409,
        DEPENDENCY_UNAVAILABLE: 503,
        STORE_CLOSED: 409,
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
      } as const
    )[error.code];
  return 503;
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
      let input: CustomerPaymentIntentInput;
      try {
        input = parse(request, this.#origin);
      } catch {
        reject(response, 400);
        return;
      }
      let result: unknown;
      try {
        result = await this.#port.create(input);
      } catch (error) {
        // WP-2423 Q4: the Store stopped taking orders before payment started; nothing was charged.
        if (error instanceof CustomerStoreClosedError) {
          reject(response, 409, "store_closed");
          return;
        }
        reject(response, failure(error));
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
          prepared.tip.amountMinor !== input.tip.amountMinor ||
          prepared.tip.currencyCode !== input.tip.currencyCode
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
