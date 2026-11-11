import { t } from "./i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { alertAction, alertSummary } from "./operations-alert-words.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import { storeTime } from "./StoreTime.js";
import type { AttentionItem } from "./StoreOverview.js";

/**
 * WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): store system alerts on the Home for the Owner and Store
 * Manager — store system down, background services needing a person, payment and settlement
 * problems, backups, certificate and disk space. The text is the monitor's plain-language catalog.
 */
export interface OperationsAlert {
  readonly key: string;
  readonly severity: "critical" | "warning";
  readonly title: string;
  readonly summary: string;
  readonly action: string;
  readonly raisedAt: string;
}
export interface OperationsAlertView {
  /**
   * DEC-PILOT-ALERTS-BACKUP correction 2. Installation: whoever runs the installation. Merchant: a
   * restaurant on it, told its own Store's problems and nothing only BOP can act on.
   */
  readonly audience: "Installation" | "Merchant";
  readonly monitor: "Reporting" | "Silent" | "NotRunning";
  readonly observedAt: string | null;
  readonly active: readonly OperationsAlert[];
  readonly recentlyCleared: readonly {
    readonly key: string;
    readonly title: string;
    readonly clearedAt: string;
  }[];
  readonly outbound: {
    readonly email: boolean;
    readonly webhooks: number;
    readonly heartbeat: boolean;
  };
  readonly lastSuccessfulBackupAt: string | null;
  /** WP-2423 (2026-10-18): a planned update in progress; store-down alerts wait during it. */
  readonly plannedUpdate: { readonly startedAt: string; readonly expiresAt: string } | null;
  /**
   * Merchant: some of this Store's checks could not run since this instant, so the Home must not say
   * all is good, or quote `observedAt`, which moves every minute whether or not a read worked.
   */
  readonly checksIncompleteSince: string | null;
  /** Who staff call when a row says "Ask BOP support"; null until it is configured. */
  readonly support: { readonly phone: string; readonly testOnly: boolean } | null;
}
/**
 * The cleared titles that still keep staff waiting for BOP support (pilot-alerts `clearedTitle`).
 * Matched by title, not key: an order-rules row that only said an order type cannot be turned on
 * yet clears under its own title, as resolved.
 */
const WAIT_FOR_SUPPORT_TITLES: ReadonlySet<string> = new Set([
  "Order rules check passes again: stay on paper until BOP support says it is fixed",
  "Unpaid rounds check passes again: keep the noted tables until BOP support says it is fixed",
]);
type ClearedAlert = OperationsAlertView["recentlyCleared"][number];
const waitsForSupport = (item: ClearedAlert) => WAIT_FOR_SUPPORT_TITLES.has(item.title);
/**
 * WP-2423 item 9: the "check passes again, wait for BOP support" lines Home still shows. The newest
 * per row, never while that row is raised again, and only from the store's current business day
 * (the monitor itself ends one when the planned update BOP fixes it in ends).
 */
export function waitingForSupport(
  view: OperationsAlertView,
  dayStartsAt: string | null = null,
): readonly ClearedAlert[] {
  const active = new Set(view.active.map((item) => item.key));
  const newest = new Map<string, ClearedAlert>();
  for (const item of view.recentlyCleared)
    if (
      waitsForSupport(item) &&
      !active.has(item.key) &&
      (dayStartsAt === null || item.clearedAt >= dayStartsAt) &&
      (newest.get(item.key)?.clearedAt ?? "") <= item.clearedAt
    )
      newest.set(item.key, item);
  return [...newest.values()].sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));
}

/** Owner 2026-11-03 walkthrough: the watcher writes English titles; staff read their language. */

