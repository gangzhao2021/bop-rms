export interface OrderAcceptanceCommand {
  readonly acceptanceReference: string;
  readonly operationReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly expectedOrderVersion: number;
}
export class OrderAcceptanceClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Order acceptance could not be confirmed");
    this.name = "OrderAcceptanceClientError";
  }
}
const invalid = (): never => {
  throw new OrderAcceptanceClientError("Unavailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function commandSnapshot(command: OrderAcceptanceCommand): OrderAcceptanceCommand {
  const keys = [
    "acceptanceReference",
    "operationReference",
    "orderReference",
    "orderBatchReference",
    "expectedOrderVersion",
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
  for (const value of values.slice(0, 4))
    if (typeof value !== "string" || !reference.test(value)) return invalid();
  const version = values[4];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version >= 2147483647
  )
    return invalid();
  return Object.freeze(
    Object.fromEntries(keys.map((key, i) => [key, values[i]])),
  ) as unknown as OrderAcceptanceCommand;
}

/** One immutable operation per user intent. Transport failures never create a new operation. */
export function createOrderAcceptanceClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: OrderAcceptanceCommand) {
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
            const response = await fetcher("/merchant/orders/accept", {
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
            if (controller.signal.aborted) throw new OrderAcceptanceClientError("OutcomeUnknown");
            if (response.status === 401 || response.status === 403)
              throw new OrderAcceptanceClientError("PermissionDenied");
            if (response.status === 409) throw new OrderAcceptanceClientError("Conflict");
            if (
              !response.ok ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
            )
              throw new OrderAcceptanceClientError("OutcomeUnknown");
            const text = await response.text();
            if (controller.signal.aborted || text.length > 1024)
              throw new OrderAcceptanceClientError("OutcomeUnknown");
            const value: unknown = JSON.parse(text);
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).length !== 2
            )
              throw new OrderAcceptanceClientError("OutcomeUnknown");
            const result = value as Record<string, unknown>;
            if (
              (result.status !== "Created" && result.status !== "AlreadyCommitted") ||
              result.acceptedOrderVersion !== snapshot.expectedOrderVersion + 1
            )
              throw new OrderAcceptanceClientError("OutcomeUnknown");
            return Object.freeze({
              status: result.status,
              acceptedOrderVersion: result.acceptedOrderVersion,
            });
          } catch (error) {
            if (error instanceof OrderAcceptanceClientError) throw error;
            throw new OrderAcceptanceClientError("OutcomeUnknown");
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  });
}
