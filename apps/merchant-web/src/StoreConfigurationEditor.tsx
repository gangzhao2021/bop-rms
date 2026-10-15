import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  createStoreConfigurationClient,
  type StoreConfigurationView,
  type StoreConfigurationSnapshot,
  type StoreConfigurationCommand,
} from "./store-configuration-client.js";
import {
  serviceOperationReference,
  type ServiceMode,
  type ServiceInterval,
} from "./service-control-client.js";

/** WP-2423 Q4: the reason recorded with an hours change made in this editor. */
export const STORE_HOURS_REASON_CODE = "STORE_HOURS_UPDATE";
/** WP-2423 Q4: lifecycle states in staff language. */
export function storeConfigurationStateLabel(
  lifecycle: StoreConfigurationSnapshot["lifecycle"],
): string {
  switch (lifecycle) {
    case "Draft":
      return "Draft, not yet sent for approval";
    case "PendingApproval":
      return "Waiting for approval";
    case "Approved":
      return "Approved, waiting to be published";
    case "Published":
      return "Published";
    case "Superseded":
      return "Replaced by a newer version";
    case "Archived":
      return "Archived";
  }
}
const serviceModeLabel = (mode: ServiceMode) =>
  mode === "DineIn" ? "Dine-in" : mode === "Pickup" ? "Pickup" : "Delivery";
const newInterval = (modes: readonly ServiceMode[]): ServiceInterval => ({
  startLocalTime: "09:00:00",
  endLocalTime: "17:00:00",
  endsNextDay: false,
  serviceModes: modes,
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
});

