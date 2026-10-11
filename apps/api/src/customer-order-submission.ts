import { GuestSessionError, readClosedRecord } from "@bop/identity";
import {
  CartError,
  CheckoutSessionServiceError,
  CheckoutValidationError,
  OrderCreationError,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  type CreateOrderResult,
} from "@rms/ordering";
import type { Request, RequestHandler, Response } from "express";

export const customerOrderSubmissionRoute = "/api/v1/orders";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
export interface CustomerOrderSubmissionCommand {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly submissionReference: string;
  readonly cartReference: string;
  readonly expectedCartVersion: number;
  readonly quoteReference: string;
}
/** The supplied owner composition resolves current Guest/Store/channel and authorizes every call. */
export interface CustomerOrderSubmissionPort {
  readonly quoteVersion: 1 | 2;
  create(input: CustomerOrderSubmissionCommand): Promise<CreateOrderResult<1 | 2>>;
}
const failures = {
  order_request_invalid: 400,
  order_not_found: 404,
  order_version_conflict: 409,
  order_idempotency_conflict: 409,
  order_store_closed: 409,
  order_requote_required: 422,
  order_service_unavailable: 503,
} as const;
type Failure = keyof typeof failures;
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, code: Failure) {
  if (code === "order_service_unavailable") response.setHeader("Retry-After", "5");
  response.status(failures[code]).json({
    schemaVersion: 1,
    error: { code, messageKey: "customer.order." + code.slice(6) },
  });
}
function parse(request: Request, origin: string): CustomerOrderSubmissionCommand {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json"
  )
    throw new Error("invalid request");
  const raw = readClosedRecord(request.body, ["cartReference", "cartVersion", "quoteReference"]);
  const reference = (value: unknown) => {
    if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid reference");
    return value;
  };
  if (
    !Number.isSafeInteger(raw.cartVersion) ||
    Number(raw.cartVersion) < 1 ||
    Number(raw.cartVersion) > 2147483647
  )
    throw new Error("invalid version");
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
  return Object.freeze({
    sessionCredential: parts[0]?.[1] as string,
    csrfCredential: csrf,
    submissionReference: reference(request.headers["idempotency-key"]),
    cartReference: reference(raw.cartReference),
    expectedCartVersion: Number(raw.cartVersion),
    quoteReference: reference(raw.quoteReference),
  });
}
function failure(error: unknown): Failure {
  if (error instanceof CheckoutSessionServiceError) {
    const codes = {
      INPUT_INVALID: "order_request_invalid",
      PERMISSION_DENIED: "order_not_found",
      INTENT_CONFLICT: "order_idempotency_conflict",
      DEPENDENCY_UNAVAILABLE: "order_service_unavailable",
      STORE_CLOSED: "order_store_closed",
    } as const;
    return codes[error.code];
  }
  if (error instanceof GuestSessionError) return "order_not_found";
  if (!(
    error instanceof OrderCreationError ||
    error instanceof CheckoutValidationError ||
    error instanceof CartError
  ))
    return "order_service_unavailable";
  const codes: Partial<
    Record<
      OrderCreationError["code"] | CheckoutValidationError["code"] | CartError["code"],
      Failure
    >
  > = {
    ORDER_CREATE_PERMISSION_DENIED: "order_not_found",
    CHECKOUT_PERMISSION_DENIED: "order_not_found",
    CART_PERMISSION_DENIED: "order_not_found",
    ORDER_CREATE_INPUT_INVALID: "order_request_invalid",
    ORDER_CREATE_IDEMPOTENCY_CONFLICT: "order_idempotency_conflict",
    CART_IDEMPOTENCY_CONFLICT: "order_idempotency_conflict",
    CART_VERSION_CONFLICT: "order_version_conflict",
    CHECKOUT_CART_VERSION_CONFLICT: "order_version_conflict",
    ORDER_CREATE_VALIDATION_EXPIRED: "order_requote_required",
    CHECKOUT_REQUOTE_REQUIRED: "order_requote_required",
    CHECKOUT_ITEM_UNAVAILABLE: "order_requote_required",
    CHECKOUT_QUOTE_EXPIRED: "order_requote_required",
    CHECKOUT_QUOTE_MISSING: "order_requote_required",
    CHECKOUT_SELECTION_INVALID: "order_requote_required",
    CHECKOUT_INPUT_INVALID: "order_request_invalid",
    CHECKOUT_CART_UNAVAILABLE: "order_not_found",
    CHECKOUT_CART_EMPTY: "order_version_conflict",
    CHECKOUT_CART_NOT_ACTIVE: "order_version_conflict",
    CART_INPUT_INVALID: "order_request_invalid",
    CART_UNAVAILABLE: "order_not_found",
    CART_QUOTE_EXPIRED: "order_requote_required",
    CART_QUOTE_INVALID: "order_requote_required",
    CART_SELECTION_INVALID: "order_requote_required",
    CART_EXPIRED: "order_version_conflict",
    CART_ABANDONED: "order_version_conflict",
  };
  return codes[error.code] ?? "order_service_unavailable";
}
export class CustomerOrderSubmissionHandler {
  readonly #port: CustomerOrderSubmissionPort;
  readonly #origin: string;
  constructor(options: { port: CustomerOrderSubmissionPort; allowedOrigin: string }) {
    this.#port = options.port;
    this.#origin = new URL(options.allowedOrigin).origin;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let command: CustomerOrderSubmissionCommand;
      try {
        command = parse(request, this.#origin);
      } catch {
        reject(response, "order_request_invalid");
        return;
      }
      let result: CreateOrderResult<1 | 2>;
      try {
        result = await this.#port.create(command);
      } catch (error) {
        reject(response, failure(error));
        return;
      }
      try {
        const envelope = readClosedRecord(result, ["status", "record"]);
        if (envelope.status !== "Created" && envelope.status !== "AlreadyCreated")
          throw new Error("invalid result");
        const record =
          this.#port.quoteVersion === 2
            ? parseConfiguredOrderCreationRecord(envelope.record)
            : parseOrderCreationRecord(envelope.record);
        const order = record.order,
          batch = order.batches[0];
        if (
          record.submissionReference !== command.submissionReference ||
          batch.sourceCartReference !== command.cartReference ||
          batch.sourceCartVersion !== command.expectedCartVersion ||
          batch.quoteReference !== command.quoteReference
        )
          throw new Error("invalid binding");
        let amount = 0n;
        for (const item of record.items) {
          if (item.pricing.total.currencyCode !== "CAD" || item.pricing.total.amountMinor < 0n)
            throw new Error("invalid amount");
          amount += item.pricing.total.amountMinor;
        }
        if (amount > 9223372036854775807n) throw new Error("invalid amount");
        response.status(envelope.status === "Created" ? 201 : 200).json({
          schemaVersion: 1,
          order: {
            orderReference: order.orderReference,
            orderNumber: record.orderNumberAllocation.orderNumber,
            submissionReference: record.submissionReference,
            cartReference: batch.sourceCartReference,
            cartVersion: batch.sourceCartVersion,
            quoteReference: batch.quoteReference,
            quoteVersion: this.#port.quoteVersion,
            orderType: order.orderType,
            phase: order.canonicalPhase,
            paymentStatus: order.paymentStatus,
            total: { amountMinor: amount.toString(), currency: "CAD" },
          },
        });
      } catch {
        reject(response, "order_service_unavailable");
      }
    };
  }
}
export const unavailableCustomerOrderSubmissionHandler: RequestHandler = (_request, response) => {
  protect(response);
  reject(response, "order_service_unavailable");
};