export function alertTitle(title: string): string {
  const words: Readonly<Record<string, string>> = {
    "Store system is not responding": t("Store system is not responding"),
    "Customer ordering page is not loading": t("Customer ordering page is not loading"),
    "Staff screens are not loading": t("Staff screens are not loading"),
    "Background services are not being watched": t("Background services are not being watched"),
    "A background service needs a person": t("A background service needs a person"),
    "A clean-up task keeps failing": t("A clean-up task keeps failing"),
    "Some background jobs are not running": t("Some background jobs are not running"),
    "Order or payment updates are stuck": t("Order or payment updates are stuck"),
    "Some order updates are being retried": t("Some order updates are being retried"),
    "Orders from earlier days are still holding stock": t(
      "Orders from earlier days are still holding stock",
    ),
    "Receipts are not being issued": t("Receipts are not being issued"),
    "Orders cannot be priced": t("Orders cannot be priced"),
    "The store's order rules cannot be used": t("The store's order rules cannot be used"),
    "New orders cannot go through": t("New orders cannot go through"),
    "Pickup orders cannot go through": t("Pickup orders cannot go through"),
    "Table orders cannot go through": t("Table orders cannot go through"),
    "Paid orders may not reach the kitchen, and paid pickup orders may be refunded automatically":
      t(
        "Paid orders may not reach the kitchen, and paid pickup orders may be refunded automatically",
      ),
    "Paid pickup orders may not reach the kitchen and may be refunded automatically": t(
      "Paid pickup orders may not reach the kitchen and may be refunded automatically",
    ),
    "Paid table orders may not reach the kitchen": t("Paid table orders may not reach the kitchen"),
    "Paid further rounds may not reach the kitchen": t(
      "Paid further rounds may not reach the kitchen",
    ),
    "Pickup cannot be turned on yet": t("Pickup cannot be turned on yet"),
    "Dine-in cannot be turned on yet": t("Dine-in cannot be turned on yet"),
    "Unpaid rounds are not being cancelled": t("Unpaid rounds are not being cancelled"),
    "Order rules check passes again: stay on paper until BOP support says it is fixed": t(
      "Order rules check passes again: stay on paper until BOP support says it is fixed",
    ),
    "Unpaid rounds check passes again: keep the noted tables until BOP support says it is fixed": t(
      "Unpaid rounds check passes again: keep the noted tables until BOP support says it is fixed",
    ),
    "Pickup orders cannot be taken": t("Pickup orders cannot be taken"),
    "Pickup times are running out": t("Pickup times are running out"),
    "Secure connection certificate has expired": t("Secure connection certificate has expired"),
    "Secure connection certificate expires soon": t("Secure connection certificate expires soon"),
    "The store's ordering setup has expired": t("The store's ordering setup has expired"),
    "The store's ordering setup expires soon": t("The store's ordering setup expires soon"),
    "Ordering at this Store is about to stop": t("Ordering at this Store is about to stop"),
    "Ordering at this Store has stopped": t("Ordering at this Store has stopped"),
    "Payment differences need checking": t("Payment differences need checking"),
    "Day-end settlement has open problems": t("Day-end settlement has open problems"),
    "Day-end check with the payment provider has not run": t(
      "Day-end check with the payment provider has not run",
    ),
    "Day-end check with the payment provider has run again": t(
      "Day-end check with the payment provider has run again",
    ),
    "Last night's backup failed": t("Last night's backup failed"),
    "No recent backup": t("No recent backup"),
    "The newest backup could not be restored": t("The newest backup could not be restored"),
    "Off-site backup copy failed": t("Off-site backup copy failed"),
    "Disk space is running low": t("Disk space is running low"),
    "Some checks could not run": t("Some checks could not run"),
    "Alert messages are not being delivered": t("Alert messages are not being delivered"),
    "Day-end settlement is not set up for this Store": t(
      "Day-end settlement is not set up for this Store",
    ),
    "Some Stores are not being checked": t("Some Stores are not being checked"),
    "Some Stores need BOP support": t("Some Stores need BOP support"),
  };
  return words[title] ?? title;
}

export const OPERATIONS_ALERTS_REFRESH_MS = 60_000;

