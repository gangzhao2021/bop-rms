import { StoreConfigurationEditor } from "./StoreConfigurationEditor.js";
import { AppFrame } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  createServiceControlClient,
  serviceOperationReference,
  type ServiceControlCommand,
  type ServiceControlState,
  type ServiceMode,
  type ServiceHours,
  type ServiceInterval,
} from "./service-control-client.js";

export function ServiceHoursSummary({
  hours,
  timeZone,
}: {
  hours: ServiceHours;
  timeZone: string;
}) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const describe = (interval: ServiceInterval) =>
    interval.startLocalTime +
    "–" +
    interval.endLocalTime +
    (interval.endsNextDay ? " (next day)" : "") +
    " · " +
    interval.serviceModes.join(", ") +
    " · order cutoff " +
    interval.orderCutoffSeconds +
    " seconds before closing · preparation lead time " +
    interval.leadTimeSeconds +
    " seconds";
  return (
    <section aria-labelledby="published-hours-title">
      <h2 id="published-hours-title">Published hours</h2>
      <p>
        {hours.configurationSource === "StoreOverride"
          ? "Store configuration"
          : "Inherited Brand configuration"}{" "}
        · {timeZone}
      </p>
      <p>Business day starts at {hours.businessDayStartLocalTime} local time.</p>
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
              <p>Closed</p>
            )}
          </section>
        ))}
      </div>
      <h3>Exceptions and holidays</h3>
      {hours.exceptions.length ? (
        <ul>
          {hours.exceptions.map((exception) => (
            <li key={exception.localDate}>
              <strong>
                {exception.localDate} · {exception.kind}
              </strong>
              {exception.intervals.length ? (
                <ul>
                  {exception.intervals.map((interval, index) => (
                    <li key={index}>{describe(interval)}</li>
                  ))}
                </ul>
              ) : (
                <p>Closed</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No published exceptions.</p>
      )}
    </section>
  );
}

export function StoreServiceControlPanel({ store, csrf }: { store: string; csrf: string }) {
  const route = useParams().id;
  const client = useMemo(() => createServiceControlClient(), []);
  const [view, setView] = useState<ServiceControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading service status…");
  const [minutes, setMinutes] = useState("30");
  const [mode, setMode] = useState("All");
  const [online, setOnline] = useState(navigator.onLine);
  const [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const pending = useRef<ServiceControlCommand | null>(null);
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
    } catch {
      if (!activeController.signal.aborted)
        setMessage("Unable to load current service status. Check access and refresh.");
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
    setMessage("Saving service change…");
    const activeController = new AbortController();
    controller.current = activeController;
    let saved = false;
    try {
      await client.execute(request, csrf, activeController.signal);
      pending.current = null;
      setUncertain(false);
      saved = true;
      setMessage("Service change saved. Refreshing status…");
    } catch (error) {
      if (activeController.signal.aborted) return;
      const detail = error instanceof Error ? error.message : "";
      if (detail.startsWith("Source changed.") || detail.startsWith("Permission denied.")) {
        pending.current = null;
        setUncertain(false);
        setView(null);
        setMessage(detail);
      } else {
        setUncertain(true);
        setMessage(
          "The result could not be confirmed. Retry this same request to check its outcome.",
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
      setMessage("Enter a positive whole number of minutes.");
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
      <section aria-label="Service controls">
        <p role="status">Select this Store in your workspace before changing service.</p>
      </section>
    );
  const disabled = busy || !online || uncertain;
  return (
    <AppFrame title="Hours & service" description="STORE-HOURS-SERVICE">
      {view && <ServiceHoursSummary hours={view.hours} timeZone={view.timeZone} />}
      <StoreConfigurationEditor key={store + csrf} store={store} csrf={csrf} />
      <section aria-labelledby="service-controls-title" aria-busy={busy}>
        <h2 id="service-controls-title">Service controls</h2>
        <p>
          Pause new service for a limited time. Existing paid orders and occupied dining tables
          remain active.
        </p>
        {!online && <p role="status">Offline read-only. Reconnect before changing service.</p>}
        <p role="status" aria-live="polite">
          {message}
        </p>
        <button type="button" onClick={() => void load()} disabled={busy || !online || uncertain}>
          Refresh service status
        </button>
        {uncertain && (
          <button type="button" onClick={() => void submit()} disabled={busy || !online}>
            Retry same request
          </button>
        )}
        {view && (
          <>
            <p>
              Updated{" "}
              {new Intl.DateTimeFormat(undefined, {
                timeZone: view.timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(view.observedAt))}{" "}
              ({view.timeZone})
            </p>
            <fieldset disabled={disabled}>
              <legend>Pause service</legend>
              <label htmlFor="pause-duration">Pause duration (minutes)</label>
              <input
                id="pause-duration"
                type="number"
                min="1"
                step="1"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <label htmlFor="pause-mode">Service</label>
              <select
                id="pause-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="All">All services</option>
                {view.enabledServiceModes.map((value) => (
                  <option key={value} value={value}>
                    {value === "DineIn" ? "Dine-in" : value}
                  </option>
                ))}
              </select>
              <button type="button" onClick={pause}>
                Pause service
              </button>
            </fieldset>
            <h3>Active pauses</h3>
            {view.activePauses.length === 0 ? (
              <p>No active pauses.</p>
            ) : (
              <ul>
                {view.activePauses.map((item) => (
                  <li key={item.closureReference}>
                    <span>
                      {item.serviceModes?.join(", ") ?? "All services"} — until{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        timeZone: view.timeZone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(item.effectiveUntil))}
                    </span>{" "}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => resume(item.closureReference)}
                    >
                      Resume {item.serviceModes?.join(", ") ?? "all services"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </AppFrame>
  );
}
