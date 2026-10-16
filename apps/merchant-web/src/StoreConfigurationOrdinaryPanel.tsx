import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createStoreConfigurationOrdinaryClient,
  StoreConfigurationPublicationNotOfferedError,
  type StoreConfigurationOrdinaryCommand,
  type PreparedStoreConfigurationOrdinaryCommand,
  type StoreConfigurationOrdinaryHistory,
  type StoreConfigurationOrdinaryHistoryEntry,
} from "./store-configuration-ordinary-client.js";
import {
  createStoreConfigurationPendingJournal,
  type StoreConfigurationPendingJournal,
  type StoreConfigurationOriginalCursor,
  type StoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationOrdinaryAction,
  type StoreConfigurationPublicationCheckCode,
  type StoreConfigurationPublicationChecks,
} from "./store-configuration-pending-journal.js";
import { storeSetupMissingItems, storeSetupMissingText } from "./store-setup-missing.js";
import {
  storeConfigurationDeclineReasonText,
  withdrawStoreConfiguration,
  type StoreConfigurationDeclineReason,
  type StoreConfigurationSnapshot,
} from "./store-configuration-client.js";
import {
  StoreSetupClientError,
  type StoreSetupScope,
  type StoreSetupSnapshot,
} from "./store-setup-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  StoreConfigurationFeeBasisView,
  storeConfigurationStateLabel,
} from "./StoreConfigurationEditor.js";
import { StaffTime } from "./StoreTime.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
/** Configuration steps in staff words (WP-2423: no command or outcome codes on screen). */
const actionLabel: Record<string, string> = {
  Materialize: "Create configuration from saved setup",
  SaveDraft: "Created from saved setup",
  Validate: "Checked",
  Submit: "Sent for approval",
  Approve: "Approved",
  Publish: "Published",
};
const requestLabel: Record<string, string> = {
  Materialize: "create-from-setup",
  Validate: "check",
  Submit: "send-for-approval",
  Approve: "approval",
  Publish: "publish",
};
const doneText: Record<string, string> = {
  Materialize: "Configuration created from the saved setup.",
  Validate: "Configuration checked.",
  Submit: "Configuration sent for approval.",
  Approve: "Configuration approved.",
  Publish: "Configuration published.",
};
/** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner's own approval, given alone. */
const soleOperatorDoneText = "Configuration approved by you alone as sole operator.";
const outcomeText = (action: string, outcome: "Committed" | "Abandoned") =>
  outcome === "Committed"
    ? (doneText[action] ?? "Change recorded.")
    : "That request did not go through; nothing changed.";
/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: each publication check in staff words — what passed, or
 * what blocks it and where to fix it. Every check blocks sending, approval and publication.
 */
const checkText: Record<StoreConfigurationPublicationCheckCode, { pass: string; fail: string }> = {
  Tax: {
    pass: "Tax settings are the ones in force for this Store.",
    fail: "Tax settings are not the ones in force for this Store, or their registration or review has expired. Use the live Store's settings above, and check Tax review.",
  },
  BrandSettings: {
    pass: "Brand settings are the same as the live Store's.",
    fail: "Brand settings differ from the live Store's. Use the live Store's settings above.",
  },
  TimeZone: {
    pass: "The time zone is the Store's own time zone.",
    fail: "The time zone must be the Store's own time zone. Change it in step 2.",
  },
  BusinessDayStart: {
    pass: "The business day starts at the same time as now.",
    fail: "The business day must start at the same time as it does now, so past days and reports keep their boundaries. Change it back in step 2.",
  },
  Hours: {
    pass: "Opening hours are complete.",
    fail: "Opening hours need at least one opening period, and each period may only use service modes this Store offers. Check steps 3 and 4.",
  },
  EffectiveDate: {
    pass: "It takes effect as soon as it is published.",
    fail: "This configuration would take effect later or end on a date. Use the live Store's settings above so it takes effect when published, then save and create it again.",
  },
  Fees: {
    pass: "Fees are set.",
    fail: "A fee that is On may only apply to service modes this Store offers. Check step 5.",
  },
  GoLive: {
    pass: "This Store's go-live check is approved.",
    fail: "This Store's go-live check is not approved, so its configuration cannot be published.",
  },
};
const checksPass = (checks: StoreConfigurationPublicationChecks | undefined) =>
  checks === undefined || checks.checks.every((check) => check.outcome === "Pass");
