import type { PriceQuoteRequoteResult, PriceQuoteSnapshot, PricingReference } from "@rms/pricing";
import type { Request, RequestHandler, Response } from "express";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface QuoteCartCommand {
  readonly cartReference: PricingReference;
  readonly expectedCartVersion: number;
  readonly customerSessionReference: PricingReference;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type QuoteCartResult =
  | { readonly status: "Created"; readonly quote: PriceQuoteSnapshot }
  | { readonly status: "Current"; readonly quote: PriceQuoteSnapshot }
  | { readonly status: "Requoted"; readonly requote: PriceQuoteRequoteResult }
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

function oneHeader(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !uuidV7.test(value)) throw new TypeError("invalid header");
  return value;
}

function parse(request: Request, now: () => string): QuoteCartCommand {
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
    Number(cartVersion) < 1
  )
    throw new TypeError("invalid body");
  const cartReference = request.params.cart_id;
  const requestedAt = now();
  if (
    typeof cartReference !== "string" ||
    !uuidV7.test(cartReference) ||
    !instant.test(requestedAt) ||
    new Date(Date.parse(requestedAt)).toISOString() !== requestedAt
  )
    throw new TypeError("invalid request");
  return Object.freeze({
    cartReference: cartReference as PricingReference,
    expectedCartVersion: Number(cartVersion),
    customerSessionReference: oneHeader(
      request.headers["x-customer-session-id"],
    ) as PricingReference,
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
      cartReference: quote.cartReference,
      cartVersion: quote.cartVersion,
      currency: quote.currencyMetadata.currencyCode,
      subtotal: money(quote.subtotal),
      discount: money(quote.discount),
      tax: money(quote.tax),
      fee: money(quote.fee),
      total: money(quote.total),
      lines: quote.lines.map((line) => ({
        lineReference: line.lineReference,
        sellableReference: line.sellableReference,
        productVersionReference: line.productVersionReference,
        menuVersionReference: line.menuVersionReference,
        quantity: line.quantity,
        unitPrice: money(line.unitPrice),
        subtotal: money(line.subtotal),
        discount: money(line.discount),
        tax: money(line.tax),
        fee: money(line.fee),
        total: money(line.total),
        priceEvidence: {
          priceBookReference: line.resolvedPrice.priceBookReference,
          versionReference: line.resolvedPrice.versionReference,
          snapshotDigest: line.resolvedPrice.snapshotDigest,
          entryReference: line.resolvedPrice.entryReference,
        },
        taxEvidence: {
          configurationReference: line.taxResolution.configurationReference,
          versionReference: line.taxResolution.versionReference,
          snapshotDigest: line.taxResolution.snapshotDigest,
          components: line.taxLines.map((taxLine) => ({
            ruleReference: taxLine.ruleReference,
            taxAmount: money(taxLine.taxAmount),
            calculationOrder: taxLine.calculationOrder,
            compoundOnPriorTax: taxLine.compoundOnPriorTax,
          })),
        },
      })),
      appliedPromotionReferences: [...quote.appliedPromotionReferences],
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
  readonly #now: () => string;
  readonly #port: CustomerQuotePort;
  constructor({
    now = () => new Date().toISOString(),
    port,
  }: {
    now?: () => string;
    port: CustomerQuotePort;
  }) {
    this.#now = now;
    this.#port = port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      let command: QuoteCartCommand;
      try {
        command = parse(request, this.#now);
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

export const unavailableCustomerQuoteHandler: RequestHandler = (_request, response) =>
  sendError(response, "quote_service_unavailable");
