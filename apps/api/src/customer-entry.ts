import { trustedClientAddress } from "./client-address.js";
import { customerFailureCode } from "./customer-failure-diagnostic.js";
import { markRequestFailure } from "./request-correlation.js";
import {
  serializeGuestSessionCookie,
  type GuestRawCredential,
  type GuestSessionCookieDescriptor,
} from "@bop/identity";
import type { RequestHandler, Response } from "express";

const compactSegmentPattern = /^[A-Za-z0-9_-]+$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const rawCredentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const entryRoute = "/bff/customer/entry";
const expectedGuestSessionCookie: GuestSessionCookieDescriptor = Object.freeze({
  name: "__Host-bop-guest",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  domain: null,
});

export interface CustomerEntryPortInput {
  readonly entryRequestReference: string;
  readonly operationReference: string;
  readonly qrToken: string;
  readonly requestedAt: string;
  /**
   * WP-2423 DEC-DINING-GUEST-TABLE-START: what the guest tapped after a first scan answered with a
   * choice: start this free table, join the people here, or start after them. Absent: a scan.
   */
  readonly intent?: CustomerEntryIntent;
  /**
   * M104/M105: the guest credentials this phone sent (its current visit's cookie, then the earlier
   * visits it keeps), so a rescan goes on with a visit instead of replacing it. Never logged.
   */
  readonly presentedCredentials?: readonly CustomerEntryPresentedCredential[];
}
export interface CustomerEntryPresentedCredential {
  readonly source: "Current" | "Earlier";
  readonly credential: string;
}
export type CustomerEntryIntent = "Start" | "Join" | "NewParty";

export interface CustomerEntryEstablished {
  readonly status: "Established";
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  readonly publicStoreReference: string;
  readonly publicTableReference: string | null;
  readonly channel: "DineIn" | "Pickup";
  readonly operatingState: "Open" | "Closed" | "TemporarilyClosed";
  readonly availableServiceModes: readonly ("DineIn" | "Pickup" | "Delivery")[];
  readonly locale: string;
  readonly contextExpiresAt: string;
  /**
   * Coordinator 2026-10-30: at a table, whether a party is seated there now (staff seat guests
   * before they can join and order, or the guest is starting it); absent for pickup or when it
   * can't be read.
   */
  readonly tableOpen?: boolean;
  readonly sessionCredential: GuestRawCredential;
  readonly csrfCredential: GuestRawCredential;
  readonly cookie: GuestSessionCookieDescriptor;
  /** M104/M105: this phone's existing visit goes on (no new visit was started). */
  readonly resumed?: true;
  /**
   * M104/M105: the earlier visits this phone keeps after this answer (absent: unchanged), so a
   * visit replaced here, at this Store or another, can be gone back to, and its receipts read.
   */
  readonly earlierCredentials?: readonly string[];
  /** The visit this phone had at this Store has ended; whether its receipts can still be read. */
  readonly previousVisit?: "Ended" | "EndedReceiptsKept";
}

/** WP-2423 Q4: the Store is closed or not taking this service now; no Session is issued. */
export interface CustomerEntryNotAccepting {
  readonly status: "NotAccepting";
  readonly storeDisplayName: string;
  readonly operatingState: "Closed" | "TemporarilyClosed" | "Open";
  readonly todayHours: readonly {
    readonly startLocalTime: string;
    readonly endLocalTime: string;
    readonly endsNextDay: boolean;
  }[];
  /** WP-2423 item 8 ③ (decision 16): today's holiday, special hours or closure, when it is one. */
  readonly todayKind: "Holiday" | "TemporaryClosure" | "Override" | null;
  /** The Store's next opening within 7 days (its local date and time), when one is published. */
  readonly nextOpening: { readonly localDate: string; readonly startLocalTime: string } | null;
  /** The Store's local date now, so "tomorrow" can be said. */
  readonly localDate: string | null;
  /** WP-2423 item 11: not a closing time; this Store isn't ready to take orders yet. */
  readonly notReadyForOrders?: true;
  /** WP-2423 item 13 ②: the platform paused this merchant's new guests (no hours to wait for). */
  readonly newGuestsPaused?: true;
}

