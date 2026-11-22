import { DiningPaymentTimingPanel } from "./DiningPaymentTimingPanel.js";
import {
  serviceModeText,
  listSeparator,
  systemText,
  t,
  wallClockTime,
  withOneSentenceEnd,
} from "./i18n/i18n.js";
import { businessDateLabel } from "./StoreBusinessDay.js";
import { storeTime } from "./StoreTime.js";
import { StatePanel } from "@bop-rms/ui";
import { StoreConfigurationEditor } from "./StoreConfigurationEditor.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { noAccessHeading } from "./access-denied.js";
import { NoAccessNotice } from "./NoAccessNotice.js";
import { createStoreConfigurationClient } from "./store-configuration-client.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { timeZoneLabel } from "./time-zone-names.js";
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
}: {
  hours: ServiceHours;
  timeZone: string;
  /** When the hours were read: special dates before that operating day are no longer listed. */
  observedAt: string;
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
  // Batch 46: each piece is one whole phrase per language ("打烊前 30 分钟停止点单").
  const describe = (interval: ServiceInterval) =>
    joinPieces([
      serviceTime(interval.startLocalTime) +
        "–" +
        serviceTime(interval.endLocalTime) +
        (interval.endsNextDay ? t(" (next day)") : ""),
      interval.serviceModes.map(serviceModeLabel).join(listSeparator()),
      ...(interval.orderCutoffSeconds > 0
        ? [
            t("last orders {minutes} before closing", {
              minutes: serviceMinutes(interval.orderCutoffSeconds),
            }),
          ]
        : []),
      ...(interval.leadTimeSeconds > 0
        ? [t("ready in {minutes}", { minutes: serviceMinutes(interval.leadTimeSeconds) })]
        : []),
    ]);
  // Batch 46 (v15: "2026-11-05 · Special hours" 17 days after the date): only today's and later
  // special dates are listed; earlier ones stay in the published configuration's own record.
  const today = operatingDate(observedAt, timeZone, hours.businessDayStartLocalTime);
  const exceptions = hours.exceptions.filter((exception) => exception.localDate >= today);
  return (
    <section aria-labelledby="published-hours-title">
      <h2 id="published-hours-title">{t("Published hours")}</h2>
      <p>
        {hours.configurationSource === "StoreOverride"
          ? t("Store configuration")
          : t("Inherited Brand configuration")}{" "}
        · {timeZoneLabel(timeZone)}
      </p>
      <p>
        {withOneSentenceEnd(
          t("Business day starts at {businessDayStartLocalTime}.", {
            businessDayStartLocalTime: serviceTime(hours.businessDayStartLocalTime),
          }),
        )}
      </p>
      <div className="detail-section-grid">
        {hours.weeklySchedule.map((day) => (
          <section key={day.isoWeekday}>
            <h3>{days[day.isoWeekday - 1]}</h3>
            {day.intervals.length ? (
              <ul>
                {day.intervals.map((interval, index) => (
                  <li key={index}>{describe(interval)}</li>
                ))}
              </ul>
            ) : (
              <p>{t("Closed")}</p>
            )}
          </section>
        ))}
      </div>
      <h3>{t("Exceptions and holidays")}</h3>
      {exceptions.length ? (
        <ul>
          {exceptions.map((exception) => (
            <li key={exception.localDate}>
              <strong>
                <time dateTime={exception.localDate}>
                  {businessDateLabel(exception.localDate, today)}
                </time>
                {" · " + exceptionKindLabel(exception.kind)}
              </strong>
              {exception.intervals.length ? (
                <ul>
                  {exception.intervals.map((interval, index) => (
                    <li key={index}>{describe(interval)}</li>
                  ))}
                </ul>
              ) : (
                <p>{t("Closed")}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("No special dates or holidays coming up.")}</p>
      )}
    </section>
  );
}

export function StoreServiceControlPanel({ store, csrf }: { store: string; csrf: string }) {
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
  // WP-2423 Q4: hours editing appears only where this runtime can actually save it.
  const [configurable, setConfigurable] = useState(false);
  useEffect(() => {
    const probe = new AbortController();
    createStoreConfigurationClient()
      .load(store, probe.signal)
      .then(
        () => setConfigurable(!probe.signal.aborted),
        () => setConfigurable(false),
      );
    return () => probe.abort();
  }, [store]);
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
  return (
    <WorkspacePage title={t("Hours & ordering")}>
      {view && (
        <ServiceHoursSummary
          hours={view.hours}
          timeZone={view.timeZone}
          observedAt={view.observedAt}
        />
      )}
      {configurable ? (
        <StoreConfigurationEditor key={store + csrf} store={store} csrf={csrf} />
      ) : null}
      <section aria-labelledby="service-controls-title" aria-busy={busy}>
        <h2 id="service-controls-title">{t("Service controls")}</h2>
        <p>
          {t(
            "Pause new service for a limited time. Existing paid orders and occupied dining tables remain active.",
          )}
        </p>
        {!online && (
          <p role="status">{t("Offline read-only. Reconnect before changing service.")}</p>
        )}
        <p role="status" aria-live="polite">
          {systemText(message)}
        </p>
        <button type="button" onClick={() => void load()} disabled={busy || !online || uncertain}>
          {t("Refresh service status")}
        </button>
        {uncertain && (
          <button type="button" onClick={() => void submit()} disabled={busy || !online}>
            {t("Retry same request")}
          </button>
        )}
        {view && (
          <>
            <p>
              {/* Batch 46: in the app's language and the Store's zone, never the browser's. */}
              {t("Updated {value} · {timeZone}", {
                value: storeTime(view.observedAt, view.timeZone, true, "Guest"),
                timeZone: timeZoneLabel(view.timeZone),
              })}
            </p>
            <fieldset disabled={disabled}>
              <legend>{t("Pause service")}</legend>
              <label htmlFor="pause-duration">{t("Pause duration (minutes)")}</label>
              <input
                id="pause-duration"
                type="number"
                min="1"
                max="240"
                step="1"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <label htmlFor="pause-mode">{t("Service")}</label>
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
              <button type="button" onClick={pause}>
                {t("Pause service")}
              </button>
            </fieldset>
            <h3>{t("Active pauses")}</h3>
            {view.activePauses.length === 0 ? (
              <p>{t("No active pauses.")}</p>
            ) : (
              <ul>
                {view.activePauses.map((item) => (
                  <li key={item.closureReference}>
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
  );
}
