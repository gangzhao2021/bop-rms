import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { timeZoneLabel } from "./time-zone-names.js";
import {
  createStoreConfigurationClient,
  type StoreConfigurationView,
  type StoreConfigurationSnapshot,
  type StoreConfigurationCommand,
  type StoreHoursDraftCommand,
  STORE_SETUP_UNPUBLISHED_MESSAGE,
  OPEN_CHANGE_BY_ANOTHER_MESSAGE,
  STORE_CONFIGURATION_WITHDRAWN_MESSAGE,
  storeConfigurationDeclineReasonText,
  storeConfigurationKeptRefusals,
  withdrawStoreConfiguration,
  type StoreConfigurationDeclineReason,
} from "./store-configuration-client.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import { StaffTime } from "./StoreTime.js";
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
/** WP-2423 (v15 D2/D3): the change a new edit starts from — the latest one unless it was
 * withdrawn or declined, then the published configuration (nothing is carried unintentionally). */
export function storeConfigurationEditBase(
  view: StoreConfigurationView,
): StoreConfigurationSnapshot | null {
  return view.latestWithdrawal ? (view.current ?? view.latest) : (view.latest ?? view.current);
}
/** WP-2423 (v15 D2/D3): whose change is open (not published, not withdrawn), if any. */
export function storeConfigurationOpenChange(
  view: StoreConfigurationView,
): "None" | "Yours" | "SomeoneElse" | "Unknown" {
  const latest = view.latest;
  if (
    latest === null ||
    view.latestWithdrawal ||
    (latest.lifecycle !== "Draft" &&
      latest.lifecycle !== "PendingApproval" &&
      latest.lifecycle !== "Approved")
  )
    return "None";
  if (view.viewerActorReference === undefined) return "Unknown";
  return latest.authoredByReference === view.viewerActorReference ? "Yours" : "SomeoneElse";
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
  const pending = useRef<StoreConfigurationCommand | StoreHoursDraftCommand | null>(null);
  // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the pending request is your own approval given alone.
  const pendingMode = useRef<"SoleOperator" | undefined>(undefined);
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
      setDraft(storeConfigurationEditBase(next));
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
    approvalMode?: "SoleOperator",
  ) {
    if (running.current || !online || !view || !draft) return;
    if (!pending.current) pendingMode.current = command === "Approve" ? approvalMode : undefined;
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
    // WP-2423 Q4: hours of a configuration from Store setup are saved as an hours-only Store setup
    // change; the server makes the draft configuration from it.
    const setupBasis = (view.latest ?? view.current)?.setupBasis;
    if (!pending.current && command === "SaveDraft" && setupBasis)
      pending.current = {
        expectedSetup: {
          setupDraftReference: setupBasis.setupDraftReference,
          sourceRevision: setupBasis.sourceRevision,
          sourceSnapshotDigest: setupBasis.sourceSnapshotDigest,
        },
        setupOperationReference: serviceOperationReference(),
        operationReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
        configurationReference: serviceOperationReference(),
        expectedVersion: view.expectedVersion,
        weeklySchedule: draft.weeklySchedule,
        exceptions: draft.exceptions,
        effectiveFrom: view.observedAt,
      };
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
      const sent = pending.current;
      const completedCommand = "command" in sent ? sent.command : "SaveDraft";
      if ("command" in sent) await client.execute(sent, csrf, active.signal, pendingMode.current);
      else await client.saveHoursDraft(sent, csrf, active.signal);
      pending.current = null;
      setUncertain(false);
      const next = await client.load(store, active.signal);
      const doneMode = pendingMode.current;
      pendingMode.current = undefined;
      if (active.signal.aborted) return;
      setView(next);
      setDraft(storeConfigurationEditBase(next));
      setMessage(
        completedCommand === "Publish"
          ? "Configuration published."
          : completedCommand === "Approve"
            ? doneMode === "SoleOperator"
              ? "Configuration approved by you alone as sole operator. Publish it to change the hours customers see."
              : "Configuration approved. Published hours remain unchanged until publication."
            : completedCommand === "Validate"
              ? "Saved draft validated."
              : completedCommand === "Submit"
                ? "Draft submitted for independent approval."
                : "Draft saved. It takes effect only after approval and publication.",
      );
    } catch (error) {
      if (active.signal.aborted) return;
      const text = error instanceof Error ? error.message : "Configuration request unavailable.";
      if (text.startsWith("Source changed")) {
        pending.current = null;
        setUncertain(false);
        setView(null);
        setDraft(null);
      } else if (
        // WP-2423 (v15): a refusal keeps the form and the change on screen (an approval refused
        // with 403 no longer collapses the editor); the reason says what to do next.
        text.startsWith("Permission denied") ||
        storeConfigurationKeptRefusals.has(text) ||
        text.startsWith("Change not accepted") ||
        text === STORE_SETUP_UNPUBLISHED_MESSAGE ||
        text === OPEN_CHANGE_BY_ANOTHER_MESSAGE ||
        text === STORE_CONFIGURATION_WITHDRAWN_MESSAGE
      ) {
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
  /** WP-2423 (v15 D2/D3): withdraw your own open change, or decline someone else's. */
  async function withdraw(declineReason?: StoreConfigurationDeclineReason) {
    const latest = view?.latest;
    if (running.current || !online || !latest || pending.current) return;
    running.current = true;
    setBusy(true);
    const active = new AbortController();
    controller.current = active;
    try {
      const kind = await withdrawStoreConfiguration(
        {
          configurationReference: latest.configurationReference,
          configurationVersion: latest.configurationVersion,
          auditReference: serviceOperationReference(),
          ...(declineReason === undefined ? {} : { declineReason }),
        },
        csrf,
      );
      const next = await client.load(store, active.signal);
      if (active.signal.aborted) return;
      setView(next);
      setDraft(storeConfigurationEditBase(next));
      setMessage(
        kind === "Withdrawn"
          ? "Your change was withdrawn. The next change starts from the published hours."
          : "The change was declined. The next change starts from the published hours.",
      );
    } catch (error) {
      if (!active.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Configuration request unavailable.");
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
          onWithdraw={(reason) => void withdraw(reason)}
        />
      )}
      {view && draft && (
        <StoreHoursOwnApproval
          view={view}
          csrf={csrf}
          busy={disabled || JSON.stringify(draft) !== JSON.stringify(view.latest)}
          onApprove={() => void save("Approve", "SoleOperator")}
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
  onWithdraw,
}: {
  readonly view: StoreConfigurationView;
  readonly draft: StoreConfigurationSnapshot;
  readonly disabled: boolean;
  onDraftChange(draft: StoreConfigurationSnapshot): void;
  onCommand(command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish"): void;
  /** WP-2423 (v15 D2/D3): withdraw your own open change, or decline someone else's (optional
   * reason, after confirming). */
  onWithdraw?(declineReason?: StoreConfigurationDeclineReason): void;
}) {
  const [declining, setDeclining] = useState(false),
    [declineReason, setDeclineReason] = useState<StoreConfigurationDeclineReason | "">("");
  const open = storeConfigurationOpenChange(view),
    // WP-2423 (v15): the person who made a change waiting for approval is not its approver (they
    // approve alone as sole operator below, when that applies).
    ownWaiting =
      view.latest?.lifecycle === "PendingApproval" &&
      (open === "Yours" || (view.soleOperator !== undefined && view.soleOperator !== null)),
    author = view.latestAuthorName ?? null,
    withdrawn = view.latestWithdrawal ?? null,
    // A withdrawn or declined change takes no further step.
    stepsClosed = withdrawn !== null;
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
        if (open !== "SomeoneElse") onCommand("SaveDraft");
      }}
    >
      <p>
        {view.latest && view.latest.lifecycle !== "Published"
          ? "Latest change: " +
            (withdrawn
              ? withdrawn.kind === "Withdrawn"
                ? "Withdrawn by the person who made it"
                : "Declined"
              : storeConfigurationStateLabel(view.latest.lifecycle))
          : view.current
            ? "No pending change. Customers see the published hours."
            : "No published hours yet."}
      </p>
      {withdrawn && (
        <p>
          It was {withdrawn.kind === "Withdrawn" ? "withdrawn" : "declined"}
          {withdrawn.byYou ? " by you" : ""} <StaffTime instant={withdrawn.withdrawnAt} />
          {withdrawn.reason ? ` (${storeConfigurationDeclineReasonText[withdrawn.reason]})` : ""}.
          The next change starts from the published hours.
        </p>
      )}
      {open === "SomeoneElse" && view.latest && (
        <section aria-label="Change waiting from someone else">
          <p>
            {author === null ? "Someone else" : author}&rsquo;s change (version{" "}
            {view.latest.configurationVersion},{" "}
            {storeConfigurationStateLabel(view.latest.lifecycle).toLowerCase()}) is still open. It
            is shown below. A new change cannot be saved until it is approved and published, or
            declined. Only {author === null ? "the person who made it" : author} can check it or
            send it for approval. If you are an Owner you can review it here; otherwise ask an
            Owner.
          </p>
          {onWithdraw && !declining && (
            <button type="button" disabled={disabled} onClick={() => setDeclining(true)}>
              Decline this change
            </button>
          )}
          {onWithdraw && declining && (
            <div role="group" aria-label="Decline this change">
              <p>
                Decline version {view.latest.configurationVersion}? It stays in the history and
                cannot be approved or published.{" "}
                {author === null ? "The person who made it" : author} sees that it was declined
                {declineReason === "" ? "" : " and why"}, and can make a new change.
              </p>
              <label>
                Reason (optional)
                <select
                  value={declineReason}
                  disabled={disabled}
                  onChange={(event) =>
                    setDeclineReason(event.currentTarget.value as StoreConfigurationDeclineReason)
                  }
                >
                  <option value="">No reason given</option>
                  {(
                    Object.keys(
                      storeConfigurationDeclineReasonText,
                    ) as StoreConfigurationDeclineReason[]
                  ).map((reason) => (
                    <option key={reason} value={reason}>
                      {storeConfigurationDeclineReasonText[reason]}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setDeclining(false);
                  onWithdraw(declineReason === "" ? undefined : declineReason);
                }}
              >
                Decline version {view.latest.configurationVersion}
              </button>{" "}
              <button type="button" disabled={disabled} onClick={() => setDeclining(false)}>
                Keep it
              </button>
            </div>
          )}
        </section>
      )}
      {open === "Yours" && view.latest && (
        <section aria-label="Your change waiting">
          <p>
            You are editing your own change (version {view.latest.configurationVersion},{" "}
            {storeConfigurationStateLabel(view.latest.lifecycle).toLowerCase()}). Saving again
            replaces it; it then needs to be sent and approved again.
          </p>
          {onWithdraw && (
            <button type="button" disabled={disabled} onClick={() => onWithdraw()}>
              Withdraw my change
            </button>
          )}
        </section>
      )}
      <p>
        Times are in {timeZoneLabel(draft.timeZone)}. The business day starts at{" "}
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
              Dates use {timeZoneLabel(draft.timeZone)}. An exception with no intervals is closed
              for that date.
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
        <button type="submit" disabled={open === "SomeoneElse"}>
          Save hours draft
        </button>
        <button
          type="button"
          disabled={
            stepsClosed || open === "SomeoneElse" || view.latest?.lifecycle !== "Draft" || !saved
          }
          onClick={() => onCommand("Validate")}
        >
          Validate saved draft
        </button>
        <button
          type="button"
          disabled={
            stepsClosed || open === "SomeoneElse" || view.latest?.lifecycle !== "Draft" || !saved
          }
          onClick={() => onCommand("Submit")}
        >
          Submit saved draft
        </button>
        {!stepsClosed && view.latest?.lifecycle === "Approved" && (
          <button type="button" disabled={!saved} onClick={() => onCommand("Publish")}>
            Publish approved configuration
          </button>
        )}
        {!stepsClosed && view.latest?.lifecycle === "PendingApproval" && !ownWaiting && (
          <>
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

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): the Owner's own hours change
 * waiting for approval — approved alone as sole operator (verified, confirmed), or why another
 * person must approve it. Outside the hours form: the verification dialog holds its own form.
 */
export function StoreHoursOwnApproval({
  view,
  csrf,
  busy,
  onApprove,
}: {
  readonly view: StoreConfigurationView;
  readonly csrf: string;
  readonly busy: boolean;
  onApprove(): void;
}) {
  const latest = view.latest;
  if (
    latest === null ||
    latest.lifecycle !== "PendingApproval" ||
    view.latestWithdrawal ||
    view.soleOperator === undefined
  )
    return null;
  const yours = storeConfigurationOpenChange(view) === "Yours";
  if (view.soleOperator === null)
    return yours ? (
      <section aria-label="Approve your own change">
        <h3>Approval</h3>
        <p>
          You made this change, so another person with Owner access must approve it. You cannot
          approve a change you made.
        </p>
      </section>
    ) : null;
  return (
    <section aria-label="Approve your own change">
      <h3>Approval</h3>
      <SoleOperatorSelfApproval
        gate={view.soleOperator}
        csrf={csrf}
        summary={
          <p>
            Version {latest.configurationVersion}: opening hours and dated closures as shown above.
            Once approved, publish it to change the hours customers see.
          </p>
        }
        what="these opening hours"
        permissionName="Owner access to this Store"
        actionLabel="Approve hours on my own"
        busy={busy}
        onApprove={onApprove}
      />
    </section>
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
          ? "Fees in the published settings"
          : "Fees in the recorded settings"}
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

/**
 * WP-2423 Q4: only hours and dated exceptions are edited here, also for a configuration from Store
 * setup (saved as an hours-only Store setup change); its other settings, fees included, stay in
 * Store setup. Lifecycle actions remain outside this boundary.
 */
export function StoreConfigurationEditingBoundary({
  configuration,
  children,
}: {
  readonly configuration: StoreConfigurationSnapshot;
  readonly children: ReactNode;
}) {
  return (
    <fieldset>
      <legend>Hours and service timing</legend>
      {configuration.setupBasis !== undefined && (
        <p>
          These hours are also the hours in Store setup. Saving them changes nothing else there.
        </p>
      )}
      {children}
    </fieldset>
  );
}