const invalid = (): never => {
  throw new Error("OPERATIONS_ALERTS_UNAVAILABLE");
};
/** The server answered 403: this staff member's role does not handle store system alerts. */
export const OPERATIONS_ALERTS_NOT_PERMITTED = "OPERATIONS_ALERTS_NOT_PERMITTED";
const notPermitted = (): never => {
  throw new Error(OPERATIONS_ALERTS_NOT_PERMITTED);
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
    ? (value as Record<string, unknown>)
    : invalid();
const instant = (value: unknown): string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : invalid();
const text = (value: unknown, max: number): string =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : invalid();
const alertKey = (value: unknown): string =>
  typeof value === "string" && /^[a-z]+\.[a-z_]+$/u.test(value) ? value : invalid();

export function parseOperationsAlertView(value: unknown): OperationsAlertView {
  const keys = [
    "monitor",
    "observedAt",
    "active",
    "recentlyCleared",
    "outbound",
    "lastSuccessfulBackupAt",
  ];
  // An older server sends none of these.
  const view = exact(value, [
    ...keys,
    ...["plannedUpdate", "audience", "checksIncompleteSince", "support"].filter(
      (optional) => value !== null && typeof value === "object" && Object.hasOwn(value, optional),
    ),
  ]);
  const audience = view.audience ?? "Installation";
  if (audience !== "Installation" && audience !== "Merchant") return invalid();
  let support: OperationsAlertView["support"] = null;
  if (view.support !== undefined && view.support !== null) {
    const contact = exact(view.support, ["phone", "testOnly"]);
    if (
      typeof contact.phone !== "string" ||
      !/^\+[1-9][0-9]{6,14}$/u.test(contact.phone) ||
      typeof contact.testOnly !== "boolean"
    )
      return invalid();
    support = { phone: contact.phone, testOnly: contact.testOnly };
  }
  let plannedUpdate: OperationsAlertView["plannedUpdate"] = null;
  if (view.plannedUpdate !== undefined && view.plannedUpdate !== null) {
    const window = exact(view.plannedUpdate, ["startedAt", "expiresAt"]);
    plannedUpdate = { startedAt: instant(window.startedAt), expiresAt: instant(window.expiresAt) };
  }
  if (view.monitor !== "Reporting" && view.monitor !== "Silent" && view.monitor !== "NotRunning")
    return invalid();
  if (!Array.isArray(view.active) || !Array.isArray(view.recentlyCleared)) return invalid();
  const outbound = exact(view.outbound, ["email", "webhooks", "heartbeat"]);
  if (
    typeof outbound.email !== "boolean" ||
    typeof outbound.heartbeat !== "boolean" ||
    !Number.isSafeInteger(outbound.webhooks) ||
    (outbound.webhooks as number) < 0
  )
    return invalid();
  return {
    audience,
    monitor: view.monitor,
    observedAt: view.observedAt === null ? null : instant(view.observedAt),
    active: view.active.map((item: unknown) => {
      const entry = exact(item, ["key", "severity", "title", "summary", "action", "raisedAt"]);
      if (entry.severity !== "critical" && entry.severity !== "warning") return invalid();
      return {
        key: alertKey(entry.key),
        severity: entry.severity,
        title: text(entry.title, 120),
        summary: text(entry.summary, 600),
        action: text(entry.action, 400),
        raisedAt: instant(entry.raisedAt),
      };
    }),
    recentlyCleared: view.recentlyCleared.map((item: unknown) => {
      const entry = exact(item, ["key", "title", "clearedAt"]);
      return {
        key: alertKey(entry.key),
        title: text(entry.title, 120),
        clearedAt: instant(entry.clearedAt),
      };
    }),
    outbound: {
      email: outbound.email,
      webhooks: outbound.webhooks as number,
      heartbeat: outbound.heartbeat,
    },
    lastSuccessfulBackupAt:
      view.lastSuccessfulBackupAt === null ? null : instant(view.lastSuccessfulBackupAt),
    plannedUpdate,
    checksIncompleteSince:
      view.checksIncompleteSince === undefined || view.checksIncompleteSince === null
        ? null
        : instant(view.checksIncompleteSince),
    support,
  };
}

/** v15 batch 8: a first failed alerts read is read again after this long before it is listed. */
export const OPERATIONS_ALERTS_RETRY_MS = 4_000;

export function createOperationsAlertsClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(signal?: AbortSignal): Promise<OperationsAlertView> {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetcher("/merchant/operations-alerts", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        // An older server refuses such a role with 403 instead.
        if (response.status === 403) return notPermitted();
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          return invalid();
        const body = await response.text();
        if (controller.signal.aborted || body.length > 262144) return invalid();
        const parsed: unknown = JSON.parse(body);
        // WP-2423: the server's ordinary answer for a role that does not handle these alerts.
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          Object.keys(parsed).length === 1 &&
          (parsed as { permitted?: unknown }).permitted === false
        )
          return notPermitted();
        return parseOperationsAlertView(parsed);
      } catch (error) {
        if (error instanceof Error && error.message === OPERATIONS_ALERTS_NOT_PERMITTED)
          throw error;
        return invalid();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}

export type OperationsAlertsRead =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly value: OperationsAlertView }
  /** `support`: who to call, from the last read that worked (this one names BOP support too). */
  | { readonly kind: "Unavailable"; readonly support?: OperationsAlertView["support"] }
  /** The role does not handle store system alerts (403): the card is not shown at all. */
  | { readonly kind: "NotPermitted" };

