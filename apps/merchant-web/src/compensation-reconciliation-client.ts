export interface CompensationView {
  caseVersion: number;
  caseState: "Open" | "Closed";
  refund: { amountMinor: string; currencyCode: "CAD"; confirmedAt: string };
  acknowledgmentRecorded: boolean;
}
export interface CompensationCommand {
  orderReference: string;
  caseReference: string;
  receiptReference: string;
  auditReference: string;
  expectedCaseVersion: number;
}
const fail = (): never => {
  throw new Error("COMPENSATION_UNAVAILABLE");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function object(value: unknown, keys: string[]) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) return fail();
    result[key] = d.value;
  }
  return result;
}
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
export function parseCompensationView(value: unknown): CompensationView {
  const x = object(value, ["caseVersion", "caseState", "refund", "acknowledgmentRecorded"]),
    r = object(x.refund, ["amountMinor", "currencyCode", "confirmedAt"]);
  if (
    !Number.isSafeInteger(x.caseVersion) ||
    Number(x.caseVersion) < 1 ||
    (x.caseState !== "Open" && x.caseState !== "Closed") ||
    typeof x.acknowledgmentRecorded !== "boolean" ||
    (x.caseState === "Closed" && !x.acknowledgmentRecorded) ||
    r.currencyCode !== "CAD" ||
    typeof r.amountMinor !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(r.amountMinor) ||
    BigInt(r.amountMinor) > 9223372036854775807n
  )
    return fail();
  return Object.freeze({
    caseVersion: Number(x.caseVersion),
    caseState: x.caseState,
    refund: Object.freeze({
      amountMinor: r.amountMinor,
      currencyCode: "CAD",
      confirmedAt: instant(r.confirmedAt),
    }),
    acknowledgmentRecorded: x.acknowledgmentRecorded,
  });
}
function body(value: unknown, mutation: boolean) {
  const keys = [
    "orderReference",
    "caseReference",
    ...(mutation ? ["receiptReference", "auditReference", "expectedCaseVersion"] : []),
  ];
  const x = object(value, keys);
  for (const k of keys) {
    if (k === "expectedCaseVersion") {
      if (!Number.isSafeInteger(x[k]) || Number(x[k]) < 1) return fail();
    } else if (typeof x[k] !== "string" || !ref.test(x[k])) return fail();
  }
  return JSON.stringify(x);
}
export function createCompensationReconciliationClient(fetcher: typeof fetch = fetch) {
  async function post(path: string, payload: string, csrf: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher("/merchant/operations/compensations/" + path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: payload,
        signal: controller.signal,
      });
      if (
        response.status !== (path === "query" ? 200 : 202) ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (controller.signal.aborted || text.length > 2048) return fail();
      return JSON.parse(text) as unknown;
    } catch {
      return fail();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    query: async (
      input: { orderReference: string; caseReference: string },
      csrf: string,
      signal?: AbortSignal,
    ) => parseCompensationView(await post("query", body(input, false), csrf, signal)),
    prepare(command: CompensationCommand) {
      const payload = body(command, true);
      return Object.freeze({
        async execute(csrf: string, signal?: AbortSignal) {
          const x = object(await post("reconcile", payload, csrf, signal), [
            "status",
            "replayed",
            "reconciledAt",
          ]);
          if (x.status !== "ReconciliationRecorded" || typeof x.replayed !== "boolean")
            return fail();
          return { reconciledAt: instant(x.reconciledAt), replayed: x.replayed };
        },
      });
    },
  });
}
