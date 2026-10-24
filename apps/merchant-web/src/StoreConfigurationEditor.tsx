import { t } from "./i18n/i18n.js";
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
      return t("Draft, not yet sent for approval");
    case "PendingApproval":
      return t("Waiting for approval");
    case "Approved":
      return t("Approved, waiting to be published");
    case "Published":
      return t("Published");
    case "Superseded":
      return t("Replaced by a newer version");
    case "Archived":
      return t("Archived");
  }
}
/** WP-2423 (v15 D2/D3): the change a new edit starts from — the latest one unless it was
 * withdrawn or declined, then the published configuration (nothing is carried unintentionally). */
export function storeConfigurationEditBase(
  view: StoreConfigurationView,
): StoreConfigurationSnapshot | null {
  return view.latestWithdrawal ? (view.current ?? view.latest) : (view.latest ?? view.current);
}
/** WP-2423 (v15 `8bd902e3` D2): the Store setup revision an hours change continues from, or none
 * for an ordinary hours change. The PUBLISHED configuration decides the kind of change: an installed
 * (V1) one takes an ordinary change even when a withdrawn or declined change from Store setup is the
 * latest; one from Store setup takes an hours-only setup revision continuing from the latest
 * setup-based change (the server checks a withdrawn one carries nothing but hours). */
export function storeHoursSetupBasis(
  view: StoreConfigurationView,
): StoreConfigurationSnapshot["setupBasis"] {
  if (view.current?.setupBasis === undefined) return undefined;
  return (view.latest ?? view.current).setupBasis;
}
/** WP-2423 (v15): whether you hold Store configuration approval. The server says so for every
 * viewer (`viewerMayApprove`); an older one only for someone else's open change (`viewerMayDecline`,
 * the same permission). Undefined when not known. */
export function storeConfigurationViewerMayApprove(
  view: StoreConfigurationView,
): boolean | undefined {
  if (view.viewerMayApprove !== undefined) return view.viewerMayApprove;
  if (storeConfigurationOpenChange(view) === "SomeoneElse") return view.viewerMayDecline;
  return undefined;
}
/** Shown to a sender who cannot approve (or whose approval access is not known). */
export const STORE_HOURS_SENT_TO_OWNER = t(
  "Sent for approval. An Owner will review and approve it; you’ll see it here once it is published.",
);
/** WP-2423 (v15 `8bd902e3` D4): what happens next once a change is sent for approval — the
 * Owner with sole operator in effect approves it alone; another sender with approval access is told
 * someone else approves it (and, when sole operator is off, where to turn it on); a sender without
 * approval access (a Store Manager) is told an Owner reviews it. Sole operator hints are only for
 * people who hold approval access. */
export function storeHoursSubmittedMessage(view: StoreConfigurationView): string {
  const gate = view.soleOperator;
  if (gate?.status === "Effective")
    return t(
      "Sent for approval. You are the sole operator: you can approve it yourself below, then publish it.",
    );
  if (storeConfigurationViewerMayApprove(view) !== true) return STORE_HOURS_SENT_TO_OWNER;
  if (gate?.status === "NotSet")
    return t(
      "Sent for approval. Another person with approval access must approve it. If you run the Store alone, turn on sole operator in Approvals to approve it yourself.",
    );
  return t(
    "Sent for approval. Another person with approval access must approve it before it is published.",
  );
}
/** WP-2423 (v15): what someone else's open change allows you to do, from its current state (never
 * draft-only wording once it has been sent or approved). */