/** The two honest notes about where alerts reach; the first is a warning, so it stays in view. */
const alertsOnlyHere = (outbound: OperationsAlertView["outbound"]) =>
  !outbound.email && outbound.webhooks === 0;
function outboundNote(outbound: OperationsAlertView["outbound"]): string {
  const channels = [
    ...(outbound.email ? ["email"] : []),
    ...(outbound.webhooks > 0 ? [t("phone or message alerts")] : []),
  ];
  return channels.length === 0
    ? t("Alerts appear only on this screen: no email or phone alerts are set up yet.")
    : t("The Owner is also alerted by {value}.", { value: channels.join(" and ") });
}

/** The page that settles an alert (a closed list: every other row says what to do in words). */
const ALERT_PAGES: Readonly<Record<string, { readonly href: string; label(): string }>> = {
  "payment.updates": { href: "/operations/orders", label: () => t("Orders") },
  "orders.held_stock": { href: "/operations/orders", label: () => t("Orders") },
  "reconciliation.differences": {
    href: "/operations/order-exceptions",
    label: () => t("Exceptions"),
  },
  "settlement.exceptions": {
    href: "/app/operations/payment-reconciliation",
    label: () => t("Settlement"),
  },
  // WP-2423 (settlement-coverage): the days not compared yet are listed on Settlement.
  "settlement.not_run": {
    href: "/app/operations/payment-reconciliation",
    label: () => t("Settlement"),
  },
};

/**
 * Owner 2026-11-03 walkthrough: a real problem with the store system is a row in "Needs attention",
 * never tucked into the status line. Urgent ones (and a planned update, which can pause ordering)
 * lead the list; those to deal with today follow the live service work. Pure, so every state can
 * be checked without a network.
 */
