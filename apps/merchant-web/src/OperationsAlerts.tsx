import { t } from "./i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { alertAction, alertSummary } from "./operations-alert-words.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
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
}
/** Owner 2026-11-03 walkthrough: the watcher writes English titles; staff read their language. */
export function alertTitle(title: string): string {
  const words: Readonly<Record<string, string>> = {
    "Store system is not responding": t("Store system is not responding"),
    "Customer ordering page is not loading": t("Customer ordering page is not loading"),
    "Staff screens are not loading": t("Staff screens are not loading"),
    "Background services are not being watched": t("Background services are not being watched"),
    "A background service needs a person": t("A background service needs a person"),
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
    "Pickup orders cannot be taken": t("Pickup orders cannot be taken"),
    "Pickup times are running out": t("Pickup times are running out"),
    "Secure connection certificate has expired": t("Secure connection certificate has expired"),
    "Secure connection certificate expires soon": t("Secure connection certificate expires soon"),
    "The store's ordering setup has expired": t("The store's ordering setup has expired"),
    "The store's ordering setup expires soon": t("The store's ordering setup expires soon"),
    "Payment differences need checking": t("Payment differences need checking"),
    "Day-end settlement has open problems": t("Day-end settlement has open problems"),
    "Last night's backup failed": t("Last night's backup failed"),
    "No recent backup": t("No recent backup"),
    "The newest backup could not be restored": t("The newest backup could not be restored"),
    "Off-site backup copy failed": t("Off-site backup copy failed"),
    "Disk space is running low": t("Disk space is running low"),
    "Some checks could not run": t("Some checks could not run"),
    "Alert messages are not being delivered": t("Alert messages are not being delivered"),
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
  // An older server sends no planned-update entry.
  const view = exact(
    value,
    value !== null && typeof value === "object" && Object.hasOwn(value, "plannedUpdate")
      ? [...keys, "plannedUpdate"]
      : keys,
  );
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
  };
}

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
  | { readonly kind: "Unavailable" }
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

/**
 * Owner 2026-11-03 walkthrough: a real problem with the store system is a row in "Needs attention",
 * never tucked into the status line. Urgent ones (and a planned update, which can pause ordering)
 * lead the list; those to deal with today follow the live service work. Pure, so every state can
 * be checked without a network.
 */
export function systemAttentionItems(
  read: OperationsAlertsRead,
  timeZone?: string,
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
        },
      ],
    };
  const view = read.value;
  if (view.monitor !== "Reporting")
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
  const row = (item: OperationsAlert): AttentionItem => ({
    key: `system-${item.key}`,
    title: alertTitle(item.title),
    // Owner 2026-10-25: what to do stays in view; the background is on request.
    detailLabel: t("What to do:"),
    detail: alertAction(item.action),
    more: alertSummary(item.summary),
    since: t("Since {raisedAt}", { raisedAt: at(item.raisedAt) }),
    state: item.severity === "critical" ? t("Urgent") : t("Today"),
    tone: item.severity === "critical" ? "danger" : "warning",
    href: null,
    action: null,
  });
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
    ],
    later: view.active.filter((item) => item.severity !== "critical").map(row),
  };
}

function systemStatusWords(read: OperationsAlertsRead): string {
  if (read.kind === "Unavailable") return t("Store system: could not be checked");
  if (read.kind !== "Ready") return t("Checking the store system…");
  const view = read.value;
  if (view.monitor !== "Reporting") return t("Store system: problems are not being checked");
  if (view.active.length > 0) return t("Store system: needs attention, see the list above");
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
  busy = false,
  onRefresh,
}: {
  readonly read: OperationsAlertsRead;
  readonly timeZone?: string | undefined;
  readonly busy?: boolean;
  readonly onRefresh?: (() => void) | undefined;
}) {
  if (read.kind === "NotPermitted") return null;
  const at = (iso: string) => storeTime(iso, timeZone, true);
  // Only a monitor that reports can vouch for the backup and alert facts.
  const view = read.kind === "Ready" && read.value.monitor === "Reporting" ? read.value : null;
  const resolved = view?.recentlyCleared ?? [];
  const moreToTell = view !== null && (resolved.length > 0 || !alertsOnlyHere(view.outbound));
  return (
    <section className="overview-system" aria-label={t("Store system")}>
      <div className="overview-system__line">
        <p aria-live="polite">
          <span>{systemStatusWords(read)}</span>
          {view === null ? null : (
            <span>
              {" · "}
              {view.lastSuccessfulBackupAt === null
                ? t("No backup recorded yet")
                : t("Last backup {lastSuccessfulBackupAt}", {
                    lastSuccessfulBackupAt: at(view.lastSuccessfulBackupAt),
                  })}
              {view.observedAt === null
                ? ""
                : t(" · Last checked {observedAt}", {
                    observedAt: storeTime(view.observedAt, timeZone),
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
      {view !== null && alertsOnlyHere(view.outbound) ? (
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
          {alertsOnlyHere(view.outbound) ? null : <p>{outboundNote(view.outbound)}</p>}
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
export function useOperationsAlerts(fetcher?: typeof fetch) {
  const [client] = useState(() => createOperationsAlertsClient(fetcher));
  const [read, setRead] = useState<OperationsAlertsRead>({ kind: "Loading" });
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(async () => {
    if (stopped.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const value = await client.load(controller.signal);
      if (!controller.signal.aborted) setRead({ kind: "Ready", value });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.message === OPERATIONS_ALERTS_NOT_PERMITTED) {
        stopped.current = true;
        if (timer.current !== null) clearInterval(timer.current);
        timer.current = null;
        setRead({ kind: "NotPermitted" });
      } else setRead({ kind: "Unavailable" });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [client]);
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
      active.current?.abort();
    };
  }, [live, load]);
  return { read, busy, refresh: load };
}
