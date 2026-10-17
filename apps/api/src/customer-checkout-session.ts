import { readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  type CheckoutSessionRequest,
} from "@rms/ordering";
import type { Request, RequestHandler, Response } from "express";
import { checkoutHoldRetrySeconds } from "./customer-checkout-hold.js";

export const customerCheckoutSessionReadRoute = "/api/v1/checkout-sessions/:checkout_session_id";
export const customerCheckoutSessionRoute = "/api/v1/carts/:cart_id/checkout-sessions";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
export interface CheckoutSessionHttpInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly command: CheckoutSessionRequest;
}
export interface CustomerCheckoutSessionPort {
  readonly quoteVersion: 1 | 2;
  create(input: CheckoutSessionHttpInput): Promise<unknown>;
}
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
/**
 * WP-2423: the guest's own Cart line a refusal is about (its reference from the guest's Cart view),
 * how many of that item can still be made with the rest of the Cart, and whether it is short only
 * because other items in the Cart use the same stock.
 */
function refusedLine(error: CheckoutSessionServiceError) {
  const line = error.line;
  if (line === null) return null;
  return error.code === "ITEM_SHORT"
    ? {
        cartItemReference: String(line.cartItemReference),
        available: line.available ?? 0,
        sharedStock: line.sharedStock,
      }
    : { cartItemReference: String(line.cartItemReference) };
}
function reject(
  response: Response,
  status: number,
  explicit?: "store_closed" | "checkout_in_progress",
) {
  if (explicit === "checkout_in_progress") {
    // DEC-DINING-ANY-PARTICIPANT-SUBMIT: same code as the Cart and quote refusals.
    response.status(409).json({
      schemaVersion: 1,
      error: {
        code: "cart_checkout_in_progress",
        messageKey: "customer.cart.checkout_in_progress",
      },
    });
    return;
  }
  const code =
    explicit ??
    (status === 400
      ? "request_invalid"
      : status === 404
        ? "not_found"
        : status === 409
          ? "intent_conflict"
          : "service_unavailable");
  if (status === 503) response.setHeader("Retry-After", "5");
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "checkout_session_" + code, messageKey: "customer.checkoutSession." + code },
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
function parse(request: Request, origin: string, quoteVersion: 1 | 2): CheckoutSessionHttpInput {
  if (
    request.get("origin") !== origin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json"
  )
    throw new Error("invalid request");
  const raw = readClosedRecord(request.body, ["cartVersion", "quoteReference"]);
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
  const credentials = readCredentials(request);
  return Object.freeze({
    ...credentials,
    command: {
      createOperationReference: reference(request.headers["idempotency-key"]),
      cartReference: reference(request.params.cart_id),
      cartVersion: Number(raw.cartVersion),
      quoteReference: reference(raw.quoteReference),
      quoteVersion,
    },
  });
}

