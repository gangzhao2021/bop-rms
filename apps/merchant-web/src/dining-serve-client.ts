export interface DiningServeCommand {
  readonly operationReference: string;
  readonly orderReference: string;
  readonly orderItemReference: string;
  readonly quantity: number;
  readonly expectedOrderVersion: number;
  readonly expectedItemServiceVersion: number;
  readonly expectedSessionVersion: number;
  readonly expectedTableAssignmentVersion: number;
}
export class DiningServeClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Serving could not be confirmed");
    this.name = "DiningServeClientError";
  }
}
const invalid = (): never => {
  throw new DiningServeClientError("Unavailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function commandSnapshot(command: DiningServeCommand): DiningServeCommand {
  const keys = [
    "operationReference",
    "orderReference",
    "orderItemReference",
    "quantity",
    "expectedOrderVersion",
    "expectedItemServiceVersion",
    "expectedSessionVersion",
    "expectedTableAssignmentVersion",
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
  for (const value of values.slice(0, 3))
    if (typeof value !== "string" || !reference.test(value)) return invalid();
  for (let index = 3; index < values.length; index++) {
    const value = values[index];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (index === 5 ? 0 : 1) ||
      value >= 2147483647 ||
      (index === 3 && value > 999)
    )
      return invalid();
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key, i) => [key, values[i]])),
  ) as unknown as DiningServeCommand;
}

/** One immutable operation per user intent. Transport failures never create a new operation. */
export function createDiningServeClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: DiningServeCommand) {
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
            const response = await fetcher("/merchant/dining/serve", {
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
            if (controller.signal.aborted) throw new DiningServeClientError("OutcomeUnknown");
            if (response.status === 401 || response.status === 403)
              throw new DiningServeClientError("PermissionDenied");
            if (response.status === 409) throw new DiningServeClientError("Conflict");
            if (
              !response.ok ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
            )
              throw new DiningServeClientError("OutcomeUnknown");
            const text = await response.text();
            if (controller.signal.aborted || text.length > 1024)
              throw new DiningServeClientError("OutcomeUnknown");
            const value: unknown = JSON.parse(text);
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).length !== 2
            )
              throw new DiningServeClientError("OutcomeUnknown");
            const result = value as Record<string, unknown>;
            if (
              (result.status !== "Created" && result.status !== "AlreadyCommitted") ||
              result.itemServiceVersion !== snapshot.expectedItemServiceVersion + 1
            )
              throw new DiningServeClientError("OutcomeUnknown");
            return Object.freeze({
              status: result.status,
              itemServiceVersion: result.itemServiceVersion,
            });
          } catch (error) {
            if (error instanceof DiningServeClientError) throw error;
            throw new DiningServeClientError("OutcomeUnknown");
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  });
}