/**
 * WP-2423 item 8 ⑦ 1b: a pickup code at a Store that turned pickup off (it takes dine-in orders
 * only); no Session is issued.
 */
export interface CustomerEntryServiceNotOffered {
  readonly status: "ServiceNotOffered";
  readonly storeDisplayName: string;
}

/**
 * Coordinator 2026-10-30: no party is seated at the scanned table (free, or waiting for cleaning).
 * Nobody can join or order there until staff seat a party, so no Session is issued (a browser's
 * earlier visit, e.g. a guest whose table was just settled, keeps its receipt); the public context
 * lets the guest look at the menu.
 */
export interface CustomerEntryTableNotOpen {
  readonly status: "TableNotOpen";
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  readonly publicStoreReference: string;
  readonly locale: string;
}

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: a scan at a Store where guests start tables, answered with
 * no Session (an earlier visit on this browser keeps its receipt): this free table can be started,
 * it is waiting for cleaning, or this phone is asked if it is with the guests already here.
 */
export type CustomerEntryTableOffer = Omit<CustomerEntryTableNotOpen, "status"> &
  (
    | { readonly status: "TableMayStart" }
    | { readonly status: "TableBeingCleaned" }
    | { readonly status: "TableAskNewParty" }
  );

/** WP-2423 Q11: a genuine table code that staff replaced or turned off; no Session is issued. */
export interface CustomerEntryQrRetired {
  readonly status: "QrRetired";
  readonly reason: "Replaced" | "TurnedOff";
}

export type CustomerEntryPortResult =
  | CustomerEntryEstablished
  | CustomerEntryNotAccepting
  | CustomerEntryServiceNotOffered
  | CustomerEntryTableNotOpen
  | CustomerEntryTableOffer
  | CustomerEntryQrRetired
  | { readonly status: "InvalidRequest" }
  | { readonly status: "EntryUnavailable" };

export interface CustomerEntryPort {
  establish(input: Readonly<CustomerEntryPortInput>): Promise<CustomerEntryPortResult>;
}

export interface CustomerEntryRequestAdmission {
  consume(
    input: Readonly<{ remoteAddress: string | null; requestedAt: string; codeValid?: boolean }>,
  ): Promise<
    | { readonly status: "Allowed" }
    | { readonly status: "RateLimited"; readonly retryAfterSeconds: number }
    | { readonly status: "Unavailable" }
  >;
}

export interface CustomerEntryHandlerOptions {
  readonly requestAdmission?: CustomerEntryRequestAdmission;
  /** WP-2423: a code's signature, checked first so a made-up code can't spend the Store's budget. */
  readonly codeCheck?: (qrToken: string) => Promise<boolean>;
  readonly allowedOrigin: string;
  readonly now?: () => string;
  readonly port: CustomerEntryPort;
  readonly uuidV7Factory: () => string;
}

type ErrorCode =
  | "entry_request_invalid"
  | "entry_unavailable"
  | "entry_service_unavailable"
  | "entry_rate_limited";

