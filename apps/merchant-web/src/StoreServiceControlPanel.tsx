import { DiningPaymentTimingPanel } from "./DiningPaymentTimingPanel.js";
import { serviceModeText, listSeparator, systemText, t, wallClockTime } from "./i18n/i18n.js";
import { businessDateLabel } from "./StoreBusinessDay.js";
import { ClockStyleContext, storeTime } from "./StoreTime.js";
import { StatePanel } from "@bop-rms/ui";
import { StoreConfigurationEditor } from "./StoreConfigurationEditor.js";
import type { StoreConfigurationView } from "./store-configuration-client.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { noAccessHeading } from "./access-denied.js";
import { NoAccessNotice } from "./NoAccessNotice.js";
import { createStoreConfigurationClient } from "./store-configuration-client.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { timeZoneLabel } from "./time-zone-names.js";
import { isOpenAllDay, lastOrdersTime } from "./open-all-day.js";
import {
  createServiceControlClient,
  serviceOperationReference,
  pauseTooLongText,
  serviceControlDeniedText,
  type ServiceControlCommand,
  type ServiceControlState,
  type ServiceMode,
  type ServiceHours,
  type ServiceInterval,
} from "./service-control-client.js";

/**
 * "09:00:00" → "9:00 a.m."; "00:00:00" → "12:00 a.m." (Chinese "0:00"). Batch 46: the Store's
 * hours read as guests read them on their phones (the b40 convention for times guests also see,
 * as on Tables), never "9:00 AM" beside a guest's "9:00 a.m.".
 */
export function serviceTime(value: string): string {
  return wallClockTime(value);
}
const exceptionKindLabel = (kind: string) =>
  kind === "TemporaryClosure"
    ? t("Temporary closure")
    : kind === "Override"
      ? t("Special hours")
      : kind === "Holiday"
        ? t("Holiday")
        : kind;

/**
 * Batch 46: the Store's operating day at an instant — its local date, or the day before while the
 * time is before the business-day start (00:12 with a 4:00 start is still the evening's day, whose
 * special hours may still be running).
 */
export function operatingDate(at: string, timeZone: string, businessDayStart: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (time >= businessDayStart) return date;
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Pieces of one published period, "11:30–14:30 · 堂食". In Chinese a full-width bracket already
 * carries its own space, so the separator after "（次日）" drops the extra one.
 */
function joinPieces(pieces: readonly string[]): string {
  return pieces.reduce((text, piece) => text + (text.endsWith("）") ? "· " : " · ") + piece);
}
const serviceModeLabel = (mode: string) => serviceModeText(mode);
const serviceMinutes = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? t("1 minute") : t("{minutes} minutes", { minutes: minutes });
};

