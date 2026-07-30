import {
  guestSessionCookie,
  parseCanonicalInstant,
  parseGuestRawCredential,
  parseOpaqueUuidV7,
  type GuestRawCredential,
  type GuestSessionCookieDescriptor,
} from "@bop/identity";
import type { RequestHandler, Response } from "express";

const compactSegmentPattern = /^[A-Za-z0-9_-]+$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const entryRoute = "/bff/customer/entry";

export interface CustomerEntryPortInput {
  readonly entryRequestReference: string;
  readonly operationReference: string;
  readonly qrToken: string;
  readonly requestedAt: string;
}

export interface CustomerEntryEstablished {
  readonly status: "Established";
  readonly publicStoreReference: string;
  readonly publicTableReference: string | null;
  readonly channel: "DineIn" | "Pickup";
  readonly locale: string;
  readonly contextExpiresAt: string;
  readonly sessionCredential: GuestRawCredential;
  readonly csrfCredential: GuestRawCredential;
  readonly cookie: GuestSessionCookieDescriptor;
}

export type CustomerEntryPortResult =
  | CustomerEntryEstablished
  | { readonly status: "InvalidRequest" }
  | { readonly status: "EntryUnavailable" };

export interface CustomerEntryPort {
  establish(input: Readonly<CustomerEntryPortInput>): Promise<CustomerEntryPortResult>;
}

export interface CustomerEntryHandlerOptions {
  readonly allowedOrigin: string;
  readonly now?: () => string;
  readonly port: CustomerEntryPort;
  readonly uuidV7Factory: () => string;
}

type ErrorCode = "entry_request_invalid" | "entry_unavailable" | "entry_service_unavailable";

const errorContracts = Object.freeze({
  entry_request_invalid: Object.freeze({
    messageKey: "customer.entry.request_invalid",
    recovery: Object.freeze({ action: "Rescan", storeSelection: "Hidden" }),
    status: 400,
  }),
  entry_unavailable: Object.freeze({
    messageKey: "customer.entry.unavailable",
    recovery: Object.freeze({ action: "RescanOrAskStaff", storeSelection: "Hidden" }),
    status: 422,
  }),
  entry_service_unavailable: Object.freeze({
    messageKey: "customer.entry.service_unavailable",
    recovery: Object.freeze({ action: "RetryOrAskStaff", storeSelection: "Hidden" }),
    status: 503,
  }),
} as const);

function setResponseControls(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function sendError(response: Response, code: ErrorCode): void {
  const contract = errorContracts[code];
  response.status(contract.status).json({
    schemaVersion: 1,
    code,
    messageKey: contract.messageKey,
    recovery: contract.recovery,
  });
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("closed record required");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    throw new TypeError("closed record prototype rejected");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    throw new TypeError("closed record keys rejected");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new TypeError("closed record accessor rejected");
    }
  }
  return value as Record<string, unknown>;
}

function validCompactFraming(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !compactSegmentPattern.test(part))) return false;
  const signature = parts[2];
  if (signature === undefined) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === signature;
}

function parseBody(value: unknown): string {
  const body = closedRecord(value, ["qrToken"]);
  if (
    typeof body.qrToken !== "string" ||
    body.qrToken.length < 1 ||
    body.qrToken.length > 2048 ||
    !validCompactFraming(body.qrToken)
  ) {
    throw new TypeError("invalid entry request");
  }
  return body.qrToken;
}

function parseOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new TypeError("allowedOrigin must be an exact HTTPS origin");
  }
  return origin.origin;
}

function parseUuidV7(value: unknown): string {
  return parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID");
}

function parseCookie(value: unknown): GuestSessionCookieDescriptor {
  const cookie = closedRecord(value, ["name", "secure", "httpOnly", "sameSite", "path", "domain"]);
  if (
    cookie.name !== guestSessionCookie.name ||
    cookie.secure !== guestSessionCookie.secure ||
    cookie.httpOnly !== guestSessionCookie.httpOnly ||
    cookie.sameSite !== guestSessionCookie.sameSite ||
    cookie.path !== guestSessionCookie.path ||
    cookie.domain !== guestSessionCookie.domain
  ) {
    throw new TypeError("unexpected Guest Cookie descriptor");
  }
  return guestSessionCookie;
}

