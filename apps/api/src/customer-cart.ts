import type { Request, RequestHandler, Response } from "express";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const currency = /^[A-Z]{3}$/u;
const code = /^[A-Z][A-Z0-9_]{0,63}$/u;
const guestCookieName = "__Host-bop-guest";

class GuestSessionError extends Error {}

export const customerCartRoutes = Object.freeze({
  create: "/api/v1/carts",
  current: "/bff/customer/cart",
  read: "/api/v1/carts/:cart_id",
  addItem: "/api/v1/carts/:cart_id/items",
  updateItem: "/api/v1/carts/:cart_id/items/:cart_item_id",
  removeItem: "/api/v1/carts/:cart_id/items/:cart_item_id",
});

export type { CustomerCartMoney, CustomerCartView } from "@rms/ordering";
import type { CustomerCartMoney, CustomerCartView } from "@rms/ordering";

interface CustomerCartContext {
  readonly guestCredential: string;
  readonly requestedAt: string;
}

interface CustomerCartMutationContext extends CustomerCartContext {
  readonly csrfCredential: string;
  readonly operationReference: string;
}

export type CustomerCartPortResult =
  | { readonly status: "Found" | "Applied" | "Current"; readonly view: CustomerCartView }
  | { readonly status: "SessionExpired" | "NotFound" | "IdempotencyConflict" }
  | { readonly status: "VersionConflict"; readonly currentVersion: number }
  | { readonly status: "SelectionInvalid"; readonly issueCodes: readonly string[] }
  | { readonly status: "LifecycleExpired" | "LifecycleAbandoned" }
  | { readonly status: "RateLimited"; readonly retryAfterSeconds: number }
  | { readonly status: "Unavailable" };

export interface CustomerCartPort {
  createCart(input: CustomerCartMutationContext): Promise<CustomerCartPortResult>;
  getCurrentCart(input: CustomerCartContext): Promise<CustomerCartPortResult>;
  getCart(
    input: CustomerCartContext & { readonly cartReference: string },
  ): Promise<CustomerCartPortResult>;
  addItem(
    input: CustomerCartMutationContext & {
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly sellableReference: string;
      readonly quantity: number;
      readonly optionSelections: readonly {
        readonly optionReference: string;
        readonly quantity: number;
      }[];
      readonly customerNote: string | null;
    },
  ): Promise<CustomerCartPortResult>;
  updateItem(
    input: CustomerCartMutationContext & {
      readonly cartReference: string;
      readonly cartItemReference: string;
      readonly expectedCartVersion: number;
      readonly quantity: number;
      readonly optionSelections: readonly {
        readonly optionReference: string;
        readonly quantity: number;
      }[];
      readonly customerNote: string | null;
    },
  ): Promise<CustomerCartPortResult>;
  removeItem(
    input: CustomerCartMutationContext & {
      readonly cartReference: string;
      readonly cartItemReference: string;
      readonly expectedCartVersion: number;
    },
  ): Promise<CustomerCartPortResult>;
}

type ErrorCode =
  | "cart_request_invalid"
  | "cart_session_expired"
  | "cart_not_found"
  | "cart_version_conflict"
  | "cart_idempotency_conflict"
  | "cart_selection_invalid"
  | "cart_expired"
  | "cart_abandoned"
  | "cart_rate_limited"
  | "cart_service_unavailable";

const errors = Object.freeze({
  cart_request_invalid: { status: 400, messageKey: "customer.cart.request_invalid" },
  cart_session_expired: { status: 401, messageKey: "customer.cart.session_expired" },
  cart_not_found: { status: 404, messageKey: "customer.cart.not_found" },
  cart_version_conflict: { status: 409, messageKey: "customer.cart.version_conflict" },
  cart_idempotency_conflict: { status: 409, messageKey: "customer.cart.idempotency_conflict" },
  cart_selection_invalid: { status: 422, messageKey: "customer.cart.selection_invalid" },
  cart_expired: { status: 409, messageKey: "customer.cart.expired" },
  cart_abandoned: { status: 409, messageKey: "customer.cart.abandoned" },
  cart_rate_limited: { status: 429, messageKey: "customer.cart.rate_limited" },
  cart_service_unavailable: { status: 503, messageKey: "customer.cart.service_unavailable" },
} as const);

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("closed record required");
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new TypeError("closed record required");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      throw new TypeError("data property required");
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function scalar(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("invalid scalar");
  return value;
}

