import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
  CustomerEntryServiceMode,
} from "./types.js";

const compactTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const publicLabelForbidden = /[\p{Cc}\p{Cf}<>{}[\]`*_#]/u;

export interface CustomerEntryBrowserBoundary {
  readonly fetch: typeof globalThis.fetch;
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
  readonly replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
  readonly online: () => boolean;
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("closed response required");
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      );
    })
  )
    throw new TypeError("closed response required");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
  );
}

function publicLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 120 ||
    value !== value.normalize("NFC") ||
    value !== value.trim() ||
    publicLabelForbidden.test(value)
  )
    throw new TypeError("public label required");
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new TypeError("public reference required");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new TypeError("canonical instant required");
  return value;
}

function parseSuccess(value: unknown): CustomerEntryEstablishedContext {
  const raw = exact(value, [
    "schemaVersion",
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
    "csrfToken",
  ]);
  if (
    raw.schemaVersion !== 2 ||
    raw.status !== "Established" ||
    (raw.channel !== "DineIn" && raw.channel !== "Pickup") ||
    !["Open", "Closed", "TemporarilyClosed"].includes(String(raw.operatingState)) ||
    typeof raw.locale !== "string" ||
    !localePattern.test(raw.locale) ||
    typeof raw.csrfToken !== "string" ||
    !credentialPattern.test(raw.csrfToken) ||
    !Array.isArray(raw.availableServiceModes)
  )
    throw new TypeError("malformed entry result");
  const publicTableReference =
    raw.publicTableReference === null ? null : reference(raw.publicTableReference);
  if ((raw.channel === "DineIn") !== (publicTableReference !== null))
    throw new TypeError("Table context mismatch");
  const modes = Object.freeze(
    raw.availableServiceModes.map((mode) => {
      if (!(["DineIn", "Pickup", "Delivery"] as const).includes(mode as never))
        throw new TypeError("unknown service mode");
      return mode as CustomerEntryServiceMode;
    }),
  );
  if (
    new Set(modes).size !== modes.length ||
    (raw.operatingState === "Open") !== modes.includes(raw.channel) ||
    (raw.operatingState !== "Open" && modes.length !== 0)
  )
    throw new TypeError("operating context conflict");
  return Object.freeze({
    brandDisplayName: publicLabel(raw.brandDisplayName),
    storeDisplayName: publicLabel(raw.storeDisplayName),
    publicStoreReference: reference(raw.publicStoreReference),
    publicTableReference,
    channel: raw.channel,
    operatingState: raw.operatingState as CustomerEntryEstablishedContext["operatingState"],
    availableServiceModes: modes,
    locale: raw.locale,
    contextExpiresAt: instant(raw.contextExpiresAt),
    csrfToken: raw.csrfToken,
  });
}

function parseError(value: unknown): CustomerEntryScreenState {
  const raw = exact(value, ["schemaVersion", "code", "messageKey", "recovery"]);
  const recovery = exact(raw.recovery, ["action", "storeSelection"]);
  if (raw.schemaVersion !== 1 || recovery.storeSelection !== "Hidden")
    return Object.freeze({ kind: "ServiceUnavailable" });
  if (
    raw.code === "entry_request_invalid" &&
    raw.messageKey === "customer.entry.request_invalid" &&
    recovery.action === "Rescan"
  )
    return Object.freeze({ kind: "RequestInvalid" });
  if (
    raw.code === "entry_unavailable" &&
    raw.messageKey === "customer.entry.unavailable" &&
    recovery.action === "RescanOrAskStaff"
  )
    return Object.freeze({ kind: "EntryUnavailable" });
  if (
    raw.code === "entry_service_unavailable" &&
    raw.messageKey === "customer.entry.service_unavailable" &&
    recovery.action === "RetryOrAskStaff"
  )
    return Object.freeze({ kind: "ServiceUnavailable" });
  return Object.freeze({ kind: "ServiceUnavailable" });
}

export function consumeCustomerQrFragment(input: {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
  readonly replaceState: CustomerEntryBrowserBoundary["replaceState"];
}): string | null {
  input.replaceState(null, "", input.pathname);
  if (input.pathname !== "/" || input.search !== "" || !input.hash.startsWith("#qr=")) return null;
  const token = input.hash.slice(4);
  if (
    token.length < 1 ||
    token.length > 2048 ||
    token.includes("%") ||
    !compactTokenPattern.test(token)
  )
    return null;
  return token;
}

export function createCustomerEntryClient(
  boundary: CustomerEntryBrowserBoundary,
): CustomerEntryClient {
  const token = consumeCustomerQrFragment(boundary);
  let settled: Promise<CustomerEntryScreenState> | null = null;

  const execute = async (): Promise<CustomerEntryScreenState> => {
    if (token === null) return Object.freeze({ kind: "Missing" });
    if (!boundary.online()) return Object.freeze({ kind: "Offline" });
    try {
      const response = await boundary.fetch("/bff/customer/entry", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrToken: token }),
      });
      const body: unknown = await response.json();
      if (response.status === 201)
        return Object.freeze({ kind: "Established", context: parseSuccess(body) });
      return parseError(body);
    } catch {
      return Object.freeze({ kind: boundary.online() ? "CommandFailed" : "Offline" });
    }
  };

  return Object.freeze({
    hasEntry: token !== null,
    start() {
      settled ??= execute();
      return settled;
    },
    retry() {
      settled = execute();
      return settled;
    },
  });
}