export function StoreConfigurationEditor({ store, csrf }: { store: string; csrf: string }) {
  const client = useMemo(() => createStoreConfigurationClient(), []);
  const [view, setView] = useState<StoreConfigurationView | null>(null);
  const [draft, setDraft] = useState<StoreConfigurationSnapshot | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<StoreConfigurationCommand | null>(null);
  const running = useRef(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      controller.current?.abort();
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  async function load() {
    if (running.current || pending.current) return;
    running.current = true;
    setBusy(true);
    const active = new AbortController();
    controller.current = active;
    try {
      const next = await client.load(store, active.signal);
      if (active.signal.aborted) return;
      setView(next);
      setDraft(next.latest ?? next.current);
      setMessage("Configuration loaded.");
    } catch {
      if (!active.signal.aborted)
        setMessage("Configuration unavailable. Check your access and retry.");
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function save(
    command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish" = "SaveDraft",
  ) {
    if (running.current || !online || !view || !draft) return;
    if (!pending.current && command === "SaveDraft" && draft.setupBasis) {
      setMessage(
        "Edit this recorded configuration in Store Setup, then materialize a new saved configuration.",
      );
      return;
    }
    if (
      !pending.current &&
      command !== "SaveDraft" &&
      (view.latest?.lifecycle !==
        (command === "Approve"
          ? "PendingApproval"
          : command === "Publish"
            ? "Approved"
            : "Draft") ||
        JSON.stringify(draft) !== JSON.stringify(view.latest))
    ) {
      setMessage("Reload the saved configuration before reviewing this action.");
      return;
    }
    if (!pending.current)
      pending.current = {
        command,
        operationReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
        expectedVersion: view.expectedVersion,
        configuration:
          command !== "SaveDraft"
            ? {
                ...draft,
                lifecycle:
                  command === "Submit" || command === "Approve"
                    ? "PendingApproval"
                    : command === "Publish"
                      ? "Approved"
                      : "Draft",
                updatedAt: command === "Publish" ? draft.updatedAt : view.observedAt,
              }
            : {
                ...draft,
                configurationReference: serviceOperationReference(),
                configurationVersion: view.expectedVersion + 1,
                supersedesConfigurationReference:
                  (view.latest ?? view.current)?.configurationReference ?? null,
                lifecycle: "Draft",
                // WP-2423 Q4: a change applies from when it is saved and has no end date; the
                // reason is fixed rather than typed by staff.
                effectiveFrom: view.observedAt,
                effectiveUntil: null,
                reasonCode: STORE_HOURS_REASON_CODE,
                approvedByReference: null,
                approvalEvidenceReference: null,
                publicationReference: null,
                liveGateEvidenceReference: null,
                createdAt: view.observedAt,
                updatedAt: view.observedAt,
              },
      };
    running.current = true;
    setBusy(true);
    const active = new AbortController();
    controller.current = active;
    try {
      const completedCommand = pending.current.command;
      await client.execute(pending.current, csrf, active.signal);
      pending.current = null;
      setUncertain(false);
      const next = await client.load(store, active.signal);
      if (active.signal.aborted) return;
      setView(next);
      setDraft(next.latest ?? next.current);
      setMessage(
        completedCommand === "Publish"
          ? "Configuration published."
          : completedCommand === "Approve"
            ? "Configuration approved. Published hours remain unchanged until publication."
            : completedCommand === "Validate"
              ? "Saved draft validated."
              : completedCommand === "Submit"
                ? "Draft submitted for independent approval."
                : "Draft saved. It takes effect only after approval and publication.",
      );
    } catch (error) {
      if (active.signal.aborted) return;
      const text = error instanceof Error ? error.message : "Configuration request unavailable.";
      if (text.startsWith("Permission denied") || text.startsWith("Source changed")) {
        pending.current = null;
        setUncertain(false);
        setView(null);
        setDraft(null);
      } else if (text.startsWith("Change not accepted")) {
        // WP-2423 Q4: a definite rejection; keep the form so staff can correct and save again.
        pending.current = null;
        setUncertain(false);
      } else setUncertain(pending.current !== null);
      setMessage(text);
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const disabled = busy || !online || uncertain;
  return (
    <section aria-labelledby="configuration-editor-title" aria-busy={busy}>
      <h2 id="configuration-editor-title">Operating hours draft</h2>
      <p>
        Save changes for review. Published hours remain active until a new configuration is
        published.
      </p>
      {!online && <p role="status">Offline read-only.</p>}
      <p role="status">{message}</p>
      <button type="button" disabled={disabled} onClick={() => void load()}>
        {view ? "Reload configuration" : "Edit operating hours"}
      </button>
      {uncertain && (
        <button type="button" disabled={busy || !online} onClick={() => void save()}>
          Retry configuration request
        </button>
      )}
      {view && draft && (
        <StoreHoursDraftForm
          view={view}
          draft={draft}
          disabled={disabled}
          onDraftChange={setDraft}
          onCommand={(command) => void save(command)}
        />
      )}
    </section>
  );
}

/** WP-2423 Q4: hours and dated closures only; other Store facts are owned by Store Setup. */
export function StoreHoursDraftForm({
  view,
  draft,
  disabled,
  onDraftChange: setDraft,
  onCommand,
}: {
  readonly view: StoreConfigurationView;
  readonly draft: StoreConfigurationSnapshot;
  readonly disabled: boolean;
  onDraftChange(draft: StoreConfigurationSnapshot): void;
  onCommand(command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish"): void;
}) {
  function updateInterval(day: number, index: number, change: Partial<ServiceInterval>) {
    setDraft({
      ...draft,
      weeklySchedule: draft.weeklySchedule.map((d, n) =>
        n !== day
          ? d
          : {
              ...d,
              intervals: d.intervals.map((v, i) => (i === index ? { ...v, ...change } : v)),
            },
      ),
    });
  }
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const saved = JSON.stringify(draft) === JSON.stringify(view.latest);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCommand("SaveDraft");
      }}
    >
      <p>
        {view.latest && view.latest.lifecycle !== "Published"
          ? "Latest change: " + storeConfigurationStateLabel(view.latest.lifecycle)
          : view.current
            ? "No pending change. Customers see the published hours."
            : "No published hours yet."}
      </p>
      <p>
        Times are in {draft.timeZone}. The business day starts at{" "}
        {draft.businessDayStartLocalTime.slice(0, 5)}.
      </p>
      {draft.setupBasis !== undefined && <StoreConfigurationFeeBasisView configuration={draft} />}
      {view.current?.setupBasis !== undefined &&
        view.current.configurationReference !== draft.configurationReference && (
          <StoreConfigurationFeeBasisView configuration={view.current} />
        )}
      <fieldset disabled={disabled}>
        <StoreConfigurationEditingBoundary configuration={draft}>
          {draft.weeklySchedule.map((day, n) => (
            <fieldset key={day.isoWeekday}>
              <legend>{days[n]}</legend>
              {day.intervals.length === 0 && <p>Closed</p>}
              {day.intervals.map((interval, i) => (
                <IntervalEditor
                  key={i}
                  index={i}
                  interval={interval}
                  modes={draft.enabledServiceModes}
                  onChange={(change) => updateInterval(n, i, change)}
                  onRemove={() =>
                    setDraft({
                      ...draft,
                      weeklySchedule: draft.weeklySchedule.map((d, j) =>
                        j !== n ? d : { ...d, intervals: d.intervals.filter((_, k) => k !== i) },
                      ),
                    })
                  }
                />
              ))}
              <button
                type="button"
                disabled={day.intervals.length >= 16}
                onClick={() =>
                  setDraft({
                    ...draft,
                    weeklySchedule: draft.weeklySchedule.map((d, j) =>
                      j !== n
                        ? d
                        : {
                            ...d,
                            intervals: [...d.intervals, newInterval(draft.enabledServiceModes)],
                          },
                    ),
                  })
                }
              >
                Add interval
              </button>
            </fieldset>
          ))}

          <fieldset>
            <legend>Dated exceptions</legend>
            <p>
              Dates use {draft.timeZone}. An exception with no intervals is closed for that date.
            </p>
            {draft.exceptions.map((exception, n) => (
              <fieldset key={n}>
                <legend>Exception {n + 1}</legend>
                <label>
                  Exception date
                  <input
                    type="date"
                    required
                    value={exception.localDate}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        exceptions: draft.exceptions.map((e, j) =>
                          j === n ? { ...e, localDate: event.target.value } : e,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Exception kind
                  <select
                    value={exception.kind}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        exceptions: draft.exceptions.map((e, j) =>
                          j === n ? { ...e, kind: event.target.value as typeof exception.kind } : e,
                        ),
                      })
                    }
                  >
                    <option value="Holiday">Holiday</option>
                    <option value="TemporaryClosure">Temporary closure</option>
                    <option value="Override">Special hours</option>
                  </select>
                </label>
                {exception.intervals.length === 0 && <p>Closed</p>}
                {exception.intervals.map((interval, i) => (
                  <IntervalEditor
                    key={i}
                    interval={interval}
                    index={i}
                    modes={draft.enabledServiceModes}
                    onChange={(change) =>
                      setDraft({
                        ...draft,
                        exceptions: draft.exceptions.map((e, j) =>
                          j !== n
                            ? e
                            : {
                                ...e,
                                intervals: e.intervals.map((v, k) =>
                                  k === i ? { ...v, ...change } : v,
                                ),
                              },
                        ),
                      })
                    }
                    onRemove={() =>
                      setDraft({
                        ...draft,
                        exceptions: draft.exceptions.map((e, j) =>
                          j !== n ? e : { ...e, intervals: e.intervals.filter((_, k) => k !== i) },
                        ),
                      })
                    }
                  />
                ))}
                <button
                  type="button"
                  disabled={exception.intervals.length >= 16}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      exceptions: draft.exceptions.map((e, j) =>
                        j !== n
                          ? e
                          : {
                              ...e,
                              intervals: [...e.intervals, newInterval(draft.enabledServiceModes)],
                            },
                      ),
                    })
                  }
                >
                  Add exception interval
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      exceptions: draft.exceptions.filter((_, j) => j !== n),
                    })
                  }
                >
                  Remove exception {n + 1}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={draft.exceptions.length >= 366}
              onClick={() =>
                setDraft({
                  ...draft,
                  exceptions: [
                    ...draft.exceptions,
                    { localDate: "", kind: "Holiday", intervals: [] },
                  ],
                })
              }
            >
              Add dated exception
            </button>
          </fieldset>
        </StoreConfigurationEditingBoundary>
        <button type="submit" disabled={draft.setupBasis !== undefined}>
          Save hours draft
        </button>
        <button
          type="button"
          disabled={view.latest?.lifecycle !== "Draft" || !saved}
          onClick={() => onCommand("Validate")}
        >
          Validate saved draft
        </button>
        <button
          type="button"
          disabled={view.latest?.lifecycle !== "Draft" || !saved}
          onClick={() => onCommand("Submit")}
        >
          Submit saved draft
        </button>
        {view.latest?.lifecycle === "Approved" && (
          <button type="button" disabled={!saved} onClick={() => onCommand("Publish")}>
            Publish approved configuration
          </button>
        )}
        {view.latest?.lifecycle === "PendingApproval" && (
          <>
            {/* The view does not identify the signed-in person, so the author check is the
                server's: approving your own change is refused. */}
            <p>
              Approval requires an authorized reviewer other than the person who made the change.
            </p>
            <button type="button" disabled={!saved} onClick={() => onCommand("Approve")}>
              Approve reviewed configuration
            </button>
          </>
        )}
      </fieldset>
    </form>
  );
}