const errorContracts = Object.freeze({
  entry_rate_limited: Object.freeze({
    messageKey: "customer.entry.rate_limited",
    recovery: Object.freeze({ action: "RetryOrAskStaff", storeSelection: "Hidden" }),
    status: 429,
  }),
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

/**
 * M02 (v15 07b7a1b7): the code a guest scanned that started no visit yet (a table not open, a
 * closed Store), so a reload or "I've been seated" asks the same Store about the same table instead
 * of losing where the guest is. It is the code the guest already holds: never in the address bar,
 * Web Storage or script, and sent only to this route.
 */
export const scanCookieName = "__Secure-bop-scan";
const scanCookieAttributes = `Path=${entryRoute}; Secure; HttpOnly; SameSite=Strict`;
export const scanCookieMaxAgeSeconds = 1800;
/** Exported so the installation's Store routing sets exactly this cookie during an outage. */
export const rememberScan = (qrToken: string) =>
  `${scanCookieName}=${qrToken}; Max-Age=${scanCookieMaxAgeSeconds}; ${scanCookieAttributes}`;
export const forgetScan = `${scanCookieName}=; Max-Age=0; ${scanCookieAttributes}`;

/** The one well-formed scan cookie this browser sent, or null. */
export function scannedCode(header: unknown): string | null {
  if (typeof header !== "string" || header.length > 8192) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(scanCookieName + "="))
    .map((part) => part.slice(scanCookieName.length + 1));
  const [value] = values;
  return values.length === 1 &&
    value !== undefined &&
    value.length <= 2048 &&
    validCompactFraming(value)
    ? value
    : null;
}

/**
 * M104/M105: the earlier visits this phone keeps (a visit at another Store, or one replaced here
 * whose receipts can still be read), so scanning that Store's code again goes back to it. Only the
 * entry writes it and only the entry and the receipt read it; never logged.
 */
export const earlierVisitsCookieName = "__Host-bop-visits";
const earlierVisitLimit = 2;
const earlierVisitsAttributes = "Path=/; Secure; HttpOnly; SameSite=Strict";
export function serializeEarlierVisits(credentials: readonly string[]): string {
  if (credentials.length === 0) return `${earlierVisitsCookieName}=; Max-Age=0; ${earlierVisitsAttributes}`;
  return `${earlierVisitsCookieName}=${credentials
    .map((credential) => parseGuestRawCredential(credential))
    .join(".")}; Max-Age=86400; ${earlierVisitsAttributes}`;
}
/** The one well-formed value of the exactly named cookie, or null. */
function exactCookie(header: unknown, name: string): string | null {
  if (typeof header !== "string" || header.length > 8192) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] !== undefined ? values[0] : null;
}
/** The guest credentials this phone sent: its current visit's, then the earlier visits it keeps. */
export function presentedGuestCredentials(header: unknown): CustomerEntryPresentedCredential[] {
  const presented: CustomerEntryPresentedCredential[] = [];
  const current = exactCookie(header, "__Host-bop-guest");
  if (current !== null && rawCredentialPattern.test(current))
    presented.push({ source: "Current", credential: current });
  const earlier = exactCookie(header, earlierVisitsCookieName);
  if (earlier !== null)
    for (const credential of earlier.split(".").slice(0, earlierVisitLimit))
      if (
        rawCredentialPattern.test(credential) &&
        !presented.some((visit) => visit.credential === credential)
      )
        presented.push({ source: "Earlier", credential });
  return presented;
}

type EntryBody =
  | { readonly qrToken: string; readonly intent: CustomerEntryIntent | undefined }
  | { readonly resume: true; readonly intent: CustomerEntryIntent | undefined };

function parseIntent(value: unknown): CustomerEntryIntent | undefined {
  if (value !== undefined && value !== "Start" && value !== "Join" && value !== "NewParty")
    throw new TypeError("invalid entry request");
  return value as CustomerEntryIntent | undefined;
}

function parseBody(value: unknown): EntryBody {
  const withIntent = value !== null && typeof value === "object" && Object.hasOwn(value, "intent");
  // M02: `{resume:true}`: the code is this browser's scan cookie, not the body.
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "resume")) {
    const body = closedRecord(value, withIntent ? ["resume", "intent"] : ["resume"]);
    if (body.resume !== true) throw new TypeError("invalid entry request");
    return { resume: true, intent: parseIntent(body.intent) };
  }
  const body = closedRecord(value, withIntent ? ["qrToken", "intent"] : ["qrToken"]);
  if (
    typeof body.qrToken !== "string" ||
    body.qrToken.length < 1 ||
    body.qrToken.length > 2048 ||
    !validCompactFraming(body.qrToken) ||
    (body.intent !== undefined &&
      body.intent !== "Start" &&
      body.intent !== "Join" &&
      body.intent !== "NewParty")
  ) {
    throw new TypeError("invalid entry request");
  }
  return { qrToken: body.qrToken, intent: body.intent as CustomerEntryIntent | undefined };
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
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) {
    throw new TypeError("opaque UUIDv7 required");
  }
  return value;
}

