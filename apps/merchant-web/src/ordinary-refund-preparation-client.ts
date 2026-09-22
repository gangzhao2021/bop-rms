export interface OrdinaryRefundPreparationCommand {
  readonly operationReference: string;
  readonly orderReference: string;
  readonly requestReference: string;
  readonly paymentAttemptReference: string;
  readonly auditReference: string;
  readonly approvalReference: string | null;
}
export class OrdinaryRefundPreparationClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Conflict" | "Unavailable" | "OutcomeUnknown") {
    super("Refund preparation could not be confirmed");
    this.name = "OrdinaryRefundPreparationClientError";
  }
}
const invalid = (): never => {
  throw new OrdinaryRefundPreparationClientError("Unavailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function commandSnapshot(
  command: OrdinaryRefundPreparationCommand,
): OrdinaryRefundPreparationCommand {
  const keys = [
    "operationReference",
    "orderReference",
    "requestReference",
    "paymentAttemptReference",
    "auditReference",
    "approvalReference",
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
  for (const value of values.slice(0, 5))
    if (typeof value !== "string" || !reference.test(value)) return invalid();
  if (values[5] !== null && (typeof values[5] !== "string" || !reference.test(values[5])))
    return invalid();
  return Object.freeze(
    Object.fromEntries(keys.map((key, i) => [key, values[i]])),
  ) as unknown as OrdinaryRefundPreparationCommand;
}

/** Preparation is not Provider success. Retain this immutable intent after an unknown outcome. */
export function createOrdinaryRefundPreparationClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: OrdinaryRefundPreparationCommand) {
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
            const response = await fetcher("/merchant/payments/refunds/prepare", {
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
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            if (response.status === 401 || response.status === 403)
              throw new OrdinaryRefundPreparationClientError("PermissionDenied");
            if (response.status === 409) throw new OrdinaryRefundPreparationClientError("Conflict");
            if (
              response.status === 503 &&
              response.headers.get("cache-control") === "no-store" &&
              response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
            ) {
              const text = await response.text();
              if (!controller.signal.aborted && text.length <= 1024) {
                const value: unknown = JSON.parse(text);
                if (
                  value &&
                  typeof value === "object" &&
                  !Array.isArray(value) &&
                  Object.keys(value).length === 1 &&
                  (value as Record<string, unknown>).error === "refund_preparation_unavailable"
                )
                  throw new OrdinaryRefundPreparationClientError("Unavailable");
              }
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            }
            if (
              response.status !== 202 ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
            )
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            const text = await response.text();
            if (controller.signal.aborted || text.length > 1024)
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            const value: unknown = JSON.parse(text);
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).length !== 3
            )
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            const result = value as Record<string, unknown>;
            if (
              result.status !== "PreparationRecorded" ||
              result.operationReference !== snapshot.operationReference ||
              typeof result.replayed !== "boolean"
            )
              throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
            return Object.freeze({
              status: "PreparationRecorded" as const,
              operationReference: snapshot.operationReference,
              replayed: result.replayed,
            });
          } catch (error) {
            if (error instanceof OrdinaryRefundPreparationClientError) throw error;
            throw new OrdinaryRefundPreparationClientError("OutcomeUnknown");
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  });
}
