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
      } else setUncertain(pending.current !== null);
      setMessage(text);
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  function updateInterval(day: number, index: number, change: Partial<ServiceInterval>) {
    if (!draft) return;
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
  const disabled = busy || !online || uncertain;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>
            Published version: {view.current?.configurationVersion ?? "None"} · Latest version:{" "}
            {view.expectedVersion}
          </p>
          <p>Time zone: {draft.timeZone}</p>
          <StoreConfigurationFeeBasisView configuration={draft} />
          {view.current && view.current.configurationReference !== draft.configurationReference && (
            <StoreConfigurationFeeBasisView configuration={view.current} />
          )}
          <fieldset disabled={disabled}>
            <StoreConfigurationEditingBoundary configuration={draft}>
              <label>
                Business day starts
                <input
                  type="time"
                  step="60"
                  required
                  value={draft.businessDayStartLocalTime.slice(0, 5)}
                  onChange={(event) =>
                    setDraft({ ...draft, businessDayStartLocalTime: event.target.value + ":00" })
                  }
                />
              </label>
              <label>
                Effective from (UTC)
                <input
                  type="datetime-local"
                  step="1"
                  required
                  value={draft.effectiveFrom.slice(0, 19)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      effectiveFrom: event.target.value
                        ? new Date(event.target.value + "Z").toISOString()
                        : "",
                    })
                  }
                />
              </label>
              <label>
                Effective until (UTC, optional)
                <input
                  type="datetime-local"
                  step="1"
                  value={draft.effectiveUntil?.slice(0, 19) ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      effectiveUntil: event.target.value
                        ? new Date(event.target.value + "Z").toISOString()
                        : null,
                    })
                  }
                />
              </label>
              <label>
                Change reason code
                <input
                  required
                  pattern="[A-Z][A-Z0-9_.:-]{0,63}"
                  maxLength={64}
                  value={draft.reasonCode}
                  onChange={(event) => setDraft({ ...draft, reasonCode: event.target.value })}
                />
              </label>
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
                            j !== n
                              ? d
                              : {
                                  ...d,
                                  intervals: d.intervals.filter((_, k) => k !== i),
                                },
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
                                intervals: [
                                  ...d.intervals,
                                  {
                                    startLocalTime: "09:00:00",
                                    endLocalTime: "17:00:00",
                                    endsNextDay: false,
                                    serviceModes: draft.enabledServiceModes,
                                    orderCutoffSeconds: 0,
                                    leadTimeSeconds: 0,
                                  },
                                ],
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
                  Dates use {draft.timeZone}. An exception with no intervals is closed for that
                  date.
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
                              j === n
                                ? { ...e, kind: event.target.value as typeof exception.kind }
                                : e,
                            ),
                          })
                        }
                      >
                        <option value="Holiday">Holiday</option>
                        <option value="TemporaryClosure">Temporary closure</option>
                        <option value="Override">Override</option>
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
                              j !== n
                                ? e
                                : { ...e, intervals: e.intervals.filter((_, k) => k !== i) },
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
                                  intervals: [
                                    ...e.intervals,
                                    {
                                      startLocalTime: "09:00:00",
                                      endLocalTime: "17:00:00",
                                      endsNextDay: false,
                                      serviceModes: draft.enabledServiceModes,
                                      orderCutoffSeconds: 0,
                                      leadTimeSeconds: 0,
                                    },
                                  ],
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
            <p>Latest state: {view.latest?.lifecycle ?? "No draft"}</p>
            <button
              type="button"
              disabled={
                view.latest?.lifecycle !== "Draft" ||
                JSON.stringify(draft) !== JSON.stringify(view.latest)
              }
              onClick={() => void save("Validate")}
            >
              Validate saved draft
            </button>
            <button
              type="button"
              disabled={
                view.latest?.lifecycle !== "Draft" ||
                JSON.stringify(draft) !== JSON.stringify(view.latest)
              }
              onClick={() => void save("Submit")}
            >
              Submit saved draft
            </button>
            {view.latest?.lifecycle === "Approved" && (
              <button
                type="button"
                disabled={JSON.stringify(draft) !== JSON.stringify(view.latest)}
                onClick={() => void save("Publish")}
              >
                Publish approved configuration
              </button>
            )}
            {view.latest?.lifecycle === "PendingApproval" && (
              <>
                <p>Approval requires an authorized reviewer other than the draft author.</p>
                <button
                  type="button"
                  disabled={JSON.stringify(draft) !== JSON.stringify(view.latest)}
                  onClick={() => void save("Approve")}
                >
                  Approve reviewed configuration
                </button>
              </>
            )}
          </fieldset>
        </form>
      )}
    </section>
  );
}

function IntervalEditor({
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
        Order cutoff seconds
        <input
          type="number"
          min="0"
          max="86400"
          step="1"
          required
          value={interval.orderCutoffSeconds}
          onChange={(event) => onChange({ orderCutoffSeconds: Number(event.target.value) })}
        />
      </label>
      <label>
        Preparation seconds
        <input
          type="number"
          min="0"
          max="86400"
          step="1"
          required
          value={interval.leadTimeSeconds}
          onChange={(event) => onChange({ leadTimeSeconds: Number(event.target.value) })}
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
            {mode}
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
        Configuration state: {configuration.lifecycle}.{" "}
        {configuration.lifecycle !== "Published" && "These settings do not change the live Store."}
      </p>
      {!basis ? (
        <p>
          This legacy configuration has no recorded Setup fee basis. Fee policy is not inferred.
        </p>
      ) : (
        <>
          <p>
            This recorded configuration is bound to its immutable Setup source. Edit its fields in
            Store Setup.
          </p>
          <Link to={`/app/organization/stores/${configuration.storeReference}/setup`}>
            Edit in Store Setup
          </Link>
          <dl>
            <dt>Setup draft source</dt>
            <dd>{basis.setupDraftReference}</dd>
            <dt>Setup source revision</dt>
            <dd>{basis.sourceRevision}</dd>
            <dt>Setup source fingerprint</dt>
            <dd>{basis.sourceSnapshotDigest}</dd>
          </dl>
          <ul>
            {basis.feeContexts.map((entry) => (
              <li key={entry.chargeType}>
                {entry.chargeType === "ServiceCharge"
                  ? "Service charge"
                  : entry.chargeType === "DeliveryFee"
                    ? "Delivery fee"
                    : "Tip"}
                : {entry.state}
                {entry.state === "Enabled" && (
                  <>
                    {" "}
                    · order types {entry.orderTypes.join(", ")} · recorded tax classification
                    selected
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            Recorded selections do not supply fee amounts, quotes or professional tax qualification.
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