export function IntervalEditor({
  interval,
  index: i,
  modes,
  onChange,
  onRemove,
}: {
  interval: ServiceInterval;
  index: number;
  modes: readonly ServiceMode[];
  onChange(value: Partial<ServiceInterval>): void;
  onRemove(): void;
}) {
  // WP-2423 Q4: staff enter whole minutes; the configuration stores seconds.
  const minutes = (seconds: number) => Math.round(seconds / 60);
  const seconds = (value: string) => Math.min(86400, Math.max(0, Math.round(Number(value)) * 60));
  return (
    <fieldset>
      <legend>Interval {i + 1}</legend>
      <label>
        Start {i + 1}
        <input
          type="time"
          required
          step="1"
          value={interval.startLocalTime}
          onChange={(event) =>
            onChange({
              startLocalTime:
                event.target.value.length === 5 ? event.target.value + ":00" : event.target.value,
            })
          }
        />
      </label>
      <label>
        End {i + 1}
        <input
          type="time"
          required
          step="1"
          value={interval.endLocalTime}
          onChange={(event) =>
            onChange({
              endLocalTime:
                event.target.value.length === 5 ? event.target.value + ":00" : event.target.value,
            })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={interval.endsNextDay}
          onChange={(event) => onChange({ endsNextDay: event.target.checked })}
        />
        Ends next day
      </label>
      <label>
        Last orders (minutes before closing)
        <input
          type="number"
          min="0"
          max="1440"
          step="1"
          required
          value={minutes(interval.orderCutoffSeconds)}
          onChange={(event) => onChange({ orderCutoffSeconds: seconds(event.target.value) })}
        />
      </label>
      <label>
        Preparation time (minutes)
        <input
          type="number"
          min="0"
          max="1440"
          step="1"
          required
          value={minutes(interval.leadTimeSeconds)}
          onChange={(event) => onChange({ leadTimeSeconds: seconds(event.target.value) })}
        />
      </label>
      <fieldset>
        <legend>Service modes</legend>
        {modes.map((mode) => (
          <label key={mode}>
            <input
              type="checkbox"
              checked={interval.serviceModes.includes(mode)}
              disabled={interval.serviceModes.length === 1 && interval.serviceModes.includes(mode)}
              onChange={(event) =>
                onChange({
                  serviceModes: event.target.checked
                    ? [...interval.serviceModes, mode]
                    : interval.serviceModes.filter((v) => v !== mode),
                })
              }
            />
            {serviceModeLabel(mode)}
          </label>
        ))}
      </fieldset>
      <button type="button" onClick={onRemove}>
        Remove interval {i + 1}
      </button>
    </fieldset>
  );
}

/** This display reports recorded content, not a new qualification or publication transition. */
export function StoreConfigurationFeeBasisView({
  configuration,
}: {
  readonly configuration: StoreConfigurationSnapshot;
}) {
  const basis = configuration.setupBasis;
  return (
    <section
      aria-label={
        configuration.lifecycle === "Published"
          ? "Published fee configuration"
          : "Recorded fee configuration"
      }
    >
      <h3>
        {configuration.lifecycle === "Published"
          ? "Published configuration fee contexts"
          : "Recorded configuration fee contexts"}
      </h3>
      <p>
        {storeConfigurationStateLabel(configuration.lifecycle)}.{" "}
        {configuration.lifecycle !== "Published" && "These settings do not change the live Store."}
      </p>
      {!basis ? (
        <p>
          This configuration was made before fees were part of Store setup, so it has no fee
          settings.
        </p>
      ) : (
        <>
          <p>
            These settings come from saved Store setup draft {basis.sourceRevision}. Change them in
            Store setup.
          </p>
          <Link to={`/app/organization/stores/${configuration.storeReference}/setup`}>
            Edit in Store Setup
          </Link>
          <ul>
            {basis.feeContexts.map((entry) => (
              <li key={entry.chargeType}>
                {entry.chargeType === "ServiceCharge"
                  ? "Service charge"
                  : entry.chargeType === "DeliveryFee"
                    ? "Delivery fee"
                    : "Tip"}
                :{" "}
                {entry.state === "Enabled" ? "On" : entry.state === "Disabled" ? "Off" : "Not set"}
                {entry.state === "Enabled" && (
                  <>
                    {" "}
                    · {entry.orderTypes.map(serviceModeLabel).join(", ")} · tax classification
                    chosen
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            Fee amounts are not set here, and the tax classification has not been checked by a tax
            professional.
          </p>
        </>
      )}
    </section>
  );
}

/** Basis-bound full content is immutable here; lifecycle actions remain outside this boundary. */
export function StoreConfigurationEditingBoundary({
  configuration,
  children,
}: {
  readonly configuration: StoreConfigurationSnapshot;
  readonly children: ReactNode;
}) {
  return (
    <fieldset disabled={configuration.setupBasis !== undefined}>
      <legend>Hours and service timing</legend>
      {children}
    </fieldset>
  );
}
