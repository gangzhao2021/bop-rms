export interface DiningSessionCloseCommand {
  readonly operationReference: string;
  readonly diningSessionReference: string;
  readonly action: "Begin" | "Finalize";
  readonly expectedSessionVersion: number;
}
export class DiningSessionCloseClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Dining session closure could not be confirmed");
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
  if (values[2] !== "Begin" && values[2] !== "Finalize") return invalid();
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
export function createDiningSessionCloseClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: DiningSessionCloseCommand) {
      const snapshot = commandSnapshot(command);
      const body = JSON.stringify(snapshot);
      return Object.freeze({
        async execute(csrf: string, signal?: AbortSignal) {
          if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted)
            return invalid();
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          const timeout = setTimeout(abort, 15000);
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
            if (controller.signal.aborted)
              throw new DiningSessionCloseClientError("OutcomeUnknown");
            if (response.status === 401 || response.status === 403)
              throw new DiningSessionCloseClientError("PermissionDenied");
            if (response.status === 409) throw new DiningSessionCloseClientError("Conflict");
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
              result.phase !== (snapshot.action === "Begin" ? "Closing" : "Closed")
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
        },
      });
    },
  });
}