export function storeConfigurationOthersChangeText(
  view: StoreConfigurationView,
  author: string | null,
): string {
  const lifecycle = view.latest?.lifecycle,
    mayApprove = storeConfigurationViewerMayApprove(view) === true,
    who = author ?? t("the person who made it");
  if (lifecycle === "PendingApproval")
    return mayApprove
      ? t("It has been sent for approval. You can approve or decline it.")
      : t("It has been sent for approval and is waiting for an Owner to approve it.");
  if (lifecycle === "Approved")
    return t(
      "It has been approved and can now be published. Customers see the new hours once it is published.",
    );
  return (
    t("Only {who} can check it or send it for approval. ", { who: who }) +
    (mayApprove
      ? t("You can approve it once it is sent, or decline it here.")
      : t("Ask an Owner to approve or decline it."))
  );
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
      setMessage(t("Configuration loaded."));
    } catch {
      if (!active.signal.aborted)
        setMessage(t("Configuration unavailable. Check your access and retry."));
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
      setMessage(t("Reload the saved configuration before reviewing this action."));
      return;
    }
    // WP-2423 Q4: hours of a configuration from Store setup are saved as an hours-only Store setup
    // change; the server makes the draft configuration from it.
    const setupBasis = storeHoursSetupBasis(view);
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
          ? t("Configuration published.")
          : completedCommand === "Approve"
            ? doneMode === "SoleOperator"
              ? t(
                  "Configuration approved by you alone as sole operator. Publish it to change the hours customers see.",
                )
              : t("Configuration approved. Published hours remain unchanged until publication.")
            : completedCommand === "Validate"
              ? t("Saved draft validated.")
              : completedCommand === "Submit"
                ? storeHoursSubmittedMessage(next)
                : t("Draft saved. It takes effect only after approval and publication."),
      );
    } catch (error) {
      if (active.signal.aborted) return;
      const text = error instanceof Error ? error.message : t("Configuration request unavailable.");
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
      const { kind, setupHoursRestored } = await withdrawStoreConfiguration(
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
        (kind === "Withdrawn"
          ? t("Your change was withdrawn. The next change starts from the published hours.")
          : t("The change was declined. The next change starts from the published hours.")) +
          // WP-2423 (2026-10-16 v15): Store setup no longer holds the withdrawn hours either.
          (setupHoursRestored ? t(" Store setup is back to the published opening hours too.") : ""),
      );
    } catch (error) {
      if (!active.signal.aborted)
        setMessage(
          error instanceof Error ? error.message : t("Configuration request unavailable."),
        );
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
      <h2 id="configuration-editor-title">{t("Operating hours draft")}</h2>
      <p>
        {t(
          "Save changes for review. Published hours remain active until a new configuration is published.",
        )}
      </p>
      {!online && <p role="status">{t("Offline read-only.")}</p>}
      <p role="status">{message}</p>
      <button type="button" disabled={disabled} onClick={() => void load()}>
        {view ? t("Reload configuration") : t("Edit operating hours")}
      </button>
      {uncertain && (
        <button type="button" disabled={busy || !online} onClick={() => void save()}>
          {t("Retry configuration request")}
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
    // v15 D3: the author may be described by role ("the Owner"); capitalised to start a sentence.
    Author = author === null ? null : author.charAt(0).toUpperCase() + author.slice(1),
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
  const days = [
    t("Monday"),
    t("Tuesday"),
    t("Wednesday"),
    t("Thursday"),
    t("Friday"),
    t("Saturday"),
    t("Sunday"),
  ];
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
          ? t("Latest change: ") +
            (withdrawn
              ? withdrawn.kind === "Withdrawn"
                ? t("Withdrawn by the person who made it")
                : t("Declined")
              : storeConfigurationStateLabel(view.latest.lifecycle))
          : view.current
            ? t("No pending change. Customers see the published hours.")
            : t("No published hours yet.")}
      </p>
      {withdrawn && (
        <p>
          {t("It was {value}{value2}", {
            value: withdrawn.kind === "Withdrawn" ? t("withdrawn") : t("declined"),
            value2: withdrawn.byYou ? t(" by you") : "",
          })}{" "}
          <StaffTime instant={withdrawn.withdrawnAt} />
          {t("{value}. The next change starts from the published hours.", {
            value: withdrawn.reason
              ? ` (${storeConfigurationDeclineReasonText[withdrawn.reason]})`
              : "",
          })}
        </p>
      )}
      {open === "SomeoneElse" && view.latest && (
        <section aria-label={t("Change waiting from someone else")}>
          <p>
            {t(
              "{value}’s change (version {configurationVersion}, {value2}) is still open. It is shown below. A new change cannot be saved until it is {value3}, or declined. {view}",
              {
                value: Author === null ? t("Someone else") : Author,
                configurationVersion: view.latest.configurationVersion,
                value2: storeConfigurationStateLabel(view.latest.lifecycle).toLowerCase(),
                value3:
                  view.latest.lifecycle === "Approved"
                    ? t("published")
                    : t("approved and published"),
                view: storeConfigurationOthersChangeText(view, author),
              },
            )}
          </p>
          {onWithdraw && view.viewerMayDecline === true && !declining && (
            <button type="button" disabled={disabled} onClick={() => setDeclining(true)}>
              {t("Decline this change")}
            </button>
          )}
          {onWithdraw && view.viewerMayDecline === true && declining && (
            <div role="group" aria-label={t("Decline this change")}>
              <p>
                {t(
                  "Decline version {configurationVersion}? It stays in the history and cannot be approved or published. {value} sees that it was declined{value2}, and can make a new change.",
                  {
                    configurationVersion: view.latest.configurationVersion,
                    value: Author === null ? t("The person who made it") : Author,
                    value2: declineReason === "" ? "" : t(" and why"),
                  },
                )}
              </p>
              <label>
                {t("Reason (optional)")}
                <select
                  value={declineReason}
                  disabled={disabled}
                  onChange={(event) =>
                    setDeclineReason(event.currentTarget.value as StoreConfigurationDeclineReason)
                  }
                >
                  <option value="">{t("No reason given")}</option>
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
                {t("Decline version {configurationVersion}", {
                  configurationVersion: view.latest.configurationVersion,
                })}
              </button>{" "}
              <button type="button" disabled={disabled} onClick={() => setDeclining(false)}>
                {t("Keep it")}
              </button>
            </div>
          )}
        </section>
      )}
      {open === "Yours" && view.latest && (
        <section aria-label={t("Your change waiting")}>
          <p>
            {t(
              "You are editing your own change (version {configurationVersion}, {value}). Saving again replaces it; it then needs to be sent and approved again.",
              {
                configurationVersion: view.latest.configurationVersion,
                value: storeConfigurationStateLabel(view.latest.lifecycle).toLowerCase(),
              },
            )}
          </p>
          {onWithdraw && (
            <button type="button" disabled={disabled} onClick={() => onWithdraw()}>
              {t("Withdraw my change")}
            </button>
          )}
        </section>
      )}
      <p>
        {t("Times are in {timeZone}. The business day starts at {value}.", {
          timeZone: timeZoneLabel(draft.timeZone),
          value: draft.businessDayStartLocalTime.slice(0, 5),
        })}
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
              {day.intervals.length === 0 && <p>{t("Closed")}</p>}
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
                {t("Add interval")}
              </button>
            </fieldset>
          ))}

          <fieldset>
            <legend>{t("Dated exceptions")}</legend>
            <p>
              {t("Dates use {timeZone}. An exception with no intervals is closed for that date.", {
                timeZone: timeZoneLabel(draft.timeZone),
              })}
            </p>
            {draft.exceptions.map((exception, n) => (
              <fieldset key={n}>
                <legend>{t("Exception {value}", { value: n + 1 })}</legend>
                <label>
                  {t("Exception date")}
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
                  {t("Exception kind")}
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
                    <option value="Holiday">{t("Holiday")}</option>
                    <option value="TemporaryClosure">{t("Temporary closure")}</option>
                    <option value="Override">{t("Special hours")}</option>
                  </select>
                </label>
                {exception.intervals.length === 0 && <p>{t("Closed")}</p>}
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
                  {t("Add exception interval")}
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
                  {t("Remove exception {value}", { value: n + 1 })}
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
              {t("Add dated exception")}
            </button>
          </fieldset>
        </StoreConfigurationEditingBoundary>
        <button type="submit" disabled={open === "SomeoneElse"}>
          {t("Save hours draft")}
        </button>
        <button
          type="button"
          disabled={
            stepsClosed || open === "SomeoneElse" || view.latest?.lifecycle !== "Draft" || !saved
          }
          onClick={() => onCommand("Validate")}
        >
          {t("Validate saved draft")}
        </button>
        <button
          type="button"
          disabled={
            stepsClosed || open === "SomeoneElse" || view.latest?.lifecycle !== "Draft" || !saved
          }
          onClick={() => onCommand("Submit")}
        >
          {t("Submit saved draft")}
        </button>
        {!stepsClosed && view.latest?.lifecycle === "Approved" && (
          <button type="button" disabled={!saved} onClick={() => onCommand("Publish")}>
            {t("Publish approved configuration")}
          </button>
        )}
        {!stepsClosed &&
          view.latest?.lifecycle === "PendingApproval" &&
          !ownWaiting &&
          storeConfigurationViewerMayApprove(view) !== false && (
            <>
              <p>
                {t(
                  "Approval requires an authorized reviewer other than the person who made the change.",
                )}
              </p>
              <button type="button" disabled={!saved} onClick={() => onCommand("Approve")}>
                {t("Approve reviewed configuration")}
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
  // WP-2423 (v15): sole operator applies only to people who hold approval access; a sender
  // without it (or not known to hold it) is told an Owner reviews the change.
  if (
    view.soleOperator?.status !== "Effective" &&
    storeConfigurationViewerMayApprove(view) !== true
  )
    return yours || view.soleOperator !== null ? (
      <section aria-label={t("Approve your own change")}>
        <h3>{t("Approval")}</h3>
        <p>
          {t(
            "An Owner will review and approve this change; you’ll see it here once it is published.",
          )}
        </p>
      </section>
    ) : null;
  if (view.soleOperator === null)
    return yours ? (
      <section aria-label={t("Approve your own change")}>
        <h3>{t("Approval")}</h3>
        <p>
          {t(
            "You made this change, so another person with Owner access must approve it. You cannot approve a change you made.",
          )}
        </p>
      </section>
    ) : null;
  return (
    <section aria-label={t("Approve your own change")}>
      <h3>{t("Approval")}</h3>
      <SoleOperatorSelfApproval
        gate={view.soleOperator}
        csrf={csrf}
        summary={
          <p>
            {t(
              "Version {configurationVersion}: opening hours and dated closures as shown above. Once approved, publish it to change the hours customers see.",
              { configurationVersion: latest.configurationVersion },
            )}
          </p>
        }
        what={t("these opening hours")}
        permissionName={t("Owner access to this Store")}
        actionLabel={t("Approve hours on my own")}
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
      <legend>{t("Interval {value}", { value: i + 1 })}</legend>
      <label>
        {t("Start {value}", { value: i + 1 })}
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
        {t("End {value}", { value: i + 1 })}
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
        {t("Ends next day")}
      </label>
      <label>
        {t("Last orders (minutes before closing)")}
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
        {t("Preparation time (minutes)")}
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
        <legend>{t("Service modes")}</legend>
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
        {t("Remove interval {value}", { value: i + 1 })}
      </button>
    </fieldset>
  );
}

/** This display reports recorded content, not a new qualification or publication transition. */
export function StoreConfigurationFeeBasisView({
  configuration,
  withdrawal,
}: {
  readonly configuration: StoreConfigurationSnapshot;
  /** WP-2423 (v15 D6): this version was withdrawn or declined (read with it); never "Draft". */
  readonly withdrawal?: "Withdrawn" | "Declined" | undefined;
}) {
  const basis = configuration.setupBasis;
  return (
    <section
      aria-label={
        configuration.lifecycle === "Published"
          ? t("Published fee configuration")
          : t("Recorded fee configuration")
      }
    >
      <h3>
        {configuration.lifecycle === "Published"
          ? t("Fees in the published settings")
          : t("Fees in the recorded settings")}
      </h3>
      <p>
        {withdrawal === undefined
          ? storeConfigurationStateLabel(configuration.lifecycle)
          : withdrawal === "Withdrawn"
            ? t("Withdrawn, will not be published")
            : t("Declined, will not be published")}
        .{" "}
        {configuration.lifecycle !== "Published" &&
          t("These settings do not change the live Store.")}
      </p>
      {!basis ? (
        <p>
          {t(
            "This configuration was made before fees were part of Store setup, so it has no fee settings.",
          )}
        </p>
      ) : (
        <>
          <p>
            {t(
              "These settings come from saved Store setup draft {sourceRevision}. Change them in Store setup.",
              { sourceRevision: basis.sourceRevision },
            )}
          </p>
          <Link to={`/app/organization/stores/${configuration.storeReference}/setup`}>
            {t("Edit in Store Setup")}
          </Link>
          <ul>
            {basis.feeContexts.map((entry) => (
              <li key={entry.chargeType}>
                {entry.chargeType === "ServiceCharge"
                  ? t("Service charge")
                  : entry.chargeType === "DeliveryFee"
                    ? t("Delivery fee")
                    : t("Tip")}
                :{" "}
                {entry.state === "Enabled"
                  ? t("On")
                  : entry.state === "Disabled"
                    ? t("Off")
                    : t("Not set")}
                {entry.state === "Enabled" && (
                  <>
                    {" "}
                    · {entry.orderTypes.map(serviceModeLabel).join(", ")} ·{" "}
                    {entry.taxClassificationReference === null
                      ? t("no tax classification (tips are not taxed)")
                      : t("tax classification chosen")}
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            {t(
              "Fee amounts are not set here, and the tax classification has not been checked by a tax professional.",
            )}
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
      <legend>{t("Hours and service timing")}</legend>
      {configuration.setupBasis !== undefined && (
        <p>
          {t(
            "These hours are also the hours in Store setup. Saving them changes nothing else there.",
          )}
        </p>
      )}
      {children}
    </fieldset>
  );
}
