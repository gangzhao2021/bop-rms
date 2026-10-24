import { t } from "./i18n/i18n.js";
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
  Materialize: t("Create configuration from saved setup"),
  SaveDraft: t("Created from saved setup"),
  Validate: "Checked",
  Submit: t("Sent for approval"),
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
  Materialize: t("Configuration created from the saved setup."),
  Validate: t("Configuration checked."),
  Submit: t("Configuration sent for approval."),
  Approve: t("Configuration approved."),
  Publish: t("Configuration published."),
};
/** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner's own approval, given alone. */
const soleOperatorDoneText = t("Configuration approved by you alone as sole operator.");
const outcomeText = (action: string, outcome: "Committed" | "Abandoned") =>
  outcome === "Committed"
    ? (doneText[action] ?? t("Change recorded."))
    : t("That request did not go through; nothing changed.");
/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: each publication check in staff words — what passed, or
 * what blocks it and where to fix it. Every check blocks sending, approval and publication.
 */
const checkText: Record<StoreConfigurationPublicationCheckCode, { pass: string; fail: string }> = {
  Tax: {
    pass: t("Tax settings are the ones in force for this Store."),
    fail: t(
      "Tax settings are not the ones in force for this Store, or their registration or review has expired. Use the live Store's settings above, and check Tax review.",
    ),
  },
  BrandSettings: {
    pass: t("Brand settings are the same as the live Store's."),
    fail: t("Brand settings differ from the live Store's. Use the live Store's settings above."),
  },
  TimeZone: {
    pass: t("The time zone is the Store's own time zone."),
    fail: t("The time zone must be the Store's own time zone. Change it in step 2."),
  },
  BusinessDayStart: {
    pass: t("The business day starts at the same time as now."),
    fail: t(
      "The business day must start at the same time as it does now, so past days and reports keep their boundaries. Change it back in step 2.",
    ),
  },
  Hours: {
    pass: t("Opening hours are complete."),
    fail: t(
      "Opening hours need at least one opening period, and each period may only use service modes this Store offers. Check steps 3 and 4.",
    ),
  },
  EffectiveDate: {
    pass: t("It takes effect as soon as it is published."),
    fail: t(
      "This configuration would take effect later or end on a date. Use the live Store's settings above so it takes effect when published, then save and create it again.",
    ),
  },
  Fees: {
    pass: t("Fees are set."),
    fail: t("A fee that is On may only apply to service modes this Store offers. Check step 5."),
  },
  GoLive: {
    pass: t("This Store's go-live check is approved."),
    fail: t(
      "This Store's go-live check is not approved, so its configuration cannot be published.",
    ),
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
    <section aria-label={t("Publication checks")}>
      <h4>{t("Before it can be published")}</h4>
      <p>
        {t("{value} Checked", {
          value:
            blocked === 0
              ? t("Every check passed.")
              : t(
                  "{blocked} {value} attention before this can be sent for approval or published.",
                  { blocked: blocked, value: blocked === 1 ? "check needs" : "checks need" },
                ),
        })}{" "}
        <StaffTime instant={checks.checkedAt} />.
      </p>
      <ul>
        {checks.checks.map((check) => (
          <li key={check.code}>
            {check.outcome === "Pass" ? t("Ready: ") : t("Needs attention: ")}
            {check.outcome === "Pass" ? checkText[check.code].pass : checkText[check.code].fail}
          </li>
        ))}
      </ul>
    </section>
  );
}
/** WP-2423 (2026-10-16 v15): said after a withdrawal returned Store setup's hours. */
export const RESTORED_HOURS_NOTE = t(
  " The saved Store setup is back to the published opening hours.",
);
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
  /** WP-2423 (2026-10-16 v15): Store setup's saved hours changed (restored after a withdrawal). */
  readonly onSetupChanged?: () => void;
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
  Invalid: t("This configuration request is invalid."),
  Stale: t("The current configuration observation expired. Refresh before a new request."),
  Denied: t(
    "Current permission or session refused this request. Keep the original and retry after access is restored.",
  ),
  Conflict: t(
    "The saved source or configuration changed. Refresh before a new request; recover any pending original first.",
  ),
  ScopeChanged: t(
    "The selected Store or Actor changed. Return to the original scope to recover its request.",
  ),
  Unavailable: t(
    "Store configuration could not be loaded. Try again; any request still waiting is kept.",
  ),
  NotRegistered: t("No tax classifications are set up for this Brand yet."),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  SoleOperatorNotInEffect: t(
    "Sole operator is not in effect for you now (it is off, or someone else also holds Owner access here), so another person with Owner access must approve this. Recover the request, then refresh.",
  ),
  SoleOperatorNeedsVerification: t(
    "Your verification is more than 15 minutes old, so the approval was not recorded. Recover the request, verify again, then approve.",
  ),
  SoleOperatorOff: t(
    "Sole operator is off, so another person with Owner access must approve this. Recover the request. If you run this business on your own, turn on Sole operator on the Approvals page, then approve again.",
  ),
  NotYourChange: t(
    "Only the person who made this configuration can check it or send it for approval, so nothing was recorded. Recover the request; ask them to, or approve or decline it.",
  ),
  SetupIncomplete: t(
    "The saved setup still has settings that are not set, so nothing was created. Recover the request, finish those settings in the earlier steps and save, then create the configuration.",
  ),
  SetupOutdated: t(
    "The Store's configuration changed after this setup was saved, so nothing was created. Recover the request, save the setup again, then create the configuration.",
  ),
  OpenChangeByAnother: t(
    "Someone else's configuration change is still waiting, so nothing was created. Recover the request; then it must be approved and published, or declined, first.",
  ),
  Withdrawn: t(
    "This configuration was withdrawn or declined, so this step was not recorded. Recover the request, then create a new configuration from the saved setup.",
  ),
  SoleOperatorApprovalInvalid: t(
    "This configuration was approved by you alone while Sole operator was off, so it cannot be published. Recover the request, withdraw it, then send a new change for approval.",
  ),
  OutcomeUnknown: t(
    "The result is unknown. Recover the original request before sending another command.",
  ),
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
        t("{value} Current configuration refreshed.", {
          value:
            approvalMode !== undefined && receipt.outcome === "Committed"
              ? soleOperatorDoneText
              : outcomeText(action, receipt.outcome),
        }),
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
      const { kind, setupHoursRestored } = await withdrawStoreConfiguration(
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
            ? t(
                "Version {configurationVersion} withdrawn. It can no longer be approved or published.{value}",
                {
                  configurationVersion: target.configurationVersion,
                  value: setupHoursRestored ? RESTORED_HOURS_NOTE : "",
                },
              )
            : t(
                "Version {configurationVersion} declined. It can no longer be approved or published.{value}",
                {
                  configurationVersion: target.configurationVersion,
                  value: setupHoursRestored ? RESTORED_HOURS_NOTE : "",
                },
              ),
        );
        if (setupHoursRestored) props.onSetupChanged?.();
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
          t("{action} Current configuration refreshed.", {
            action: outcomeText(original.action, result.receipt.outcome),
          }),
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
    <section className="store-setup-review" aria-label={t("Store configuration publication")}>
      <h3>{t("Store configuration publication")}</h3>
      <p>
        {t(
          "A saved setup draft does not change the live Store. Create a configuration from it, have it approved, then publish it.",
        )}
      </p>
      {busy && <p role="status">{t("Loading Store configuration…")}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <>
          <p>
            {t(
              "An earlier {value} request was not confirmed. Recover it before making another change; the saved setup is kept.",
              { value: requestLabel[pending.action] ?? t("configuration") },
            )}
          </p>
          <button type="button" disabled={busy} onClick={() => void recover()}>
            {t("Recover original configuration request")}
          </button>
        </>
      )}
      <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>
        {t("Refresh Store configuration")}
      </button>
      <section aria-label={t("Store configuration operation history")}>
        <h3>{t("Recorded configuration history")}</h3>
        <p>{t("Every recorded change to this Store’s configuration, newest first.")}</p>
        <button
          type="button"
          disabled={busy || historyBusy || !!props.freshDisabled}
          onClick={() => void loadHistory()}
        >
          {t("Refresh configuration history")}
        </button>
        {historyBusy && <p role="status">{t("Loading configuration history…")}</p>}
        {historyError && <p role="alert">{historyError}</p>}
        {historyLoaded && history.length === 0 && (
          <p>{t("No configuration changes have been recorded yet.")}</p>
        )}
        <StoreConfigurationHistoryView entries={history} />
        {nextHistory !== null && (
          <button
            type="button"
            disabled={busy || historyBusy || !!props.freshDisabled}
            onClick={() => void loadHistory(true)}
          >
            {t("Load older changes")}
          </button>
        )}
      </section>
      {workspace && (
        <>
          <dl>
            <dt>{t("Latest recorded configuration")}</dt>
            <dd>
              {latest
                ? t("Version {configurationVersion} · {value}", {
                    configurationVersion: latest.configurationVersion,
                    value: withdrawal
                      ? withdrawal.kind === "Withdrawn"
                        ? "Withdrawn"
                        : "Declined"
                      : storeConfigurationStateLabel(latest.lifecycle),
                  })
                : t("None recorded")}
            </dd>
            <dt>{t("Current published configuration")}</dt>
            <dd>
              {current
                ? t("Version {configurationVersion} · {lifecycle}", {
                    configurationVersion: current.configurationVersion,
                    lifecycle: storeConfigurationStateLabel(current.lifecycle),
                  })
                : t("Nothing published yet")}
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
                {t("It must be approved and published by")}{" "}
                <StaffTime
                  instant={new Date(
                    Date.parse(latest.createdAt) + publicationWindowMs,
                  ).toISOString()}
                />
                {t("; after that, create it again from the saved setup.")}
              </p>
            )}
          {withdrawal && latest && (
            <p>
              {t("Version {configurationVersion} was {value}{value2}", {
                configurationVersion: latest.configurationVersion,
                value: withdrawal.kind === "Withdrawn" ? t("withdrawn") : t("declined"),
                value2: withdrawal.byYou ? t(" by you") : "",
              })}{" "}
              <StaffTime instant={withdrawal.withdrawnAt} />
              {t(". It can no longer be approved or published. {value}", {
                value: setupOutdated
                  ? t(
                      "To create a new configuration, save the setup again (Save setup draft, it then builds on the latest configuration), then create it.",
                    )
                  : t("Create a new configuration from the saved setup."),
              })}
            </p>
          )}
          {openByAnother && latest && (
            <section aria-label={t("Configuration waiting from someone else")}>
              <p>
                {t(
                  "Version {configurationVersion}, made by someone else, is {value}. A new configuration cannot be created until it is approved and published, or declined. Declining keeps it in the history; the person who made it can make a new change.",
                  {
                    configurationVersion: latest.configurationVersion,
                    value: storeConfigurationStateLabel(latest.lifecycle).toLowerCase(),
                  },
                )}
              </p>
              {!declining ? (
                <button type="button" disabled={locked} onClick={() => setDeclining(true)}>
                  {t("Decline version {configurationVersion}", {
                    configurationVersion: latest.configurationVersion,
                  })}
                </button>
              ) : (
                <div role="group" aria-label={t("Decline this configuration")}>
                  <p>
                    {t(
                      "Decline version {configurationVersion}? It stays in the history and cannot be approved or published. The person who made it sees that it was declined{value}.",
                      {
                        configurationVersion: latest.configurationVersion,
                        value: declineReason === "" ? "" : t(" and why"),
                      },
                    )}
                  </p>
                  <label>
                    {t("Reason (optional)")}
                    <select
                      value={declineReason}
                      disabled={locked}
                      onChange={(event) =>
                        setDeclineReason(
                          event.currentTarget.value as StoreConfigurationDeclineReason,
                        )
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
                    disabled={locked}
                    onClick={() => {
                      setDeclining(false);
                      void withdrawLatest(declineReason === "" ? undefined : declineReason);
                    }}
                  >
                    {t("Decline version {configurationVersion}", {
                      configurationVersion: latest.configurationVersion,
                    })}
                  </button>{" "}
                  <button type="button" disabled={locked} onClick={() => setDeclining(false)}>
                    {t("Keep it")}
                  </button>
                </div>
              )}
            </section>
          )}
          {openYours && latest && (
            <section aria-label={t("Your configuration waiting")}>
              <p>
                {t("Your version {configurationVersion} is {value}. {value2}", {
                  configurationVersion: latest.configurationVersion,
                  value: storeConfigurationStateLabel(latest.lifecycle).toLowerCase(),
                  value2: createdFromSaved
                    ? t(
                        "It was created from this saved setup. To change it, change the setup and save it, then create a new configuration (it replaces version {configurationVersion}); or withdraw it to stop it being approved.",
                        { configurationVersion: latest.configurationVersion },
                      )
                    : t(
                        "Creating a new configuration from the saved setup replaces it; or withdraw it to stop it being approved.",
                      ),
                })}
              </p>
              <button type="button" disabled={locked} onClick={() => void withdrawLatest()}>
                {t("Withdraw version {configurationVersion}", {
                  configurationVersion: latest.configurationVersion,
                })}
              </button>
            </section>
          )}
          {setupOutdated && !openByAnother && !createdFromSaved && withdrawal === undefined && (
            <p>
              {t(
                "The Store’s configuration changed after this setup was saved. Save the setup again (it then builds on the latest configuration) before creating a configuration.",
              )}
            </p>
          )}
          {createdFromSaved && !openLatest && withdrawal === undefined && latest && (
            <p>
              {t(
                "Version {configurationVersion} was created from this saved setup and is {value}. To change the Store again, change the setup and save it, then create a new configuration.",
                {
                  configurationVersion: latest.configurationVersion,
                  value: storeConfigurationStateLabel(latest.lifecycle).toLowerCase(),
                },
              )}
            </p>
          )}
          {setupIncomplete && (
            <p>
              {t(
                "A configuration cannot be created yet: the saved setup still has {value} not set: {setupMissing}. Set {value2}, save the setup draft, then create the configuration.",
                {
                  value:
                    setupMissing.length === 1
                      ? t("a setting")
                      : t("{length} settings", { length: setupMissing.length }),
                  setupMissing: storeSetupMissingText(setupMissing),
                  value2: setupMissing.length === 1 ? t("it") : t("them"),
                },
              )}
            </p>
          )}
          {ownChange && latest && soleOperator !== undefined && (
            <section aria-label={t("Approve your own configuration")}>
              <h4>{t("Approval")}</h4>
              <SoleOperatorSelfApproval
                gate={soleOperator}
                csrf={props.csrf}
                summary={
                  <p>
                    {t(
                      "Version {configurationVersion}, created from saved setup{value}. {value2} Once approved, you can publish it to the live Store.",
                      {
                        configurationVersion: latest.configurationVersion,
                        value: latest.setupBasis
                          ? ` revision ${latest.setupBasis.sourceRevision}`
                          : "",
                        value2: ready
                          ? t("Every check above has passed.")
                          : t("Some checks above still need attention."),
                      },
                    )}
                  </p>
                }
                what={t("this Store configuration")}
                permissionName={t("Owner access to this Store")}
                actionLabel={t("Approve configuration on my own")}
                busy={locked || !ready}
                onApprove={() => void act("Approve", "SoleOperator")}
              />
            </section>
          )}
          {ownChange && soleOperator === undefined && latest?.setupBasis === undefined && (
            <p>
              {t(
                "This is an opening hours change. Approve it (on your own as sole operator, when that applies) and publish it on Hours & ordering.",
              )}
            </p>
          )}
          {ownChange && soleOperator === undefined && latest?.setupBasis !== undefined && (
            <p>
              {t(
                "Another person with Owner access must approve this configuration. You cannot approve a change you made.",
              )}
            </p>
          )}
          {workspace.original && (
            <p>
              {t("Last request: {action}", {
                action: outcomeText(workspace.original.action, workspace.original.outcome),
              })}{" "}
              <StaffTime instant={workspace.original.occurredAt} />
            </p>
          )}
          <div className="store-setup-actions">
            <button
              type="button"
              disabled={locked || !props.saved || setupIncomplete || setupOutdated || openByAnother}
              onClick={() => void act("Materialize")}
            >
              {t("Create configuration from saved setup")}
            </button>
            <button
              type="button"
              disabled={locked || withdrawal !== undefined || latest?.lifecycle !== "Draft"}
              onClick={() => void act("Validate")}
            >
              {t("Validate configuration")}
            </button>
            <button
              type="button"
              disabled={
                locked || withdrawal !== undefined || latest?.lifecycle !== "Draft" || !ready
              }
              onClick={() => void act("Submit")}
            >
              {t("Submit configuration for review")}
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
              {t("Approve configuration independently")}
            </button>
            <button
              type="button"
              disabled={
                locked || withdrawal !== undefined || latest?.lifecycle !== "Approved" || !ready
              }
              onClick={() => void act("Publish")}
            >
              {t("Publish Store configuration")}
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
            {t("{value} · Version {configurationVersion} · {lifecycle} ·", {
              value: actionLabel[entry.command] ?? t("Changed"),
              configurationVersion: entry.configuration.configurationVersion,
              lifecycle: storeConfigurationStateLabel(entry.configuration.lifecycle),
            })}{" "}
            <StaffTime instant={entry.occurredAt} />
          </p>
        </li>
      ))}
    </ol>
  );
}
