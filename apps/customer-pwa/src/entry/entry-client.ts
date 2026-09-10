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

function parseError(status: number, value: unknown): CustomerEntryScreenState {
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
): CustomerEntryClient {
  const token = consumeCustomerQrFragment(boundary);
  let settled: Promise<CustomerEntryScreenState> | null = null;
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
      return { status: response.status, body };
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
      const { status, body } = await receive(current);
      if (!online() || !current()) throw new Error("entry unavailable");
      if (status === 201) {
        const context = parseSuccess(body);
        if (!online() || !current()) throw new Error("entry unavailable");
        setCustomerCsrfCredential(context.csrfToken);
        return Object.freeze({ kind: "Established", context });
      }
      return parseError(status, body);
    } catch {
      return Object.freeze({ kind: online() ? "CommandFailed" : "Offline" });
    }
  };
  function launch() {
    if (flight) return flight;
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
      return settled ?? launch();
    },
    retry() {
      return flight ?? launch();
    },
  });
}
