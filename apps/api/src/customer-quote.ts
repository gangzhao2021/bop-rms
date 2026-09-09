import { readClosedRecord } from "@bop/identity";
import type { PriceQuoteRequoteResult, PriceQuoteSnapshot, PricingReference } from "@rms/pricing";
import type { Request, RequestHandler, Response } from "express";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
const guestCookieName = "__Host-bop-guest";

export interface QuoteCartCommand {
  readonly cartReference: PricingReference;
  readonly expectedCartVersion: number;
  readonly guestCredential: string;
  readonly csrfCredential: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type QuoteCartResult =
  | { readonly status: "Created"; readonly quote: PriceQuoteSnapshot }
  | { readonly status: "Current"; readonly quote: PriceQuoteSnapshot }
  | { readonly status: "Requoted"; readonly requote: PriceQuoteRequoteResult }
  | {
      readonly status: "Expired";
      readonly resolution: {
        readonly operationReference: string;
        readonly cartReference: string;
        readonly cartVersion: number;
      };
    }
  | { readonly status: "NotFound" }
  | { readonly status: "VersionConflict" }
  | { readonly status: "IdempotencyConflict" }
  | { readonly status: "InvalidConfiguration" }
  | { readonly status: "Unavailable" };

export interface CustomerQuotePort {
  quoteCart(input: Readonly<QuoteCartCommand>): Promise<QuoteCartResult>;
}

type ErrorCode =
  | "quote_request_invalid"
  | "quote_not_found"
  | "quote_version_conflict"
  | "quote_idempotency_conflict"
  | "quote_configuration_invalid"
  | "quote_service_unavailable";

const errors = Object.freeze({
  quote_request_invalid: { status: 400, messageKey: "customer.quote.request_invalid" },
  quote_not_found: { status: 404, messageKey: "customer.quote.not_found" },
  quote_version_conflict: { status: 409, messageKey: "customer.quote.version_conflict" },
  quote_idempotency_conflict: { status: 409, messageKey: "customer.quote.idempotency_conflict" },
  quote_configuration_invalid: { status: 422, messageKey: "customer.quote.configuration_invalid" },
  quote_service_unavailable: { status: 503, messageKey: "customer.quote.service_unavailable" },
} as const);

function sendError(response: Response, code: ErrorCode): void {
  if (code === "quote_service_unavailable") response.setHeader("Retry-After", "5");
  const contract = errors[code];
  response
    .status(contract.status)
    .json({ schemaVersion: 1, error: { code, messageKey: contract.messageKey } });
}

function protectResponse(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function oneHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !uuidV7.test(value)) throw new TypeError("invalid header");
  return value;
}

function guestCredential(request: Request): string {
  const header = request.headers.cookie;
  if (typeof header !== "string") throw new TypeError("guest cookie required");
  const values = header
    .split(";")
    .map((part) => part.trim().split("="))
    .filter(([name]) => name === guestCookieName);
  if (values.length !== 1 || values[0]?.length !== 2 || !credential.test(values[0]?.[1] ?? ""))
    throw new TypeError("guest cookie required");
  return values[0]?.[1] as string;
}

function parse(request: Request, now: () => string, allowedOrigin: string): QuoteCartCommand {
  const body = request.body as unknown;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  )
    throw new TypeError("invalid body");
  const keys = Object.keys(body);
  const cartVersion = (body as { cartVersion?: unknown }).cartVersion;
  if (
    keys.length !== 1 ||
    keys[0] !== "cartVersion" ||
    !Number.isSafeInteger(cartVersion) ||
    Number(cartVersion) < 1 ||
    Number(cartVersion) > 2147483647
  )
    throw new TypeError("invalid body");
  const cartReference = request.params.cart_id;
  const requestedAt = now();
  if (
    request.get("origin") !== allowedOrigin ||
    request.get("sec-fetch-site") !== "same-origin" ||
    request.is("application/json") !== "application/json" ||
    typeof cartReference !== "string" ||
    !uuidV7.test(cartReference) ||
    !instant.test(requestedAt) ||
    new Date(Date.parse(requestedAt)).toISOString() !== requestedAt
  )
    throw new TypeError("invalid request");
  return Object.freeze({
    cartReference: cartReference as PricingReference,
    expectedCartVersion: Number(cartVersion),
    guestCredential: guestCredential(request),
    csrfCredential: (() => {
      const value = request.headers["x-csrf-token"];
      if (typeof value !== "string" || !credential.test(value))
        throw new TypeError("csrf required");
      return value;
    })(),
    idempotencyKey: oneHeader(request.headers["idempotency-key"]),
    requestedAt,
  });
}

