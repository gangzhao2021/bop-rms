export type DiningJoinClientErrorCode =
  "request-invalid" | "offline" | "unavailable" | "outcome-unknown";
export class DiningJoinClientError extends Error {
  constructor(readonly code: DiningJoinClientErrorCode) {
    super("dining join is unavailable");
    this.name = "DiningJoinClientError";
  }
}
export interface DiningJoined {
  readonly status: "Joined";
  readonly operationReference: string;
  readonly admissionReference: string;
}
export interface DiningJoinClient {
  join(input: unknown): Promise<DiningJoined>;
}
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const route = "/bff/customer/dining/join";
function invalid(): never {
  throw new DiningJoinClientError("request-invalid");
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function credential(value: unknown): string {
  if (typeof value !== "string" || !credentialPattern.test(value)) return invalid();
  return value;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !referencePattern.test(value)) return invalid();
  return value;
}
function joinCredential(value: unknown): string {
  // A canonical 16-byte base64url encoding has four zero padding bits in its last character.
  if (
    typeof value !== "string" ||
    !(/^[0-9]{6}$/u.test(value) || /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value))
  )
    return invalid();
  return value;
}
/** The admission belongs only in short-lived caller memory; it is not Ordering authority. */
export function createBrowserDiningJoinClient(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly online?: () => boolean;
    readonly timeoutMs?: number;
  } = {},
): DiningJoinClient {
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const online =
    options.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) return invalid();

  async function send<T>(
    operationReference: string,
    csrfToken: string,
    body: object,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      if (!online()) throw new DiningJoinClientError("offline");
    } catch {
      throw new DiningJoinClientError("offline");
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let knownFailure: "request-invalid" | "unavailable" | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DiningJoinClientError("outcome-unknown"));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetcher(route, {
        method: "POST",
        mode: "cors",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": operationReference,
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(body),
      });
      if (
        controller.signal.aborted ||
        response.redirected ||
        !response.headers
          .get("cache-control")
          ?.split(",")
          .some((part) => part.trim().toLowerCase() === "no-store") ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        response.body === null
      ) {
        // A late or rejected envelope may arrive after the outer deadline has already settled.
        if (response.body !== null) void response.body.cancel().catch(() => undefined);
        throw new Error("invalid response");
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        if (controller.signal.aborted) throw new Error("expired request");
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) throw new Error("oversized response");
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (response.status === 200) return parse(value);
      const payload = exact(value, ["error"]);
      const error = exact(payload.error, ["code", "messageKey"]);
      if (
        response.status === 400 &&
        error.code === "dining_join_request_invalid" &&
        error.messageKey === "customer.dining.join_request_invalid"
      )
        knownFailure = "request-invalid";
      if (
        response.status === 503 &&
        error.code === "dining_join_unavailable" &&
        error.messageKey === "customer.dining.join_unavailable"
      )
        knownFailure = "unavailable";
      throw new Error("failed response");
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch {
      throw new DiningJoinClientError(knownFailure ?? "outcome-unknown");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader !== undefined) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  return Object.freeze({
    async join(value: unknown) {
      let parsed: { operationReference: string; csrfToken: string; joinCredential: string };
      try {
        const raw = exact(value, ["operationReference", "csrfToken", "joinCredential"]);
        parsed = {
          operationReference: reference(raw.operationReference),
          csrfToken: credential(raw.csrfToken),
          joinCredential: joinCredential(raw.joinCredential),
        };
      } catch {
        return invalid();
      }
      return send(
        parsed.operationReference,
        parsed.csrfToken,
        { joinCredential: parsed.joinCredential },
        (value) => {
          const raw = exact(value, ["status", "operationReference", "admissionReference"]);
          const admissionReference = reference(raw.admissionReference);
          if (raw.status !== "Joined" || raw.operationReference !== parsed.operationReference)
            return invalid();
          return Object.freeze({
            status: "Joined",
            operationReference: parsed.operationReference,
            admissionReference,
          } as const);
        },
      );
    },
  });
}