export function systemAttentionItems(
  read: OperationsAlertsRead,
  timeZone?: string,
  dayStartsAt: string | null = null,
): { readonly urgent: readonly AttentionItem[]; readonly later: readonly AttentionItem[] } {
  const at = (iso: string) => storeTime(iso, timeZone, true);
  if (read.kind === "Loading" || read.kind === "NotPermitted") return { urgent: [], later: [] };
  if (read.kind === "Unavailable")
    return {
      urgent: [],
      later: [
        {
          key: "system-unread",
          title: t("The store system could not be checked"),
          detail: t(
            "System alerts could not be read. Check again in a moment; if this stays, ask BOP support to check the store system.",
          ),
          state: t("Not checked"),
          tone: "warning",
          href: null,
          action: t("Check again"),
          retry: "system",
          ...(read.support === undefined || read.support === null ? {} : { call: read.support }),
        },
      ],
    };
  const view = read.value;
  // DEC-PILOT-ALERTS-BACKUP correction 2: a merchant cannot start the monitor and must not learn to
  // ignore "Urgent". BOP hears of it; here the last problems stay in view, as of when last checked
  // ("Do not take a second payment" must not vanish because the checks went quiet).
  if (view.monitor !== "Reporting" && view.audience !== "Merchant")
    return {
      urgent: [
        {
          key: "system-monitor",
          title: t("Store system problems are not being checked"),
          detail:
            view.monitor === "NotRunning"
              ? t(
                  "The alert monitor is not running, so problems with the store system, backups and certificate are not being checked. Ask BOP support to start it.",
                )
              : t(
                  "The alert monitor stopped reporting{value}. Problems are not being checked. Ask BOP support to restart it.",
                  {
                    value:
                      view.observedAt === null
                        ? ""
                        : t(" at {observedAt}", { observedAt: at(view.observedAt) }),
                  },
                ),
          state: t("Urgent"),
          tone: "danger",
          href: null,
          action: t("Check again"),
          retry: "system",
        },
      ],
      later: [],
    };
  // On a board gone quiet, when each row was last known true: never before its own "Since". A row
  // found after some checks stopped was still being read when the board was last written; one from
  // before may come from a check that stopped then.
  const asOf = (item: OperationsAlert) => {
    if (view.monitor !== "Silent" || view.observedAt === null) return "";
    const known =
      view.checksIncompleteSince !== null &&
      Date.parse(item.raisedAt) <= Date.parse(view.checksIncompleteSince)
        ? view.checksIncompleteSince
        : view.observedAt;
    return t(" · as of {observedAt}", { observedAt: at(known) });
  };
  const row = (item: OperationsAlert): AttentionItem => {
    const page = ALERT_PAGES[item.key];
    return {
      key: `system-${item.key}`,
      title: alertTitle(item.title),
      // Owner 2026-10-25: what to do stays in view; the background is on request.
      detailLabel: t("What to do:"),
      detail: alertAction(item.action),
      more: alertSummary(item.summary),
      since: t("Since {raisedAt}", { raisedAt: at(item.raisedAt) }) + asOf(item),
      state: item.severity === "critical" ? t("Urgent") : t("Today"),
      tone: item.severity === "critical" ? "danger" : "warning",
      href: page?.href ?? null,
      action: page === undefined ? null : t("Go to {value}", { value: page.label() }),
      // The monitor's catalog is English: a row that sends them to BOP support says how to reach it
      // (not one addressed to BOP support itself).
      ...(view.support !== null &&
      item.action.includes("BOP support") &&
      !item.action.startsWith("BOP support:")
        ? { call: view.support }
        : {}),
    };
  };
  return {
    urgent: [
      // WP-2423 (2026-10-18): a planned update is not an outage; if the store is still down when
      // its window ends, the usual urgent alert follows at once.
      ...(view.plannedUpdate === null
        ? []
        : [
            {
              key: "system-update",
              title: t("System update in progress — ordering may pause for a few minutes."),
              detail: t(
                "Started {startedAt}. If guests or staff screens still can’t order after {expiresAt}, this page shows an urgent alert.",
                {
                  startedAt: at(view.plannedUpdate.startedAt),
                  expiresAt: at(view.plannedUpdate.expiresAt),
                },
              ),
              state: t("In progress"),
              tone: "progress",
              href: null,
              action: null,
            } satisfies AttentionItem,
          ]),
      ...view.active.filter((item) => item.severity === "critical").map(row),
      // In the place the urgent row had: its clearing is not yet the all clear.
      ...waitingForSupport(view, dayStartsAt).map((item): AttentionItem => ({
        key: `system-wait-${item.key}`,
        title: alertTitle(item.title),
        detailLabel: t("What to do:"),
        detail:
          item.key === "orders.unpaid_rounds"
            ? t(
                "Keep seating new parties at other tables, and close the noted tables once BOP support says it is fixed. This line goes when BOP support finishes the update that fixes it, or when today's business day ends.",
              )
            : t(
                "Keep taking orders on paper and payment on the card machine, and do not resume ordering yet: the store's services can still use the old order rules until BOP support restarts them. This line goes when BOP support finishes the update that fixes it, or when today's business day ends.",
              ),
        since: t("Check passed {clearedAt}", { clearedAt: at(item.clearedAt) }),
        state: t("Wait for BOP support"),
        tone: "warning",
        href: null,
        action: null,
      })),
    ],
    later: view.active.filter((item) => item.severity !== "critical").map(row),
  };
}

