export interface RefundSendCommand {
  operationReference: string;
  orderReference: string;
  requestReference: string;
  dispatchReference: string;
  auditReference: string;
  approvalReference: string | null;
}
export interface RefundReconciliationCommand {
  orderReference: string;
  operationReference: string;
  observationReference: string;
  auditReference: string;
}
export class OrdinaryRefundExecutionError extends Error {
  constructor(readonly code: "PermissionDenied" | "Unavailable" | "OutcomeUnknown") {
    super("Refund execution could not be confirmed");
    this.name = "OrdinaryRefundExecutionError";
  }
}
const fail = (code: "PermissionDenied" | "Unavailable" | "OutcomeUnknown"): never => {
  throw new OrdinaryRefundExecutionError(code);
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function snapshot(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail("Unavailable");
  return JSON.stringify(
    Object.fromEntries(
      keys.map((key) => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !("value" in d) || !d.enumerable) return fail("Unavailable");
        const v: unknown = d.value;
        if (!(key === "approvalReference" && v === null) && (typeof v !== "string" || !ref.test(v)))
          return fail("Unavailable");
        return [key, v];
      }),
    ),
  );
}
/** Retain the returned intent across an unknown result; acknowledgments never
 * claim that the refund settled. Read current execution status separately. */
export function createOrdinaryRefundExecutionClient(fetcher: typeof fetch = fetch) {
  function prepare(path: "send" | "reconcile", command: unknown, keys: readonly string[]) {
    const body = snapshot(command, keys),
      status = path === "send" ? "DispatchRecorded" : "ReconciliationRecorded";
    return Object.freeze({
      async execute(
        csrf: string,
        signal?: AbortSignal,
      ): Promise<{
        readonly status: "DispatchRecorded" | "ReconciliationRecorded";
        readonly receipt?: {
          readonly status: "Created" | "Existing";
          readonly version: number;
          readonly kind: string;
        };
      }> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted) return fail("Unavailable");
        const controller = new AbortController(),
          abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 15000);
        try {
          const response = await fetcher("/merchant/payments/refunds/" + path, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": csrf,
            },
            body,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return fail("OutcomeUnknown");
          if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
          if (
            response.headers.get("cache-control") !== "no-store" ||
            !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
          )
            return fail("OutcomeUnknown");
          const text = await response.text();
          if (controller.signal.aborted || text.length > 1024) return fail("OutcomeUnknown");
          const value: unknown = JSON.parse(text);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== (response.status === 202 && path === "reconcile" ? 2 : 1)
          )
            return fail("OutcomeUnknown");
          const data = value as Record<string, unknown>;
          if (response.status === 503 && data.error === "refund_execution_unavailable")
            return fail("Unavailable");
          if (response.status !== 202 || data.status !== status) return fail("OutcomeUnknown");
          if (path === "send") return Object.freeze({ status });
          const receipt = data.receipt;
          if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
            return fail("OutcomeUnknown");
          const summary = receipt as Record<string, unknown>;
          if (
            Object.keys(summary).length !== 3 ||
            (summary.status !== "Created" && summary.status !== "Existing") ||
            !Number.isSafeInteger(summary.version) ||
            (summary.version as number) < 1 ||
            typeof summary.kind !== "string" ||
            !["Original", "Correction", "Refund", "Reissue"].includes(summary.kind) ||
            (summary.status === "Created" && summary.kind !== "Refund")
          )
            return fail("OutcomeUnknown");
          return Object.freeze({
            status,
            receipt: Object.freeze({
              status: summary.status,
              version: summary.version as number,
              kind: summary.kind,
            }),
          });
        } catch (error) {
          if (error instanceof OrdinaryRefundExecutionError) throw error;
          return fail("OutcomeUnknown");
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      },
    });
  }
  return Object.freeze({
    prepareSend: (command: RefundSendCommand) =>
      prepare("send", command, [
        "operationReference",
        "orderReference",
        "requestReference",
        "dispatchReference",
        "auditReference",
        "approvalReference",
      ]),
    prepareReconciliation: (command: RefundReconciliationCommand) =>
      prepare("reconcile", command, [
        "orderReference",
        "operationReference",
        "observationReference",
        "auditReference",
      ]),
  });
}
