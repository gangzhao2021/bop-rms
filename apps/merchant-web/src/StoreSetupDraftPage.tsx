import { StoreConfigurationOrdinaryPanel } from "./StoreConfigurationOrdinaryPanel.js";
import { ReceiptTemplateStoreSelection } from "./ReceiptTemplateStoreSelection.js";
import { ReceiptTemplateArtifactEditor } from "./ReceiptTemplateArtifactEditor.js";
import { ReceiptTemplateDraftEditor } from "./ReceiptTemplateDraftEditor.js";
import {
  createStorePaymentConfigurationClient,
  parseStorePaymentConfigurationContent,
  type StorePaymentConfigurationCurrent,
  type StorePaymentConfigurationCursor,
  type StorePaymentConfigurationContent,
} from "./store-payment-configuration-client.js";
import {
  createStorePaymentConfigurationPendingJournal,
  type StorePaymentConfigurationPendingJournal,
} from "./store-payment-configuration-pending-journal.js";
import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferenceContent,
  type StoreSetupReferenceKind,
  type StoreSetupReferencesCurrent,
  type StoreSetupReferenceCursor,
} from "./store-setup-reference-client.js";
import {
  createStoreSetupReferencePendingJournal,
  type StoreSetupReferencePendingJournal,
} from "./store-setup-reference-pending-journal.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  createUnconfiguredStoreSetupContentV2,
  normalizeStoreSetupContentV2,
  storeSetupFeeCharges,
  type StoreSetupFeeContext,
  parseStoreSetupContent,
  StoreSetupClientError,
  type StoreSetupContent,
  type StoreSetupWorkspace,
  type StoreSetupCursor,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  createStoreSetupPendingJournal,
  type StoreSetupPendingJournal,
} from "./store-setup-pending-journal.js";
import { serviceOperationReference, type ServiceMode } from "./service-control-client.js";
const steps = [
  "Identity",
  "Address and timezone",
  "Service modes",
  "Hours",
  "Tax and payment",
  "Capacity",
  "Contacts",
  "Review",
] as const;
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const modes: readonly ServiceMode[] = ["DineIn", "Pickup", "Delivery"];
export interface StoreSetupHourInput {
  readonly start: string;
  readonly end: string;
  readonly followingDay: boolean;
  readonly modes: readonly ServiceMode[];
  readonly cutoff: string;
  readonly lead: string;
}
export interface StoreSetupEditorInputs {
  readonly timeZone: string;
  readonly businessStart: string;
  readonly serviceModes: readonly ServiceMode[];
  readonly hours: readonly (readonly StoreSetupHourInput[])[] | null;
}
function editInputs(content: StoreSetupContent): StoreSetupEditorInputs {
  return {
    timeZone: content.timeZone.state === "Configured" ? content.timeZone.value : "",
    businessStart:
      content.businessDayStartLocalTime.state === "Configured"
        ? content.businessDayStartLocalTime.value
        : "",
    serviceModes:
      content.enabledServiceModes.state === "Configured" ? content.enabledServiceModes.value : [],
    hours:
      content.weeklySchedule.state === "Configured"
        ? content.weeklySchedule.value.map((day) =>
            day.intervals.map((i) => ({
              start: i.startLocalTime,
              end: i.endLocalTime,
              followingDay: i.endsNextDay,
              modes: i.serviceModes,
              cutoff: String(i.orderCutoffSeconds),
              lead: String(i.leadTimeSeconds),
            })),
          )
        : null,
  };
}
/** Ordinary raw input remains local while offline or an original is pending.
 * The closed wire parser is used before reservation; invalid text is not coerced. */
export function buildStoreSetupEditedContent(
  content: StoreSetupContent,
  inputs: StoreSetupEditorInputs,
): StoreSetupContent {
  const configured = <T,>(value: T) => ({ state: "Configured" as const, value }),
    empty = { state: "Unconfigured" as const };
  const integer = (value: string) => {
    if (!/^\d+$/u.test(value) || Number(value) > 86400) throw new StoreSetupClientError("Invalid");
    return Number(value);
  };
  const time = (value: string) => (/^\d{2}:\d{2}$/u.test(value) ? value + ":00" : value);
  const weeklySchedule =
    inputs.hours === null
      ? empty
      : configured(
          inputs.hours.map((intervals, i) => ({
            isoWeekday: i + 1,
            intervals: intervals.map((value) => ({
              startLocalTime: time(value.start),
              endLocalTime: time(value.end),
              endsNextDay: value.followingDay,
              serviceModes: value.modes,
              orderCutoffSeconds: integer(value.cutoff),
              leadTimeSeconds: integer(value.lead),
            })),
          })),
        );
  return parseStoreSetupContent({
    ...content,
    timeZone: inputs.timeZone === "" ? empty : configured(inputs.timeZone),
    businessDayStartLocalTime:
      inputs.businessStart === "" ? empty : configured(time(inputs.businessStart)),
    enabledServiceModes: inputs.serviceModes.length === 0 ? empty : configured(inputs.serviceModes),
    weeklySchedule,
  });
}
/** The actual page uses this reserve-before-dispatch routine. Storage failure
 * never dispatches, and a reserved original survives all transport failures. */
