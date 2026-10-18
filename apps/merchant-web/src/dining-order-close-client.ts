import {
  defaultCommandOutcomeRecovery,
  withCommandOutcomeRecovery,
  type CommandOutcomeRecovery,
} from "./command-outcome-recovery.js";
export interface DiningOrderCloseCommand {
  readonly operationReference: string;
  readonly orderReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedClosureVersion: number;
  readonly reasonCode: string;
}
export class DiningOrderCloseClientError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "NotReady" | "Conflict" | "Unavailable" | "OutcomeUnknown",
    /** NotReady: the server's reason codes (what is still outstanding). */
    readonly reasons: readonly string[] = [],
  ) {
    super("Order closure could not be confirmed");
    this.name = "DiningOrderCloseClientError";
  }
}
/** WP-2423 (B759): a 409 names why the Order can't close yet; anything else is a plain conflict. */
async function refusal(response: Response): Promise<DiningOrderCloseClientError> {
  try {
    const text = await response.text();
    const value: unknown = text.length > 4096 ? null : JSON.parse(text);
    const body = value as { error?: unknown; reasons?: unknown } | null;
    if (
      body?.error === "order_not_ready" &&
      Array.isArray(body.reasons) &&
      body.reasons.length <= 32 &&
      body.reasons.every(
        (code: unknown) => typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code),
      )
    )
      return new DiningOrderCloseClientError("NotReady", Object.freeze([...body.reasons]));
  } catch {
    // An unreadable body is still a refusal: re-check the table.
  }
  return new DiningOrderCloseClientError("Conflict");
}
const invalid = (): never => {
  throw new DiningOrderCloseClientError("Unavailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function commandSnapshot(command: DiningOrderCloseCommand): DiningOrderCloseCommand {
  const keys = [
    "operationReference",
    "orderReference",
    "expectedOrderVersion",
    "expectedClosureVersion",
    "reasonCode",
  ] as const;
  if (
    !command ||
    Object.getPrototypeOf(command) !== Object.prototype ||
    Reflect.ownKeys(command).length !== keys.length
  )
    return invalid();
  const values = keys.map((key) => {
    const property = Object.getOwnPropertyDescriptor(command, key);
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    return property.value as unknown;
  });
  for (const value of values.slice(0, 2))
    if (typeof value !== "string" || !reference.test(value)) return invalid();
  for (let index = 2; index < 4; index++) {
    const value = values[index];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (index === 3 ? 0 : 1) ||
      value >= 2147483647
    )
      return invalid();
  }
  if (typeof values[4] !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(values[4])) return invalid();
  return Object.freeze(
    Object.fromEntries(keys.map((key, i) => [key, values[i]])),
  ) as unknown as DiningOrderCloseCommand;
}

/** One immutable operation per user intent. Transport failures never create a new operation. */
export function createDiningOrderCloseClient(
  fetcher: typeof fetch = fetch,
  recovery: CommandOutcomeRecovery = defaultCommandOutcomeRecovery,
) {
  return Object.freeze({
    prepare(command: DiningOrderCloseCommand) {
      const snapshot = commandSnapshot(command);
      const body = JSON.stringify(snapshot);
      return Object.freeze({
        async execute(csrf: string, signal?: AbortSignal) {
          if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted)
            return invalid();
          // WP-2423: a lost answer is re-checked with this same operation (applied once).
          return withCommandOutcomeRecovery({
            recovery,
            firstTimeoutMs: 15000,
            signal,
            send: (timeoutMs) => send(csrf, signal, timeoutMs),
            lost: (error) =>
              error instanceof DiningOrderCloseClientError && error.code === "OutcomeUnknown",
          });
        },
      });
      async function send(csrf: string, signal: AbortSignal | undefined, timeoutMs: number) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, timeoutMs);
        try {
          const response = await fetcher("/merchant/orders/close", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            body,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": csrf,
            },
          });
          if (controller.signal.aborted) throw new DiningOrderCloseClientError("OutcomeUnknown");
          if (response.status === 401 || response.status === 403)
            throw new DiningOrderCloseClientError("PermissionDenied");
          if (response.status === 409) throw await refusal(response);
          if (
            !response.ok ||
            response.headers.get("cache-control") !== "no-store" ||
            !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
          )
            throw new DiningOrderCloseClientError("OutcomeUnknown");
          const text = await response.text();
          if (controller.signal.aborted || text.length > 1024)
            throw new DiningOrderCloseClientError("OutcomeUnknown");
          const value: unknown = JSON.parse(text);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== 3
          )
            throw new DiningOrderCloseClientError("OutcomeUnknown");
          const result = value as Record<string, unknown>;
          if (
            (result.status !== "Committed" && result.status !== "AlreadyCommitted") ||
            result.closureVersion !== snapshot.expectedClosureVersion + 1 ||
            result.closedOrderVersion !== snapshot.expectedOrderVersion
          )
            throw new DiningOrderCloseClientError("OutcomeUnknown");
          return Object.freeze({
            status: result.status,
            closureVersion: result.closureVersion,
            closedOrderVersion: result.closedOrderVersion,
          });
        } catch (error) {
          if (error instanceof DiningOrderCloseClientError) throw error;
          throw new DiningOrderCloseClientError("OutcomeUnknown");
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
      }
    },
  });
}