/**
 * A merchant's board with nothing to report and no way to vouch for it: when it last checked. That
 * is when its checks stopped running if they did, and the board's own time only if the monitor went
 * quiet with every check still running.
 */
const quietSince = (view: OperationsAlertView): string | null =>
  view.audience !== "Merchant" || view.active.length > 0 || view.plannedUpdate !== null
    ? null
    : (view.checksIncompleteSince ?? (view.monitor === "Silent" ? view.observedAt : null));

function systemStatusWords(
  read: OperationsAlertsRead,
  timeZone: string | undefined,
  dayStartsAt: string | null,
): string {
  if (read.kind === "Unavailable") return t("Store system: could not be checked");
  if (read.kind !== "Ready") return t("Checking the store system…");
  const view = read.value;
  if (view.audience === "Merchant") {
    if (view.monitor === "NotRunning") return t("Store system: not checked yet");
    const since = quietSince(view);
    if (since !== null && waitingForSupport(view, dayStartsAt).length === 0)
      return t("Store system: last checked {observedAt}", {
        observedAt: storeTime(since, timeZone, true),
      });
  } else if (view.monitor !== "Reporting") return t("Store system: problems are not being checked");
  if (view.active.length > 0 || waitingForSupport(view, dayStartsAt).length > 0)
    return t("Store system: needs attention, see the list above");
  if (view.plannedUpdate !== null) return t("Store system: update in progress");
  return t("Store system: all good");
}

/**
 * The store system in one quiet line at the bottom of Home: its state, the last backup and a way to
 * check again. The rarer truths stay below it at lower weight. The server decides who sees it.
 */