/** A configuration created from setup must be approved and published within 14 days. */
const publicationWindowMs = 14 * 86400000;
export function StoreConfigurationPublicationChecklist({
  checks,
}: {
  readonly checks: StoreConfigurationPublicationChecks;
}) {
  const blocked = checks.checks.filter((check) => check.outcome === "Fail").length;
  return (
    <section aria-label="Publication checks">
      <h4>Before it can be published</h4>
      <p>
        {blocked === 0
          ? "Every check passed."
          : `${blocked} ${blocked === 1 ? "check needs" : "checks need"} attention before this can be sent for approval or published.`}{" "}
        Checked <StaffTime instant={checks.checkedAt} />.
      </p>
      <ul>
        {checks.checks.map((check) => (
          <li key={check.code}>
            {check.outcome === "Pass" ? "Ready: " : "Needs attention: "}
            {check.outcome === "Pass" ? checkText[check.code].pass : checkText[check.code].fail}
          </li>
        ))}
      </ul>
    </section>
  );
}
export interface StoreConfigurationOrdinaryPanelProps {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly saved: StoreSetupSnapshot | null;
  readonly freshDisabled?: boolean;
  /** The live (published) configuration and the server time it was read, for carrying settings
   * Store setup does not edit (tax, Brand settings, dated closures, start). */
  readonly onLiveConfiguration?: (live: {
    readonly current: StoreConfigurationSnapshot | null;
    readonly observedAt: string;
    readonly storeTaxConfigurationReference?: string | null;
  }) => void;
  readonly client?: ReturnType<typeof createStoreConfigurationOrdinaryClient>;
  readonly journalFactory?: (scope: StoreSetupScope) => StoreConfigurationPendingJournal;
}
const denied = () => {
  throw new StoreSetupClientError("ScopeChanged");
};
/** Explicit terminal plus owner-reobserved original, then compare-and-clear.
 * A returned command receipt alone never clears the durable original. */
