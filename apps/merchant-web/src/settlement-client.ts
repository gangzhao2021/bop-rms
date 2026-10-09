/** WP-2423 P1 (PAY-RECONCILIATION): the day-end settlement view and its strict reader. */
export class SettlementClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Unavailable") {
    super(code);
    this.name = "SettlementClientError";
  }
}
const fail = (): never => {
  throw new SettlementClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = (value: unknown): string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? value
    : fail();
const reference = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const text = (value: unknown, max: number): string =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : fail();
const minor = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? value : fail();
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}

export interface SettlementAmount {
  readonly count: number;
  readonly amountMinor: string;
  readonly currencyCode: string;
}
export interface SettlementRun {
  readonly runReference: string;
  readonly mode: "Operational" | "DailySettlement";
  readonly scheduledAt: string;
  readonly cutoffAt: string;
  readonly completedAt: string;
  readonly counts: {
    readonly Matched: number;
    readonly Healed: number;
    readonly Unresolved: number;
    readonly Unavailable: number;
    readonly Difference: number;
  };
}
export interface SettlementDifference {
  readonly checkReference: string;
  readonly runReference: string;
  readonly checkedAt: string;
  readonly outcome: "Difference" | "Unresolved" | "Unavailable";
  readonly differenceReason: string | null;
  readonly settlementReference: string | null;
  readonly internalStatus: string | null;
  readonly providerStatus: string | null;
  readonly currencyCode: string;
  readonly internalCapturedMinor: string;
  readonly providerCapturedMinor: string | null;
  readonly internalRefundedMinor: string;
  readonly providerRefundedMinor: string | null;
  readonly exceptionReference: string | null;
}
export interface SettlementView {
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly window: {
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timeZone: string;
    readonly status: "Closed" | "Open";
  };
  readonly captured: SettlementAmount | null;
  readonly refunded: SettlementAmount | null;
  readonly reconciliation: {
    readonly runs: readonly SettlementRun[];
    readonly differences: readonly SettlementDifference[];
  } | null;
  readonly projectedAt: string;
}

const amount = (value: unknown): SettlementAmount | null => {
  if (value === null) return null;
  const raw = exact(value, ["count", "amountMinor", "currencyCode"]);
  if (raw.currencyCode !== "CAD") return fail();
  return Object.freeze({
    count: count(raw.count),
    amountMinor: minor(raw.amountMinor),
    currencyCode: "CAD",
  });
};
const optionalText = (value: unknown, max: number) => (value === null ? null : text(value, max));
const optionalMinor = (value: unknown) => (value === null ? null : minor(value));

export function parseSettlementView(value: unknown): SettlementView {
  const raw = exact(value, [
    "screenId",
    "storeLabel",
    "businessDate",
    "window",
    "captured",
    "refunded",
    "reconciliation",
    "projectedAt",
  ]);
  if (raw.screenId !== "PAY-RECONCILIATION") return fail();
  const window = exact(raw.window, ["startsAt", "endsAt", "timeZone", "status"]);
  if (window.status !== "Closed" && window.status !== "Open") return fail();
  const businessDate = text(raw.businessDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) return fail();
  let reconciliation: SettlementView["reconciliation"] = null;
  if (raw.reconciliation !== null) {
    const r = exact(raw.reconciliation, ["runs", "differences"]);
    if (
      !Array.isArray(r.runs) ||
      !Array.isArray(r.differences) ||
      r.runs.length > 50 ||
      r.differences.length > 200
    )
      return fail();
    const runs = r.runs.map((item): SettlementRun => {
      const run = exact(item, [
        "runReference",
        "mode",
        "scheduledAt",
        "cutoffAt",
        "completedAt",
        "counts",
      ]);
      const counts = exact(run.counts, [
        "Matched",
        "Healed",
        "Unresolved",
        "Unavailable",
        "Difference",
      ]);
      if (run.mode !== "Operational" && run.mode !== "DailySettlement") return fail();
      return Object.freeze({
        runReference: reference(run.runReference),
        mode: run.mode,
        scheduledAt: instant(run.scheduledAt),
        cutoffAt: instant(run.cutoffAt),
        completedAt: instant(run.completedAt),
        counts: Object.freeze({
          Matched: count(counts.Matched),
          Healed: count(counts.Healed),
          Unresolved: count(counts.Unresolved),
          Unavailable: count(counts.Unavailable),
          Difference: count(counts.Difference),
        }),
      });
    });
    const known = new Set(runs.map((run) => run.runReference));
    const differences = r.differences.map((item): SettlementDifference => {
      const d = exact(item, [
        "checkReference",
        "runReference",
        "checkedAt",
        "outcome",
        "differenceReason",
        "settlementReference",
        "internalStatus",
        "providerStatus",
        "currencyCode",
        "internalCapturedMinor",
        "providerCapturedMinor",
        "internalRefundedMinor",
        "providerRefundedMinor",
        "exceptionReference",
      ]);
      const runReference = reference(d.runReference);
      if (
        !known.has(runReference) ||
        (d.outcome !== "Difference" && d.outcome !== "Unresolved" && d.outcome !== "Unavailable") ||
        d.currencyCode !== "CAD"
      )
        return fail();
      return Object.freeze({
        checkReference: reference(d.checkReference),
        runReference,
        checkedAt: instant(d.checkedAt),
        outcome: d.outcome,
        differenceReason: optionalText(d.differenceReason, 64),
        settlementReference: optionalText(d.settlementReference, 128),
        internalStatus: optionalText(d.internalStatus, 64),
        providerStatus: optionalText(d.providerStatus, 64),
        currencyCode: "CAD",
        internalCapturedMinor: minor(d.internalCapturedMinor),
        providerCapturedMinor: optionalMinor(d.providerCapturedMinor),
        internalRefundedMinor: minor(d.internalRefundedMinor),
        providerRefundedMinor: optionalMinor(d.providerRefundedMinor),
        exceptionReference: d.exceptionReference === null ? null : reference(d.exceptionReference),
      });
    });
    reconciliation = Object.freeze({
      runs: Object.freeze(runs),
      differences: Object.freeze(differences),
    });
  }
  return Object.freeze({
    storeLabel: text(raw.storeLabel, 100),
    businessDate,
    window: Object.freeze({
      startsAt: instant(window.startsAt),
      endsAt: instant(window.endsAt),
      timeZone: text(window.timeZone, 64),
      status: window.status,
    }),
    captured: amount(raw.captured),
    refunded: amount(raw.refunded),
    reconciliation,
    projectedAt: instant(raw.projectedAt),
  });
}

export function createSettlementClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(businessDate: string | null, signal: AbortSignal): Promise<SettlementView> {
      if (businessDate !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) return fail();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetcher(
          "/merchant/settlement" +
            (businessDate === null ? "" : "?businessDate=" + encodeURIComponent(businessDate)),
          {
            method: "GET",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (response.status === 401 || response.status === 403)
          throw new SettlementClientError("PermissionDenied");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          return fail();
        const body = await response.text();
        if (controller.signal.aborted || body.length > 262144) return fail();
        return parseSettlementView(JSON.parse(body) as unknown);
      } catch (error) {
        if (error instanceof SettlementClientError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
