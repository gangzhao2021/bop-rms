import { t } from "./i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { storeTime } from "./StoreTime.js";

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

function outboundNote(outbound: OperationsAlertView["outbound"]): string {
  const channels = [
    ...(outbound.email ? ["email"] : []),
    ...(outbound.webhooks > 0 ? [t("phone or message alerts")] : []),
  ];
  return channels.length === 0
    ? t("Alerts appear only on this screen: no email or phone alerts are set up yet.")
    : t("The Owner is also alerted by {value}.", { value: channels.join(" and ") });
}

/** The pure card, so every state can be rendered and checked without a network. */
export function OperationsAlertsCard({
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
  const view = read.kind === "Ready" ? read.value : null;
  const critical =
    view !== null &&
    (view.monitor !== "Reporting" || view.active.some((item) => item.severity === "critical"));
  const warning = view !== null && !critical && view.active.length > 0;
  // Everything working and no update running: a calm one-line status, not a full card.
  const clear =
    view !== null &&
    view.monitor === "Reporting" &&
    view.active.length === 0 &&
    view.plannedUpdate === null;
  return (
    <section
      className={
        "overview-card overview-card--alerts" +
        (critical
          ? " overview-card--alerts-critical"
          : warning
            ? " overview-card--alerts-warning"
            : clear
              ? " overview-card--alerts-clear"
              : "")
      }
      aria-labelledby="system-alerts-heading"
    >
      <header>
        <h3 id="system-alerts-heading">{t("Store system")}</h3>
        {onRefresh ? (
          <button type="button" onClick={onRefresh} disabled={busy}>
            {t("Check again")}
          </button>
        ) : null}
      </header>
      <div aria-live="polite">
        {read.kind === "Loading" ? (
          <p role="status">{t("Checking the store system…")}</p>
        ) : read.kind === "Unavailable" ? (
          <p role="status">
            {t(
              "System alerts could not be read. Check again in a moment; if this stays, ask the pilot operator to check the store system.",
            )}
          </p>
        ) : read.value.monitor === "NotRunning" ? (
          <p className="system-alert__headline">
            {t(
              "The alert monitor is not running, so problems with the store system, backups and certificate are not being checked. Ask the pilot operator to start it.",
            )}
          </p>
        ) : read.value.monitor === "Silent" ? (
          <p className="system-alert__headline">
            {t(
              "The alert monitor stopped reporting{value}. Problems are not being checked. Ask the pilot operator to restart it.",
              {
                value:
                  read.value.observedAt === null
                    ? ""
                    : t(" at {observedAt}", { observedAt: at(read.value.observedAt) }),
              },
            )}
          </p>
        ) : (
          <>
            {read.value.plannedUpdate !== null ? (
              // WP-2423 (2026-10-18): a planned update is not an outage; if the store is still
              // down when its window ends, the usual urgent alert follows at once.
              <div className="system-alert system-alert--update">
                <p className="system-alert__headline">
                  {t("System update in progress — ordering may pause for a few minutes.")}
                </p>
                <p>
                  {t(
                    "Started {startedAt}. If guests or staff screens still can’t order after {expiresAt}, this card shows an urgent alert.",
                    {
                      startedAt: at(read.value.plannedUpdate.startedAt),
                      expiresAt: at(read.value.plannedUpdate.expiresAt),
                    },
                  )}
                </p>
              </div>
            ) : read.value.active.length === 0 ? (
              <p className="system-alert__headline">{t("Everything is working.")}</p>
            ) : null}
            {read.value.active.length === 0 ? null : (
              <ul className="system-alerts">
                {read.value.active.map((item) => (
                  <li key={item.key} className={"system-alert system-alert--" + item.severity}>
                    <p className="system-alert__title">
                      <span className="system-alert__badge">
                        {item.severity === "critical" ? t("Urgent") : t("Today")}
                      </span>
                      <strong>{item.title}</strong>
                    </p>
                    <p>{item.summary}</p>
                    <p>
                      <span className="system-alert__label">{t("What to do:")} </span>
                      {item.action}
                    </p>
                    <p className="system-alert__since">
                      {t("Since {raisedAt}", { raisedAt: at(item.raisedAt) })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {view !== null && view.monitor === "Reporting" ? (
        <div className="system-alert__footer">
          {view.recentlyCleared.length > 0 ? (
            <p className="system-alert__resolved">
              {t("Resolved recently: {value}", {
                value: view.recentlyCleared
                  .slice(-3)
                  .reverse()
                  .map((item) => `${item.title} (${at(item.clearedAt)})`)
                  .join("; "),
              })}
            </p>
          ) : null}
          <p className="overview-updated">
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
          </p>
          <p className="overview-updated">{outboundNote(view.outbound)}</p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Reads the alert board while the Home is open and visible. The server decides who sees it
 * (operations.order-exception.manage): its "not permitted" answer (WP-2423; a 403 from an older
 * server) hides the card and stops reading, so front-of-house staff never poll it again and no
 * refusal shows in their browser.
 */
export function OperationsAlerts({
  timeZone,
  fetcher,
}: {
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
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
  return (
    <OperationsAlertsCard
      read={read}
      timeZone={timeZone}
      busy={busy}
      onRefresh={() => void load()}
    />
  );
}