export class CustomerCheckoutSessionHandler {
  readonly #port: CustomerCheckoutSessionPort;
  readonly #origin: string;
  readonly #now: () => number;
  constructor(options: {
    port: CustomerCheckoutSessionPort;
    allowedOrigin: string;
    /** Clock for the Retry-After of a held Cart (defaults to the system clock). */
    now?: () => number;
  }) {
    this.#port = options.port;
    this.#now = options.now ?? Date.now;
    this.#origin = new URL(options.allowedOrigin).origin;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CheckoutSessionHttpInput;
      try {
        input = parse(request, this.#origin, this.#port.quoteVersion);
      } catch {
        reject(response, 400);
        return;
      }
      let result: unknown;
      try {
        result = await this.#port.create(input);
      } catch (error) {
        const status =
          error instanceof CheckoutSessionServiceError
            ? (
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
              )[error.code]
            : 503;
        // WP-2423: say which item is short (or can't be sold) and how many are left; nothing was
        // created or charged, and the guest's Cart stays as it is.
        if (
          error instanceof CheckoutSessionServiceError &&
          (error.code === "ITEM_SHORT" || error.code === "ITEM_UNAVAILABLE")
        ) {
          const code = error.code === "ITEM_SHORT" ? "item_short" : "item_unavailable";
          const line = refusedLine(error);
          response.status(409).json({
            schemaVersion: 1,
            error: {
              code: "checkout_session_" + code,
              messageKey: "customer.checkoutSession." + code,
              ...(line === null ? {} : { line }),
            },
          });
          return;
        }
        if (error instanceof CheckoutSessionServiceError && error.code === "CHECKOUT_IN_PROGRESS") {
          response.setHeader(
            "Retry-After",
            String(
              error.heldUntil === null
                ? 60
                : checkoutHoldRetrySeconds(error.heldUntil, new Date(this.#now()).toISOString()),
            ),
          );
          reject(response, 409, "checkout_in_progress");
          return;
        }
        // WP-2423 Q4: say plainly that the Store is not taking orders; nothing was charged.
        reject(
          response,
          status,
          error instanceof CheckoutSessionServiceError && error.code === "STORE_CLOSED"
            ? "store_closed"
            : undefined,
        );
        return;
      }
      try {
        const envelope = readClosedRecord(result, ["status", "session"]);
        if (envelope.status !== "Created" && envelope.status !== "AlreadyCreated")
          throw new Error("invalid result");
        const session = parseCheckoutSession(envelope.session);
        const validation = session.validation;
        const command = input.command;
        if (
          session.createOperationReference !== command.createOperationReference ||
          validation.cartReference !== command.cartReference ||
          validation.cartVersion !== command.cartVersion ||
          validation.quoteReference !== command.quoteReference ||
          validation.quoteVersion !== command.quoteVersion
        )
          throw new Error("invalid binding");
        response.status(envelope.status === "Created" ? 201 : 200).json({
          schemaVersion: 1,
          session: {
            checkoutSessionReference: session.checkoutSessionReference,
            cartReference: validation.cartReference,
            cartVersion: validation.cartVersion,
            quoteReference: validation.quoteReference,
            quoteVersion: validation.quoteVersion,
            createdAt: session.createdAt,
          },
        });
      } catch {
        reject(response, 503);
      }
    };
  }
}
export const unavailableCustomerCheckoutSessionHandler: RequestHandler = (_request, response) => {
  protect(response);
  reject(response, 503);
};

export interface CheckoutSessionReadHttpInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly checkoutSessionReference: string;
}
export interface CustomerCheckoutSessionReadPort {
  read(input: CheckoutSessionReadHttpInput): Promise<unknown>;
}
export class CustomerCheckoutSessionReadHandler {
  readonly #port: CustomerCheckoutSessionReadPort;
  readonly #origin: string;
  constructor(options: { port: CustomerCheckoutSessionReadPort; allowedOrigin: string }) {
    this.#port = options.port;
    this.#origin = new URL(options.allowedOrigin).origin;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CheckoutSessionReadHttpInput;
      try {
        // Same-origin browser GET may omit Origin; Fetch Metadata and CSRF remain required.
        if (
          request.get("sec-fetch-site") !== "same-origin" ||
          (request.get("origin") !== undefined && request.get("origin") !== this.#origin) ||
          Object.keys(request.query).length !== 0
        )
          throw new Error("invalid request");
        const reference = request.params.checkout_session_id;
        if (typeof reference !== "string" || !uuid.test(reference))
          throw new Error("invalid reference");
        input = { ...readCredentials(request), checkoutSessionReference: reference };
      } catch {
        reject(response, 400);
        return;
      }
      let result: unknown;
      try {
        result = await this.#port.read(input);
      } catch (error) {
        reject(
          response,
          error instanceof CheckoutSessionServiceError
            ? (
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
              )[error.code]
            : 503,
        );
        return;
      }
      try {
        const session = parseCheckoutSession(result);
        if (session.checkoutSessionReference !== input.checkoutSessionReference)
          throw new Error("invalid binding");
        response.status(200).json({
          schemaVersion: 1,
          session: {
            checkoutSessionReference: session.checkoutSessionReference,
            cartReference: session.validation.cartReference,
            cartVersion: session.validation.cartVersion,
            quoteReference: session.validation.quoteReference,
            quoteVersion: session.validation.quoteVersion,
            createdAt: session.createdAt,
          },
        });
      } catch {
        reject(response, 503);
      }
    };
  }
}