function parseEstablished(
  value: unknown,
  requestedAt: string,
): Omit<CustomerEntryEstablished, "status"> {
  const result = closedRecord(value, [
    "status",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "locale",
    "contextExpiresAt",
    "sessionCredential",
    "csrfCredential",
    "cookie",
  ]);
  if (
    result.status !== "Established" ||
    (result.channel !== "DineIn" && result.channel !== "Pickup") ||
    typeof result.locale !== "string" ||
    !localePattern.test(result.locale)
  ) {
    throw new TypeError("malformed established result");
  }
  const publicStoreReference = parseUuidV7(result.publicStoreReference);
  const publicTableReference =
    result.publicTableReference === null ? null : parseUuidV7(result.publicTableReference);
  if ((result.channel === "DineIn") !== (publicTableReference !== null)) {
    throw new TypeError("channel and Table context mismatch");
  }
  const contextExpiresAt = parseCanonicalInstant(result.contextExpiresAt);
  if (Date.parse(contextExpiresAt) <= Date.parse(requestedAt)) {
    throw new TypeError("expired context result");
  }
  return Object.freeze({
    publicStoreReference,
    publicTableReference,
    channel: result.channel,
    locale: result.locale,
    contextExpiresAt,
    sessionCredential: parseGuestRawCredential(result.sessionCredential),
    csrfCredential: parseGuestRawCredential(result.csrfCredential),
    cookie: parseCookie(result.cookie),
  });
}

function parsePortResult(
  value: unknown,
  requestedAt: string,
):
  | { readonly status: "InvalidRequest" }
  | { readonly status: "EntryUnavailable" }
  | CustomerEntryEstablished {
  const statusRecord =
    typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, "status")
      : undefined;
  const status =
    statusRecord !== undefined && Object.hasOwn(statusRecord, "value")
      ? statusRecord.value
      : undefined;
  if (status === "InvalidRequest" || status === "EntryUnavailable") {
    closedRecord(value, ["status"]);
    return Object.freeze({ status });
  }
  if (status === "Established") {
    return Object.freeze({ status, ...parseEstablished(value, requestedAt) });
  }
  throw new TypeError("unknown Customer-entry result");
}

function serializeCookie(credential: GuestRawCredential): string {
  return `${guestSessionCookie.name}=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export const unavailableCustomerEntryHandler: RequestHandler = (_request, response) => {
  setResponseControls(response);
  sendError(response, "entry_service_unavailable");
};

export function sendInvalidCustomerEntryRequest(response: Response): void {
  setResponseControls(response);
  sendError(response, "entry_request_invalid");
}

export class CustomerEntryHandler {
  readonly #allowedOrigin: string;
  readonly #now: () => string;
  readonly #port: CustomerEntryPort;
  readonly #uuidV7Factory: () => string;

  constructor({
    allowedOrigin,
    now = () => new Date().toISOString(),
    port,
    uuidV7Factory,
  }: CustomerEntryHandlerOptions) {
    this.#allowedOrigin = parseOrigin(allowedOrigin);
    this.#now = now;
    this.#port = port;
    this.#uuidV7Factory = uuidV7Factory;
  }

  handler(): RequestHandler {
    return async (request, response) => {
      setResponseControls(response);
      if (
        request.originalUrl !== entryRoute ||
        request.get("origin") !== this.#allowedOrigin ||
        request.get("sec-fetch-site") !== "same-origin" ||
        request.get("sec-fetch-mode") !== "cors" ||
        request.is("application/json") !== "application/json"
      ) {
        sendError(response, "entry_request_invalid");
        return;
      }

      let qrToken: string;
      try {
        qrToken = parseBody(request.body);
      } catch {
        sendError(response, "entry_request_invalid");
        return;
      }

      try {
        const requestedAt = parseCanonicalInstant(this.#now());
        const entryRequestReference = parseUuidV7(this.#uuidV7Factory());
        const operationReference = parseUuidV7(this.#uuidV7Factory());
        if (entryRequestReference === operationReference) {
          throw new TypeError("fresh references must differ");
        }
        const result = parsePortResult(
          await this.#port.establish(
            Object.freeze({
              entryRequestReference,
              operationReference,
              qrToken,
              requestedAt,
            }),
          ),
          requestedAt,
        );
        if (result.status === "InvalidRequest") {
          sendError(response, "entry_request_invalid");
          return;
        }
        if (result.status === "EntryUnavailable") {
          sendError(response, "entry_unavailable");
          return;
        }
        response.setHeader("Set-Cookie", serializeCookie(result.sessionCredential));
        response.status(201).json({
          schemaVersion: 1,
          status: "Established",
          publicStoreReference: result.publicStoreReference,
          publicTableReference: result.publicTableReference,
          channel: result.channel,
          locale: result.locale,
          contextExpiresAt: result.contextExpiresAt,
          csrfToken: result.csrfCredential,
        });
      } catch {
        sendError(response, "entry_service_unavailable");
      }
    };
  }
}