export async function recoverStoreConfigurationOriginal(input: {
  client: ReturnType<typeof createStoreConfigurationOrdinaryClient>;
  journal: StoreConfigurationPendingJournal;
  cursor: StoreConfigurationOriginalCursor;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const check = () => {
    if (!input.isCurrent() || input.signal.aborted) denied();
  };
  check();
  const receipt = await input.client.resolve(input.cursor, {
    csrf: input.csrf,
    signal: input.signal,
  });
  check();
  const workspace = await input.client.refreshOriginal(input.cursor, {
    csrf: input.csrf,
    signal: input.signal,
  });
  check();
  await input.journal.complete(input.cursor, receipt, workspace);
  check();
  return { receipt, workspace };
}
/** Reserve is an asynchronous durable boundary: a parent edit may occur while
 * it is pending. Preserve the original first, then recheck dispatch permission.
 * This check never prevents resolution of that already-reserved original. */
export async function executeStoreConfigurationOriginal(input: {
  client: ReturnType<typeof createStoreConfigurationOrdinaryClient>;
  journal: StoreConfigurationPendingJournal;
  prepared: PreparedStoreConfigurationOrdinaryCommand;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  canDispatch: () => boolean;
  onReserved: (cursor: StoreConfigurationOriginalCursor) => void;
  /** WP-2423: "SoleOperator" when the Owner approves their own configuration alone. */
  approvalMode?: "SoleOperator";
}) {
  const check = () => {
    if (!input.isCurrent() || input.signal.aborted) denied();
  };
  check();
  await input.journal.reserve(input.prepared.cursor);
  input.onReserved(input.prepared.cursor);
  check();
  if (!input.canDispatch()) throw new StoreSetupClientError("Conflict");
  const receipt = await input.client.execute(
    input.prepared,
    { csrf: input.csrf, signal: input.signal },
    input.approvalMode,
  );
  check();
  const workspace = await input.client.refreshOriginal(input.prepared.cursor, {
    csrf: input.csrf,
    signal: input.signal,
  });
  check();
  await input.journal.complete(input.prepared.cursor, receipt, workspace);
  check();
  return { receipt, workspace };
}
const messages: Record<StoreSetupClientError["code"], string> = {
  Invalid: "This configuration request is invalid.",
  Stale: "The current configuration observation expired. Refresh before a new request.",
  Denied:
    "Current permission or session refused this request. Keep the original and retry after access is restored.",
  Conflict:
    "The saved source or configuration changed. Refresh before a new request; recover any pending original first.",
  ScopeChanged:
    "The selected Store or Actor changed. Return to the original scope to recover its request.",
  Unavailable:
    "Store configuration could not be loaded. Try again; any request still waiting is kept.",
  NotRegistered: "No tax classifications are set up for this Brand yet.",
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  SoleOperatorNotInEffect:
    "Sole operator is not in effect for you now (it is off, or someone else also holds Owner access here), so another person with Owner access must approve this. Recover the request, then refresh.",
  SoleOperatorNeedsVerification:
    "Your verification is more than 15 minutes old, so the approval was not recorded. Recover the request, verify again, then approve.",
  SoleOperatorOff:
    "Sole operator is off, so another person with Owner access must approve this. Recover the request. If you run this business on your own, turn on Sole operator on the Approvals page, then approve again.",
  NotYourChange:
    "Only the person who made this configuration can check it or send it for approval, so nothing was recorded. Recover the request; ask them to, or approve or decline it.",
  SetupIncomplete:
    "The saved setup still has settings that are not set, so nothing was created. Recover the request, finish those settings in the earlier steps and save, then create the configuration.",
  SetupOutdated:
    "The Store's configuration changed after this setup was saved, so nothing was created. Recover the request, save the setup again, then create the configuration.",
  OpenChangeByAnother:
    "Someone else's configuration change is still waiting, so nothing was created. Recover the request; then it must be approved and published, or declined, first.",
  Withdrawn:
    "This configuration was withdrawn or declined, so this step was not recorded. Recover the request, then create a new configuration from the saved setup.",
  OutcomeUnknown:
    "The result is unknown. Recover the original request before sending another command.",
};
/** WP-2423 (v15 D6): the latest configuration was created from exactly this saved setup (its
 * setup revision), so step 8 says what became of it rather than "the configuration changed after
 * this setup was saved". */
export function storeSetupCreatedFromSaved(
  saved: { readonly setupDraftReference: string; readonly revision: number } | null,
  latest: Pick<StoreConfigurationSnapshot, "setupBasis"> | null,
): boolean {
  return (
    saved !== null &&
    latest?.setupBasis !== undefined &&
    latest.setupBasis.setupDraftReference === saved.setupDraftReference &&
    latest.setupBasis.sourceRevision === saved.revision
  );
}
export function StoreConfigurationOrdinaryPanel(props: StoreConfigurationOrdinaryPanelProps) {
  const client = useMemo(
    () => props.client ?? createStoreConfigurationOrdinaryClient(),
    [props.client],
  );
  const historyClient = useMemo(
    () => props.client ?? createStoreConfigurationOrdinaryClient(),
    [props.client],
  );
  const historyGeneration = useRef(0),
    historyController = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<readonly StoreConfigurationOrdinaryHistoryEntry[]>([]),
    [nextHistory, setNextHistory] = useState<number | null>(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const identity = canonical(props.scope) + props.csrf;
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    journal = useRef<StoreConfigurationPendingJournal | null>(null),
    running = useRef(false),
    freshDisabled = useRef(props.freshDisabled);
  freshDisabled.current = props.freshDisabled;
  const [workspace, setWorkspace] = useState<StoreConfigurationOrdinaryWorkspace | null>(null),
    [pending, setPending] = useState<StoreConfigurationOriginalCursor | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [notOffered, setNotOffered] = useState(false),
    // WP-2423 (v15): declining someone else's configuration is confirmed, with an optional reason.
    [declining, setDeclining] = useState(false),
    [declineReason, setDeclineReason] = useState<StoreConfigurationDeclineReason | "">("");
  useEffect(() => {
    ++historyGeneration.current;
    historyController.current?.abort();
    historyClient.invalidate();
    setHistory([]);
    setNextHistory(null);
    setHistoryBusy(false);
    setHistoryError(null);
    setHistoryLoaded(false);
    return () => {
      ++historyGeneration.current;
      historyController.current?.abort();
      historyClient.invalidate();
    };
  }, [identity, historyClient, props.freshDisabled]);
  async function loadHistory(more = false) {
    if (busy || historyBusy || props.freshDisabled || (more && nextHistory === null)) return;
    const selector = more ? nextHistory : null,
      epoch = ++historyGeneration.current,
      c = new AbortController();
    historyController.current?.abort();
    historyController.current = c;
    setHistoryBusy(true);
    setHistoryError(null);
    const current = () => epoch === historyGeneration.current && !c.signal.aborted;
    try {
      const page = await historyClient.history(props.scope, {
        beforeSequence: selector,
        csrf: props.csrf,
        signal: c.signal,
      });
      if (current()) {
        setHistory(more ? appendStoreConfigurationHistory(history, page) : page.entries);
        setNextHistory(page.nextBeforeSequence);
        setHistoryLoaded(true);
      }
    } catch (e) {
      if (current()) setHistoryError(message(e));
    } finally {
      if (current()) setHistoryBusy(false);
    }
  }
  const message = (e: unknown) =>
    e instanceof StoreSetupClientError ? messages[e.code] : messages.Unavailable;
  useEffect(() => {
    const epoch = ++generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    client.invalidate();
    running.current = true;
    setBusy(true);
    setWorkspace(null);
    setPending(null);
    setError(null);
    setNotice(null);
    setNotOffered(false);
    const current = () => epoch === generation.current && !c.signal.aborted;
    const j = (props.journalFactory ?? createStoreConfigurationPendingJournal)(props.scope);
    journal.current = j;
    void (async () => {
      try {
        const original = await j.load();
        if (!current()) return;
        setPending(original);
        if (original) return;
        const next = await client.load(props.scope, { signal: c.signal });
        if (current()) setWorkspace(next);
      } catch (e) {
        if (current() && e instanceof StoreConfigurationPublicationNotOfferedError)
          setNotOffered(true);
        else if (current()) setError(message(e));
      } finally {
        if (current()) {
          running.current = false;
          setBusy(false);
        }
      }
    })();
    return () => {
      ++generation.current;
      c.abort();
      client.invalidate();
      running.current = false;
    };
  }, [identity, client, props.journalFactory]);
  async function refresh() {
    if (running.current || pending) return;
    const epoch = generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    running.current = true;
    setBusy(true);
    setError(null);
    // WP-2423 (v15 D6): an earlier action's result no longer describes the refreshed state.
    setNotice(null);
    try {
      const next = await client.load(props.scope, { signal: c.signal });
      if (epoch === generation.current && !c.signal.aborted) setWorkspace(next);
    } catch (e) {
      if (epoch === generation.current && !c.signal.aborted) setError(message(e));
    } finally {
      if (epoch === generation.current && !c.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function act(action: StoreConfigurationOrdinaryAction, approvalMode?: "SoleOperator") {
    if (running.current || pending || freshDisabled.current || !workspace || !journal.current)
      return;
    const epoch = generation.current,
      c = new AbortController(),
      j = journal.current,
      baseline = workspace,
      saved = props.saved;
    controller.current?.abort();
    controller.current = c;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const current = () => epoch === generation.current && !c.signal.aborted;
    const check = () => {
      if (!current()) denied();
    };
    try {
      const latest = await client.load(props.scope, { signal: c.signal });
      check();
      setWorkspace(latest);
      if (canonical(latest.expectedHead) !== canonical(baseline.expectedHead))
        throw new StoreSetupClientError("Conflict");
      if (freshDisabled.current) throw new StoreSetupClientError("Conflict");
      const base = {
        profile: "StoreConfigurationOrdinaryCommandV1" as const,
        ...props.scope,
        operationReference: serviceOperationReference(),
        expectedHead: baseline.expectedHead,
      };
      let command: StoreConfigurationOrdinaryCommand;
      if (action === "Materialize") {
        if (
          !saved ||
          saved.tenantReference !== props.scope.tenantReference ||
          saved.brandReference !== props.scope.brandReference ||
          saved.storeReference !== props.scope.storeReference
        )
          throw new StoreSetupClientError("Invalid");
        command = {
          ...base,
          action,
          setupSelector: {
            setupDraftReference: saved.setupDraftReference,
            sourceRevision: saved.revision,
            sourceSnapshotDigest: await publicationValueDigest(saved),
          },
          reasonCode: "STORE_SETUP_MATERIALIZATION",
        };
      } else command = { ...base, action };
      check();
      const prepared = await client.prepare(command, { signal: c.signal });
      check();
      if (freshDisabled.current) throw new StoreSetupClientError("Conflict");
      const { receipt, workspace: after } = await executeStoreConfigurationOriginal({
        client,
        journal: j,
        prepared,
        csrf: props.csrf,
        signal: c.signal,
        isCurrent: current,
        canDispatch: () => !freshDisabled.current,
        onReserved: (cursor) => {
          if (current()) setPending(cursor);
        },
        ...(approvalMode === undefined ? {} : { approvalMode }),
      });
      setWorkspace(after);
      setPending(null);
      setNotice(
        `${approvalMode !== undefined && receipt.outcome === "Committed" ? soleOperatorDoneText : outcomeText(action, receipt.outcome)} Current configuration refreshed.`,
      );
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  /** WP-2423 (v15 D2/D3): withdraw your own open configuration, or decline someone else's. */
  async function withdrawLatest(declineReason?: StoreConfigurationDeclineReason) {
    const target = workspace?.latest;
    if (running.current || pending || !target) return;
    const epoch = generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const current = () => epoch === generation.current && !c.signal.aborted;
    try {
      const kind = await withdrawStoreConfiguration(
        {
          configurationReference: target.configurationReference,
          configurationVersion: target.configurationVersion,
          auditReference: serviceOperationReference(),
          ...(declineReason === undefined ? {} : { declineReason }),
        },
        props.csrf,
      );
      const next = await client.load(props.scope, { signal: c.signal });
      if (current()) {
        setWorkspace(next);
        setNotice(
          // WP-2423 (v15 D6): what to do next is said from the current state below, not here.
          kind === "Withdrawn"
            ? `Version ${target.configurationVersion} withdrawn. It can no longer be approved or published.`
            : `Version ${target.configurationVersion} declined. It can no longer be approved or published.`,
        );
      }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : messages.Unavailable);
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function recover() {
    if (running.current || !pending || !journal.current) return;
    const epoch = generation.current,
      c = new AbortController(),
      original = pending,
      j = journal.current;
    controller.current?.abort();
    controller.current = c;
    running.current = true;
    setBusy(true);
    setError(null);
    const current = () => epoch === generation.current && !c.signal.aborted;
    try {
      const result = await recoverStoreConfigurationOriginal({
        client,
        journal: j,
        cursor: original,
        csrf: props.csrf,
        signal: c.signal,
        isCurrent: current,
      });
      if (current()) {
        setWorkspace(result.workspace);
        setPending(null);
        setNotice(
          `${outcomeText(original.action, result.receipt.outcome)} Current configuration refreshed.`,
        );
      }
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  // WP-2423 (v15 D6): saving the setup again makes an earlier action's result out of date.
  const savedRevision = props.saved?.revision ?? 0;
  useEffect(() => setNotice(null), [savedRevision]);
  const onLive = props.onLiveConfiguration;
  useEffect(() => {
    if (workspace && onLive)
      onLive({
        current: workspace.current,
        observedAt: workspace.observedAt,
        ...(workspace.storeTaxConfigurationReference === undefined
          ? {}
          : { storeTaxConfigurationReference: workspace.storeTaxConfigurationReference }),
      });
  }, [workspace, onLive]);
  const latest = workspace?.latest,
    current = workspace?.current,
    checks = workspace?.publicationChecks,
    ready = checksPass(checks),
    locked = busy || historyBusy || !!pending || !!props.freshDisabled,
    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the server says when the signed-in Owner created or sent
    // the configuration awaiting approval, and whether they may approve it alone.
    soleOperator = workspace?.soleOperator,
    // WP-2423 (v15 D2/D3): the latest change that is not published — whose it is, and whether it
    // was withdrawn or declined; and whether the saved setup is complete.
    withdrawal = workspace?.latestWithdrawal,
    openLatest =
      latest !== null &&
      latest !== undefined &&
      withdrawal === undefined &&
      (latest.lifecycle === "Draft" ||
        latest.lifecycle === "PendingApproval" ||
        latest.lifecycle === "Approved"),
    openByAnother = openLatest && latest.authoredByReference !== props.scope.actorReference,
    openYours = openLatest && latest.authoredByReference === props.scope.actorReference,
    // WP-2423 (v15): what the saved setup still lacks, named with where to set it.
    setupMissing = props.saved === null ? [] : storeSetupMissingItems(props.saved.content),
    setupIncomplete = setupMissing.length > 0,
    // The setup builds on the configuration that was latest when it was saved.
    setupOutdated =
      props.saved !== null &&
      workspace !== null &&
      props.saved.baseConfigurationReference !==
        ((latest ?? current)?.configurationReference ?? null),
    // WP-2423 (v15 D6): the latest configuration was created from exactly this saved setup — the
    // setup did not "change after it was saved"; say what became of that configuration instead.
    createdFromSaved = storeSetupCreatedFromSaved(props.saved, latest ?? null),
    ownChange =
      withdrawal === undefined &&
      latest?.lifecycle === "PendingApproval" &&
      (soleOperator !== undefined || latest.authoredByReference === props.scope.actorReference);
  // WP-2423 Q15/Q16: no publication path in this deployment; no panel rather than an outage.
  if (notOffered) return null;
  return (
    <section className="store-setup-review" aria-label="Store configuration publication">
      <h3>Store configuration publication</h3>
      <p>
        A saved setup draft does not change the live Store. Create a configuration from it, have it
        approved, then publish it.
      </p>
      {busy && <p role="status">Loading Store configuration…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <>
          <p>
            An earlier {requestLabel[pending.action] ?? "configuration"} request was not confirmed.
            Recover it before making another change; the saved setup is kept.
          </p>
          <button type="button" disabled={busy} onClick={() => void recover()}>
            Recover original configuration request
          </button>
        </>
      )}
      <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>
        Refresh Store configuration
      </button>
      <section aria-label="Store configuration operation history">
        <h3>Recorded configuration history</h3>
        <p>Every recorded change to this Store&rsquo;s configuration, newest first.</p>
        <button
          type="button"
          disabled={busy || historyBusy || !!props.freshDisabled}
          onClick={() => void loadHistory()}
        >
          Refresh configuration history
        </button>
        {historyBusy && <p role="status">Loading configuration history…</p>}
        {historyError && <p role="alert">{historyError}</p>}
        {historyLoaded && history.length === 0 && (
          <p>No configuration changes have been recorded yet.</p>
        )}
        <StoreConfigurationHistoryView entries={history} />
        {nextHistory !== null && (
          <button
            type="button"
            disabled={busy || historyBusy || !!props.freshDisabled}
            onClick={() => void loadHistory(true)}
          >
            Load older changes
          </button>
        )}
      </section>
      {workspace && (
        <>
          <dl>
            <dt>Latest recorded configuration</dt>
            <dd>
              {latest
                ? `Version ${latest.configurationVersion} · ${
                    // WP-2423 (v15): a withdrawn or declined version is shown as such.
                    withdrawal
                      ? withdrawal.kind === "Withdrawn"
                        ? "Withdrawn"
                        : "Declined"
                      : storeConfigurationStateLabel(latest.lifecycle)
                  }`
                : "None recorded"}
            </dd>
            <dt>Current published configuration</dt>
            <dd>
              {current
                ? `Version ${current.configurationVersion} · ${storeConfigurationStateLabel(current.lifecycle)}`
                : "Nothing published yet"}
            </dd>
          </dl>
          {latest && (
            <StoreConfigurationFeeBasisView configuration={latest} withdrawal={withdrawal?.kind} />
          )}{" "}
          {checks && <StoreConfigurationPublicationChecklist checks={checks} />}
          {latest?.setupBasis !== undefined &&
            withdrawal === undefined &&
            (latest.lifecycle === "Draft" ||
              latest.lifecycle === "PendingApproval" ||
              latest.lifecycle === "Approved") && (
              <p>
                It must be approved and published by{" "}
                <StaffTime
                  instant={new Date(
                    Date.parse(latest.createdAt) + publicationWindowMs,
                  ).toISOString()}
                />
                ; after that, create it again from the saved setup.
              </p>
            )}
          {withdrawal && latest && (
            <p>
              Version {latest.configurationVersion} was{" "}
              {withdrawal.kind === "Withdrawn" ? "withdrawn" : "declined"}
              {withdrawal.byYou ? " by you" : ""} <StaffTime instant={withdrawal.withdrawnAt} />. It
              can no longer be approved or published.{" "}
              {setupOutdated
                ? "To create a new configuration, save the setup again (Save setup draft, it then builds on the latest configuration), then create it."
                : "Create a new configuration from the saved setup."}
            </p>
          )}
          {openByAnother && latest && (
            <section aria-label="Configuration waiting from someone else">
              <p>
                Version {latest.configurationVersion}, made by someone else, is{" "}
                {storeConfigurationStateLabel(latest.lifecycle).toLowerCase()}. A new configuration
                cannot be created until it is approved and published, or declined. Declining keeps
                it in the history; the person who made it can make a new change.
              </p>
              {!declining ? (
                <button type="button" disabled={locked} onClick={() => setDeclining(true)}>
                  Decline version {latest.configurationVersion}
                </button>
              ) : (
                <div role="group" aria-label="Decline this configuration">
                  <p>
                    Decline version {latest.configurationVersion}? It stays in the history and
                    cannot be approved or published. The person who made it sees that it was
                    declined{declineReason === "" ? "" : " and why"}.
                  </p>
                  <label>
                    Reason (optional)
                    <select
                      value={declineReason}
                      disabled={locked}
                      onChange={(event) =>
                        setDeclineReason(
                          event.currentTarget.value as StoreConfigurationDeclineReason,
                        )
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
                    disabled={locked}
                    onClick={() => {
                      setDeclining(false);
                      void withdrawLatest(declineReason === "" ? undefined : declineReason);
                    }}
                  >
                    Decline version {latest.configurationVersion}
                  </button>{" "}
                  <button type="button" disabled={locked} onClick={() => setDeclining(false)}>
                    Keep it
                  </button>
                </div>
              )}
            </section>
          )}
          {openYours && latest && (
            <section aria-label="Your configuration waiting">
              <p>
                Your version {latest.configurationVersion} is{" "}
                {storeConfigurationStateLabel(latest.lifecycle).toLowerCase()}.{" "}
                {createdFromSaved
                  ? `It was created from this saved setup. To change it, change the setup and save it, then create a new configuration (it replaces version ${latest.configurationVersion}); or withdraw it to stop it being approved.`
                  : "Creating a new configuration from the saved setup replaces it; or withdraw it to stop it being approved."}
              </p>
              <button type="button" disabled={locked} onClick={() => void withdrawLatest()}>
                Withdraw version {latest.configurationVersion}
              </button>
            </section>
          )}
          {setupOutdated && !openByAnother && !createdFromSaved && withdrawal === undefined && (
            <p>
              The Store&rsquo;s configuration changed after this setup was saved. Save the setup
              again (it then builds on the latest configuration) before creating a configuration.
            </p>
          )}
          {createdFromSaved && !openLatest && withdrawal === undefined && latest && (
            <p>
              Version {latest.configurationVersion} was created from this saved setup and is{" "}
              {storeConfigurationStateLabel(latest.lifecycle).toLowerCase()}. To change the Store
              again, change the setup and save it, then create a new configuration.
            </p>
          )}
          {setupIncomplete && (
            <p>
              A configuration cannot be created yet: the saved setup still has{" "}
              {setupMissing.length === 1 ? "a setting" : `${setupMissing.length} settings`} not set:{" "}
              {storeSetupMissingText(setupMissing)}. Set {setupMissing.length === 1 ? "it" : "them"}
              , save the setup draft, then create the configuration.
            </p>
          )}
          {ownChange && latest && soleOperator !== undefined && (
            <section aria-label="Approve your own configuration">
              <h4>Approval</h4>
              <SoleOperatorSelfApproval
                gate={soleOperator}
                csrf={props.csrf}
                summary={
                  <p>
                    Version {latest.configurationVersion}, created from saved setup
                    {latest.setupBasis ? ` revision ${latest.setupBasis.sourceRevision}` : ""}.{" "}
                    {ready
                      ? "Every check above has passed."
                      : "Some checks above still need attention."}{" "}
                    Once approved, you can publish it to the live Store.
                  </p>
                }
                what="this Store configuration"
                permissionName="Owner access to this Store"
                actionLabel="Approve configuration on my own"
                busy={locked || !ready}
                onApprove={() => void act("Approve", "SoleOperator")}
              />
            </section>
          )}
          {ownChange && soleOperator === undefined && latest?.setupBasis === undefined && (
            <p>
              This is an opening hours change. Approve it (on your own as sole operator, when that
              applies) and publish it on Hours &amp; ordering.
            </p>
          )}
          {ownChange && soleOperator === undefined && latest?.setupBasis !== undefined && (
            <p>
              Another person with Owner access must approve this configuration. You cannot approve a
              change you made.
            </p>
          )}
          {workspace.original && (
            <p>
              Last request: {outcomeText(workspace.original.action, workspace.original.outcome)}{" "}
              <StaffTime instant={workspace.original.occurredAt} />
            </p>
          )}
          <div className="store-setup-actions">
            <button
              type="button"
              disabled={locked || !props.saved || setupIncomplete || setupOutdated || openByAnother}
              onClick={() => void act("Materialize")}
            >
              Create configuration from saved setup
            </button>
            <button
              type="button"
              disabled={locked || withdrawal !== undefined || latest?.lifecycle !== "Draft"}
              onClick={() => void act("Validate")}
            >
              Validate configuration
            </button>
            <button
              type="button"
              disabled={
                locked || withdrawal !== undefined || latest?.lifecycle !== "Draft" || !ready
              }
              onClick={() => void act("Submit")}
            >
              Submit configuration for review
            </button>
            <button
              type="button"
              disabled={
                locked ||
                withdrawal !== undefined ||
                latest?.lifecycle !== "PendingApproval" ||
                ownChange ||
                !ready
              }
              onClick={() => void act("Approve")}
            >
              Approve configuration independently
            </button>
            <button
              type="button"
              disabled={
                locked || withdrawal !== undefined || latest?.lifecycle !== "Approved" || !ready
              }
              onClick={() => void act("Publish")}
            >
              Publish Store configuration
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function appendStoreConfigurationHistory(
  previous: readonly StoreConfigurationOrdinaryHistoryEntry[],
  page: StoreConfigurationOrdinaryHistory,
): readonly StoreConfigurationOrdinaryHistoryEntry[] {
  const last = previous.at(-1);
  if (
    !last ||
    page.beforeSequence !== last.sequenceNumber ||
    page.entries.some(
      (e) =>
        e.sequenceNumber >= last.sequenceNumber ||
        previous.some((old) => old.operationReference === e.operationReference),
    )
  )
    throw new StoreSetupClientError("Conflict");
  return Object.freeze([...previous, ...page.entries]);
}
export function StoreConfigurationHistoryView({
  entries,
}: {
  readonly entries: readonly StoreConfigurationOrdinaryHistoryEntry[];
}) {
  return (
    <ol>
      {entries.map((entry) => (
        <li key={entry.operationReference}>
          <p>
            {actionLabel[entry.command] ?? "Changed"} · Version{" "}
            {entry.configuration.configurationVersion} ·{" "}
            {storeConfigurationStateLabel(entry.configuration.lifecycle)} ·{" "}
            <StaffTime instant={entry.occurredAt} />
          </p>
        </li>
      ))}
    </ol>
  );
}