export async function dispatchStoreSetupDraft(input: {
  readonly client: ReturnType<typeof createStoreSetupClient>;
  readonly journal: StoreSetupPendingJournal;
  readonly baseline: StoreSetupWorkspace;
  readonly content: StoreSetupContent;
  readonly csrf: string;
  readonly signal: AbortSignal;
  readonly onReserved: (cursor: StoreSetupCursor) => void;
}) {
  const { client, journal, baseline, content, csrf, signal, onReserved } = input;
  const fresh = await client.load({
    storeReference: baseline.scope.storeReference,
    expectedScope: baseline.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("Unavailable");
  if (!sameRoot(baseline, fresh)) throw new StoreSetupClientError("Conflict");
  const prepared = await client.prepare({
    expectedScope: fresh.scope,
    operationReference: serviceOperationReference(),
    expectedSetupReference: root(baseline).reference,
    expectedRevision: root(baseline).revision,
    content,
  });
  if (signal.aborted) throw new StoreSetupClientError("Unavailable");
  await journal.reserve(prepared.cursor);
  onReserved(prepared.cursor);
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  const receipt = await client.execute(prepared, { csrf, signal });
  const workspace = await client.load({
    storeReference: fresh.scope.storeReference,
    expectedScope: fresh.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  await journal.complete(prepared.cursor, receipt, workspace);
  return { receipt, workspace };
}
export async function recoverStoreSetupDraft(input: {
  readonly client: ReturnType<typeof createStoreSetupClient>;
  readonly journal: StoreSetupPendingJournal;
  readonly cursor: StoreSetupCursor;
  readonly csrf: string;
  readonly signal: AbortSignal;
}) {
  const { client, journal, cursor, csrf, signal } = input;
  const receipt = await client.resolve(cursor, { csrf, signal });
  const workspace = await client.load({
    storeReference: cursor.scope.storeReference,
    expectedScope: cursor.scope,
    signal,
  });
  if (signal.aborted) throw new StoreSetupClientError("OutcomeUnknown");
  await journal.complete(cursor, receipt, workspace);
  return { receipt, workspace };
}
const messages: Record<StoreSetupClientError["code"], string> = {
  Invalid:
    "Check the edited settings. Each service interval needs valid times and at least one service mode. Wait times must be whole seconds from 0 to 86400. Enabled fee contexts require an active registered classification and at least one order type.",
  Denied: "Your current permission or selected Store does not allow this action.",
  Conflict:
    "The saved settings or their baseline changed. Refresh, then discard your local edits to use the latest saved version.",
  Unavailable: "The current Store settings could not be loaded. Connect and refresh to try again.",
  OutcomeUnknown:
    "The save result could not be confirmed. Recover the original save before making another change.",
  ScopeChanged:
    "The selected Store or signed-in session changed. Open setup for the current Store.",
  Stale: "The current settings check expired. Refresh to read the current Store again.",
};
const root = (view: StoreSetupWorkspace) => ({
  reference: view.setup.snapshot?.setupDraftReference ?? null,
  revision: view.setup.snapshot?.revision ?? 0,
});
const sameRoot = (a: StoreSetupWorkspace, b: StoreSetupWorkspace) =>
  JSON.stringify(root(a)) === JSON.stringify(root(b));
function SavedReference({ value }: { value: StoreSetupContent["addressReference"] }) {
  return <p>{value.state === "Configured" ? "Already configured." : "Not configured."}</p>;
}
export function StoreSetupDraftPage({
  storeReference,
  csrf,
  client: injected,
  journalFactory = createStoreSetupPendingJournal,
}: {
  readonly storeReference: string;
  readonly csrf: string;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StoreSetupPendingJournal;
}) {
  const { id } = useParams(),
    client = useMemo(() => injected ?? createStoreSetupClient(), [injected]),
    feeClient = useMemo(() => createStoreSetupClient(), []);
  const [workspace, setWorkspace] = useState<StoreSetupWorkspace | null>(null),
    [baseline, setBaseline] = useState<StoreSetupWorkspace | null>(null),
    [content, setContent] = useState<StoreSetupContent>(createUnconfiguredStoreSetupContentV2),
    [inputs, setInputs] = useState<StoreSetupEditorInputs>(() =>
      editInputs(createUnconfiguredStoreSetupContent()),
    ),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState<StoreSetupCursor | null>(null),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState(""),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine),
    [ready, setReady] = useState(false);
  const running = useRef(false),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    journal = useRef<StoreSetupPendingJournal | null>(null),
    savedScope = useRef<StoreSetupScope | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null);
  const current = (value: number, signal: AbortSignal) =>
    value === epoch.current && !signal.aborted;
  const apply = (view: StoreSetupWorkspace) => {
    const next = normalizeStoreSetupContentV2(
      view.setup.snapshot?.content ?? createUnconfiguredStoreSetupContent(),
    );
    setWorkspace(view);
    setBaseline(view);
    setContent(next);
    setInputs(editInputs(next));
    setDirty(false);
  };
  useEffect(() => {
    const request = new AbortController(),
      token = ++epoch.current;
    controller.current = request;
    running.current = true;
    setBusy(true);
    setReady(false);
    setError(null);
    setWorkspace(null);
    setPending(null);
    savedScope.current = null;
    journal.current = null;
    const offline = () => {
      setOnline(false);
      controller.current?.abort();
      setError("Unavailable");
      setBusy(false);
      running.current = false;
    };
    const reconnect = () => setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", reconnect);
    if (id !== storeReference) {
      setError("ScopeChanged");
      setBusy(false);
      running.current = false;
    } else if (!navigator.onLine) {
      setBusy(false);
      running.current = false;
      setError("Unavailable");
    } else
      void client
        .load({ storeReference, signal: request.signal })
        .then(async (view) => {
          if (!current(token, request.signal)) return;
          const original = journalFactory(view.scope);
          const cursor = await original.load();
          if (!current(token, request.signal)) return;
          savedScope.current = view.scope;
          journal.current = original;
          apply(view);
          setPending(cursor);
          setReady(true);
          if (cursor)
            setNotice(
              "An earlier save needs recovery. Your new changes stay locked until its result is known.",
            );
        })
        .catch((value: unknown) => {
          if (current(token, request.signal))
            setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
        })
        .finally(() => {
          if (token === epoch.current) {
            setBusy(false);
            running.current = false;
          }
        });
    return () => {
      epoch.current++;
      request.abort();
      controller.current?.abort();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", reconnect);
    };
  }, [client, csrf, id, journalFactory, storeReference]);
  const begin = () => {
    running.current = true;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const token = ++epoch.current;
    setBusy(true);
    setError(null);
    setNotice("");
    return { request, token };
  };
  const refresh = async (discard = false) => {
    if (running.current || busy || !online || id !== storeReference) return;
    const { request, token } = begin();
    try {
      const view = await client.load({
        storeReference,
        ...(savedScope.current ? { expectedScope: savedScope.current } : {}),
        signal: request.signal,
      });
      if (!current(token, request.signal)) return;
      const original = journal.current ?? journalFactory(view.scope),
        cursor = await original.load();
      if (!current(token, request.signal)) return;
      if (pending && !cursor) throw new StoreSetupClientError("Unavailable");
      journal.current = original;
      savedScope.current = view.scope;
      setPending(cursor);
      if (discard || !dirty) apply(view);
      else {
        setWorkspace(view);
        if (baseline && !sameRoot(baseline, view)) setError("Conflict");
      }
      setReady(true);
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const save = async () => {
    if (
      running.current ||
      !ready ||
      !workspace ||
      !baseline ||
      busy ||
      pending ||
      !online ||
      id !== storeReference ||
      !journal.current
    )
      return;
    const activeJournal = journal.current;
    let candidate: StoreSetupContent;
    try {
      candidate = buildStoreSetupEditedContent(content, inputs);
    } catch {
      setError("Invalid");
      setStep(7);
      heading.current?.focus();
      return;
    }
    const { request, token } = begin();
    try {
      if (
        candidate.feeContexts?.state === "Configured" &&
        candidate.feeContexts.value.some((v) => v.state === "Enabled")
      ) {
        const choices = await feeClient.classifications({
          storeReference,
          expectedScope: workspace.scope,
          signal: request.signal,
        });
        validateStoreSetupFeeSelections(candidate, choices);
        if (!current(token, request.signal)) return;
      }
      const result = await dispatchStoreSetupDraft({
        client,
        journal: activeJournal,
        baseline,
        content: candidate,
        csrf,
        signal: request.signal,
        onReserved: (cursor) => {
          if (token === epoch.current) setPending(cursor);
        },
      });
      if (!current(token, request.signal)) return;
      const { receipt, workspace: after } = result;
      setPending(null);
      apply(after);
      setNotice(
        receipt.outcome === "Committed"
          ? "Setup draft saved. These settings have not been validated or published."
          : "The original save was not committed. You can continue editing.",
      );
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const recover = async () => {
    if (running.current || busy || !online || !pending || !journal.current) return;
    const activeJournal = journal.current,
      original = pending,
      { request, token } = begin();
    try {
      const { receipt, workspace: fresh } = await recoverStoreSetupDraft({
        client,
        journal: activeJournal,
        cursor: original,
        csrf,
        signal: request.signal,
      });
      if (!current(token, request.signal)) return;
      setPending(null);
      apply(fresh);
      setNotice(
        receipt.outcome === "Committed"
          ? "The original save was committed. Current saved settings are shown."
          : "The original save was not committed. You can continue with a new save.",
      );
    } catch (value) {
      if (current(token, request.signal))
        setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (token === epoch.current) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const changeInputs = (change: Partial<StoreSetupEditorInputs>) => {
    setInputs((old) => ({ ...old, ...change }));
    setDirty(true);
    setError(null);
  };
  const changeContent = (change: Partial<StoreSetupContent>) => {
    setContent((old) => ({ ...old, ...change }));
    setDirty(true);
    setError(null);
  };
  const disabled = busy || !!pending || !online || !ready;
  const intervalChange = (day: number, index: number, change: Partial<StoreSetupHourInput>) => {
    const hours = inputs.hours;
    if (!hours) return;
    changeInputs({
      hours: hours.map((values, i) =>
        i !== day
          ? values
          : values.map((value, j) => (j !== index ? value : { ...value, ...change })),
      ),
    });
  };
  let parsed: StoreSetupContent | null = null;
  try {
    parsed = buildStoreSetupEditedContent(content, inputs);
  } catch {
    /* Review shows a safe validation state; local raw input remains. */
  }
  return (
    <AppFrame
      className="store-setup-draft-page"
      title="Store setup"
      description="Save unfinished settings and continue later"
    >
      <header className="screen-heading">
        <div>
          <h2>Store setup</h2>
          {workspace && (
            <p>
              {workspace.store.displayName} · {workspace.store.code}
            </p>
          )}
          <p>Saving a draft does not change the live Store.</p>
        </div>
        <button
          type="button"
          disabled={busy || !online || id !== storeReference}
          onClick={() => void refresh()}
        >
          Refresh saved setup
        </button>
      </header>
      {id !== storeReference && (
        <StatePanel heading="Select this Store" tone="error" status>
          <p>Choose this Store in the workspace before opening its setup.</p>
        </StatePanel>
      )}
      {!online && (
        <p role="status">
          Offline. Your local edits are retained. Reconnect and refresh before saving.
        </p>
      )}
      {error && (
        <p id="setup-validation-error" role="alert">
          {messages[error]}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Checking current Store settings…</p>}
      {pending && (
        <section className="store-setup-recovery" aria-label="Original save recovery">
          <p>An earlier save has not been cleared. A new save is blocked.</p>
          <button type="button" disabled={busy || !online} onClick={() => void recover()}>
            Recover original save
          </button>
        </section>
      )}
      {workspace && (
        <>
          <nav className="store-setup-steps" aria-label="Setup steps">
            <ol>
              {steps.map((name, i) => (
                <li key={name}>
                  <button
                    type="button"
                    aria-current={step === i ? "step" : undefined}
                    onClick={() => {
                      setStep(i);
                      heading.current?.focus();
                    }}
                  >
                    {i + 1}. {name}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section className="store-setup-step-content" aria-labelledby="setup-step-heading">
            <h3 id="setup-step-heading" ref={heading} tabIndex={-1}>
              {steps[step]}
            </h3>
            {step === 0 && (
              <dl>
                <dt>Store</dt>
                <dd>{workspace.store.displayName}</dd>
                <dt>Store code</dt>
                <dd>{workspace.store.code}</dd>
                <dt>Current locale</dt>
                <dd>{workspace.store.locale}</dd>
                <dt>Currency</dt>
                <dd>{workspace.store.currencyCode}</dd>
                <dt>Current timezone</dt>
                <dd>{workspace.store.timeZone}</dd>
                <dt>Saved draft</dt>
                <dd>
                  {workspace.setup.snapshot
                    ? `Revision ${workspace.setup.snapshot.revision}`
                    : "No draft saved yet"}
                </dd>
              </dl>
            )}
            {step === 1 && (
              <>
                <h4>Address</h4>
                <SavedReference value={content.addressReference} />
                <p>Save an address below, then choose it for this draft.</p>
                <label>
                  Draft timezone
                  <select
                    disabled={disabled}
                    value={inputs.timeZone}
                    onChange={(e) => changeInputs({ timeZone: e.currentTarget.value })}
                  >
                    <option value="">Not configured</option>
                    {[
                      ...new Set([
                        ...(inputs.timeZone ? [inputs.timeZone] : []),
                        "UTC",
                        ...Intl.supportedValuesOf("timeZone"),
                      ]),
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Business day starts at (local time)
                  <input
                    type="time"
                    step="1"
                    disabled={disabled}
                    value={inputs.businessStart}
                    onChange={(e) => changeInputs({ businessStart: e.currentTarget.value })}
                  />
                </label>
                <p>Choose draft values explicitly. Current Store values are shown in Identity.</p>
              </>
            )}
            {step === 2 && (
              <>
                <label>
                  Configuration source
                  <select
                    disabled={disabled}
                    value={content.source.state === "Configured" ? content.source.value : ""}
                    onChange={(e) =>
                      changeContent({
                        source:
                          e.currentTarget.value === ""
                            ? { state: "Unconfigured" }
                            : { state: "Configured", value: "StoreOverride" },
                      })
                    }
                  >
                    <option value="">Not configured</option>
                    <option value="StoreOverride">Settings for this Store</option>
                    {content.source.state === "Configured" &&
                      content.source.value === "BrandInherited" && (
                        <option value="BrandInherited" disabled>
                          Saved Brand settings retained
                        </option>
                      )}
                  </select>
                </label>
                <fieldset disabled={disabled}>
                  <legend>Service modes</legend>
                  {modes.map((mode) => (
                    <label key={mode}>
                      <input
                        type="checkbox"
                        checked={inputs.serviceModes.includes(mode)}
                        onChange={(e) =>
                          changeInputs({
                            serviceModes: e.currentTarget.checked
                              ? [...inputs.serviceModes, mode]
                              : inputs.serviceModes.filter((v) => v !== mode),
                          })
                        }
                      />
                      {mode === "DineIn" ? "Dine in" : mode}
                    </label>
                  ))}
                </fieldset>
                <p>
                  {inputs.serviceModes.length === 0
                    ? "Service modes are not configured."
                    : "Selected modes are draft settings until validated and published."}
                </p>
              </>
            )}
            {step === 3 && (
              <>
                <p>
                  Weekly times use the draft timezone. Wait times are whole seconds from 0 to 86400.
                </p>
                {inputs.hours === null ? (
                  <>
                    <p>Weekly hours are not configured.</p>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => changeInputs({ hours: Array.from({ length: 7 }, () => []) })}
                    >
                      Configure weekly hours
                    </button>
                  </>
                ) : (
                  <>
                    {inputs.hours.map((intervals, day) => (
                      <fieldset key={day} disabled={disabled}>
                        <legend>{days[day]}</legend>
                        {intervals.length === 0 && <p>No service intervals on this day.</p>}
                        {intervals.map((value, index) => (
                          <div className="store-setup-interval" key={index}>
                            <h4>Interval {index + 1}</h4>
                            <label>
                              {days[day]} interval {index + 1} start
                              <input
                                type="time"
                                step="1"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid" ? "setup-validation-error" : undefined
                                }
                                value={value.start}
                                onChange={(e) =>
                                  intervalChange(day, index, { start: e.currentTarget.value })
                                }
                              />
                            </label>
                            <label>
                              {days[day]} interval {index + 1} end
                              <input
                                type="time"
                                step="1"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid" ? "setup-validation-error" : undefined
                                }
                                value={value.end}
                                onChange={(e) =>
                                  intervalChange(day, index, { end: e.currentTarget.value })
                                }
                              />
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={value.followingDay}
                                onChange={(e) =>
                                  intervalChange(day, index, {
                                    followingDay: e.currentTarget.checked,
                                  })
                                }
                              />
                              Ends on the following day
                            </label>
                            <fieldset>
                              <legend>
                                {days[day]} interval {index + 1} service modes
                              </legend>
                              {modes.map((mode) => (
                                <label key={mode}>
                                  <input
                                    type="checkbox"
                                    checked={value.modes.includes(mode)}
                                    onChange={(e) =>
                                      intervalChange(day, index, {
                                        modes: e.currentTarget.checked
                                          ? [...value.modes, mode]
                                          : value.modes.filter((v) => v !== mode),
                                      })
                                    }
                                  />
                                  {mode === "DineIn" ? "Dine in" : mode}
                                </label>
                              ))}
                            </fieldset>
                            <label>
                              Order cutoff seconds
                              <input
                                inputMode="numeric"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid"
                                    ? "setup-wait-help setup-validation-error"
                                    : "setup-wait-help"
                                }
                                value={value.cutoff}
                                onChange={(e) =>
                                  intervalChange(day, index, { cutoff: e.currentTarget.value })
                                }
                              />
                            </label>
                            <label>
                              Lead time seconds
                              <input
                                inputMode="numeric"
                                aria-invalid={error === "Invalid"}
                                aria-describedby={
                                  error === "Invalid"
                                    ? "setup-wait-help setup-validation-error"
                                    : "setup-wait-help"
                                }
                                value={value.lead}
                                onChange={(e) =>
                                  intervalChange(day, index, { lead: e.currentTarget.value })
                                }
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                changeInputs({
                                  hours:
                                    inputs.hours?.map((values, i) =>
                                      i !== day ? values : values.filter((_, j) => j !== index),
                                    ) ?? null,
                                })
                              }
                            >
                              Remove {days[day]} interval {index + 1}
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          disabled={intervals.length >= 16}
                          onClick={() =>
                            changeInputs({
                              hours:
                                inputs.hours?.map((values, i) =>
                                  i !== day
                                    ? values
                                    : [
                                        ...values,
                                        {
                                          start: "",
                                          end: "",
                                          followingDay: false,
                                          modes: [],
                                          cutoff: "",
                                          lead: "",
                                        },
                                      ],
                                ) ?? null,
                            })
                          }
                        >
                          Add {days[day]} interval
                        </button>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => changeInputs({ hours: null })}
                    >
                      Leave weekly hours unconfigured
                    </button>
                  </>
                )}
                <p id="setup-wait-help">
                  Enter a whole number from 0 to 86400 for each wait time. Daily intervals must not
                  overlap.
                </p>
                {content.exceptions.state === "Configured" ? (
                  <>
                    <h4>Saved special-date hours</h4>
                    {content.exceptions.value.length === 0 ? (
                      <p>No special dates selected.</p>
                    ) : (
                      <ul>
                        {content.exceptions.value.map((value) => (
                          <li key={value.localDate}>
                            {value.localDate} · {value.kind} · {value.intervals.length} service
                            intervals
                          </li>
                        ))}
                      </ul>
                    )}
                    <p>
                      Saved special dates are retained. Editing these dates is not available here
                      yet.
                    </p>
                  </>
                ) : (
                  <p>
                    Holiday and special-date hours are not configured. Editing these dates is not
                    available here yet.
                  </p>
                )}
              </>
            )}
            {step === 4 && (
              <>
                <StoreSetupFeeContextEditor
                  key={`fees:${JSON.stringify(workspace.scope)}:${csrf}`}
                  scope={workspace.scope}
                  csrf={csrf}
                  value={content.feeContexts ?? { state: "Unconfigured" }}
                  disabled={disabled}
                  onChange={(feeContexts) => changeContent({ feeContexts })}
                />
                <h4>Tax configuration</h4>
                <SavedReference value={content.taxConfigurationReference} />
                <h4>Payment configuration</h4>
                <SavedReference value={content.paymentConfigurationReference} />
                <h4>Receipt configuration</h4>
                <SavedReference value={content.receiptReference} />
                <p>Tax selection is not available here yet.</p>
              </>
            )}
            {step === 5 && (
              <>
                <label>
                  Capacity configuration
                  <select
                    disabled={
                      disabled ||
                      (content.capacityConfigurationReference.state === "Configured" &&
                        content.capacityConfigurationReference.value !== null)
                    }
                    value={
                      content.capacityConfigurationReference.state === "Unconfigured"
                        ? "unconfigured"
                        : content.capacityConfigurationReference.value === null
                          ? "none"
                          : "saved"
                    }
                    onChange={(e) =>
                      changeContent({
                        capacityConfigurationReference:
                          e.currentTarget.value === "none"
                            ? { state: "Configured", value: null }
                            : { state: "Unconfigured" },
                      })
                    }
                  >
                    <option value="unconfigured">Not configured</option>
                    <option value="none">No capacity configuration</option>
                    {content.capacityConfigurationReference.state === "Configured" &&
                      content.capacityConfigurationReference.value !== null && (
                        <option value="saved">Already configured</option>
                      )}
                  </select>
                </label>
                <p>
                  Choose whether capacity still needs configuration. Capacity settings cannot be
                  selected here yet.
                </p>
              </>
            )}
            {step === 6 && (
              <>
                <h4>Contact configuration</h4>
                <SavedReference value={content.contactReference} />
                <p>Save contact details below, then choose them for this draft.</p>
              </>
            )}
            <ReceiptTemplateStoreSelection
              key={`receipt-selection:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              locale={workspace.store.locale}
              csrf={csrf}
              value={content.receiptReference}
              hidden={step !== 4}
              disabled={busy || !ready || !online || !!pending}
              onSelect={(templateReference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    receiptReference:
                      templateReference === null
                        ? { state: "Unconfigured" }
                        : { state: "Configured", value: templateReference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            <ReceiptTemplateArtifactEditor
              key={`receipt-artifacts:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              hidden={step !== 4}
              disabled={busy || !online || !!pending}
            />
            <ReceiptTemplateDraftEditor
              key={`receipt-templates:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              defaultLocale={workspace.store.locale}
              hidden={step !== 4}
              disabled={busy || !online || !!pending}
            />
            <StorePaymentConfigurationEditor
              key={`payment:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              hidden={step !== 4}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    paymentConfigurationReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            <StoreSetupReferenceEditor
              key={`address:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              kind="Address"
              hidden={step !== 1}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    addressReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            <StoreSetupReferenceEditor
              key={`contact:${JSON.stringify(workspace.scope)}:${csrf}`}
              scope={workspace.scope}
              csrf={csrf}
              kind="Contact"
              hidden={step !== 6}
              disabled={busy || !online || !!pending}
              onSelect={(reference) => {
                setContent((v) =>
                  parseStoreSetupContent({
                    ...v,
                    contactReference: { state: "Configured", value: reference },
                  }),
                );
                setDirty(true);
                setError(null);
              }}
            />
            {step === 7 && (
              <>
                <StoreSetupDraftReview content={parsed} />
                <StoreConfigurationOrdinaryPanel
                  key={JSON.stringify(workspace.scope)}
                  scope={workspace.scope}
                  csrf={csrf}
                  saved={workspace.setup.snapshot}
                  freshDisabled={disabled || dirty}
                />
              </>
            )}
          </section>
          <footer className="store-setup-actions">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => {
                setStep((v) => v - 1);
                heading.current?.focus();
              }}
            >
              Previous step
            </button>
            <button
              type="button"
              disabled={step === 7}
              onClick={() => {
                setStep((v) => v + 1);
                heading.current?.focus();
              }}
            >
              Next step
            </button>
            <button
              className="store-setup-save"
              type="button"
              disabled={disabled}
              onClick={() => void save()}
            >
              Save setup draft
            </button>
            <button type="button" disabled={disabled || !dirty} onClick={() => void refresh(true)}>
              Discard local edits
            </button>
          </footer>
        </>
      )}
    </AppFrame>
  );
}
function storeReview(content: StoreSetupContent): readonly (readonly [string, string])[] {
  return [
    [
      "Timezone",
      content.timeZone.state === "Configured" ? content.timeZone.value : "Not configured",
    ],
    [
      "Business day start",
      content.businessDayStartLocalTime.state === "Configured"
        ? content.businessDayStartLocalTime.value
        : "Not configured",
    ],
    [
      "Service modes",
      content.enabledServiceModes.state === "Configured"
        ? content.enabledServiceModes.value.join(", ")
        : "Not configured",
    ],
    [
      "Weekly hours",
      content.weeklySchedule.state === "Configured" ? "Configured draft hours" : "Not configured",
    ],
    [
      "Address",
      content.addressReference.state === "Configured" ? "Already configured" : "Not configured",
    ],
    [
      "Fee contexts",
      content.feeContexts?.state === "Configured"
        ? content.feeContexts.value.map((v) => `${v.chargeType}: ${v.state}`).join(", ")
        : "Not configured",
    ],
    [
      "Tax and payment",
      content.taxConfigurationReference.state === "Configured" &&
      content.paymentConfigurationReference.state === "Configured"
        ? "Already configured"
        : "Not configured",
    ],
    [
      "Capacity",
      content.capacityConfigurationReference.state === "Unconfigured"
        ? "Not configured"
        : content.capacityConfigurationReference.value === null
          ? "No capacity configuration"
          : "Already configured",
    ],
    [
      "Contacts",
      content.contactReference.state === "Configured" ? "Already configured" : "Not configured",
    ],
  ];
}

export function StoreSetupDraftReview({ content }: { readonly content: StoreSetupContent | null }) {
  const missing = content
    ? Object.values(content).filter((value) => value.state === "Unconfigured").length +
      (content.feeContexts?.state === "Configured"
        ? content.feeContexts.value.filter((v) => v.state === "Unconfigured").length
        : 0)
    : null;
  return (
    <>
      <p>
        {missing === null
          ? "Some edited times or wait values need correction before saving."
          : `${missing} settings are not configured. An unfinished draft can be saved.`}
      </p>
      {content && (
        <ul>
          {storeReview(content).map(([label, value]) => (
            <li key={label}>
              {label}: {value}
            </li>
          ))}
        </ul>
      )}
      <p>These settings still need validation. This draft is not approved, published, or live.</p>
    </>
  );
}

/** Independent reference originals survive wizard-step changes; selecting a saved
 * version only updates the local setup draft, whose own save remains explicit. */
export function StoreSetupReferenceEditor({
  scope,
  csrf,
  kind,
  hidden = false,
  disabled = false,
  onSelect,
  client: injected,
  journalFactory = createStoreSetupReferencePendingJournal,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly kind: StoreSetupReferenceKind;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (reference: string) => void;
  readonly client?: ReturnType<typeof createStoreSetupReferenceClient>;
  readonly journalFactory?: (
    scope: StoreSetupScope,
    kind: StoreSetupReferenceKind,
  ) => StoreSetupReferencePendingJournal;
}) {
  const client = useMemo(() => injected ?? createStoreSetupReferenceClient(), [injected]);
  const [view, setView] = useState<StoreSetupReferencesCurrent | null>(null),
    [pending, setPending] = useState<StoreSetupReferenceCursor | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState("");
  const [fields, setFields] = useState({
    countryCode: "",
    regionCode: "",
    locality: "",
    postalCode: "",
    line1: "",
    line2: "",
    line3: "",
    contactName: "",
    businessPhone: "",
    website: "",
  });
  const dirty = useRef(false),
    epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<StoreSetupReferencePendingJournal | null>(null);
  const selected = view ? (kind === "Address" ? view.address : view.contact) : null;
  const apply = (v: StoreSetupReferencesCurrent) => {
    setView(v);
    const s = kind === "Address" ? v.address : v.contact;
    if (s && !dirty.current) {
      const c = s.content;
      if ("addressLines" in c)
        setFields({
          countryCode: c.countryCode,
          regionCode: c.regionCode,
          locality: c.locality,
          postalCode: c.postalCode,
          line1: c.addressLines[0] ?? "",
          line2: c.addressLines[1] ?? "",
          line3: c.addressLines[2] ?? "",
          contactName: "",
          businessPhone: "",
          website: "",
        });
      else
        setFields({
          countryCode: "",
          regionCode: "",
          locality: "",
          postalCode: "",
          line1: "",
          line2: "",
          line3: "",
          contactName: c.contactName,
          businessPhone: c.businessPhone,
          website: c.website ?? "",
        });
    }
  };
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current = c;
    setReady(false);
    setView(null);
    setPending(null);
    setError(null);
    running.current = false;
    setBusy(true);
    journal.current = null;
    void client
      .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
      .then(async (v) => {
        const j = journalFactory(scope, kind),
          p = await j.load();
        if (e !== epoch.current || c.signal.aborted) return;
        journal.current = j;
        apply(v);
        setPending(p);
        setReady(true);
      })
      .catch((value) => {
        if (e === epoch.current && !c.signal.aborted)
          setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
      })
      .finally(() => {
        if (e === epoch.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      c.abort();
      active.current = null;
    };
  }, [client, scopeKey, csrf, kind, journalFactory]);
  useEffect(() => {
    if (disabled) {
      active.current?.abort();
      running.current = false;
      setBusy(false);
    }
  }, [disabled]);
  const action = async (mode: "Refresh" | "Save" | "Resolve") => {
    if (running.current || disabled || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () => e === epoch.current && !c.signal.aborted;
    try {
      let j = journal.current;
      if (!j) {
        j = journalFactory(scope, kind);
        journal.current = j;
      }
      const stored = await j.load();
      if (!valid()) return;
      setPending(stored);
      if (mode === "Refresh") {
        const v = await client.load({
          storeReference: scope.storeReference,
          expectedScope: scope,
          signal: c.signal,
        });
        if (valid()) {
          apply(v);
          setReady(true);
        }
        return;
      }
      if (mode === "Resolve") {
        if (!stored) throw new StoreSetupClientError("Conflict");
        const { receipt, current: v } = await recoverStoreSetupReference({
          client,
          journal: j,
          cursor: stored,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        });
        if (valid()) {
          setPending(null);
          apply(v);
          setReady(true);
          setNotice(
            receipt.outcome === "Committed"
              ? "Earlier save confirmed. Choose this saved configuration to use it in the setup draft."
              : "Earlier save did not commit. You can save again.",
          );
        }
        return;
      }
      if (stored) throw new StoreSetupClientError("Conflict");
      if (!view || !ready) throw new StoreSetupClientError("Unavailable");
      const value =
        kind === "Address"
          ? {
              countryCode: fields.countryCode,
              regionCode: fields.regionCode,
              locality: fields.locality,
              postalCode: fields.postalCode,
              addressLines: [
                fields.line1,
                ...(fields.line2 ? [fields.line2] : []),
                ...(fields.line3 ? [fields.line3] : []),
              ],
            }
          : {
              contactName: fields.contactName,
              businessPhone: fields.businessPhone,
              website: fields.website === "" ? null : fields.website,
            };
      const content = parseStoreSetupReferenceContent(kind, value);
      if (!valid()) return;
      const { current: v } = await dispatchStoreSetupReference({
        client,
        journal: j,
        scope,
        kind,
        baseline: view,
        content,
        csrf,
        signal: c.signal,
        isCurrent: valid,
        onReserved: (cursor) => {
          if (valid()) setPending(cursor);
        },
      });
      if (valid()) {
        setPending(null);
        dirty.current = false;
        apply(v);
        setNotice(
          "Configuration saved. Choose it below, then save the setup draft to keep that selection.",
        );
      }
    } catch (value) {
      if (valid()) setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (valid()) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const field = (key: keyof typeof fields, label: string, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        value={fields[key]}
        disabled={disabled || busy || !!pending}
        onChange={(e) => {
          const value = e.currentTarget.value;
          dirty.current = true;
          setFields((v) => ({ ...v, [key]: value }));
          setError(null);
        }}
      />
    </label>
  );
  return (
    <section hidden={hidden} aria-label={`${kind} configuration`}>
      <h4>{kind === "Address" ? "Store address" : "Store contact"}</h4>
      {error && (
        <p role="alert">
          {error === "Invalid"
            ? "Check the entered details. Phone numbers need a country code; websites must use HTTPS."
            : error === "Conflict"
              ? "This configuration changed. Refresh and review before saving."
              : error === "Denied"
                ? "You cannot access this configuration in the current Store."
                : error === "OutcomeUnknown"
                  ? "The save could not be confirmed. Recover the original save before making another change."
                  : "Configuration unavailable. Refresh when connected; an earlier save remains protected."}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <>
          <p role="status">
            An earlier {kind.toLowerCase()} save must be recovered before another save.
          </p>
          <button type="button" disabled={disabled || busy} onClick={() => void action("Resolve")}>
            Recover original {kind.toLowerCase()} save
          </button>
        </>
      )}
      {kind === "Address" ? (
        <>
          {field("countryCode", "Country code")}
          {field("regionCode", "Province or region code")}
          {field("locality", "City")}
          {field("postalCode", "Postal code")}
          {field("line1", "Address line 1")}
          {field("line2", "Address line 2 (optional)")}
          {field("line3", "Address line 3 (optional)")}
        </>
      ) : (
        <>
          {field("contactName", "Contact name")}
          {field("businessPhone", "Business phone with country code", "tel")}
          {field("website", "Website (optional)", "url")}
        </>
      )}
      <button type="button" disabled={disabled || busy} onClick={() => void action("Refresh")}>
        Refresh saved {kind.toLowerCase()}
      </button>
      <button
        type="button"
        disabled={disabled || busy || !ready || !!pending}
        onClick={() => void action("Save")}
      >
        Save {kind.toLowerCase()} configuration
      </button>
      {selected && (
        <>
          <p>Saved revision {selected.revision}. Business validation has not been completed.</p>
          <button
            type="button"
            disabled={disabled || busy || !!pending}
            onClick={() => {
              if (!view || Date.now() >= Date.parse(view.validUntil)) {
                setError("Stale");
                return;
              }
              onSelect(selected.reference);
              setNotice("Selection changed locally. Save the setup draft to keep it.");
            }}
          >
            Use saved {kind.toLowerCase()}
          </button>
        </>
      )}
    </section>
  );
}

export async function dispatchStoreSetupReference(input: {
  client: ReturnType<typeof createStoreSetupReferenceClient>;
  journal: StoreSetupReferencePendingJournal;
  scope: StoreSetupScope;
  kind: StoreSetupReferenceKind;
  baseline: StoreSetupReferencesCurrent;
  content: unknown;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  onReserved: (cursor: StoreSetupReferenceCursor) => void;
}) {
  const check = () => {
    if (input.signal.aborted || input.isCurrent?.() === false)
      throw new StoreSetupClientError("ScopeChanged");
  };
  const content = parseStoreSetupReferenceContent(input.kind, input.content),
    fresh = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  const key = input.kind === "Address" ? "address" : "contact",
    head = fresh[key],
    old = input.baseline[key];
  if (head?.reference !== old?.reference || head?.revision !== old?.revision)
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    kind: input.kind,
    operationReference: serviceOperationReference(),
    expectedReference: head?.reference ?? null,
    expectedRevision: head?.revision ?? 0,
    content,
  });
  check();
  await input.journal.reserve(prepared.cursor);
  check();
  input.onReserved(prepared.cursor);
  const receipt = await input.client.execute(prepared, { csrf: input.csrf, signal: input.signal }),
    current = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  await input.journal.complete(prepared.cursor, receipt, current);
  check();
  return { receipt, current };
}
export async function recoverStoreSetupReference(input: {
  client: ReturnType<typeof createStoreSetupReferenceClient>;
  journal: StoreSetupReferencePendingJournal;
  cursor: StoreSetupReferenceCursor;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const receipt = await input.client.resolve(input.cursor, {
      csrf: input.csrf,
      signal: input.signal,
    }),
    current = await input.client.load({
      storeReference: input.cursor.scope.storeReference,
      expectedScope: input.cursor.scope,
      signal: input.signal,
    });
  if (input.signal.aborted || input.isCurrent?.() === false)
    throw new StoreSetupClientError("ScopeChanged");
  await input.journal.complete(input.cursor, receipt, current);
  return { receipt, current };
}

/** Saves immutable channel rules, not Provider readiness. Explicit selection is a
 * separate local setup edit and never follows a newer Manager's save silently. */
export function StorePaymentConfigurationEditor({
  scope,
  csrf,
  hidden = false,
  disabled = false,
  onSelect,
  client: injected,
  journalFactory = createStorePaymentConfigurationPendingJournal,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (reference: string) => void;
  readonly client?: ReturnType<typeof createStorePaymentConfigurationClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StorePaymentConfigurationPendingJournal;
}) {
  const client = useMemo(() => injected ?? createStorePaymentConfigurationClient(), [injected]);
  const [view, setView] = useState<StorePaymentConfigurationCurrent | null>(null),
    [pending, setPending] = useState<StorePaymentConfigurationCursor | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState("");
  const [fields, setFields] = useState<StorePaymentConfigurationContent>({
    customerOnlineCardEnabled: false,
    staffTerminalCardPresentEnabled: false,
    staffTerminalInteracEnabled: false,
  });
  const dirty = useRef(false),
    epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<StorePaymentConfigurationPendingJournal | null>(null);
  const apply = (v: StorePaymentConfigurationCurrent) => {
    setView(v);
    if (v.snapshot && !dirty.current) setFields(v.snapshot.content);
  };
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current = c;
    setReady(false);
    setView(null);
    setPending(null);
    setError(null);
    setBusy(true);
    running.current = false;
    journal.current = null;
    dirty.current = false;
    setFields({
      customerOnlineCardEnabled: false,
      staffTerminalCardPresentEnabled: false,
      staffTerminalInteracEnabled: false,
    });
    void client
      .load({ storeReference: scope.storeReference, expectedScope: scope, signal: c.signal })
      .then(async (v) => {
        const j = journalFactory(scope),
          p = await j.load();
        if (e !== epoch.current || c.signal.aborted) return;
        journal.current = j;
        apply(v);
        setPending(p);
        setReady(true);
      })
      .catch((value) => {
        if (e === epoch.current && !c.signal.aborted)
          setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
      })
      .finally(() => {
        if (e === epoch.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      c.abort();
      active.current = null;
    };
  }, [client, scopeKey, csrf, journalFactory]);
  // Parent draft saves may temporarily disable this child. Keep its initial
  // read alive; cancel only an active command, whose durable original survives.
  useEffect(() => {
    if (disabled && running.current) {
      active.current?.abort();
      running.current = false;
      setBusy(false);
    }
  }, [disabled]);
  const action = async (mode: "Save" | "Refresh" | "Resolve") => {
    if (running.current || disabled || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () => e === epoch.current && !c.signal.aborted;
    try {
      const j = journal.current ?? journalFactory(scope);
      journal.current = j;
      const stored = await j.load();
      if (!valid()) return;
      setPending(stored);
      if (mode === "Refresh") {
        const v = await client.load({
          storeReference: scope.storeReference,
          expectedScope: scope,
          signal: c.signal,
        });
        if (valid()) {
          apply(v);
          setReady(true);
        }
        return;
      }
      if (mode === "Resolve") {
        if (!stored) throw new StoreSetupClientError("Conflict");
        const result = await recoverStorePaymentConfiguration({
          client,
          journal: j,
          cursor: stored,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        });
        if (valid()) {
          setPending(null);
          apply(result.current);
          setReady(true);
          setNotice(
            result.receipt.outcome === "Committed"
              ? "Earlier payment save confirmed. Choose the saved configuration to use it."
              : "Earlier payment save did not commit. You can save again.",
          );
        }
        return;
      }
      if (stored) throw new StoreSetupClientError("Conflict");
      if (!view || !ready) throw new StoreSetupClientError("Unavailable");
      const result = await dispatchStorePaymentConfiguration({
        client,
        journal: j,
        scope,
        baseline: view,
        content: fields,
        csrf,
        signal: c.signal,
        isCurrent: valid,
        onReserved: (cursor) => {
          if (valid()) setPending(cursor);
        },
      });
      if (valid()) {
        setPending(null);
        dirty.current = false;
        apply(result.current);
        setNotice(
          "Payment configuration saved. Choose it below, then save the setup draft to keep that selection.",
        );
      }
    } catch (value) {
      if (valid()) setError(value instanceof StoreSetupClientError ? value.code : "Unavailable");
    } finally {
      if (valid()) {
        setBusy(false);
        running.current = false;
      }
    }
  };
  const labels: readonly [keyof StorePaymentConfigurationContent, string][] = [
    ["customerOnlineCardEnabled", "Customer online card"],
    ["staffTerminalCardPresentEnabled", "Staff terminal card present"],
    ["staffTerminalInteracEnabled", "Staff terminal Interac"],
  ];
  return (
    <section hidden={hidden} aria-label="Payment configuration">
      <h4>Store payment rules</h4>
      <p>
        These saved rules do not establish Provider readiness. Approval, publication and live
        payment availability have not been evaluated.
      </p>
      {error && (
        <p role="alert">
          {error === "Denied"
            ? "You cannot access payment configuration in the current Store."
            : error === "Conflict"
              ? "Payment configuration changed. Refresh and review before saving."
              : error === "OutcomeUnknown"
                ? "The payment save could not be confirmed. Recover the original save before making another change."
                : error === "Invalid"
                  ? "Check the three payment channel settings."
                  : "Payment configuration unavailable. Refresh when connected; an earlier save remains protected."}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Loading payment configuration…</p>}
      {pending && (
        <>
          <p role="status">An earlier payment save must be recovered before another save.</p>
          <button type="button" disabled={disabled || busy} onClick={() => void action("Resolve")}>
            Recover original payment save
          </button>
        </>
      )}
      <fieldset disabled={disabled || busy || !ready || !!pending}>
        <legend>Allowed payment channels</legend>
        {labels.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={fields[key]}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                dirty.current = true;
                setFields((v) => ({ ...v, [key]: checked }));
                setError(null);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={disabled || busy} onClick={() => void action("Refresh")}>
        Refresh saved payment configuration
      </button>
      <button
        type="button"
        disabled={disabled || busy || !ready || !!pending}
        onClick={() => void action("Save")}
      >
        Save payment configuration
      </button>
      {view?.snapshot && (
        <>
          <p>
            Saved payment revision {view.snapshot.revision}. Provider readiness has not been
            evaluated.
          </p>
          <button
            type="button"
            disabled={disabled || busy || !!pending}
            onClick={() => {
              if (Date.now() >= Date.parse(view.validUntil)) {
                setError("Stale");
                return;
              }
              const selected = view.snapshot;
              if (!selected) return;
              onSelect(selected.configurationReference);
              setNotice("Selection changed locally. Save the setup draft to keep it.");
            }}
          >
            Use saved payment configuration
          </button>
        </>
      )}
    </section>
  );
}
export async function dispatchStorePaymentConfiguration(input: {
  client: ReturnType<typeof createStorePaymentConfigurationClient>;
  journal: StorePaymentConfigurationPendingJournal;
  scope: StoreSetupScope;
  baseline: StorePaymentConfigurationCurrent;
  content: unknown;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  onReserved: (cursor: StorePaymentConfigurationCursor) => void;
}) {
  const check = () => {
    if (input.signal.aborted || input.isCurrent?.() === false)
      throw new StoreSetupClientError("ScopeChanged");
  };
  const content = parseStorePaymentConfigurationContent(input.content),
    fresh = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  if (
    fresh.snapshot?.configurationReference !== input.baseline.snapshot?.configurationReference ||
    fresh.snapshot?.revision !== input.baseline.snapshot?.revision
  )
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    operationReference: serviceOperationReference(),
    expectedConfigurationReference: fresh.snapshot?.configurationReference ?? null,
    expectedRevision: fresh.snapshot?.revision ?? 0,
    content,
  });
  check();
  await input.journal.reserve(prepared.cursor);
  check();
  input.onReserved(prepared.cursor);
  const receipt = await input.client.execute(prepared, { csrf: input.csrf, signal: input.signal }),
    current = await input.client.load({
      storeReference: input.scope.storeReference,
      expectedScope: input.scope,
      signal: input.signal,
    });
  check();
  await input.journal.complete(prepared.cursor, receipt, current);
  check();
  return { receipt, current };
}
export async function recoverStorePaymentConfiguration(input: {
  client: ReturnType<typeof createStorePaymentConfigurationClient>;
  journal: StorePaymentConfigurationPendingJournal;
  cursor: StorePaymentConfigurationCursor;
  csrf: string;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const receipt = await input.client.resolve(input.cursor, {
      csrf: input.csrf,
      signal: input.signal,
    }),
    current = await input.client.load({
      storeReference: input.cursor.scope.storeReference,
      expectedScope: input.cursor.scope,
      signal: input.signal,
    });
  if (input.signal.aborted || input.isCurrent?.() === false)
    throw new StoreSetupClientError("ScopeChanged");
  await input.journal.complete(input.cursor, receipt, current);
  return { receipt, current };
}

/** Fresh owning choices validate only recorded classification selection, never legal qualification. */
export function validateStoreSetupFeeSelections(
  content: StoreSetupContent,
  choices: Awaited<ReturnType<ReturnType<typeof createStoreSetupClient>["classifications"]>>,
  now = Date.now(),
): void {
  if (Date.parse(choices.observedAt) > now || Date.parse(choices.validUntil) <= now)
    throw new StoreSetupClientError("Stale");
  if (content.feeContexts?.state !== "Configured") return;
  for (const entry of content.feeContexts.value) {
    if (
      entry.state === "Enabled" &&
      !choices.choices.some(
        (v) =>
          v.classificationReference === entry.taxClassificationReference &&
          v.lifecycle === "Active",
      )
    )
      throw new StoreSetupClientError("Invalid");
  }
}
export function StoreSetupFeeContextEditor({
  scope,
  csrf,
  value,
  disabled,
  onChange,
  client: injected,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly value: NonNullable<StoreSetupContent["feeContexts"]>;
  readonly disabled: boolean;
  readonly onChange: (value: NonNullable<StoreSetupContent["feeContexts"]>) => void;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
}) {
  const client = useMemo(() => injected ?? createStoreSetupClient(), [injected]);
  const [choices, setChoices] = useState<Awaited<ReturnType<typeof client.classifications>> | null>(
    null,
  );
  const [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current,
      controller = new AbortController();
    setChoices(null);
    setError(false);
    void client
      .classifications({
        storeReference: scope.storeReference,
        expectedScope: scope,
        signal: controller.signal,
      })
      .then((v) => {
        if (token === generation.current && !controller.signal.aborted) setChoices(v);
      })
      .catch(() => {
        if (token === generation.current && !controller.signal.aborted) setError(true);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [client, scope, csrf, reload]);
  const entries: readonly StoreSetupFeeContext[] =
    value.state === "Configured"
      ? value.value
      : storeSetupFeeCharges.map((chargeType) => ({ chargeType, state: "Unconfigured" as const }));
  const change = (index: number, entry: StoreSetupFeeContext) =>
    onChange({ state: "Configured", value: entries.map((v, i) => (i === index ? entry : v)) });
  const fresh =
    choices !== null &&
    Date.parse(choices.observedAt) <= Date.now() &&
    Date.parse(choices.validUntil) > Date.now();
  return (
    <section className="store-setup-fee-contexts" aria-label="Fee contexts">
      <h4>Fee contexts</h4>
      <p>Draft configuration only. These selections do not set fees, rates or effective policy.</p>
      {error && (
        <p role="status">
          Classification choices unavailable. Unconfigured or disabled settings can still be saved.
        </p>
      )}
      <button type="button" disabled={disabled} onClick={() => setReload((v) => v + 1)}>
        Refresh fee classification choices
      </button>
      {entries.map((entry, index) => (
        <fieldset disabled={disabled} key={entry.chargeType}>
          <legend>
            {entry.chargeType === "ServiceCharge"
              ? "Service charge"
              : entry.chargeType === "DeliveryFee"
                ? "Delivery fee"
                : "Tip"}
          </legend>
          <label>
            {entry.chargeType} configuration
            <select
              aria-label={`${entry.chargeType} configuration`}
              value={entry.state}
              onChange={(e) => {
                const state = e.currentTarget.value;
                if (state === "Unconfigured" || state === "Disabled")
                  change(index, { chargeType: entry.chargeType, state });
                else if (state === "Enabled")
                  change(
                    index,
                    entry.state === "Enabled"
                      ? entry
                      : {
                          chargeType: entry.chargeType,
                          state: "Enabled",
                          taxClassificationReference: "",
                          orderTypes: [],
                        },
                  );
              }}
            >
              <option value="Unconfigured">Unconfigured</option>
              <option value="Disabled">Disabled</option>
              <option value="Enabled">Enabled</option>
            </select>
          </label>
          <label>
            {entry.chargeType} tax classification
            <select
              aria-label={`${entry.chargeType} tax classification`}
              disabled={disabled || !fresh || entry.state !== "Enabled"}
              value={entry.state === "Enabled" ? entry.taxClassificationReference : ""}
              onChange={(e) => {
                const selected = choices?.choices.find(
                  (v) =>
                    v.classificationReference === e.currentTarget.value && v.lifecycle === "Active",
                );
                if (!fresh || !selected) return;
                change(index, {
                  chargeType: entry.chargeType,
                  state: "Enabled",
                  taxClassificationReference: selected.classificationReference,
                  orderTypes: entry.state === "Enabled" ? entry.orderTypes : [],
                });
              }}
            >
              <option value="">Select a registered classification to enable</option>
              {entry.state === "Enabled" &&
                entry.taxClassificationReference !== "" &&
                !choices?.choices.some(
                  (v) => v.classificationReference === entry.taxClassificationReference,
                ) && (
                  <option value={entry.taxClassificationReference}>
                    Saved classification retained
                  </option>
                )}
              {choices?.choices.map((choice) => (
                <option
                  key={choice.classificationReference}
                  value={choice.classificationReference}
                  disabled={choice.lifecycle !== "Active"}
                >
                  {choice.code} — {choice.localizedNames[choices.defaultLocale] ?? choice.code} (
                  {choice.lifecycle})
                </option>
              ))}
            </select>
          </label>
          {entry.state === "Enabled" && (
            <fieldset>
              <legend>{entry.chargeType} order types</legend>
              {modes.map((mode) => (
                <label key={mode}>
                  <input
                    type="checkbox"
                    checked={entry.orderTypes.includes(mode)}
                    onChange={(e) =>
                      change(index, {
                        ...entry,
                        orderTypes: e.currentTarget.checked
                          ? modes.filter((v) => v === mode || entry.orderTypes.includes(v))
                          : entry.orderTypes.filter((v) => v !== mode),
                      })
                    }
                  />
                  {mode === "DineIn" ? "Dine in" : mode}
                </label>
              ))}
            </fieldset>
          )}
        </fieldset>
      ))}
      <p>
        Enabled contexts require a registered classification and at least one order type before
        saving. Classification references are recorded inputs; professional and legal qualification
        has not been evaluated.
      </p>
    </section>
  );
}
