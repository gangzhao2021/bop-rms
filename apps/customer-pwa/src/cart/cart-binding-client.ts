export type CartBindingClientErrorCode =
  "request-invalid" | "offline" | "unavailable" | "outcome-unknown";

export class CartBindingClientError extends Error {
  constructor(readonly code: CartBindingClientErrorCode) {
    super("cart binding is unavailable");
    this.name = "CartBindingClientError";
  }
}
export interface CartBindingPrepared {
  readonly status: "Prepared";
  readonly operationReference: string;
  readonly candidateCsrfToken: string;
  readonly recoveryProof: string;
  readonly expiresAt: string;
}
export interface CartBindingActivated {
  readonly status: "Activated";
  readonly operationReference: string;
  readonly csrfToken: string;
}
export interface CartBindingClient {
  prepare(input: unknown): Promise<CartBindingPrepared>;
  activate(input: unknown): Promise<CartBindingActivated>;
  complete(input: unknown): Promise<CartBindingActivated>;
}
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const routes = Object.freeze({
  prepare: "/bff/customer/cart-binding/prepare",
  activate: "/bff/customer/cart-binding/activate",
  complete: "/bff/customer/cart-binding/complete",
});
function invalid(): never {
  throw new CartBindingClientError("request-invalid");
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
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}

/** Credentials returned here belong only in short-lived caller memory, never rendered state. */
export function createBrowserCartBindingClient(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly online?: () => boolean;
    readonly timeoutMs?: number;
  } = {},
): CartBindingClient {
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const online =
    options.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) return invalid();

  async function send<T>(
    action: keyof typeof routes,
    operationReference: string,
    csrfToken: string,
    body: object,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      if (!online()) throw new CartBindingClientError("offline");
    } catch {
      throw new CartBindingClientError("offline");
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let knownFailure: "request-invalid" | "unavailable" | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CartBindingClientError("outcome-unknown"));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetcher(routes[action], {
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
      )
        throw new Error("invalid response");
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
        error.code === "cart_binding_request_invalid" &&
        error.messageKey === "customer.cart.binding_request_invalid"
      )
        knownFailure = "request-invalid";
      if (
        response.status === 503 &&
        error.code === "cart_binding_unavailable" &&
        error.messageKey === "customer.cart.binding_unavailable"
      )
        knownFailure = "unavailable";
      throw new Error("failed response");
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch {
      throw new CartBindingClientError(knownFailure ?? "outcome-unknown");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader !== undefined) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  function input(value: unknown, action: keyof typeof routes) {
    try {
      const raw = exact(
        value,
        action === "activate"
          ? ["operationReference", "csrfToken", "candidateCsrfToken", "recoveryProof"]
          : ["operationReference", "csrfToken"],
      );
      const base = {
        operationReference: reference(raw.operationReference),
        csrfToken: credential(raw.csrfToken),
      };
      if (action !== "activate") return { ...base, candidateCsrfToken: null, recoveryProof: null };
      const candidateCsrfToken = credential(raw.candidateCsrfToken);
      const recoveryProof = credential(raw.recoveryProof);
      if (new Set([base.csrfToken, candidateCsrfToken, recoveryProof]).size !== 3) return invalid();
      return { ...base, candidateCsrfToken, recoveryProof };
    } catch {
      return invalid();
    }
  }
  function activated(
    value: unknown,
    operationReference: string,
    csrfToken: string,
  ): CartBindingActivated {
    const raw = exact(value, ["status", "operationReference", "csrfToken"]);
    if (
      raw.status !== "Activated" ||
      raw.operationReference !== operationReference ||
      raw.csrfToken !== csrfToken
    )
      return invalid();
    return Object.freeze({ status: "Activated", operationReference, csrfToken });
  }
  return Object.freeze({
    async prepare(value: unknown) {
      const parsed = input(value, "prepare");
      return send("prepare", parsed.operationReference, parsed.csrfToken, {}, (value) => {
        const raw = exact(value, [
          "status",
          "operationReference",
          "candidateCsrfToken",
          "recoveryProof",
          "expiresAt",
        ]);
        const candidateCsrfToken = credential(raw.candidateCsrfToken);
        const recoveryProof = credential(raw.recoveryProof);
        if (
          raw.status !== "Prepared" ||
          raw.operationReference !== parsed.operationReference ||
          new Set([parsed.csrfToken, candidateCsrfToken, recoveryProof]).size !== 3
        )
          return invalid();
        return Object.freeze({
          status: "Prepared",
          operationReference: parsed.operationReference,
          candidateCsrfToken,
          recoveryProof,
          expiresAt: instant(raw.expiresAt),
        } as const);
      });
    },
    async activate(value: unknown) {
      const parsed = input(value, "activate");
      const candidateCsrfToken = credential(parsed.candidateCsrfToken);
      return send(
        "activate",
        parsed.operationReference,
        parsed.csrfToken,
        { candidateCsrfToken, recoveryProof: parsed.recoveryProof },
        (value) => activated(value, parsed.operationReference, candidateCsrfToken),
      );
    },
    async complete(value: unknown) {
      const parsed = input(value, "complete");
      return send("complete", parsed.operationReference, parsed.csrfToken, {}, (value) =>
        activated(value, parsed.operationReference, parsed.csrfToken),
      );
    },
  });
}
