import { t } from "./i18n/i18n.js";
import {
  defaultCommandOutcomeRecovery,
  withCommandOutcomeRecovery,
  type CommandOutcomeRecovery,
} from "./command-outcome-recovery.js";
export interface DiningSessionCloseCommand {
  readonly operationReference: string;
  readonly diningSessionReference: string;
  /** DEC-DINE-IN-PAY-LATER: "Cancel" takes a checking-out table back to ordering. */
  readonly action: "Begin" | "Cancel" | "Finalize";
  readonly expectedSessionVersion: number;
}
export class DiningSessionCloseClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "Conflict"
      | "AlreadyPaid"
      | "GuestPaying"
      | "Unavailable"
      | "OutcomeUnknown",
  ) {
    super(t("Dining session closure could not be confirmed"));
    this.name = "DiningSessionCloseClientError";
  }
}
const invalid = (): never => {
  throw new DiningSessionCloseClientError("Unavailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function commandSnapshot(command: DiningSessionCloseCommand): DiningSessionCloseCommand {
  const keys = [
    "operationReference",
    "diningSessionReference",
    "action",
    "expectedSessionVersion",
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
  if (values[2] !== "Begin" && values[2] !== "Cancel" && values[2] !== "Finalize") return invalid();
  if (
    typeof values[3] !== "number" ||
    !Number.isSafeInteger(values[3]) ||
    values[3] < 1 ||
    values[3] >= 2147483647
  )
    return invalid();
  return Object.freeze(
    Object.fromEntries(keys.map((key, i) => [key, values[i]])),
  ) as unknown as DiningSessionCloseCommand;
}

/** One immutable operation per user intent. Transport failures never create a new operation. */
export function createDiningSessionCloseClient(
  fetcher: typeof fetch = fetch,
  recovery: CommandOutcomeRecovery = defaultCommandOutcomeRecovery,
) {
  return Object.freeze({
    prepare(command: DiningSessionCloseCommand) {
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
              error instanceof DiningSessionCloseClientError && error.code === "OutcomeUnknown",
          });
        },
      });
      async function send(csrf: string, signal: AbortSignal | undefined, timeoutMs: number) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, timeoutMs);
        try {
          const response = await fetcher("/merchant/dining/closing", {
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
          if (controller.signal.aborted) throw new DiningSessionCloseClientError("OutcomeUnknown");
          if (response.status === 401 || response.status === 403)
            throw new DiningSessionCloseClientError("PermissionDenied");
          if (response.status === 409) {
            const error = ((await response.json().catch(() => null)) as { error?: unknown } | null)
              ?.error;
            throw new DiningSessionCloseClientError(
              error === "table_already_paid"
                ? "AlreadyPaid"
                : error === "table_guest_paying"
                  ? "GuestPaying"
                  : "Conflict",
            );
          }
          if (
            !response.ok ||
            response.headers.get("cache-control") !== "no-store" ||
            !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
          )
            throw new DiningSessionCloseClientError("OutcomeUnknown");
          const text = await response.text();
          if (controller.signal.aborted || text.length > 1024)
            throw new DiningSessionCloseClientError("OutcomeUnknown");
          const value: unknown = JSON.parse(text);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== 3
          )
            throw new DiningSessionCloseClientError("OutcomeUnknown");
          const result = value as Record<string, unknown>;
          if (
            (result.status !== "Applied" && result.status !== "AlreadyApplied") ||
            result.sessionVersion !== snapshot.expectedSessionVersion + 1 ||
            result.phase !==
              ({ Begin: "Closing", Cancel: "Active", Finalize: "Closed" } as const)[snapshot.action]
          )
            throw new DiningSessionCloseClientError("OutcomeUnknown");
          return Object.freeze({
            status: result.status,
            sessionVersion: result.sessionVersion,
            phase: result.phase,
          });
        } catch (error) {
          if (error instanceof DiningSessionCloseClientError) throw error;
          throw new DiningSessionCloseClientError("OutcomeUnknown");
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
      }
    },
  });
}