export function ServiceHoursSummary({
  hours,
  timeZone,
  observedAt,
  action = null,
  changes = null,
}: {
  hours: ServiceHours;
  timeZone: string;
  /** When the hours were read: special dates before that operating day are no longer listed. */
  observedAt: string;
  /** Batch 63 F54: "Edit hours", accent text at the end of the section's title row. */
  action?: ReactNode;
  /** Batch 63 F54: the "Changes waiting for approval" line under the hours. */
  changes?: ReactNode;
}) {
  const days = [
    t("Monday"),
    t("Tuesday"),
    t("Wednesday"),
    t("Thursday"),
    t("Friday"),
    t("Saturday"),
    t("Sunday"),
  ];
  // WP-2423 Q4: hours in staff language — 9:00 a.m., Dine-in, minutes; zero settings are left out.
  // Batch 46: each piece is one whole phrase per language ("打烊前 30 分钟停止点单"); a period open
  // all day reads "Open 24 hours", and its last orders as the time they stop (there is no closing
  // for "before closing" to count from).
  const describe = (interval: ServiceInterval) => {
    const allDay = isOpenAllDay([interval]);
    return joinPieces([
      allDay
        ? t("Open 24 hours")
        : serviceTime(interval.startLocalTime) +
          "–" +
          serviceTime(interval.endLocalTime) +
          (interval.endsNextDay ? t(" (next day)") : ""),
      interval.serviceModes.map(serviceModeLabel).join(listSeparator()),
      ...(interval.orderCutoffSeconds > 0
        ? [
            allDay
              ? t("no orders after {time}", {
                  time: serviceTime(lastOrdersTime(interval, interval.orderCutoffSeconds)),
                })
              : t("last orders {minutes} before closing", {
                  minutes: serviceMinutes(interval.orderCutoffSeconds),
                }),
          ]
        : []),
      ...(interval.leadTimeSeconds > 0
        ? [t("ready in {minutes}", { minutes: serviceMinutes(interval.leadTimeSeconds) })]
        : []),
    ]);
  };
  /**
   * Batch 63 F54 (Figma 57:121): one row a day, the day and its periods on one line (each period
   * a line of its own), row hairlines; periods back to back that cover the day are said once.
   */
  const periods = (intervals: readonly ServiceInterval[]) =>
    intervals.length === 0 ? (
      <span className="hours-page__period">{t("Closed")}</span>
    ) : (
      <>
        {intervals.length > 1 && isOpenAllDay(intervals) ? (
          <span className="hours-page__period">{t("Open 24 hours")}</span>
        ) : null}
        {intervals.map((interval, index) => (
          <span key={index} className="hours-page__period">
            {describe(interval)}
          </span>
        ))}
      </>
    );
  // Batch 46 (v15: "2026-11-05 · Special hours" 17 days after the date): only today's and later
  // special dates are listed; earlier ones stay in the published configuration's own record.
  const today = operatingDate(observedAt, timeZone, hours.businessDayStartLocalTime);
  const exceptions = hours.exceptions.filter((exception) => exception.localDate >= today);
  return (
    <section aria-labelledby="published-hours-title" className="hours-page__section">
      <div className="hours-page__section-head">
        <h2 id="published-hours-title">{t("Opening hours")}</h2>
        {action}
      </div>
      {/* RA-05: what guests see, in their words (was "Published hours", "Store configuration"). */}
      <p className="hours-page__muted">{t("Hours guests see now")}</p>
      <dl className="hours-page__rows">
        {hours.weeklySchedule.map((day) => (
          <div key={day.isoWeekday} className="hours-page__row">
            <dt>{days[day.isoWeekday - 1]}</dt>
            <dd>{periods(day.intervals)}</dd>
          </div>
        ))}
      </dl>
      {exceptions.length ? (
        <>
          <p className="hours-page__muted">{t("Special dates and holidays:")}</p>
          <dl className="hours-page__rows">
            {exceptions.map((exception) => (
              <div key={exception.localDate} className="hours-page__row hours-page__row--date">
                <dt>
                  <time dateTime={exception.localDate}>
                    {businessDateLabel(exception.localDate, today)}
                  </time>
                  {" · " + exceptionKindLabel(exception.kind)}
                </dt>
                <dd>{periods(exception.intervals)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="hours-page__muted">{t("Special dates and holidays: none coming up.")}</p>
      )}
      {changes}
    </section>
  );
}

/** Batch 63 F54: whether an hours change is on its way, in plain words (none, saved, waiting). */
export function hoursChangesText(view: StoreConfigurationView | null): string | null {
  if (view === null) return null;
  const latest = view.latestWithdrawal === undefined ? view.latest : null;
  switch (latest?.lifecycle) {
    case "Draft":
      return t(
        "Changes waiting for approval: none. A saved change has not been sent for approval yet.",
      );
    case "PendingApproval":
      return t("Changes waiting for approval: 1.");
    case "Approved":
      return t("Changes waiting for approval: none. An approved change is not live yet.");
    default:
      return t("Changes waiting for approval: none.");
  }
}

export function StoreServiceControlPanel({
  store,
  csrf,
  storeLabel = "",
}: {
  store: string;
  csrf: string;
  /** Batch 63 F54: the Store's name, first in the line under the title (as on Orders). */
  storeLabel?: string;
}) {
  const route = useParams().id;
  const client = useMemo(() => createServiceControlClient(), []);
  const [view, setView] = useState<ServiceControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(t("Loading service status…"));
  const [minutes, setMinutes] = useState("30");
  const [mode, setMode] = useState("All");
  const [online, setOnline] = useState(navigator.onLine);
  const [uncertain, setUncertain] = useState(false);
  // WP-2423: a role without hours access sees one clear state, not a half-loaded page.
  const [noAccess, setNoAccess] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const pending = useRef<ServiceControlCommand | null>(null);
  // WP-2423 Q4: hours editing appears only where this runtime can actually save it. Batch 63 F54:
  // the same read says whether a change is waiting for approval.
  const [configuration, setConfiguration] = useState<StoreConfigurationView | null>(null);
  const configurable = configuration !== null;
  const [editing, setEditing] = useState(false);
  // Batch 64: closing the editor reads again whether a change waits (one may have been saved) and
  // gives focus back to "Edit hours".
  const [probeRevision, setProbeRevision] = useState(0);
  const editHours = useRef<HTMLButtonElement | null>(null);
  const focusEditHours = useRef(false);
  useEffect(() => {
    if (editing || !focusEditHours.current || editHours.current === null) return;
    focusEditHours.current = false;
    editHours.current.focus();
  });
  useEffect(() => {
    const probe = new AbortController();
    createStoreConfigurationClient()
      .load(store, probe.signal)
      .then(
        (next) => {
          if (!probe.signal.aborted) setConfiguration(next);
        },
        () => {
          if (!probe.signal.aborted) setConfiguration(null);
        },
      );
    return () => probe.abort();
  }, [store, probeRevision]);
  const load = useCallback(async () => {
    if (running.current || route !== store) return;
    running.current = true;
    setBusy(true);
    setView(null);
    const activeController = new AbortController();
    controller.current = activeController;
    try {
      const next = await client.load(store, activeController.signal);
      setView(next);
      setMessage("");
    } catch (error) {
      if (activeController.signal.aborted) return;
      if (error instanceof Error && error.message === serviceControlDeniedText) setNoAccess(true);
      else
        setMessage(t("Unable to load current service status. Check your connection and refresh."));
    } finally {
      if (controller.current === activeController) running.current = false;
      if (!activeController.signal.aborted) setBusy(false);
    }
  }, [client, route, store]);
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      running.current = false;
    };
  }, [load]);
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener("online", change);
    window.addEventListener("offline", change);
    return () => {
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
    };
  }, []);
  async function submit(command?: ServiceControlCommand) {
    if (running.current || !online || route !== store) return;
    const request = pending.current ?? command;
    if (!request) return;
    pending.current = request;
    running.current = true;
    setBusy(true);
    setMessage(t("Saving service change…"));
    const activeController = new AbortController();
    controller.current = activeController;
    let saved = false;
    try {
      await client.execute(request, csrf, activeController.signal);
      pending.current = null;
      setUncertain(false);
      saved = true;
      setMessage(t("Service change saved. Refreshing status…"));
    } catch (error) {
      if (activeController.signal.aborted) return;
      const detail = error instanceof Error ? error.message : "";
      if (
        detail.startsWith(t("Source changed. Refresh before trying again.")) ||
        detail === serviceControlDeniedText ||
        detail === pauseTooLongText
      ) {
        pending.current = null;
        setUncertain(false);
        setView(null);
        setMessage(detail);
      } else {
        setUncertain(true);
        setMessage(
          t("The result could not be confirmed. Retry this same request to check its outcome."),
        );
      }
    } finally {
      if (controller.current === activeController) running.current = false;
      if (!activeController.signal.aborted) setBusy(false);
    }
    if (saved) await load();
  }
  function pause() {
    if (!view || pending.current) return;
    const duration = Number(minutes);
    if (
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      !Number.isFinite(new Date(Date.now() + duration * 60000).getTime())
    ) {
      setMessage(t("Enter a positive whole number of minutes."));
      return;
    }
    if (duration > 240) {
      setMessage(pauseTooLongText);
      return;
    }
    void submit({
      command: "PauseService",
      operationReference: serviceOperationReference(),
      auditReference: serviceOperationReference(),
      configurationReference: view.configurationReference,
      expectedVersion: view.expectedVersion,
      content: {
        effectiveUntil: new Date(Date.now() + duration * 60000).toISOString(),
        serviceModes: mode === "All" ? null : [mode as ServiceMode],
      },
    });
  }
  function resume(pauseOperationReference: string) {
    if (!view || pending.current) return;
    void submit({
      command: "ResumeService",
      operationReference: serviceOperationReference(),
      auditReference: serviceOperationReference(),
      configurationReference: view.configurationReference,
      expectedVersion: view.expectedVersion,
      content: { pauseOperationReference },
    });
  }
  if (route !== store)
    return (
      <section aria-label={t("Service controls")}>
        <p role="status">{t("Select this Store in your workspace before changing service.")}</p>
      </section>
    );
  if (noAccess)
    return (
      <WorkspacePage title={t("Hours & ordering")}>
        <StatePanel heading={noAccessHeading} tone="error" status>
          <NoAccessNotice />
        </StatePanel>
      </WorkspacePage>
    );
  const disabled = busy || !online || uncertain;
  const head =
    view === null
      ? storeLabel
      : joinPieces(
          [
            storeLabel,
            timeZoneLabel(view.timeZone),
            t("business day starts {time}", {
              time: serviceTime(view.hours.businessDayStartLocalTime),
            }),
          ].filter((part) => part !== ""),
        );
  const changes = hoursChangesText(configuration);
  return (
    // Batch 47: every time on Hours & ordering, the editor's included, in the guests' style.
    // Batch 63 F54 (Figma 57:121): the Orders header — title, the Store, its zone and business
    // day, the shared stamp and Refresh at the right — then three sections at 20/600.
    <ClockStyleContext.Provider value="Guest">
      <WorkspacePage
        title={t("Hours & ordering")}
        className="hours-page"
        meta={head === "" ? null : head}
        status={
          view === null ? null : (
            <span className="hours-page__updated">
              {/* Batch 46: in the app's language and the Store's zone, never the browser's. */}
              {t("Updated {time}", {
                time: storeTime(view.observedAt, view.timeZone, false, "Guest"),
              })}
            </span>
          )
        }
        actions={
          <button
            type="button"
            className="hours-page__link"
            onClick={() => void load()}
            disabled={busy || !online || uncertain}
          >
            {t("Refresh")}
          </button>
        }
      >
        {view && (
          <ServiceHoursSummary
            hours={view.hours}
            timeZone={view.timeZone}
            observedAt={view.observedAt}
            action={
              configurable && !editing ? (
                <button
                  type="button"
                  className="hours-page__link"
                  ref={editHours}
                  onClick={() => setEditing(true)}
                >
                  {t("Edit hours")}
                </button>
              ) : null
            }
            changes={
              changes === null || editing ? null : <p className="hours-page__muted">{changes}</p>
            }
          />
        )}
        {configurable && (editing || view === null) ? (
          <StoreConfigurationEditor
            key={store + csrf}
            store={store}
            csrf={csrf}
            autoLoad={editing}
            {...(editing
              ? {
                  onClose: () => {
                    focusEditHours.current = true;
                    setEditing(false);
                    setProbeRevision((value) => value + 1);
                  },
                }
              : {})}
            // Batch 51: the editor says the zone itself while Opening hours is not drawn.
            publishedHours={
              view
                ? {
                    timeZone: view.timeZone,
                    businessDayStartLocalTime: view.hours.businessDayStartLocalTime,
                  }
                : null
            }
          />
        ) : null}
        <section
          aria-labelledby="service-controls-title"
          aria-busy={busy}
          className="hours-page__section"
        >
          <h2 id="service-controls-title">{t("Pause ordering")}</h2>
          <p className="hours-page__muted">
            {t("While paused, no new orders come in. Paid orders and seated tables carry on.")}
          </p>
          {!online && (
            <p role="status">{t("Offline read-only. Reconnect before changing service.")}</p>
          )}
          <p role="status" aria-live="polite" className="hours-page__status">
            {systemText(message)}
          </p>
          {uncertain && (
            <button
              type="button"
              className="hours-page__link"
              onClick={() => void submit()}
              disabled={busy || !online}
            >
              {t("Retry same request")}
            </button>
          )}
          {view && (
            <>
              <fieldset disabled={disabled} className="hours-page__pause">
                <legend className="visually-hidden">{t("Pause ordering")}</legend>
                <label>
                  <span>{t("How long (minutes)")}</span>
                  <input
                    id="pause-duration"
                    type="number"
                    min="1"
                    max="240"
                    step="1"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("Which services")}</span>
                  <select
                    id="pause-mode"
                    value={mode}
                    onChange={(event) => setMode(event.target.value)}
                  >
                    <option value="All">{t("All services")}</option>
                    {view.enabledServiceModes.map((value) => (
                      <option key={value} value={value}>
                        {serviceModeText(value)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="hours-page__primary" onClick={pause}>
                  {t("Pause ordering")}
                </button>
              </fieldset>
              {view.activePauses.length === 0 ? (
                <p className="hours-page__muted">{t("No pause now.")}</p>
              ) : (
                <ul className="hours-page__pauses" aria-label={t("Paused now")}>
                  {view.activePauses.map((item) => (
                    <li key={item.closureReference} className="hours-page__row">
                      <span>
                        {t("{value} — until {value2}", {
                          value:
                            item.serviceModes?.map(serviceModeText).join(listSeparator()) ??
                            t("All services"),
                          value2: storeTime(item.effectiveUntil, view.timeZone, true, "Guest"),
                        })}
                      </span>{" "}
                      <button
                        type="button"
                        className="hours-page__link"
                        disabled={disabled}
                        onClick={() => resume(item.closureReference)}
                      >
                        {t("Resume {value}", {
                          value:
                            item.serviceModes?.map(serviceModeText).join(listSeparator()) ??
                            t("all services"),
                        })}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
        {/* WP-2423 DEC-DINE-IN-PAY-LATER: when dine-in guests pay (Owner, Store Manager). */}
        <DiningPaymentTimingPanel csrf={csrf} />
      </WorkspacePage>
    </ClockStyleContext.Provider>
  );
}
