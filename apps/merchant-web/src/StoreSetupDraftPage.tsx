import { StoreConfigurationOrdinaryPanel } from "./StoreConfigurationOrdinaryPanel.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import { createStoreConfigurationOrdinaryClient } from "./store-configuration-ordinary-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { ReceiptTemplateStoreSelection } from "./ReceiptTemplateStoreSelection.js";
import { ReceiptTemplateArtifactEditor } from "./ReceiptTemplateArtifactEditor.js";
import { ReceiptTemplateDraftEditor } from "./ReceiptTemplateDraftEditor.js";
import { storeSetupMissingItems } from "./store-setup-missing.js";
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
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
import { languageName } from "./staff-text.js";
import { timeZoneChoices, timeZoneLabel } from "./time-zone-names.js";
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
  /** Staff type wait times in whole minutes; the stored contract keeps seconds. */
  readonly cutoff: string;
  readonly lead: string;
  /**
   * The saved seconds behind a prefilled minute field, kept until staff edit that field (then
   * null). A saved value that is not a whole number of minutes (e.g. 90 seconds) is shown rounded
   * (2) but saved back unchanged, so opening and saving setup never alters a value staff did not
   * touch; typing any value replaces it with exactly that many minutes.
   */
  readonly savedCutoffSeconds?: number | null;
  readonly savedLeadSeconds?: number | null;
}
/** Largest wait the contract accepts: 86,400 seconds = 24 hours = 1,440 minutes. */
const maxWaitMinutes = 1440;
/** Minutes shown for saved seconds; rounded only for display (see StoreSetupHourInput). */
export const waitMinutesText = (seconds: number) => String(Math.round(seconds / 60));
/** "1 minute 30 seconds" for a saved wait that is not a whole number of minutes. */
export function savedWaitText(seconds: number): string {
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  return [
    minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
    rest > 0 ? `${rest} second${rest === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
export interface StoreSetupEditorInputs {
  readonly timeZone: string;
  readonly businessStart: string;
  readonly serviceModes: readonly ServiceMode[];
  readonly hours: readonly (readonly StoreSetupHourInput[])[] | null;
}
/** Shown only when a saved wait is not a whole number of minutes and staff have not edited it. */
function SavedWaitNote({ seconds }: { readonly seconds?: number | null | undefined }) {
  if (typeof seconds !== "number" || seconds % 60 === 0) return null;
  return <p>Saved as {savedWaitText(seconds)}. It stays as saved unless you change it here.</p>;
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
              cutoff: waitMinutesText(i.orderCutoffSeconds),
              lead: waitMinutesText(i.leadTimeSeconds),
              savedCutoffSeconds: i.orderCutoffSeconds,
              savedLeadSeconds: i.leadTimeSeconds,
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
  const waitSeconds = (minutes: string, saved: number | null | undefined) => {
    if (typeof saved === "number" && minutes === waitMinutesText(saved)) return saved;
    if (!/^\d+$/u.test(minutes) || Number(minutes) > maxWaitMinutes)
      throw new StoreSetupClientError("Invalid");
    return Number(minutes) * 60;
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
              orderCutoffSeconds: waitSeconds(value.cutoff, value.savedCutoffSeconds),
              leadTimeSeconds: waitSeconds(value.lead, value.savedLeadSeconds),
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
    "Check the edited settings. Each service interval needs valid times and at least one service mode. Wait times are whole minutes, up to 24 hours (1,440 minutes). A service charge or delivery fee that is On needs a tax classification that is still in use, and every fee that is On needs at least one order type.",
  Denied: "Your current permission or selected Store does not allow this action.",
  Conflict:
    "The saved settings or their baseline changed. Refresh, then discard your local edits to use the latest saved version.",
  Unavailable: "The current Store settings could not be loaded. Connect and refresh to try again.",
  OutcomeUnknown:
    "The save result could not be confirmed. Recover the original save before making another change.",
  ScopeChanged:
    "The selected Store or signed-in session changed. Open setup for the current Store.",
  Stale: "The current settings check expired. Refresh to read the current Store again.",
  NotRegistered: "No tax classifications are set up for this Brand yet.",
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  SoleOperatorNotInEffect:
    "Sole operator is not in effect for you now, so another person with Owner access must approve this.",
  SoleOperatorNeedsVerification:
    "Your verification is more than 15 minutes old. Verify again, then approve.",
  SoleOperatorOff:
    "Sole operator is off, so another person with Owner access must approve this. If you run this business on your own, turn on Sole operator on the Approvals page, then approve again.",
  NotYourChange:
    "Only the person who made this configuration can check it or send it for approval. Ask them to, or approve or decline it.",
  SetupIncomplete:
    "The saved setup still has settings that are not set (see the list in this step). Finish them, save the setup, then create the configuration.",
  SetupOutdated:
    "The Store's configuration changed after this setup was saved. Save the setup again, then create the configuration.",
  OpenChangeByAnother:
    "Someone else's configuration change is still waiting. It must be approved and published, or declined, before a new configuration can be created.",
  Withdrawn: "This configuration was withdrawn or declined. Create a new one from the saved setup.",
  SoleOperatorApprovalInvalid:
    "This configuration was approved by you alone while Sole operator was off, so it cannot be published. Withdraw it, then send a new change for approval.",
};
const root = (view: StoreSetupWorkspace) => ({
  reference: view.setup.snapshot?.setupDraftReference ?? null,
  revision: view.setup.snapshot?.revision ?? 0,
});
const sameRoot = (a: StoreSetupWorkspace, b: StoreSetupWorkspace) =>
  JSON.stringify(root(a)) === JSON.stringify(root(b));
const feeLabel = (chargeType: string) =>
  chargeType === "ServiceCharge"
    ? "Service charge"
    : chargeType === "DeliveryFee"
      ? "Delivery fee"
      : "Tip";
function SavedReference({ value }: { value: StoreSetupContent["addressReference"] }) {
  return <p>{value.state === "Configured" ? "Already configured." : "Not configured."}</p>;
}
/**
 * v15 finding: a Store Manager reads this page (organization.store.read) but only the Owner changes
 * setup (organization.manage). When the setup read itself is refused, the setup steps are
 * permission-trimmed: no "not allowed" error and no refresh of a draft they cannot read, while the
 * Store sections on the page stay readable with their own "Only the Owner can change" notes.
 */
export function storeSetupOwnerOnly(
  error: StoreSetupClientError["code"] | null,
  workspace: StoreSetupWorkspace | null,
  sameStore: boolean,
): boolean {
  return error === "Denied" && workspace === null && sameStore;
}
export function StoreSetupHeader({
  ownerOnly,
  displayName,
  refreshDisabled,
  onRefresh,
}: {
  readonly ownerOnly: boolean;
  readonly displayName: string | null;
  readonly refreshDisabled: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <header className="screen-heading">
      <div>
        <h2>Store setup</h2>
        {displayName !== null && <p>{displayName}</p>}
        {ownerOnly ? (
          <p role="note">
            Only the Owner can change Store setup. You can see the details customers and receipts
            use below.
          </p>
        ) : (
          <p>Saving a draft does not change the live Store.</p>
        )}
      </div>
      {ownerOnly ? null : (
        <button type="button" disabled={refreshDisabled} onClick={onRefresh}>
          Refresh saved setup
        </button>
      )}
    </header>
  );
}
export function StoreSetupDraftPage({
  storeReference,
  csrf,
  client: injected,
  journalFactory = createStoreSetupPendingJournal,
  children,
  taxClassificationsHref,
}: {
  readonly storeReference: string;
  readonly csrf: string;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StoreSetupPendingJournal;
  /** Store-level sections shown above the setup steps (WP-2423 Q15/Q16 receipts and privacy). */
  readonly children?: ReactNode;
  /** Where the Brand Owner manages tax classifications (only for people who can). */
  readonly taxClassificationsHref?: string;
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
    [ready, setReady] = useState(false),
    [live, setLive] = useState<StoreSetupLiveConfiguration | null>(null);
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
        candidate.feeContexts.value.some(
          // WP-2423 (v15 D7): a Tip On without a tax classification needs no classification read.
          (v) => v.state === "Enabled" && v.taxClassificationReference !== null,
        )
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
  const zones = useMemo(() => timeZoneChoices(inputs.timeZone), [inputs.timeZone]);
  let parsed: StoreSetupContent | null = null;
  try {
    parsed = buildStoreSetupEditedContent(content, inputs);
  } catch {
    /* Review shows a safe validation state; local raw input remains. */
  }
  // WP-2423 (v15): step 5 offers the receipt template the live Store issues receipts with; read
  // the live configuration once when it is needed (step 8 reads it again with its panel).
  const liveScope = workspace ? JSON.stringify(workspace.scope) : null;
  useEffect(() => {
    if (liveScope === null || workspace === null || step !== 4 || live !== null) return;
    const c = new AbortController();
    void createStoreConfigurationOrdinaryClient()
      .load(workspace.scope, { signal: c.signal })
      .then((read) => {
        if (!c.signal.aborted)
          setLive((old) => old ?? { current: read.current, observedAt: read.observedAt });
      })
      .catch(() => undefined);
    return () => c.abort();
  }, [liveScope, step, live === null]);
  const ownerOnly = storeSetupOwnerOnly(error, workspace, id === storeReference);
  return (
    <AppFrame
      className="store-setup-draft-page"
      title="Store setup"
      description={
        ownerOnly ? "The Store's details" : "Save unfinished settings and continue later"
      }
    >
      <StoreSetupHeader
        ownerOnly={ownerOnly}
        displayName={workspace?.store.displayName ?? null}
        refreshDisabled={busy || !online || id !== storeReference}
        onRefresh={() => void refresh()}
      />
      {id !== storeReference && (
        <StatePanel heading="Select this Store" tone="error" status>
          <p>Choose this Store in the workspace before opening its setup.</p>
        </StatePanel>
      )}
      {id === storeReference ? children : null}
      {!online && (
        <p role="status">
          Offline. Your local edits are retained. Reconnect and refresh before saving.
        </p>
      )}
      {error && !ownerOnly && (
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
                <dt>Language</dt>
                <dd>{languageName(workspace.store.locale)}</dd>
                <dt>Currency</dt>
                <dd>
                  {workspace.store.currencyCode === "CAD"
                    ? "Canadian dollars ($)"
                    : workspace.store.currencyCode}
                </dd>
                <dt>Current timezone</dt>
                <dd>{timeZoneLabel(workspace.store.timeZone)}</dd>
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
                    <optgroup label="Canada">
                      {zones.canada.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Other time zones">
                      {zones.other.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.label}
                        </option>
                      ))}
                    </optgroup>
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
                  Use service settings from
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
                    <option value="">Not chosen yet</option>
                    <option value="StoreOverride">This Store</option>
                    {content.source.state === "Configured" &&
                      content.source.value === "BrandInherited" && (
                        <option value="BrandInherited" disabled>
                          The Brand (saved earlier)
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
                  Weekly times are in the store&rsquo;s timezone chosen in step 2. Wait times are in
                  whole minutes, up to 24 hours (1,440 minutes).
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
                              Last orders (minutes before closing)
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
                                  intervalChange(day, index, {
                                    cutoff: e.currentTarget.value,
                                    savedCutoffSeconds: null,
                                  })
                                }
                              />
                            </label>
                            <SavedWaitNote seconds={value.savedCutoffSeconds} />
                            <label>
                              Preparation time (minutes)
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
                                  intervalChange(day, index, {
                                    lead: e.currentTarget.value,
                                    savedLeadSeconds: null,
                                  })
                                }
                              />
                            </label>
                            <SavedWaitNote seconds={value.savedLeadSeconds} />
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
                  Enter each wait as whole minutes, from 0 to 1,440 (24 hours). Opening periods on
                  the same day must not overlap.
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
                            {value.localDate} ·{" "}
                            {value.kind === "Holiday" ? "Holiday" : "Special hours"} ·{" "}
                            {value.intervals.length === 0
                              ? "closed"
                              : `${value.intervals.length} opening period${value.intervals.length === 1 ? "" : "s"}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p>
                      Saved special dates are kept. Holidays and special hours are changed in Hours
                      &amp; ordering.
                    </p>
                  </>
                ) : (
                  <p>No holidays or special hours are set. Add them in Hours &amp; ordering.</p>
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
                  {...(taxClassificationsHref === undefined ? {} : { taxClassificationsHref })}
                />
                <h4>Tax settings</h4>
                <SavedReference value={content.taxConfigurationReference} />
                <h4>Payment settings</h4>
                <SavedReference value={content.paymentConfigurationReference} />
                <h4>Receipt settings</h4>
                <SavedReference value={content.receiptReference} />
                <p>Tax rates and tax names are set in Tax review.</p>
              </>
            )}
            {step === 5 && (
              <>
                <label>
                  Order limits
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
                    <option value="unconfigured">Not decided yet</option>
                    <option value="none">No order limits</option>
                    {content.capacityConfigurationReference.state === "Configured" &&
                      content.capacityConfigurationReference.value !== null && (
                        <option value="saved">Limits saved earlier</option>
                      )}
                  </select>
                </label>
                <p>
                  Choose &ldquo;No order limits&rdquo; when the Store accepts every order it
                  receives; staff pause ordering from Hours &amp; ordering when the kitchen is busy.
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
              liveTemplateReference={live?.current?.receiptReference ?? null}
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
                <StoreSetupLiveSettings
                  content={parsed ?? content}
                  live={live}
                  disabled={disabled}
                  onUse={(change) => {
                    const next = parseStoreSetupContent({ ...content, ...change });
                    setContent(next);
                    // WP-2423 (v15): time zone, business day start, service modes and opening
                    // hours are edited through the step 2-4 inputs, which Review and Save read;
                    // carry each value taken from the live Store into them too.
                    const edited = editInputs(next);
                    setInputs((old) => ({
                      ...old,
                      ...(change.timeZone !== undefined ? { timeZone: edited.timeZone } : {}),
                      ...(change.businessDayStartLocalTime !== undefined
                        ? { businessStart: edited.businessStart }
                        : {}),
                      ...(change.enabledServiceModes !== undefined
                        ? { serviceModes: edited.serviceModes }
                        : {}),
                      ...(change.weeklySchedule !== undefined ? { hours: edited.hours } : {}),
                    }));
                    setDirty(true);
                    setError(null);
                  }}
                />
                <StoreConfigurationOrdinaryPanel
                  key={JSON.stringify(workspace.scope)}
                  scope={workspace.scope}
                  csrf={csrf}
                  saved={workspace.setup.snapshot}
                  freshDisabled={disabled || dirty}
                  onLiveConfiguration={setLive}
                  onSetupChanged={() => void refresh()}
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
/** WP-2423: what is still missing says where to set it (step names as on screen). */
const notSet = (step: number) => `Not set yet (step ${step}, ${steps[step - 1]})`;
function storeReview(content: StoreSetupContent): readonly (readonly [string, string])[] {
  return [
    [
      "Timezone",
      content.timeZone.state === "Configured" ? timeZoneLabel(content.timeZone.value) : notSet(2),
    ],
    [
      "Business day start",
      content.businessDayStartLocalTime.state === "Configured"
        ? content.businessDayStartLocalTime.value
        : notSet(2),
    ],
    [
      "Service modes",
      content.enabledServiceModes.state === "Configured"
        ? content.enabledServiceModes.value
            .map((mode) => (mode === "DineIn" ? "Dine in" : mode))
            .join(", ")
        : notSet(3),
    ],
    [
      "Weekly hours",
      content.weeklySchedule.state === "Configured"
        ? ((open) => `Open ${open} ${open === 1 ? "day" : "days"} a week`)(
            content.weeklySchedule.value.filter((day) => day.intervals.length > 0).length,
          )
        : notSet(4),
    ],
    ["Address", content.addressReference.state === "Configured" ? "Already configured" : notSet(2)],
    [
      "Fees",
      content.feeContexts?.state === "Configured"
        ? content.feeContexts.value
            .map(
              (v) =>
                `${feeLabel(v.chargeType)}: ${v.state === "Enabled" ? "On" : v.state === "Disabled" ? "Off" : "Not set"}`,
            )
            .join(", ")
        : notSet(5),
    ],
    [
      "Tax settings",
      content.taxConfigurationReference.state === "Configured"
        ? "Set (see Tax review)"
        : "Not set yet (use the live Store's settings below)",
    ],
    [
      "Payment",
      content.paymentConfigurationReference.state === "Configured"
        ? "Already configured"
        : notSet(5),
    ],
    ["Receipt", content.receiptReference.state === "Configured" ? "Already configured" : notSet(5)],
    [
      "Capacity",
      content.capacityConfigurationReference.state === "Unconfigured"
        ? notSet(6)
        : content.capacityConfigurationReference.value === null
          ? "No order limits"
          : "Already configured",
    ],
    [
      "Contacts",
      content.contactReference.state === "Configured" ? "Already configured" : notSet(7),
    ],
  ];
}

export function StoreSetupDraftReview({ content }: { readonly content: StoreSetupContent | null }) {
  // WP-2423 (v15): the count is exactly the list of what is not set, each with where to set it.
  const missing = content ? storeSetupMissingItems(content) : null;
  return (
    <>
      <p>
        {missing === null
          ? "Some edited times or wait values need correction before saving."
          : missing.length === 0
            ? "Every setting is set."
            : `${missing.length} ${missing.length === 1 ? "setting is" : "settings are"} not set yet. An unfinished draft can be saved.`}
      </p>
      {missing !== null && missing.length > 0 && (
        <section aria-label="Settings not set yet">
          <h4>Not set yet</h4>
          <ul>
            {missing.map((item) => (
              <li key={item.label}>
                {item.label}: set it in {item.where}
              </li>
            ))}
          </ul>
        </section>
      )}
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
                  : "These details could not be loaded. Refresh when connected; an earlier save remains protected."}
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
        Saving these rules does not turn on card payments by itself: the payment provider account
        must be set up, and the rules approved and published.
      </p>
      {error === "FullSignInRequired" ? (
        <>
          <FullSignInPrompt csrf={csrf} />
          {pending ? (
            <p role="status">
              After you verify, choose Recover original payment save. If it shows the save did not
              go through, save again — your choices are kept.
            </p>
          ) : null}
        </>
      ) : error ? (
        <p role="alert">
          {error === "Denied"
            ? "You cannot access payment configuration in the current Store."
            : error === "Conflict"
              ? "Payment configuration changed. Refresh and review before saving."
              : error === "OutcomeUnknown"
                ? "The payment save could not be confirmed. Recover the original save before making another change."
                : error === "Invalid"
                  ? "Check the three payment channel settings."
                  : "Payment settings could not be loaded. Refresh when connected; an earlier save remains protected."}
        </p>
      ) : null}
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
            Saved payment rules, version {view.snapshot.revision}. Card payments still need the
            payment provider account to be set up.
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
      // WP-2423 (v15 D7): only a Tip may be On with no tax classification (not taxed).
      (entry.taxClassificationReference !== null || entry.chargeType !== "Tip") &&
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
  taxClassificationsHref,
}: {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly value: NonNullable<StoreSetupContent["feeContexts"]>;
  readonly disabled: boolean;
  readonly onChange: (value: NonNullable<StoreSetupContent["feeContexts"]>) => void;
  readonly client?: ReturnType<typeof createStoreSetupClient>;
  /** WP-2423: where the Brand Owner adds tax classifications (only for people who can). */
  readonly taxClassificationsHref?: string;
}) {
  const client = useMemo(() => injected ?? createStoreSetupClient(), [injected]);
  const [choices, setChoices] = useState<Awaited<ReturnType<typeof client.classifications>> | null>(
    null,
  );
  const [error, setError] = useState<false | "Unavailable" | "NotRegistered" | "Denied">(false),
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
      .catch((reason: unknown) => {
        if (token === generation.current && !controller.signal.aborted)
          setError(
            reason instanceof StoreSetupClientError &&
              (reason.code === "NotRegistered" || reason.code === "Denied")
              ? reason.code
              : "Unavailable",
          );
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
  // WP-2423 (v15 D5): the choices load as soon as this step opens. They are only what can be
  // picked: the server answers within seconds of reading them, and Save reads them again and
  // refuses a classification no longer in use, so picking never waits for a manual refresh.
  const loading = choices === null && error === false;
  return (
    <section className="store-setup-fee-contexts" aria-label="Fees">
      <h4>Fees</h4>
      <p>
        Choose whether this store uses a service charge, a delivery fee and tips, and which orders
        each one applies to. Saving the setup draft keeps these choices. It does not set fee amounts
        or tax rates, and customers are not charged anything new until the store settings are
        approved and published.
      </p>
      {loading && <p role="status">Loading tax classification choices…</p>}
      {error === "NotRegistered" && (
        <p role="status">
          No tax classifications are set up for this Brand yet, so a service charge or delivery fee
          cannot be turned on here. Leave them as Not set or Off; tips can still be turned on, and
          you can save the rest of this setup.
        </p>
      )}
      {taxClassificationsHref !== undefined &&
        (error === "NotRegistered" ||
          (choices !== null && !choices.choices.some((v) => v.lifecycle === "Active"))) && (
          <p>
            <Link to={taxClassificationsHref}>Set up the Brand&rsquo;s tax classifications</Link>,
            then come back and choose Refresh fee classification choices.
          </p>
        )}
      {error === "Denied" && (
        <p role="status">
          Choosing a tax classification needs permission to read Products and tax settings. Leave
          the service charge and delivery fee as Not set or Off; tips can still be turned on, and
          you can save the rest of this setup.
        </p>
      )}
      {error === "Unavailable" && (
        <p role="status">
          Tax classifications could not be loaded. Choose Refresh fee classification choices to try
          again; tips, and fees that are Not set or Off, can still be saved.
        </p>
      )}
      <button type="button" disabled={disabled || loading} onClick={() => setReload((v) => v + 1)}>
        Refresh fee classification choices
      </button>
      {entries.map((entry, index) => (
        <fieldset disabled={disabled} key={entry.chargeType}>
          <legend>{feeLabel(entry.chargeType)}</legend>
          <label>
            {feeLabel(entry.chargeType)}
            <select
              aria-label={feeLabel(entry.chargeType)}
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
                          // WP-2423 (v15 D7): a tip is not taxed, so it starts without one.
                          taxClassificationReference: entry.chargeType === "Tip" ? null : "",
                          orderTypes: [],
                        },
                  );
              }}
            >
              <option value="Unconfigured">Not set</option>
              <option value="Disabled">Off</option>
              <option value="Enabled">On</option>
            </select>
          </label>
          <label>
            {feeLabel(entry.chargeType)} tax classification
            <select
              aria-label={`${feeLabel(entry.chargeType)} tax classification`}
              disabled={
                disabled ||
                entry.state !== "Enabled" ||
                (choices === null && entry.chargeType !== "Tip")
              }
              value={
                entry.state === "Enabled" && entry.taxClassificationReference !== null
                  ? entry.taxClassificationReference
                  : ""
              }
              onChange={(e) => {
                if (entry.state !== "Enabled") return;
                if (e.currentTarget.value === "" && entry.chargeType === "Tip") {
                  change(index, { ...entry, taxClassificationReference: null });
                  return;
                }
                const selected = choices?.choices.find(
                  (v) =>
                    v.classificationReference === e.currentTarget.value && v.lifecycle === "Active",
                );
                if (!selected) return;
                change(index, {
                  ...entry,
                  taxClassificationReference: selected.classificationReference,
                });
              }}
            >
              <option value="">
                {entry.chargeType === "Tip"
                  ? "No tax classification (tips are not taxed)"
                  : "Choose a tax classification to turn this on"}
              </option>
              {entry.state === "Enabled" &&
                entry.taxClassificationReference !== null &&
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
                  {choice.localizedNames[choices.defaultLocale] ??
                    Object.values(choice.localizedNames)[0] ??
                    "Unnamed tax classification"}
                  {choice.lifecycle === "Active" ? "" : " (no longer in use)"}
                </option>
              ))}
            </select>
          </label>
          {entry.state === "Enabled" && (
            <fieldset>
              <legend>{feeLabel(entry.chargeType)} order types</legend>
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
        A service charge or delivery fee that is On needs a tax classification, and every fee that
        is On needs at least one order type before saving. Tips customers choose to give go to staff
        and are generally not subject to GST/HST, so a tip needs no tax classification (a service
        charge every customer must pay is taxed). The classification is the Brand&rsquo;s own
        choice; it has not been checked by a tax professional.
      </p>
    </section>
  );
}

/** The live Store's own operating settings "Use the live Store's settings" also fills in where the
 * setup has none yet (WP-2423 v15: a running Store starts its setup from what it runs today),
 * including the receipt template it issues receipts with today (checked again when the
 * configuration is created). The address, contact and payment settings it runs with were set at
 * installation and are not Store setup records: they are entered and saved in their steps. */
const liveOperatingFields = [
  "source",
  "timeZone",
  "businessDayStartLocalTime",
  "enabledServiceModes",
  "weeklySchedule",
  "capacityConfigurationReference",
  "receiptReference",
] as const;
/** The setup change "Use the live Store's settings" makes: tax and Brand settings of the live Store,
 * its opening hours (DEC-STORE-SETUP-PUBLICATION 13: using the live settings carries what the live
 * Store runs with, so publishing does not silently change its hours; the screen says so before the
 * button is used), its holidays when the setup has none, a start as soon as it is published (server
 * time), and the live Store's time zone, business day start, service modes, order limits and receipt
 * template where the setup has none yet. Those other settings already in the setup are kept. */
export function liveStoreSettingsChange(
  content: StoreSetupContent,
  live: StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot },
): Partial<StoreSetupContent> {
  const current = live.current;
  const operating = Object.fromEntries(
    liveOperatingFields
      .filter((field) => content[field].state !== "Configured")
      .map((field) => [field, { state: "Configured", value: current[field] }]),
  ) as Partial<StoreSetupContent>;
  return {
    ...operating,
    weeklySchedule: { state: "Configured", value: current.weeklySchedule },
    taxConfigurationReference: { state: "Configured", value: liveStoreTaxReference(live) },
    brandBaseVersionReference: { state: "Configured", value: current.brandBaseVersionReference },
    exceptions:
      content.exceptions.state === "Configured"
        ? content.exceptions
        : { state: "Configured", value: current.exceptions },
    effectiveFrom: { state: "Configured", value: live.observedAt },
    effectiveUntil: { state: "Configured", value: null },
  };
}
type WeeklySchedule = StoreConfigurationSnapshot["weeklySchedule"];
type ScheduleInterval = WeeklySchedule[number]["intervals"][number];
const clock = (value: string) => value.slice(0, 5);
function intervalText(interval: ScheduleInterval, detailed: boolean): string {
  const times = `${clock(interval.startLocalTime)}\u2013${clock(interval.endLocalTime)}${
    interval.endsNextDay ? " (next day)" : ""
  }`;
  if (!detailed) return times;
  const services = interval.serviceModes
    .map((mode) => (mode === "DineIn" ? "Dine in" : mode))
    .join(", ");
  return `${times} (${services}; last orders ${waitMinutesText(interval.orderCutoffSeconds)} min before closing; preparation ${waitMinutesText(interval.leadTimeSeconds)} min)`;
}
function dayText(intervals: readonly ScheduleInterval[] | undefined, detailed: boolean): string {
  return intervals === undefined || intervals.length === 0
    ? "closed"
    : intervals.map((interval) => intervalText(interval, detailed)).join(", ");
}
/**
 * WP-2423 (v15): how publishing this setup changes the live Store's opening hours, one line per
 * day that changes ("Sunday: 10:00–20:00 becomes 10:00–15:00"); times alone when they differ,
 * otherwise the service modes and wait times that do. Empty when the hours are the same.
 */
export function openingHoursChanges(
  live: WeeklySchedule,
  setup: WeeklySchedule,
): readonly string[] {
  const byDay = (schedule: WeeklySchedule) =>
    new Map(schedule.map((day) => [day.isoWeekday, day.intervals] as const));
  const from = byDay(live),
    to = byDay(setup);
  return days.flatMap((name, i) => {
    const before = from.get(i + 1),
      after = to.get(i + 1);
    if (JSON.stringify(before ?? []) === JSON.stringify(after ?? [])) return [];
    const detailed = dayText(before, false) === dayText(after, false);
    return [`${name}: ${dayText(before, detailed)} becomes ${dayText(after, detailed)}`];
  });
}
/** The live (published) Store configuration as the publication panel read it. */
export interface StoreSetupLiveConfiguration {
  readonly current: StoreConfigurationSnapshot | null;
  readonly observedAt: string;
  /** WP-2423 (v15 `8bd902e3` D1): the tax configuration that governs the Store now (the one its
   * quotes use and the publication check expects), when read. */
  readonly storeTaxConfigurationReference?: string | null;
}
/** v15 D1: the Store's tax settings in force: its tax configuration record (an installed
 * configuration may still name the installer's reference), else the live configuration's. */
export function liveStoreTaxReference(
  live: StoreSetupLiveConfiguration & { readonly current: StoreConfigurationSnapshot },
): string {
  return live.storeTaxConfigurationReference ?? live.current.taxConfigurationReference;
}
/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: settings Store setup does not edit itself — the Store's tax
 * settings (Tax review), its Brand settings, holidays and special hours (Hours & ordering) and when
 * it takes effect — are carried from the live Store, so a saved setup can be created and published.
 */
export function StoreSetupLiveSettings({
  content,
  live,
  disabled,
  onUse,
}: {
  readonly content: StoreSetupContent;
  readonly live: StoreSetupLiveConfiguration | null;
  readonly disabled: boolean;
  onUse(change: Partial<StoreSetupContent>): void;
}) {
  if (live === null || live.current === null) return null;
  const current = live.current;
  const known = { ...live, current };
  const same = <T,>(value: StoreSetupContent[keyof StoreSetupContent] | undefined, expected: T) =>
    value?.state === "Configured" && JSON.stringify(value.value) === JSON.stringify(expected);
  const tax = same(content.taxConfigurationReference, liveStoreTaxReference(known)),
    brand = same(content.brandBaseVersionReference, current.brandBaseVersionReference),
    closures = content.exceptions.state === "Configured",
    start =
      content.effectiveFrom.state === "Configured" &&
      content.effectiveFrom.value <= live.observedAt &&
      content.effectiveFrom.value >= current.effectiveFrom &&
      content.effectiveUntil.state === "Configured" &&
      content.effectiveUntil.value === null;
  const hours = same(content.weeklySchedule, current.weeklySchedule);
  // The live operating settings the setup has none of yet (filled in by the button below).
  const missingOperating = liveOperatingFields.filter(
    (field) => content[field].state !== "Configured",
  );
  const complete = tax && brand && closures && start && hours && missingOperating.length === 0;
  const hourChanges =
    content.weeklySchedule.state === "Configured"
      ? openingHoursChanges(current.weeklySchedule, content.weeklySchedule.value)
      : [];
  return (
    <section aria-label="Settings from the live Store">
      <h4>Settings from the live Store</h4>
      <p>
        These are not changed in Store setup. They come from the Store as it runs today; save the
        setup draft after using them.
      </p>
      <ul>
        <li>
          Tax settings (see Tax review):{" "}
          {tax ? "same as the live Store" : "not the live Store's settings yet"}
        </li>
        <li>Brand settings: {brand ? "same as the live Store" : "not set yet"}</li>
        <li>
          Holidays and special hours (changed in Hours &amp; ordering):{" "}
          {closures
            ? content.exceptions.state === "Configured" && content.exceptions.value.length === 0
              ? "none"
              : "kept as saved"
            : "not set yet"}
        </li>
        <li>Takes effect: {start ? "as soon as it is published" : "not set yet"}</li>
        {missingOperating.length > 0 && (
          <li>
            Time zone, business day start, service modes, opening hours, order limits and the
            receipt template not set in this setup: the live Store&rsquo;s are used when you choose
            &ldquo;Use the live Store&rsquo;s settings&rdquo;.
          </li>
        )}
        {(content.addressReference.state !== "Configured" ||
          content.contactReference.state !== "Configured" ||
          content.paymentConfigurationReference.state !== "Configured") && (
          <li>
            Address, contact details and payment settings: the ones the Store runs with today were
            set when it was installed and cannot be carried over. Enter them in step 2 (address),
            step 7 (contact) and step 5 (payment), save each, choose &ldquo;Use saved&rdquo;, then
            save the setup draft. They can be the same as the name and contact shown to customers
            above.
          </li>
        )}
        <li>
          Opening hours:{" "}
          {hours
            ? "same as the live Store"
            : content.weeklySchedule.state !== "Configured"
              ? "not set yet"
              : hourChanges.length === 0
                ? "different from the live Store"
                : "different from the live Store (see below)"}
        </li>
      </ul>
      {!hours && hourChanges.length > 0 && (
        <div role="note" aria-label="Opening hours change">
          <p>Publishing this setup changes the Store&rsquo;s opening hours:</p>
          <ul>
            {hourChanges.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            To keep the hours the Store opens with today, choose &ldquo;Use the live Store&rsquo;s
            opening hours&rdquo; and save the setup draft before sending or publishing it.
          </p>
        </div>
      )}
      {!hours && (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onUse({ weeklySchedule: { state: "Configured", value: current.weeklySchedule } })
          }
        >
          Use the live Store&rsquo;s opening hours
        </button>
      )}
      <button
        type="button"
        disabled={disabled || complete}
        onClick={() => onUse(liveStoreSettingsChange(content, known))}
      >
        Use the live Store&rsquo;s settings
      </button>
      {!hours && content.weeklySchedule.state === "Configured" && (
        <p>
          &ldquo;Use the live Store&rsquo;s settings&rdquo; also replaces the opening hours in this
          setup with the live Store&rsquo;s.
        </p>
      )}
    </section>
  );
}
