import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
  CustomerEntryServiceMode,
} from "./types.js";
import {
  captureCustomerCsrfContext,
  setCustomerCsrfCredential,
  setPaymentOperationReference,
} from "../session/customer-transaction-context.js";

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

/** WP-2423 Q4: a closed or paused Store, with today's published hours. */
function parseNotAccepting(value: unknown): CustomerEntryScreenState {
  const raw = exact(value, ["schemaVersion", "code", "messageKey", "recovery", "store"]);
  const recovery = exact(raw.recovery, ["action", "storeSelection"]);
  const store = exact(raw.store, ["storeDisplayName", "operatingState", "todayHours"]);
  const time = /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u;
  if (
    raw.schemaVersion !== 1 ||
    raw.messageKey !== "customer.entry.not_accepting" ||
    recovery.action !== "TryLaterOrAskStaff" ||
    recovery.storeSelection !== "Hidden" ||
    !["Closed", "TemporarilyClosed", "Open"].includes(String(store.operatingState)) ||
    !Array.isArray(store.todayHours) ||
    store.todayHours.length > 12
  )
    return Object.freeze({ kind: "ServiceUnavailable" });
  try {
    const todayHours = store.todayHours.map((entry: unknown) => {
      const interval = exact(entry, ["startLocalTime", "endLocalTime", "endsNextDay"]);
      if (
        typeof interval.startLocalTime !== "string" ||
        !time.test(interval.startLocalTime) ||
        typeof interval.endLocalTime !== "string" ||
        !time.test(interval.endLocalTime) ||
        typeof interval.endsNextDay !== "boolean"
      )
        throw new TypeError("invalid hours");
      return Object.freeze({
        start: interval.startLocalTime,
        end: interval.endLocalTime,
        endsNextDay: interval.endsNextDay,
      });
    });
    return Object.freeze({
      kind: "NotAccepting",
      storeDisplayName: publicLabel(store.storeDisplayName),
      // Open with this service unavailable, or temporarily closed, is a pause, not closing time.
      paused: store.operatingState !== "Closed",
      todayHours: Object.freeze(todayHours),
    });
  } catch {
    return Object.freeze({ kind: "ServiceUnavailable" });
  }
}

function parseError(
  status: number,
  value: unknown,
  retryAfter: string | null,
): CustomerEntryScreenState {
  if (
    status === 409 &&
    value !== null &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === "entry_not_accepting"
  )
    return parseNotAccepting(value);
  const raw = exact(value, ["schemaVersion", "code", "messageKey", "recovery"]);
  const recovery = exact(raw.recovery, ["action", "storeSelection"]);
  if (raw.schemaVersion !== 1 || recovery.storeSelection !== "Hidden")
    return Object.freeze({ kind: "ServiceUnavailable" });
  if (
    status === 400 &&
    raw.code === "entry_request_invalid" &&
    raw.messageKey === "customer.entry.request_invalid" &&
    recovery.action === "Rescan"
  )
    return Object.freeze({ kind: "RequestInvalid" });
  if (
    status === 422 &&
    raw.code === "entry_unavailable" &&
    raw.messageKey === "customer.entry.unavailable" &&
    recovery.action === "RescanOrAskStaff"
  )
    return Object.freeze({ kind: "EntryUnavailable" });
  if (
    status === 429 &&
    raw.code === "entry_rate_limited" &&
    raw.messageKey === "customer.entry.rate_limited" &&
    recovery.action === "RetryOrAskStaff" &&
    retryAfter !== null &&
    /^[1-9][0-9]{0,4}$/u.test(retryAfter) &&
    Number(retryAfter) <= 86400
  )
    return Object.freeze({ kind: "RateLimited", retryAfterSeconds: Number(retryAfter) });
  if (
    status === 503 &&
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
  inMemoryToken?: string,
): CustomerEntryClient {
  const fragmentToken = consumeCustomerQrFragment(boundary);
  const token =
    inMemoryToken === undefined
      ? fragmentToken
      : boundary.pathname === "/" &&
          boundary.search === "" &&
          inMemoryToken.length > 0 &&
          inMemoryToken.length <= 2048 &&
          compactTokenPattern.test(inMemoryToken)
        ? inMemoryToken
        : null;
  let settled: Promise<CustomerEntryScreenState> | null = null;
  let retryUntil: number | null = null;
  const cooldown = (): CustomerEntryScreenState =>
    Object.freeze({
      kind: "RateLimited",
      retryAfterSeconds: Math.max(0, Math.ceil(((retryUntil ?? 0) - performance.now()) / 1000)),
    });
  let flight: Promise<CustomerEntryScreenState> | null = null;
  const fetcher = boundary.fetch;
  const online = () => {
    try {
      return boundary.online() === true;
    } catch {
      return false;
    }
  };

  async function receive(current: () => boolean) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = () => {
      if (!online() || !current() || controller.signal.aborted)
        throw new Error("entry unavailable");
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("entry unavailable"));
        controller.abort();
      }, 15_000);
    });
    const request = async () => {
      guard();
      const response = await fetcher("/bff/customer/entry", {
        method: "POST",
        mode: "cors",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qrToken: token }),
      });
      try {
        guard();
        if (
          response.redirected ||
          response.body === null ||
          !response.headers
            .get("cache-control")
            ?.split(",")
            .some((part) => part.trim().toLowerCase() === "no-store") ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
        )
          throw new Error("entry unavailable");
      } catch {
        if (response.body) void response.body.cancel().catch(() => undefined);
        throw new Error("entry unavailable");
      }
      if (response.body === null) throw new Error("entry unavailable");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        guard();
        const part = await reader.read();
        guard();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) throw new Error("entry unavailable");
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      guard();
      return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
    };
    try {
      return await Promise.race([request(), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  const execute = async (): Promise<CustomerEntryScreenState> => {
    setCustomerCsrfCredential(null);
    setPaymentOperationReference(null);
    const current = captureCustomerCsrfContext();
    if (token === null) return Object.freeze({ kind: "Missing" });
    if (!online()) return Object.freeze({ kind: "Offline" });
    try {
      const { status, body, retryAfter } = await receive(current);
      if (!online() || !current()) throw new Error("entry unavailable");
      if (status === 201) {
        const context = parseSuccess(body);
        if (!online() || !current()) throw new Error("entry unavailable");
        setCustomerCsrfCredential(context.csrfToken);
        return Object.freeze({ kind: "Established", context });
      }
      const error = parseError(status, body, retryAfter);
      retryUntil =
        error.kind === "RateLimited" ? performance.now() + error.retryAfterSeconds * 1000 : null;
      return error;
    } catch {
      return Object.freeze({ kind: online() ? "CommandFailed" : "Offline" });
    }
  };
  function launch() {
    if (flight) return flight;
    if (retryUntil !== null && performance.now() < retryUntil) return Promise.resolve(cooldown());
    retryUntil = null;
    const pending = execute();
    flight = pending;
    settled = pending;
    void pending.then(() => {
      if (flight === pending) flight = null;
    });
    return pending;
  }
  return Object.freeze({
    hasEntry: token !== null,
    start() {
      return retryUntil === null ? (settled ?? launch()) : Promise.resolve(cooldown());
    },
    retry() {
      return flight ?? launch();
    },
  });
}