const money = (value: PriceQuoteSnapshot["subtotal"]) =>
  Object.freeze({ amountMinor: value.amountMinor.toString(), currency: value.currencyCode });

function publicQuote(quote: PriceQuoteSnapshot, requote?: PriceQuoteRequoteResult) {
  return {
    schemaVersion: 1,
    quote: {
      quoteReference: quote.quoteReference,
      quoteVersion: quote.quoteVersion,
      cartVersion: quote.cartVersion,
      currency: quote.currencyMetadata.currencyCode,
      subtotal: money(quote.subtotal),
      discount: money(quote.discount),
      tax: money(quote.tax),
      fee: money(quote.fee),
      total: money(quote.total),
      expiresAt: quote.expiresAt,
      warnings: [...quote.warnings],
      blockingReasons: [...quote.blockingReasons],
      priceChange:
        requote === undefined
          ? null
          : {
              previousQuoteReference: requote.previousQuoteReference,
              outcome: requote.change,
              totalChange: money(requote.totalChange),
              requiresReconfirmation: requote.requiresReconfirmation,
              evaluatedAt: requote.evaluatedAt,
            },
    },
  };
}

export class CustomerQuoteHandler {
  readonly #allowedOrigin: string;
  readonly #now: () => string;
  readonly #port: CustomerQuotePort;
  constructor({
    now = () => new Date().toISOString(),
    port,
    allowedOrigin,
  }: {
    now?: () => string;
    port: CustomerQuotePort;
    allowedOrigin: string;
  }) {
    this.#allowedOrigin = new URL(allowedOrigin).origin;
    this.#now = now;
    this.#port = port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protectResponse(response);
      let command: QuoteCartCommand;
      try {
        command = parse(request, this.#now, this.#allowedOrigin);
      } catch {
        sendError(response, "quote_request_invalid");
        return;
      }
      let result: QuoteCartResult;
      try {
        result = await this.#port.quoteCart(command);
      } catch {
        sendError(response, "quote_service_unavailable");
        return;
      }
      if (result.status === "Expired") {
        try {
          const envelope = readClosedRecord(
            result,
            ["status", "resolution"],
            "ACTOR_SHAPE_INVALID",
          );
          const resolution = readClosedRecord(
            envelope.resolution,
            ["operationReference", "cartReference", "cartVersion"],
            "ACTOR_SHAPE_INVALID",
          );
          if (
            resolution.operationReference !== command.idempotencyKey ||
            resolution.cartReference !== command.cartReference ||
            resolution.cartVersion !== command.expectedCartVersion
          )
            throw new Error();
          response.status(410).json({
            schemaVersion: 1,
            error: {
              code: "quote_operation_expired",
              messageKey: "customer.quote.operation_expired",
            },
            resolution: {
              operationReference: resolution.operationReference,
              cartReference: resolution.cartReference,
              cartVersion: resolution.cartVersion,
            },
          });
        } catch {
          sendError(response, "quote_service_unavailable");
        }
        return;
      }
      if (
        result.status === "Created" ||
        result.status === "Current" ||
        result.status === "Requoted"
      ) {
        try {
          const quote =
            result.status === "Requoted" ? result.requote.replacementQuote : result.quote;
          response.setHeader("ETag", `"${quote.quoteVersion}"`);
          response.setHeader("Location", `/api/v1/price-quotes/${quote.quoteReference}`);
          response
            .status(result.status === "Current" ? 200 : 201)
            .json(publicQuote(quote, result.status === "Requoted" ? result.requote : undefined));
        } catch {
          sendError(response, "quote_service_unavailable");
        }
        return;
      }
      const mapping = {
        NotFound: "quote_not_found",
        VersionConflict: "quote_version_conflict",
        IdempotencyConflict: "quote_idempotency_conflict",
        InvalidConfiguration: "quote_configuration_invalid",
        Unavailable: "quote_service_unavailable",
      } as const;
      sendError(response, mapping[result.status]);
    };
  }
}

export const unavailableCustomerQuoteHandler: RequestHandler = (_request, response) => {
  protectResponse(response);
  sendError(response, "quote_service_unavailable");
};
