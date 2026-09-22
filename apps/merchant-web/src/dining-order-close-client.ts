export interface DiningOrderCloseCommand {
  readonly operationReference: string;
  readonly orderReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedClosureVersion: number;
  readonly reasonCode: string;
}
export class DiningOrderCloseClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Order closure could not be confirmed");
    this.name = "DiningOrderCloseClientError";
  }
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
export function createDiningOrderCloseClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: DiningOrderCloseCommand) {
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
            if (response.status === 409) throw new DiningOrderCloseClientError("Conflict");
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
        },
      });
    },
  });
}