export function StoreSystemLine({
  read,
  timeZone,
  dayStartsAt,
  busy = false,
  onRefresh,
}: {
  readonly read: OperationsAlertsRead;
  readonly timeZone?: string | undefined;
  /** The store's current business day; from the Store's business-day read when not given. */
  readonly dayStartsAt?: string | null | undefined;
  readonly busy?: boolean;
  readonly onRefresh?: (() => void) | undefined;
}) {
  const businessDay = useStoreBusinessDay();
  const startsAt = dayStartsAt ?? businessDay?.startsAt ?? null;
  if (read.kind === "NotPermitted") return null;
  const at = (iso: string) => storeTime(iso, timeZone, true);
  // Only a monitor that reports can vouch for the backup and alert facts.
  const view = read.kind === "Ready" && read.value.monitor === "Reporting" ? read.value : null;
  // A merchant has no backups or alert channels to think about: those are BOP's.
  const merchant = view?.audience === "Merchant";
  const cleared = view?.recentlyCleared ?? [];
  // A cleared order-rules row is not all clear: it stays in "Needs attention", never "Resolved".
  const resolved = cleared.filter((item) => !waitsForSupport(item));
  const moreToTell =
    view !== null && (resolved.length > 0 || (!merchant && !alertsOnlyHere(view.outbound)));
  return (
    <section className="overview-system" aria-label={t("Store system")}>
      <div className="overview-system__line">
        <p aria-live="polite">
          <span>{systemStatusWords(read, timeZone, startsAt)}</span>
          {view === null || quietSince(view) !== null ? null : (
            <span>
              {merchant ? null : (
                <>
                  {" · "}
                  {view.lastSuccessfulBackupAt === null
                    ? t("No backup recorded yet")
                    : t("Last backup {lastSuccessfulBackupAt}", {
                        lastSuccessfulBackupAt: at(view.lastSuccessfulBackupAt),
                      })}
                </>
              )}
              {view.observedAt === null
                ? ""
                : view.checksIncompleteSince === null
                  ? t(" · Last checked {observedAt}", {
                      observedAt: storeTime(view.observedAt, timeZone),
                    })
                  : // Beside rows found today, "last checked" days ago would contradict them: only
                    // some checks stopped, maybe days ago, so with the date.
                    t(" · Some checks last ran {observedAt}", {
                      observedAt: at(view.checksIncompleteSince),
                    })}
            </span>
          )}
        </p>
        {onRefresh ? (
          <button
            type="button"
            className="overview-text-action"
            onClick={onRefresh}
            disabled={busy}
          >
            {t("Check again")}
          </button>
        ) : null}
      </div>
      {view !== null && !merchant && alertsOnlyHere(view.outbound) ? (
        <p className="overview-system__note">{outboundNote(view.outbound)}</p>
      ) : null}
      {moreToTell ? (
        <details className="overview-more">
          <summary>{t("System details")}</summary>
          {resolved.length > 0 ? (
            <p>
              {t("Resolved recently: {value}", {
                value: resolved
                  .slice(-3)
                  .reverse()
                  .map((item) => `${alertTitle(item.title)} (${at(item.clearedAt)})`)
                  .join("; "),
              })}
            </p>
          ) : null}
          {merchant || alertsOnlyHere(view.outbound) ? null : <p>{outboundNote(view.outbound)}</p>}
        </details>
      ) : null}
    </section>
  );
}

/**
 * Reads the alert board while the Home is open and visible. The server decides who sees it
 * (operations.order-exception.manage): its "not permitted" answer (WP-2423; a 403 from an older
 * server) hides it and stops reading, so front-of-house staff never poll it again and no refusal
 * shows in their browser.
 */
export function useOperationsAlerts(
  fetcher?: typeof fetch,
  /** v15 batch 8: how long a first failed read waits before it is read again (tests shorten it). */
  retryMs = OPERATIONS_ALERTS_RETRY_MS,
) {
  const [client] = useState(() => createOperationsAlertsClient(fetcher));
  // v15 batch 8: one failed read (a busy moment, the reload after switching language) is read
  // again shortly before Home lists "could not be checked"; only a failure that repeats is listed.
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [read, setRead] = useState<OperationsAlertsRead>({ kind: "Loading" });
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  // The number to call when the alerts themselves cannot be read is the one the last read carried.
  const support = useRef<OperationsAlertView["support"]>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(async () => {
    if (stopped.current) return;
    active.current?.abort();
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const value = await client.load(controller.signal);
      if (!controller.signal.aborted) {
        failures.current = 0;
        support.current = value.support;
        setRead({ kind: "Ready", value });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.message === OPERATIONS_ALERTS_NOT_PERMITTED) {
        stopped.current = true;
        if (timer.current !== null) clearInterval(timer.current);
        timer.current = null;
        setRead({ kind: "NotPermitted" });
      } else if (failures.current === 0) {
        // What was read last stays in view meanwhile (or nothing, before the first answer).
        failures.current = 1;
        retry.current = setTimeout(() => void loadRef.current?.(), retryMs);
      } else {
        failures.current += 1;
        setRead({ kind: "Unavailable", support: support.current });
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [client, retryMs]);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  loadRef.current = load;
  // v15 cbff9d6f: no reads once this screen's sign-in has ended; again at once if it is live.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!live) return;
    void load();
    timer.current = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, OPERATIONS_ALERTS_REFRESH_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
      timer.current = null;
      if (retry.current !== null) clearTimeout(retry.current);
      retry.current = null;
      active.current?.abort();
    };
  }, [live, load]);
  return { read, busy, refresh: load };
}