function parseCanonicalInstant(value: unknown): string {
  if (typeof value !== "string" || !canonicalInstantPattern.test(value)) {
    throw new TypeError("canonical instant required");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError("canonical instant required");
  }
  return value;
}

function parseGuestRawCredential(value: unknown): GuestRawCredential {
  if (typeof value !== "string" || !rawCredentialPattern.test(value)) {
    throw new TypeError("Guest raw credential required");
  }
  return value as GuestRawCredential;
}

function parseCookie(value: unknown): GuestSessionCookieDescriptor {
  const cookie = closedRecord(value, ["name", "secure", "httpOnly", "sameSite", "path", "domain"]);
  if (
    cookie.name !== expectedGuestSessionCookie.name ||
    cookie.secure !== expectedGuestSessionCookie.secure ||
    cookie.httpOnly !== expectedGuestSessionCookie.httpOnly ||
    cookie.sameSite !== expectedGuestSessionCookie.sameSite ||
    cookie.path !== expectedGuestSessionCookie.path ||
    cookie.domain !== expectedGuestSessionCookie.domain
  ) {
    throw new TypeError("unexpected Guest Cookie descriptor");
  }
  return expectedGuestSessionCookie;
}

function parseEstablished(
  value: unknown,
  requestedAt: string,
): Omit<CustomerEntryEstablished, "status"> {
  const result = closedRecord(value, [
    "status",
    "brandDisplayName",
    "storeDisplayName",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "operatingState",
    "availableServiceModes",
    "locale",
    "contextExpiresAt",
    ...(Object.hasOwn(value as object, "tableOpen") ? ["tableOpen"] : []),
    "sessionCredential",
    "csrfCredential",
    "cookie",
    ...(["resumed", "earlierCredentials", "previousVisit"] as const).filter((key) =>
      Object.hasOwn(value as object, key),
    ),
  ]);
  if (result.resumed !== undefined && (result.resumed !== true || result.channel !== "Pickup"))
    throw new TypeError("only a pickup visit resumes");
  if (
    result.previousVisit !== undefined &&
    (result.resumed !== undefined ||
      (result.previousVisit !== "Ended" && result.previousVisit !== "EndedReceiptsKept"))
  )
    throw new TypeError("invalid previous visit");
  const earlierCredentials =
    result.earlierCredentials === undefined
      ? undefined
      : (() => {
          if (
            !Array.isArray(result.earlierCredentials) ||
            result.earlierCredentials.length > earlierVisitLimit
          )
            throw new TypeError("invalid earlier visits");
          return Object.freeze(
            result.earlierCredentials.map((credential) => parseGuestRawCredential(credential)),
          );
        })();
  if (
    result.tableOpen !== undefined &&
    (typeof result.tableOpen !== "boolean" || result.channel !== "DineIn")
  )
    throw new TypeError("table state only at a table");
  if (
    result.status !== "Established" ||
    (result.channel !== "DineIn" && result.channel !== "Pickup") ||
    !["Open", "Closed", "TemporarilyClosed"].includes(String(result.operatingState)) ||
    typeof result.locale !== "string" ||
    !localePattern.test(result.locale)
  ) {
    throw new TypeError("malformed established result");
  }
  const publicStoreReference = parseUuidV7(result.publicStoreReference);
  const publicLabel = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 120 ||
      value !== value.normalize("NFC") ||
      value !== value.trim() ||
      /[\p{Cc}\p{Cf}<>{}[\]`*_#]/u.test(value)
    ) {
      throw new TypeError("public Store label required");
    }
    return value;
  };
  const brandDisplayName = publicLabel(result.brandDisplayName);
  const storeDisplayName = publicLabel(result.storeDisplayName);
  const publicTableReference =
    result.publicTableReference === null ? null : parseUuidV7(result.publicTableReference);
  if ((result.channel === "DineIn") !== (publicTableReference !== null)) {
    throw new TypeError("channel and Table context mismatch");
  }
  if (!Array.isArray(result.availableServiceModes)) {
    throw new TypeError("available service modes required");
  }
  const availableServiceModes = Object.freeze(
    result.availableServiceModes.map((mode) => {
      if (!(["DineIn", "Pickup", "Delivery"] as const).includes(mode as never)) {
        throw new TypeError("unknown service mode");
      }
      return mode as "DineIn" | "Pickup" | "Delivery";
    }),
  );
  if (
    new Set(availableServiceModes).size !== availableServiceModes.length ||
    // A resumed visit goes on whatever the Store takes from new guests now.
    (result.resumed !== true &&
      (result.operatingState === "Open") !== availableServiceModes.includes(result.channel)) ||
    (result.operatingState !== "Open" && availableServiceModes.length !== 0)
  ) {
    throw new TypeError("operating state and service modes conflict");
  }
  const contextExpiresAt = parseCanonicalInstant(result.contextExpiresAt);
  if (Date.parse(contextExpiresAt) <= Date.parse(requestedAt)) {
    throw new TypeError("expired context result");
  }
  return Object.freeze({
    brandDisplayName,
    storeDisplayName,
    publicStoreReference,
    publicTableReference,
    channel: result.channel,
    operatingState: result.operatingState as "Open" | "Closed" | "TemporarilyClosed",
    availableServiceModes,
    locale: result.locale,
    contextExpiresAt,
    ...(result.tableOpen === undefined ? {} : { tableOpen: result.tableOpen as boolean }),
    sessionCredential: parseGuestRawCredential(result.sessionCredential),
    csrfCredential: parseGuestRawCredential(result.csrfCredential),
    cookie: parseCookie(result.cookie),
    ...(result.resumed === true ? { resumed: true as const } : {}),
    ...(earlierCredentials === undefined ? {} : { earlierCredentials }),
    ...(result.previousVisit === undefined
      ? {}
      : { previousVisit: result.previousVisit as "Ended" | "EndedReceiptsKept" }),
  });
}

function parsePortResult(
  value: unknown,
  requestedAt: string,
):
  | { readonly status: "InvalidRequest" }
  | { readonly status: "EntryUnavailable" }
  | CustomerEntryQrRetired
  | CustomerEntryNotAccepting
  | CustomerEntryServiceNotOffered
  | CustomerEntryTableNotOpen
  | CustomerEntryTableOffer
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
  if (status === "QrRetired") {
    const raw = closedRecord(value, ["status", "reason"]);
    if (raw.reason !== "Replaced" && raw.reason !== "TurnedOff")
      throw new TypeError("invalid retired result");
    return Object.freeze({ status: "QrRetired", reason: raw.reason });
  }
  if (
    status === "TableNotOpen" ||
    status === "TableMayStart" ||
    status === "TableBeingCleaned" ||
    status === "TableAskNewParty"
  ) {
    const raw = closedRecord(value, [
      "status",
      "brandDisplayName",
      "storeDisplayName",
      "publicStoreReference",
      "locale",
    ]);
    const label = (text: unknown) =>
      typeof text === "string" &&
      /^[^\p{Cc}\p{Cf}<>{}[\]`*_#]{1,120}$/u.test(text) &&
      text === text.trim()
        ? text
        : (() => {
            throw new TypeError("invalid table-not-open result");
          })();
    if (typeof raw.locale !== "string" || !localePattern.test(raw.locale))
      throw new TypeError("invalid table-not-open result");
    return Object.freeze({
      status,
      brandDisplayName: label(raw.brandDisplayName),
      storeDisplayName: label(raw.storeDisplayName),
      publicStoreReference: parseUuidV7(raw.publicStoreReference),
      locale: raw.locale,
    });
  }
  if (status === "ServiceNotOffered") {
    const raw = closedRecord(value, ["status", "storeDisplayName"]);
    if (
      typeof raw.storeDisplayName !== "string" ||
      !/^[^\p{Cc}\p{Cf}<>]{1,120}$/u.test(raw.storeDisplayName)
    )
      throw new TypeError("invalid service-not-offered result");
    return Object.freeze({ status: "ServiceNotOffered", storeDisplayName: raw.storeDisplayName });
  }
  if (status === "NotAccepting") {
    const raw = closedRecord(value, [
      "status",
      "storeDisplayName",
      "operatingState",
      "todayHours",
      "todayKind",
      "nextOpening",
      "localDate",
      ...(Object.hasOwn(value as object, "notReadyForOrders") ? ["notReadyForOrders"] : []),
      ...(Object.hasOwn(value as object, "newGuestsPaused") ? ["newGuestsPaused"] : []),
    ]);
    if (
      (raw.notReadyForOrders !== undefined && raw.notReadyForOrders !== true) ||
      (raw.newGuestsPaused !== undefined && raw.newGuestsPaused !== true)
    )
      throw new TypeError("invalid not-accepting result");
    const time = /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u;
    if (
      typeof raw.storeDisplayName !== "string" ||
      !/^[^\p{Cc}\p{Cf}<>]{1,120}$/u.test(raw.storeDisplayName) ||
      !["Closed", "TemporarilyClosed", "Open"].includes(String(raw.operatingState)) ||
      !Array.isArray(raw.todayHours) ||
      raw.todayHours.length > 12
    )
      throw new TypeError("invalid not-accepting result");
    const todayHours = raw.todayHours.map((value: unknown) => {
      const interval = closedRecord(value, ["startLocalTime", "endLocalTime", "endsNextDay"]);
      if (
        typeof interval.startLocalTime !== "string" ||
        !time.test(interval.startLocalTime) ||
        typeof interval.endLocalTime !== "string" ||
        !time.test(interval.endLocalTime) ||
        typeof interval.endsNextDay !== "boolean"
      )
        throw new TypeError("invalid hours");
      return Object.freeze({
        startLocalTime: interval.startLocalTime,
        endLocalTime: interval.endLocalTime,
        endsNextDay: interval.endsNextDay,
      });
    });
    const date = /^\d{4}-\d{2}-\d{2}$/u;
    if (
      (raw.todayKind !== null &&
        !["Holiday", "TemporaryClosure", "Override"].includes(String(raw.todayKind))) ||
      (raw.localDate !== null && (typeof raw.localDate !== "string" || !date.test(raw.localDate)))
    )
      throw new TypeError("invalid not-accepting result");
    let nextOpening: CustomerEntryNotAccepting["nextOpening"] = null;
    if (raw.nextOpening !== null) {
      const next = closedRecord(raw.nextOpening, ["localDate", "startLocalTime"]);
      if (
        typeof next.localDate !== "string" ||
        !date.test(next.localDate) ||
        typeof next.startLocalTime !== "string" ||
        !time.test(next.startLocalTime)
      )
        throw new TypeError("invalid next opening");
      nextOpening = Object.freeze({
        localDate: next.localDate,
        startLocalTime: next.startLocalTime,
      });
    }
    return Object.freeze({
      status: "NotAccepting",
      storeDisplayName: raw.storeDisplayName,
      operatingState: raw.operatingState as CustomerEntryNotAccepting["operatingState"],
      todayHours: Object.freeze(todayHours),
      todayKind: raw.todayKind as CustomerEntryNotAccepting["todayKind"],
      nextOpening,
      localDate: raw.localDate as string | null,
      ...(raw.notReadyForOrders === true ? { notReadyForOrders: true as const } : {}),
      ...(raw.newGuestsPaused === true ? { newGuestsPaused: true as const } : {}),
    });
  }
  throw new TypeError("unknown Customer-entry result");
}