function canonicalInstant(value: unknown): string {
  const parsed = scalar(value, instant);
  if (new Date(Date.parse(parsed)).toISOString() !== parsed) throw new TypeError("invalid instant");
  return parsed;
}

function positive(value: unknown, maximum = 100): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new TypeError("positive integer required");
  return Number(value);
}

function exactHeader(value: string | string[] | undefined, pattern: RegExp): string {
  if (typeof value !== "string") throw new TypeError("single header required");
  return scalar(value, pattern);
}

function guestCredential(request: Request): string {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length > 4096) throw new GuestSessionError();
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${guestCookieName}=`))
    .map((part) => part.slice(guestCookieName.length + 1));
  if (values.length !== 1) throw new GuestSessionError();
  try {
    return scalar(values[0], credential);
  } catch {
    throw new GuestSessionError();
  }
}

function versionHeader(request: Request): number {
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !/^"[1-9][0-9]{0,8}"$/u.test(value))
    throw new TypeError("quoted version required");
  return positive(Number(value.slice(1, -1)), 999_999_999);
}

function sameOriginRead(request: Request): void {
  if (
    request.get("sec-fetch-site") !== "same-origin" ||
    !["cors", "same-origin"].includes(request.get("sec-fetch-mode") ?? "")
  )
    throw new TypeError("same-origin fetch required");
}

function sameOriginMutation(request: Request, allowedOrigin: string): void {
  sameOriginRead(request);
  if (request.get("origin") !== allowedOrigin) throw new TypeError("exact origin required");
}

function body(request: Request, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (request.is("application/json") !== "application/json") throw new TypeError("JSON required");
  return closed(request.body, keys);
}

function note(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("invalid note");
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 500) throw new TypeError("invalid note");
  return normalized;
}

function selections(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) throw new TypeError("invalid selections");
  const seen = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      const raw = closed(candidate, ["optionReference", "quantity"]);
      const optionReference = scalar(raw.optionReference, uuidV7);
      if (seen.has(optionReference)) throw new TypeError("duplicate option");
      seen.add(optionReference);
      return Object.freeze({ optionReference, quantity: positive(raw.quantity, 100) });
    }),
  );
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new TypeError("text required");
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > maximum) throw new TypeError("invalid text");
  return normalized;
}

function codes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("invalid codes");
  return Object.freeze(value.map((candidate) => scalar(candidate, code)));
}

function money(value: unknown): CustomerCartMoney {
  const raw = closed(value, ["amountMinor", "currency"]);
  if (typeof raw.amountMinor !== "string" || !/^-?(?:0|[1-9][0-9]{0,20})$/u.test(raw.amountMinor))
    throw new TypeError("invalid money");
  return Object.freeze({
    amountMinor: raw.amountMinor,
    currency: scalar(raw.currency, currency),
  });
}

function publicView(value: unknown): CustomerCartView {
  const root = closed(value, ["schemaVersion", "cart"]);
  if (root.schemaVersion !== 1) throw new TypeError("unsupported schema");
  const cart = closed(root.cart, [
    "cartReference",
    "version",
    "orderType",
    "serviceMode",
    "context",
    "lifecycle",
    "items",
    "quote",
    "warnings",
  ]);
  if (cart.orderType !== "DineIn" && cart.orderType !== "Pickup")
    throw new TypeError("invalid order type");
  const context = closed(cart.context, ["brandName", "storeName"]);
  const lifecycle = closed(cart.lifecycle, ["status", "idleExpiresAt", "absoluteExpiresAt"]);
  if (!["Active", "Abandoned", "Expired"].includes(String(lifecycle.status)))
    throw new TypeError("invalid lifecycle");
  const idleExpiresAt = canonicalInstant(lifecycle.idleExpiresAt);
  const absoluteExpiresAt = canonicalInstant(lifecycle.absoluteExpiresAt);
  if (Date.parse(idleExpiresAt) > Date.parse(absoluteExpiresAt))
    throw new TypeError("invalid lifecycle ordering");
  if (!Array.isArray(cart.items) || cart.items.length > 100) throw new TypeError("invalid items");
  const items = Object.freeze(
    cart.items.map((candidate) => {
      const item = closed(candidate, [
        "cartItemReference",
        "sellableReference",
        "displayName",
        "quantity",
        "configuration",
        "customerNote",
        "lineEstimate",
        "warnings",
      ]);
      if (!Array.isArray(item.configuration) || item.configuration.length > 50)
        throw new TypeError("invalid configuration");
      const configuration = Object.freeze(
        item.configuration.map((option) => {
          const raw = closed(option, ["optionReference", "displayName", "quantity"]);
          return Object.freeze({
            optionReference: scalar(raw.optionReference, uuidV7),
            displayName: text(raw.displayName, 200),
            quantity: positive(raw.quantity, 100),
          });
        }),
      );
      const estimate = closed(
        item.lineEstimate,
        (item.lineEstimate as { status?: unknown })?.status === "Available"
          ? ["status", "total"]
          : ["status", "reasonCode"],
      );
      const lineEstimate =
        estimate.status === "Available"
          ? Object.freeze({ status: "Available" as const, total: money(estimate.total) })
          : estimate.status === "Unavailable"
            ? Object.freeze({
                status: "Unavailable" as const,
                reasonCode: scalar(estimate.reasonCode, code),
              })
            : (() => {
                throw new TypeError("invalid estimate");
              })();
      return Object.freeze({
        cartItemReference: scalar(item.cartItemReference, uuidV7),
        sellableReference: scalar(item.sellableReference, uuidV7),
        displayName: text(item.displayName, 200),
        quantity: positive(item.quantity, 100),
        configuration,
        customerNote: item.customerNote === null ? null : text(item.customerNote, 500),
        lineEstimate,
        warnings: codes(item.warnings),
      });
    }),
  );
  let quote: CustomerCartView["cart"]["quote"] = null;
  if (cart.quote !== null) {
    const raw = closed(cart.quote, [
      "quoteReference",
      "quoteVersion",
      "cartVersion",
      "subtotal",
      "discount",
      "tax",
      "fee",
      "total",
      "expiresAt",
      "warnings",
      "blockingReasons",
    ]);
    quote = Object.freeze({
      quoteReference: scalar(raw.quoteReference, uuidV7),
      quoteVersion: positive(raw.quoteVersion, 999_999_999),
      cartVersion: positive(raw.cartVersion, 999_999_999),
      subtotal: money(raw.subtotal),
      discount: money(raw.discount),
      tax: money(raw.tax),
      fee: money(raw.fee),
      total: money(raw.total),
      expiresAt: canonicalInstant(raw.expiresAt),
      warnings: codes(raw.warnings),
      blockingReasons: codes(raw.blockingReasons),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    cart: Object.freeze({
      cartReference: scalar(cart.cartReference, uuidV7),
      version: positive(cart.version, 999_999_999),
      orderType: cart.orderType,
      serviceMode: text(cart.serviceMode, 100),
      context: Object.freeze({
        brandName: text(context.brandName, 200),
        storeName: text(context.storeName, 200),
      }),
      lifecycle: Object.freeze({
        status: lifecycle.status as "Active" | "Abandoned" | "Expired",
        idleExpiresAt,
        absoluteExpiresAt,
      }),
      items,
      quote,
      warnings: codes(cart.warnings),
    }),
  });
}

function responseControls(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function sendError(
  response: Response,
  errorCode: ErrorCode,
  details?: { readonly currentVersion?: number; readonly issueCodes?: readonly string[] },
): void {
  const contract = errors[errorCode];
  response.status(contract.status).json({
    schemaVersion: 1,
    error: {
      code: errorCode,
      messageKey: contract.messageKey,
      ...(details === undefined ? {} : details),
    },
  });
}

function handleResult(response: Response, result: CustomerCartPortResult, created = false): void {
  if (result.status === "Found" || result.status === "Applied" || result.status === "Current") {
    try {
      const view = publicView(result.view);
      response.setHeader("ETag", `"${view.cart.version}"`);
      response.setHeader("Location", `/api/v1/carts/${view.cart.cartReference}`);
      response.status(created && result.status === "Applied" ? 201 : 200).json(view);
    } catch {
      sendError(response, "cart_service_unavailable");
    }
    return;
  }
  if (result.status === "RateLimited") {
    const retry = positive(result.retryAfterSeconds, 3600);
    response.setHeader("Retry-After", String(retry));
    sendError(response, "cart_rate_limited");
    return;
  }
  const mapping = {
    SessionExpired: "cart_session_expired",
    NotFound: "cart_not_found",
    VersionConflict: "cart_version_conflict",
    IdempotencyConflict: "cart_idempotency_conflict",
    SelectionInvalid: "cart_selection_invalid",
    LifecycleExpired: "cart_expired",
    LifecycleAbandoned: "cart_abandoned",
    Unavailable: "cart_service_unavailable",
  } as const;
  sendError(
    response,
    mapping[result.status],
    result.status === "VersionConflict"
      ? { currentVersion: positive(result.currentVersion, 999_999_999) }
      : result.status === "SelectionInvalid"
        ? { issueCodes: codes(result.issueCodes) }
        : undefined,
  );
}

async function invoke(
  response: Response,
  operation: Promise<CustomerCartPortResult>,
  created = false,
): Promise<void> {
  try {
    handleResult(response, await operation, created);
  } catch {
    sendError(response, "cart_service_unavailable");
  }
}

function parseOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new TypeError("exact HTTPS origin required");
  return parsed.origin;
}

export class CustomerCartHandler {
  readonly #allowedOrigin: string;
  readonly #now: () => string;
  readonly #port: CustomerCartPort;

  constructor({
    allowedOrigin,
    now = () => new Date().toISOString(),
    port,
  }: {
    readonly allowedOrigin: string;
    readonly now?: () => string;
    readonly port: CustomerCartPort;
  }) {
    this.#allowedOrigin = parseOrigin(allowedOrigin);
    this.#now = now;
    this.#port = port;
  }

  #context(request: Request): CustomerCartContext {
    return Object.freeze({
      guestCredential: guestCredential(request),
      requestedAt: canonicalInstant(this.#now()),
    });
  }

  #mutation(request: Request): CustomerCartMutationContext {
    sameOriginMutation(request, this.#allowedOrigin);
    return Object.freeze({
      ...this.#context(request),
      csrfCredential: exactHeader(request.headers["x-csrf-token"], credential),
      operationReference: exactHeader(request.headers["idempotency-key"], uuidV7),
    });
  }

  #requestError(response: Response, error: unknown): void {
    sendError(
      response,
      error instanceof GuestSessionError ? "cart_session_expired" : "cart_request_invalid",
    );
  }

  create(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        const input = this.#mutation(request);
        body(request, []);
        await invoke(response, this.#port.createCart(input), true);
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }

  current(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        sameOriginRead(request);
        await invoke(response, this.#port.getCurrentCart(this.#context(request)));
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }

  read(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        sameOriginRead(request);
        await invoke(
          response,
          this.#port.getCart({
            ...this.#context(request),
            cartReference: scalar(request.params.cart_id, uuidV7),
          }),
        );
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }

  addItem(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        const raw = body(request, [
          "sellableReference",
          "quantity",
          "optionSelections",
          "customerNote",
        ]);
        await invoke(
          response,
          this.#port.addItem({
            ...this.#mutation(request),
            cartReference: scalar(request.params.cart_id, uuidV7),
            expectedCartVersion: versionHeader(request),
            sellableReference: scalar(raw.sellableReference, uuidV7),
            quantity: positive(raw.quantity, 100),
            optionSelections: selections(raw.optionSelections),
            customerNote: note(raw.customerNote),
          }),
        );
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }

  updateItem(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        const raw = body(request, ["quantity", "optionSelections", "customerNote"]);
        await invoke(
          response,
          this.#port.updateItem({
            ...this.#mutation(request),
            cartReference: scalar(request.params.cart_id, uuidV7),
            cartItemReference: scalar(request.params.cart_item_id, uuidV7),
            expectedCartVersion: versionHeader(request),
            quantity: positive(raw.quantity, 100),
            optionSelections: selections(raw.optionSelections),
            customerNote: note(raw.customerNote),
          }),
        );
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }

  removeItem(): RequestHandler {
    return async (request, response) => {
      responseControls(response);
      try {
        await invoke(
          response,
          this.#port.removeItem({
            ...this.#mutation(request),
            cartReference: scalar(request.params.cart_id, uuidV7),
            cartItemReference: scalar(request.params.cart_item_id, uuidV7),
            expectedCartVersion: versionHeader(request),
          }),
        );
      } catch (error) {
        this.#requestError(response, error);
      }
    };
  }
}

export const unavailableCustomerCartHandler: RequestHandler = (_request, response) => {
  responseControls(response);
  sendError(response, "cart_service_unavailable");
};
