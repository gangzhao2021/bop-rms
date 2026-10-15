import { createContractParsers } from "./contract-parsers.js";

/** WP-2423 P1 (PAY-RECONCILIATION): the day-end settlement view and its strict reader. */
export class SettlementClientError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "Busy" | "Unavailable" | "NotCovered",
    /** WP-2423: with NotCovered, the first business day the Store's records cover. */
    readonly firstBusinessDate: string | null = null,
  ) {
    super(code);
    this.name = "SettlementClientError";
  }
}
const fail = (): never => {
  throw new SettlementClientError("Unavailable");
};
const { instant, reference, text, minor, count, exact } = createContractParsers(fail);

export interface SettlementAmount {
  readonly count: number;
  readonly amountMinor: string;
  readonly currencyCode: string;
}
export type SettlementOutcome = "Matched" | "Healed" | "Unresolved" | "Unavailable" | "Difference";
const settlementOutcomes: readonly SettlementOutcome[] = [
  "Matched",
  "Healed",
  "Unresolved",
  "Unavailable",
  "Difference",
];
const unmatchedOutcomes: readonly SettlementOutcome[] = ["Difference", "Unresolved", "Unavailable"];
export interface SettlementRun {
  readonly runReference: string;
  readonly mode: "Operational" | "DailySettlement";
  readonly scheduledAt: string;
  readonly cutoffAt: string;
  readonly completedAt: string;
  readonly counts: Readonly<Record<SettlementOutcome, number>>;
}
export interface SettlementCheck {
  readonly checkReference: string;
  readonly runReference: string;
  readonly checkedAt: string;
  readonly outcome: SettlementOutcome;
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
/** The day's reconciliation: its settlement run, the per-payment checks and what did not match. */
export interface SettlementReconciliation {
  readonly settlement: {
    readonly run: SettlementRun;
    readonly checks: readonly SettlementCheck[];
    /** WP-2423: the day's latest later check (its current result), when it was checked again. */
    readonly recheck: {
      readonly run: SettlementRun;
      readonly check: SettlementCheck;
      readonly count: number;
    } | null;
    /**
     * WP-2423: other settlement checks of the same day outside its schedule (history only; the
     * day's result is its scheduled check and that check's re-checks). Oldest first.
     */
    readonly additionalChecks: readonly SettlementCheck[];
  } | null;
  readonly operational: {
    readonly runCount: number;
    readonly latestRun: SettlementRun | null;
    readonly paymentCount: number;
    readonly outcomes: Readonly<Record<SettlementOutcome, number>>;
  };
  readonly differences: readonly SettlementCheck[];
  readonly differenceCount: number;
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
  /** WP-2423 Q19: refunds the Owner approved for themself (sole operator) in the day. */
  readonly selfApprovedRefunds: SettlementAmount | null;
  /** WP-2423 Q19: the current business day's self-approved refunds so far (beside a closed day). */
  readonly currentDaySelfApprovedRefunds:
    (SettlementAmount & { readonly businessDate: string }) | null;
  readonly reconciliation: SettlementReconciliation | null;
  /** WP-2423 Q7: the Store's own card machine, apart from online payments; null when unreadable,
   * undefined when the server does not report it. */
  readonly cardMachine?: SettlementCardMachine | null;
  /** WP-2423: Provider charges matching no order, and their refunds, in the day; null when not
   * read, undefined when the server does not report them. */
  readonly unmatchedProviderCharges?: {
    readonly captured: SettlementAmount;
    readonly refunded: SettlementAmount;
  } | null;
  readonly projectedAt: string;
}
export interface SettlementCardMachine {
  readonly taken: SettlementAmount;
  readonly tipMinor: string;
  readonly recordedAfterOutageCount: number;
  readonly refunded: SettlementAmount;
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
    "selfApprovedRefunds",
    ...(value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "currentDaySelfApprovedRefunds")
      ? ["currentDaySelfApprovedRefunds"]
      : []),
    "reconciliation",
    ...(value !== null && typeof value === "object" && Object.hasOwn(value, "cardMachine")
      ? ["cardMachine"]
      : []),
    ...(value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "unmatchedProviderCharges")
      ? ["unmatchedProviderCharges"]
      : []),
    "projectedAt",
  ]);
  if (raw.screenId !== "PAY-RECONCILIATION") return fail();
  const window = exact(raw.window, ["startsAt", "endsAt", "timeZone", "status"]);
  if (window.status !== "Closed" && window.status !== "Open") return fail();
  const businessDate = text(raw.businessDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) return fail();
  const outcome = (value: unknown): SettlementOutcome =>
    typeof value === "string" && (settlementOutcomes as readonly string[]).includes(value)
      ? (value as SettlementOutcome)
      : fail();
  const counts = (value: unknown): Readonly<Record<SettlementOutcome, number>> => {
    const c = exact(value, settlementOutcomes);
    return Object.freeze({
      Matched: count(c.Matched),
      Healed: count(c.Healed),
      Unresolved: count(c.Unresolved),
      Unavailable: count(c.Unavailable),
      Difference: count(c.Difference),
    });
  };
  const run = (item: unknown): SettlementRun => {
    const r = exact(item, [
      "runReference",
      "mode",
      "scheduledAt",
      "cutoffAt",
      "completedAt",
      "counts",
    ]);
    if (r.mode !== "Operational" && r.mode !== "DailySettlement") return fail();
    return Object.freeze({
      runReference: reference(r.runReference),
      mode: r.mode,
      scheduledAt: instant(r.scheduledAt),
      cutoffAt: instant(r.cutoffAt),
      completedAt: instant(r.completedAt),
      counts: counts(r.counts),
    });
  };
  const check = (item: unknown, runReference?: string): SettlementCheck => {
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
    if (d.currencyCode !== "CAD" || (runReference !== undefined && d.runReference !== runReference))
      return fail();
    return Object.freeze({
      checkReference: reference(d.checkReference),
      runReference: reference(d.runReference),
      checkedAt: instant(d.checkedAt),
      outcome: outcome(d.outcome),
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
  };
  let reconciliation: SettlementView["reconciliation"] = null;
  if (raw.reconciliation !== null) {
    const r = exact(raw.reconciliation, [
      "settlement",
      "operational",
      "differences",
      "differenceCount",
    ]);
    let settlement: SettlementReconciliation["settlement"] = null;
    if (r.settlement !== null) {
      const s = exact(r.settlement, [
        "run",
        "checks",
        ...(r.settlement !== null &&
        typeof r.settlement === "object" &&
        Object.hasOwn(r.settlement, "recheck")
          ? ["recheck"]
          : []),
        ...(r.settlement !== null &&
        typeof r.settlement === "object" &&
        Object.hasOwn(r.settlement, "additionalChecks")
          ? ["additionalChecks"]
          : []),
      ]);
      const settlementRun = run(s.run);
      if (
        settlementRun.mode !== "DailySettlement" ||
        !Array.isArray(s.checks) ||
        s.checks.length === 0 ||
        s.checks.length > 100
      )
        return fail();
      let recheck: NonNullable<SettlementReconciliation["settlement"]>["recheck"] = null;
      if (s.recheck !== undefined && s.recheck !== null) {
        const c = exact(s.recheck, ["run", "check", "count"]);
        const recheckRun = run(c.run);
        if (
          recheckRun.mode !== "DailySettlement" ||
          recheckRun.runReference === settlementRun.runReference
        )
          return fail();
        const recheckCount = count(c.count);
        if (recheckCount < 1) return fail();
        recheck = Object.freeze({
          run: recheckRun,
          check: check(c.check, recheckRun.runReference),
          count: recheckCount,
        });
      }
      const additional = s.additionalChecks === undefined ? [] : s.additionalChecks;
      if (!Array.isArray(additional) || additional.length > 5) return fail();
      const additionalChecks = additional.map((item) => check(item));
      if (
        additionalChecks.some(
          (item) =>
            item.runReference === settlementRun.runReference ||
            item.runReference === recheck?.run.runReference,
        )
      )
        return fail();
      settlement = Object.freeze({
        run: settlementRun,
        checks: Object.freeze(s.checks.map((item) => check(item, settlementRun.runReference))),
        recheck,
        additionalChecks: Object.freeze(additionalChecks),
      });
    }
    const o = exact(r.operational, ["runCount", "latestRun", "paymentCount", "outcomes"]);
    const operational = Object.freeze({
      runCount: count(o.runCount),
      latestRun: o.latestRun === null ? null : run(o.latestRun),
      paymentCount: count(o.paymentCount),
      outcomes: counts(o.outcomes),
    });
    if (
      (operational.runCount === 0) !== (operational.latestRun === null) ||
      Object.values(operational.outcomes).reduce((sum, value) => sum + value, 0) !==
        operational.paymentCount
    )
      return fail();
    const differenceCount = count(r.differenceCount);
    if (
      !Array.isArray(r.differences) ||
      r.differences.length > 200 ||
      r.differences.length > differenceCount ||
      differenceCount !== unmatchedOutcomes.reduce((sum, key) => sum + operational.outcomes[key], 0)
    )
      return fail();
    const differences = r.differences.map((item) => {
      const d = check(item);
      return unmatchedOutcomes.includes(d.outcome) ? d : fail();
    });
    reconciliation = Object.freeze({
      settlement,
      operational,
      differences: Object.freeze(differences),
      differenceCount,
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
    selfApprovedRefunds: amount(raw.selfApprovedRefunds),
    currentDaySelfApprovedRefunds: (() => {
      const today = raw.currentDaySelfApprovedRefunds;
      if (today === null || today === undefined) return null;
      const r = exact(today, ["businessDate", "count", "amountMinor", "currencyCode"]);
      const day = text(r.businessDate, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return fail();
      const parsed = amount({
        count: r.count,
        amountMinor: r.amountMinor,
        currencyCode: r.currencyCode,
      });
      return parsed === null ? null : Object.freeze({ ...parsed, businessDate: day });
    })(),
    reconciliation,
    ...(raw.cardMachine === undefined
      ? {}
      : {
          cardMachine: (() => {
            if (raw.cardMachine === null) return null;
            const c = exact(raw.cardMachine, [
              "taken",
              "tipMinor",
              "recordedAfterOutageCount",
              "refunded",
            ]);
            const taken = amount(c.taken),
              refunded = amount(c.refunded);
            if (taken === null || refunded === null) return fail();
            return Object.freeze({
              taken,
              tipMinor: minor(c.tipMinor),
              recordedAfterOutageCount: count(c.recordedAfterOutageCount),
              refunded,
            });
          })(),
        }),
    ...(raw.unmatchedProviderCharges === undefined
      ? {}
      : {
          unmatchedProviderCharges: (() => {
            if (raw.unmatchedProviderCharges === null) return null;
            const u = exact(raw.unmatchedProviderCharges, ["captured", "refunded"]);
            const captured = amount(u.captured),
              refunded = amount(u.refunded);
            if (captured === null || refunded === null) return fail();
            return Object.freeze({ captured, refunded });
          })(),
        }),
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
        // WP-2423: the day is before the Store's records begin (an answer, not a failure).
        if (response.status === 404) {
          const body = (await response.json().catch(() => null)) as {
            error?: unknown;
            firstBusinessDate?: unknown;
          } | null;
          if (
            body?.error === "settlement_not_covered" &&
            typeof body.firstBusinessDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/u.test(body.firstBusinessDate)
          )
            throw new SettlementClientError("NotCovered", body.firstBusinessDate);
        }
        // The Store's records were busy with live work for a moment; the page tries again.
        if (response.status === 503) {
          const busy = await response
            .json()
            .then((value: unknown) => (value as { error?: unknown } | null)?.error)
            .catch(() => null);
          if (busy === "settlement_busy") throw new SettlementClientError("Busy");
        }
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