/** WP-2423 Q10: persistent for the Session's absolute lifetime so a browser restart keeps the order. */
function serializeCookie(credential: GuestRawCredential): string {
  return serializeGuestSessionCookie(credential);
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
  readonly #requestAdmission: CustomerEntryRequestAdmission | undefined;
  readonly #codeCheck: ((qrToken: string) => Promise<boolean>) | undefined;

  constructor({
    allowedOrigin,
    now = () => new Date().toISOString(),
    port,
    uuidV7Factory,
    requestAdmission,
    codeCheck,
  }: CustomerEntryHandlerOptions) {
    this.#allowedOrigin = parseOrigin(allowedOrigin);
    this.#now = now;
    this.#port = port;
    this.#uuidV7Factory = uuidV7Factory;
    this.#requestAdmission = requestAdmission;
    this.#codeCheck = codeCheck;
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
      let intent: CustomerEntryIntent | undefined;
      const remembered = scannedCode(request.get("cookie"));
      try {
        const body = parseBody(request.body);
        intent = body.intent;
        if ("resume" in body) {
          // Nothing scanned here that is still waiting: the app asks the guest to scan.
          if (remembered === null) {
            response.status(404).json({
              schemaVersion: 1,
              code: "entry_scan_missing",
              messageKey: "customer.entry.scan_missing",
              recovery: { action: "Rescan", storeSelection: "Hidden" },
            });
            return;
          }
          qrToken = remembered;
        } else qrToken = body.qrToken;
      } catch {
        sendError(response, "entry_request_invalid");
        return;
      }
      // An answer that starts no visit remembers the code; a visit or a retired code forgets it.
      const remember = () => response.setHeader("Set-Cookie", rememberScan(qrToken));
      const forget = () => {
        if (remembered !== null) response.append("Set-Cookie", forgetScan);
      };

      try {
        const requestedAt = parseCanonicalInstant(this.#now());
        // A check that can't answer leaves the code to the full entry check below.
        const codeValid = await this.#codeCheck?.(qrToken).catch(() => undefined);
        const admission = await this.#requestAdmission?.consume(
          Object.freeze({
            remoteAddress: trustedClientAddress(request),
            requestedAt,
            ...(codeValid === undefined ? {} : { codeValid }),
          }),
        );
        if (admission?.status === "RateLimited") {
          const decision = closedRecord(admission, ["status", "retryAfterSeconds"]);
          if (
            !Number.isSafeInteger(decision.retryAfterSeconds) ||
            Number(decision.retryAfterSeconds) < 1 ||
            Number(decision.retryAfterSeconds) > 86400
          )
            throw new TypeError("admission unavailable");
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          sendError(response, "entry_rate_limited");
          return;
        }
        if (admission?.status !== "Allowed") {
          sendError(response, "entry_service_unavailable");
          return;
        }
        closedRecord(admission, ["status"]);
        // A made-up code goes no further: the same answer as any unusable code, no database.
        if (codeValid === false) {
          sendError(response, "entry_unavailable");
          return;
        }
        const entryRequestReference = parseUuidV7(this.#uuidV7Factory());
        const operationReference = parseUuidV7(this.#uuidV7Factory());
        if (entryRequestReference === operationReference) {
          throw new TypeError("fresh references must differ");
        }
        const presented = presentedGuestCredentials(request.get("cookie"));
        const result = parsePortResult(
          await this.#port.establish(
            Object.freeze({
              entryRequestReference,
              operationReference,
              qrToken,
              requestedAt,
              ...(intent === undefined ? {} : { intent }),
              ...(presented.length === 0 ? {} : { presentedCredentials: Object.freeze(presented) }),
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
        // WP-2423 Q11: a replaced or turned-off table code; the customer asks staff for help.
        if (result.status === "QrRetired") {
          forget();
          response.status(410).json({
            schemaVersion: 1,
            code: "entry_qr_retired",
            messageKey:
              result.reason === "Replaced"
                ? "customer.entry.qr_replaced"
                : "customer.entry.qr_turned_off",
            recovery: { action: "AskStaff", storeSelection: "Hidden" },
          });
          return;
        }
        // Coordinator 2026-10-30: no party is seated at this table; no visit is started.
        if (result.status === "TableNotOpen") {
          remember();
          response.status(409).json({
            schemaVersion: 1,
            code: "entry_table_not_open",
            messageKey: "customer.entry.table_not_open",
            recovery: { action: "AskStaff", storeSelection: "Hidden" },
            store: {
              brandDisplayName: result.brandDisplayName,
              storeDisplayName: result.storeDisplayName,
              publicStoreReference: result.publicStoreReference,
              locale: result.locale,
            },
          });
          return;
        }
        // WP-2423 DEC-DINING-GUEST-TABLE-START: a choice for the guest; no visit is started yet.
        if (
          result.status === "TableMayStart" ||
          result.status === "TableBeingCleaned" ||
          result.status === "TableAskNewParty"
        ) {
          const offer = {
            TableMayStart: [
              "entry_table_may_start",
              "customer.entry.table_may_start",
              "StartTable",
            ],
            TableBeingCleaned: [
              "entry_table_being_cleaned",
              "customer.entry.table_being_cleaned",
              "AskStaff",
            ],
            TableAskNewParty: [
              "entry_table_ask_new_party",
              "customer.entry.table_ask_new_party",
              "AnswerNewParty",
            ],
          }[result.status];
          remember();
          response.status(409).json({
            schemaVersion: 1,
            code: offer[0],
            messageKey: offer[1],
            recovery: { action: offer[2], storeSelection: "Hidden" },
            store: {
              brandDisplayName: result.brandDisplayName,
              storeDisplayName: result.storeDisplayName,
              publicStoreReference: result.publicStoreReference,
              locale: result.locale,
            },
          });
          return;
        }
        // WP-2423 item 8 ⑦ 1b: this Store takes no pickup orders (dine-in only).
        if (result.status === "ServiceNotOffered") {
          remember();
          response.status(409).json({
            schemaVersion: 1,
            code: "entry_service_not_offered",
            messageKey: "customer.entry.pickup_not_offered",
            recovery: { action: "AskStaff", storeSelection: "Hidden" },
            store: { storeDisplayName: result.storeDisplayName },
          });
          return;
        }
        // WP-2423 Q4: tell the customer the Store is not taking orders, and today's hours.
        if (result.status === "NotAccepting") {
          remember();
          response.status(409).json({
            schemaVersion: 1,
            code: "entry_not_accepting",
            messageKey: "customer.entry.not_accepting",
            recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
            store: {
              storeDisplayName: result.storeDisplayName,
              operatingState: result.operatingState,
              todayHours: result.todayHours,
              todayKind: result.todayKind,
              nextOpening: result.nextOpening,
              localDate: result.localDate,
              ...(result.notReadyForOrders === true ? { notReadyForOrders: true } : {}),
              ...(result.newGuestsPaused === true ? { newGuestsPaused: true } : {}),
            },
          });
          return;
        }
        const current = presented.find((visit) => visit.source === "Current")?.credential;
        const earlier = presented
          .filter((visit) => visit.source === "Earlier")
          .map((visit) => visit.credential);
        // The visit's cookie only when it changed (a resumed current visit keeps its own), the
        // earlier visits only when they changed, and forgetting the waiting scan.
        if (result.sessionCredential !== current)
          response.append("Set-Cookie", serializeCookie(result.sessionCredential));
        if (
          result.earlierCredentials !== undefined &&
          result.earlierCredentials.join(".") !== earlier.join(".")
        )
          response.append("Set-Cookie", serializeEarlierVisits(result.earlierCredentials));
        forget();
        response.status(result.resumed === true ? 200 : 201).json({
          schemaVersion: 2,
          status: "Established",
          ...(result.resumed === true ? { resumed: true } : {}),
          ...(result.previousVisit === undefined ? {} : { previousVisit: result.previousVisit }),
          brandDisplayName: result.brandDisplayName,
          storeDisplayName: result.storeDisplayName,
          publicStoreReference: result.publicStoreReference,
          publicTableReference: result.publicTableReference,
          channel: result.channel,
          operatingState: result.operatingState,
          availableServiceModes: result.availableServiceModes,
          locale: result.locale,
          contextExpiresAt: result.contextExpiresAt,
          ...(result.tableOpen === undefined ? {} : { tableOpen: result.tableOpen }),
          csrfToken: result.csrfCredential,
        });
      } catch (error) {
        // Only the safe failure code (and SQLSTATE) reaches the request log: no token, no reference.
        markRequestFailure(request, customerFailureCode(error));
        sendError(response, "entry_service_unavailable");
      }
    };
  }
}
