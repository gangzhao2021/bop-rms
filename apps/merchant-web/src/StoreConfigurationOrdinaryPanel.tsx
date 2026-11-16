import { t } from "./i18n/i18n.js";
import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
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
import {
  storeSetupMissingItems,
  storeSetupMissingText,
  type StoreSetupLayout,
} from "./store-setup-missing.js";
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
import { storeConfigurationStateLabel } from "./StoreConfigurationEditor.js";
import { wordGap } from "./word-gap.js";
import { StaffTime } from "./StoreTime.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
/** Configuration steps in staff words (WP-2423: no command or outcome codes on screen). */
const actionLabel: Record<string, string> = {
  Materialize: t("Create configuration from saved setup"),
  SaveDraft: t("Created from saved setup"),
  Validate: t("Checked"),
  Submit: t("Sent for approval"),
  Approve: t("Approved"),
  Publish: t("Published"),
};
/** WP-2423 store-service-controls (v15 M33): the step's name in the staff's language. */
const requestLabel = (action: string): string | undefined =>
  ({
    Materialize: t("create"),
    Validate: t("check"),
    Submit: t("send for approval"),
    Approve: t("approve"),
    Publish: t("publish"),
  })[action];
/** The notice for a request whose result is not known yet, in the staff's language. */
export const storeConfigurationPendingText = (action: string): string =>
  t(
    "An earlier {value} request was not confirmed. Recover it before making another change; the saved setup is kept.",
    { value: requestLabel(action) ?? t("configuration") },
  );
const doneText: Record<string, string> = {
  Materialize: t("Change created from the saved setup."),
  Validate: t("Settings checked."),
  Submit: t("Sent for approval."),
  Approve: t("Change approved."),
  Publish: t("Published. Customers and staff see the new settings now."),
};
/** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner's own approval, given alone. */
const soleOperatorDoneText = t("Approved by you alone as sole operator.");
/**
 * b19 review: once the page shows the state an action led to, what the action did is said as the
 * one status sentence (not a second line repeating it). Publish adds what it means for customers.
 */
const doneStatus: Record<string, { readonly lifecycle: string; readonly text: string }> = {
  Materialize: {
    lifecycle: "Draft",
    text: t("Change created from the saved setup, not yet sent for approval."),
  },
  Validate: { lifecycle: "Draft", text: t("Settings checked, not yet sent for approval.") },
  Submit: { lifecycle: "PendingApproval", text: t("Sent for approval, waiting to be approved.") },
  Approve: { lifecycle: "Approved", text: t("Change approved, waiting to be published.") },
};
const soleOperatorDoneStatus = t(
  "Approved by you alone as sole operator, waiting to be published.",
);
/** What an action that went through did: `notice` is said when the page does not show its state. */
interface StoreConfigurationDone {
  readonly action: string;
  readonly sole: boolean;
  readonly notice: string;
}
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
    fail: t(
      "The time zone must be the Store's own time zone. Change it in the time zone and business day step.",
    ),
  },
  BusinessDayStart: {
    pass: t("The business day starts at the same time as now."),
    fail: t(
      "The business day must start at the same time as it does now, so past days and reports keep their boundaries. Change it back in the time zone and business day step.",
    ),
  },
  Hours: {
    pass: t("Opening hours are complete."),
    fail: t(
      "Opening hours need at least one opening period, and each period may only use service modes this Store offers. Check the services and the opening hours.",
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
    fail: t(
      "A fee that is On may only apply to service modes this Store offers. Check the fees, tax and payment step.",
    ),
  },
  GoLive: {
    pass: t("This Store's go-live check is approved."),
    fail: t(
      "This Store's go-live check is not approved, so its configuration cannot be published.",
    ),
  },
  // M109 (DEC-STORE-PHONE-BEFORE-PICKUP): pickup guests are not in front of staff.
  StorePhone: {
    pass: t("The store has a phone number for pickup guests, or does not offer pickup."),
    fail: t(
      "This setup offers pickup, and pickup guests call the store about allergies or their order. Add the store's phone number in Store details, or take pickup out of the services this setup offers.",
    ),
  },
};
const checksPass = (checks: StoreConfigurationPublicationChecks | undefined) =>
  checks === undefined || checks.checks.every((check) => check.outcome === "Pass");
/** A configuration created from setup must be approved and published within 14 days. */
export const publicationWindowMs = 14 * 86400000;
export function StoreConfigurationPublicationChecklist({
  checks,
}: {
  readonly checks: StoreConfigurationPublicationChecks;
}) {
  // b19: only what blocks it is listed, each with where to fix it; what passed is not repeated.
  const failing = checks.checks.filter((check) => check.outcome === "Fail");
  return (
    <section aria-label={t("Publication checks")}>
      <h4>{t("Before it can be published")}</h4>
      <p>
        {failing.length === 0
          ? t("Every check passed.")
          : failing.length === 1
            ? t("1 thing needs fixing before this can be sent for approval or published.")
            : t("{count} things need fixing before this can be sent for approval or published.", {
                count: failing.length,
              })}{" "}
        <span className="store-setup-publish__when">
          {t("Checked")} <StaffTime instant={checks.checkedAt} />
        </span>
      </p>
      {failing.length > 0 && (
        <ul>
          {failing.map((check) => (
            <li key={check.code}>{checkText[check.code].fail}</li>
          ))}
        </ul>
      )}
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
  /** b18: which steps Store setup shows (an open Store's approval steps, or a Store being opened). */
  readonly setupLayout?: StoreSetupLayout;
  /**
   * b20: a step here changed where the change stands (created, sent, approved, published,
   * withdrawn or declined), so a notice about an earlier action on the page no longer applies.
   */
  readonly onChanged?: () => void;
  /** b20: the page has edits that are not saved yet; the steps here use the saved setup only. */
  readonly unsavedEdits?: boolean;
  /**
   * b22: whether the device is online. Earlier changes are a read of past facts: the rows already
   * shown stay while offline or while edits are not saved; only loading more waits for the
   * connection, and the list reads again by itself once it is back.
   */
  readonly online?: boolean;
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
/** The command for one step of a configuration: a new one is made from the saved setup. */
export async function buildStoreConfigurationCommand(input: {
  readonly scope: StoreSetupScope;
  readonly action: StoreConfigurationOrdinaryAction;
  readonly operationReference: string;
  readonly expectedHead: StoreConfigurationOrdinaryWorkspace["expectedHead"];
  readonly saved: StoreSetupSnapshot | null;
}): Promise<StoreConfigurationOrdinaryCommand> {
  const { scope, action, saved } = input;
  const base = {
    profile: "StoreConfigurationOrdinaryCommandV1" as const,
    ...scope,
    operationReference: input.operationReference,
    expectedHead: input.expectedHead,
  };
  if (action !== "Materialize") return { ...base, action };
  if (
    !saved ||
    saved.tenantReference !== scope.tenantReference ||
    saved.brandReference !== scope.brandReference ||
    saved.storeReference !== scope.storeReference
  )
    throw new StoreSetupClientError("Invalid");
  return {
    ...base,
    action,
    setupSelector: {
      setupDraftReference: saved.setupDraftReference,
      sourceRevision: saved.revision,
      sourceSnapshotDigest: await publicationValueDigest(saved),
    },
    reasonCode: "STORE_SETUP_MATERIALIZATION",
  };
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
    "Sole operator is off, so another person with Owner access must approve this. Recover the request. If you run this business on your own, turn on Sole operator in Store setup, then approve again.",
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
  ReceiptTemplateUnavailable: t(
    "This Store has no receipt template in use yet, so nothing was created. In the fees, tax and payment step, choose or create this Store's receipt template and save the setup, then create the configuration again.",
  ),
  StorePhoneRequired: t(
    "This setup offers pickup, and pickup guests call the store about allergies or their order, so it was not sent. Add the store's phone number in Store details, or take pickup out of the services this setup offers, then send it again.",
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
    [historyLoaded, setHistoryLoaded] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const online = props.online ?? true;
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
    [done, setDone] = useState<StoreConfigurationDone | null>(null),
    [notOffered, setNotOffered] = useState(false),
    // WP-2423 (v15): declining someone else's configuration is confirmed, with an optional reason.
    [declining, setDeclining] = useState(false),
    [declineReason, setDeclineReason] = useState<StoreConfigurationDeclineReason | "">(""),
    // b19: withdrawing your own change is confirmed first, like declining.
    [withdrawing, setWithdrawing] = useState(false);
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
    // b22: only another Store or Actor (or session) starts the list again. Going offline or starting
    // an edit no longer clears the rows already shown.
  }, [identity, historyClient]);
  // b22: the list reads when it is opened, by itself once the connection is back and after a change
  // of Store or session. Rows already shown for the same Store stay, with any newer ones on top.
  const historyIdentity = useRef<string | null>(null);
  useEffect(() => {
    if (!historyOpen || !online) return;
    void loadHistory(false, historyIdentity.current === identity && history.length > 0);
  }, [online, historyOpen, identity]);
  async function loadHistory(more = false, keep = false) {
    if (!online || (more && (historyBusy || nextHistory === null))) return;
    historyIdentity.current = identity;
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
        if (keep) {
          const merged = mergeNewestStoreConfigurationHistory(history, nextHistory, page);
          setHistory(merged.entries);
          setNextHistory(merged.nextBeforeSequence);
        } else {
          setHistory(more ? appendStoreConfigurationHistory(history, page) : page.entries);
          setNextHistory(page.nextBeforeSequence);
        }
        setHistoryLoaded(true);
      }
    } catch (e) {
      if (current()) setHistoryError(historyMessage(e));
    } finally {
      if (current()) setHistoryBusy(false);
    }
  }
  /**
   * b21: a history read that fails for an outage says so in plain words; real refusals keep theirs.
   * b21 review: only an outage (no answer, or an answer that never arrived whole) asks to check the
   * connection; an answer that was refused or cannot be read (Invalid, Conflict, a row the reader
   * refuses) says that part cannot be shown, with no promise that trying again helps.
   */
  const historyMessage = (e: unknown) => {
    const outage =
      e instanceof StoreSetupClientError &&
      (e.code === "Unavailable" || e.code === "OutcomeUnknown");
    if (outage)
      return t("Earlier changes could not be loaded just now. Check the connection and try again.");
    if (
      e instanceof StoreSetupClientError &&
      (e.code === "Denied" || e.code === "FullSignInRequired" || e.code === "ScopeChanged")
    )
      return messages[e.code];
    return t(
      "This part of the earlier changes cannot be shown. Everything else keeps working as usual.",
    );
  };
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
    setDone(null);
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
    setDone(null);
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
    setDone(null);
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
      const command = await buildStoreConfigurationCommand({
        scope: props.scope,
        action,
        operationReference: serviceOperationReference(),
        expectedHead: baseline.expectedHead,
        saved,
      });
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
      // b19: what happened, in plain words; said as the status sentence when the page shows it.
      if (receipt.outcome === "Committed") props.onChanged?.();
      if (receipt.outcome === "Committed")
        setDone({
          action,
          sole: approvalMode !== undefined,
          notice:
            approvalMode !== undefined ? soleOperatorDoneText : outcomeText(action, "Committed"),
        });
      else setNotice(outcomeText(action, receipt.outcome));
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
    setDone(null);
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
        props.onChanged?.();
        // WP-2423 (v15 D6): what to do next is said from the current state below, not here.
        // b19: no version numbers on the page; the status sentence says it was withdrawn or
        // declined, so only the hours note is added to it.
        setDone({
          action: "Withdraw",
          sole: false,
          notice:
            kind === "Withdrawn"
              ? t("Change withdrawn. It can no longer be approved or published.")
              : t("Change declined. It can no longer be approved or published."),
        });
        if (setupHoursRestored) setNotice(RESTORED_HOURS_NOTE.trim());
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
        if (result.receipt.outcome === "Committed") props.onChanged?.();
        if (result.receipt.outcome === "Committed")
          setDone({
            action: original.action,
            sole: false,
            notice: outcomeText(original.action, "Committed"),
          });
        else setNotice(outcomeText(original.action, result.receipt.outcome));
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
  useEffect(() => {
    setNotice(null);
    setDone(null);
  }, [savedRevision]);
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
    setupMissing =
      props.saved === null
        ? []
        : storeSetupMissingItems(props.saved.content, props.setupLayout ?? "Opening"),
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
  const next =
    workspace === null || pending
      ? null
      : storeConfigurationNextStep({
          saved: props.saved !== null,
          setupIncomplete,
          setupOutdated,
          openByAnother,
          openYours,
          lifecycle: openLatest ? latest.lifecycle : null,
          ownChange,
          soleOperator: soleOperator !== undefined,
        });
  const failing = checks?.checks.filter((check) => check.outcome === "Fail") ?? [];
  // Said with sending for approval: how an Owner who runs the business alone approves it.
  const soleOperatorHint = (
    <p>
      {t("If you run the business alone, turn on")}
      {wordGap()}
      <Link
        to={`/app/organization/stores/${props.scope.storeReference}/setup?section=access#sole-operator`}
      >
        {t("Sole operator")}
      </Link>
      {wordGap()}
      {t("to approve it yourself after confirming it is you.")}
    </p>
  );
  // Sending, approving and publishing need every check to pass; creating a change does not.
  const blocked = (action: StoreConfigurationStep["action"]) =>
    locked ||
    (action === "Materialize"
      ? !props.saved || setupIncomplete || setupOutdated || openByAnother
      : !ready);
  // The Owner's own approval as sole operator has its own solid button; the step is text then.
  const selfApproval = ownChange && soleOperator !== undefined && latest !== undefined;
  // b19 review: the status sentence says what an action just did once the page shows its result.
  const doneShown =
    done === null || !workspace
      ? false
      : done.action === "Withdraw"
        ? withdrawal !== undefined
        : done.action === "Publish"
          ? !openLatest && withdrawal === undefined && current !== null && current !== undefined
          : openLatest && latest.lifecycle === doneStatus[done.action]?.lifecycle;
  return (
    <section
      className="store-setup-review store-setup-publish"
      aria-label={t("Store configuration publication")}
      aria-busy={busy}
    >
      {/* b19 (Owner: step 4 was messy): where the change stands in one sentence, then the one
          thing to do next and what it does; the record of earlier changes is folded away. */}
      <h4>{t("Approval and publishing")}</h4>
      {workspace ? (
        <p className="store-setup-publish__status" role={doneShown ? "status" : undefined}>
          {doneShown && done && done.action !== "Withdraw" && done.action !== "Publish" ? (
            done.sole ? (
              soleOperatorDoneStatus
            ) : (
              doneStatus[done.action]?.text
            )
          ) : (
            <StoreConfigurationStatus
              latest={latest ?? null}
              current={current ?? null}
              withdrawal={withdrawal}
              openLatest={openLatest}
              openByAnother={openByAnother}
            />
          )}
          {doneShown && done?.action === "Publish" ? (
            <>
              {wordGap()}
              {t("Customers and staff see the new settings now.")}
            </>
          ) : null}
          {doneShown && notice ? (
            <>
              {wordGap()}
              {notice}
            </>
          ) : null}
        </p>
      ) : null}
      {busy && <p role="status">{t("Loading Store configuration…")}</p>}
      {error && <p role="alert">{error}</p>}
      {!doneShown && (notice || done) && (
        <p role="status">{[done?.notice, notice].filter((text) => text).join(wordGap())}</p>
      )}
      {pending && (
        <div className="store-setup-publish__next">
          <p>{storeConfigurationPendingText(pending.action)}</p>
          <button
            type="button"
            data-variant="primary"
            disabled={busy}
            onClick={() => void recover()}
          >
            {t("Recover original configuration request")}
          </button>
        </div>
      )}
      {workspace && (
        <>
          {checks && failing.length > 0 && (openLatest || next?.action === "Materialize") && (
            <StoreConfigurationPublicationChecklist checks={checks} />
          )}
          {openLatest && latest?.setupBasis !== undefined && (
            <p>
              {t("Approve and publish it by")}
              {wordGap()}
              <StaffTime
                instant={new Date(Date.parse(latest.createdAt) + publicationWindowMs).toISOString()}
              />
              {t("; after that it has to be created again.")}
            </p>
          )}
          {setupIncomplete && (
            <p>
              {t(
                "A change cannot be created yet: the saved setup still has {value} not set: {setupMissing}. Set {value2}, save as draft, then come back here.",
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
          {setupOutdated &&
            !openByAnother &&
            !setupIncomplete &&
            withdrawal !== undefined &&
            !props.unsavedEdits && (
              <p>
                {t(
                  "To make a new change, save as draft again (it then builds on the latest settings), then come back here.",
                )}
              </p>
            )}
          {setupOutdated &&
            !openByAnother &&
            !createdFromSaved &&
            !setupIncomplete &&
            withdrawal === undefined &&
            !openLatest &&
            !props.unsavedEdits && (
              <p>
                {t(
                  "The Store’s settings changed after this setup was saved. Save as draft again (it then builds on the latest settings), then come back here.",
                )}
              </p>
            )}
          {/* b20: with edits not saved yet, nothing here says everything is saved and published. */}
          {props.unsavedEdits && !pending && (
            <p>
              {t(
                "Some changes on this page are not saved yet, so the steps here wait. Save as draft first; the change is then created from what you saved.",
              )}
            </p>
          )}
          {createdFromSaved && !openLatest && withdrawal === undefined && !props.unsavedEdits && (
            <p>
              {t(
                "Everything saved in this setup is published. To change the Store again, change the setup, save as draft, then come back here.",
              )}
            </p>
          )}
          {openByAnother && (
            <p>
              {t(
                "A new change cannot be created until this one is approved and published, or declined. Declining keeps it in the history; the person who made it can make a new change.",
              )}
            </p>
          )}
          {ownChange && soleOperator !== undefined && latest && (
            <section
              className="store-setup-publish__next"
              aria-label={t("Approve your own change to the Store")}
            >
              <SoleOperatorSelfApproval
                gate={soleOperator}
                csrf={props.csrf}
                summary={
                  <p>
                    {/* b18: no version or revision numbers on the page. */}
                    {t(
                      "Created from the saved setup draft. {value2} Once approved, you can publish it to the live Store.",
                      {
                        value2: ready
                          ? t("Every check passed.")
                          : t("Some checks above still need attention."),
                      },
                    )}
                  </p>
                }
                // b20: the same word for the change as the rest of the step ("修改" in Chinese).
                yourPart={t("You made this change to the Store")}
                what={t("this change to the Store")}
                permissionName={t("Owner access to this Store")}
                actionLabel={t("Approve this change on my own")}
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
              {t("Another person with Owner access must approve it, because you made this change.")}
            </p>
          )}
          {next !== null && next.action !== "SoleOperator" && (
            <div className="store-setup-publish__next">
              <p>{next.effect}</p>
              {next.action === "Submit" && soleOperatorHint}
              <button
                type="button"
                data-variant={selfApproval ? undefined : "primary"}
                disabled={blocked(next.action)}
                onClick={() => void act(next.action as StoreConfigurationOrdinaryAction)}
              >
                {next.label}
              </button>
              {next.alternative !== undefined && next.alternative.action !== "SoleOperator" && (
                <button
                  type="button"
                  disabled={blocked(next.alternative.action)}
                  onClick={() =>
                    void act(next.alternative?.action as StoreConfigurationOrdinaryAction)
                  }
                >
                  {next.alternative.label}
                </button>
              )}
              {next.alternative?.action === "Submit" && soleOperatorHint}
            </div>
          )}
          {openByAnother && latest && declining && (
            <div role="group" aria-label={t("Decline this configuration")}>
              <p>
                {t(
                  "Decline this change? It stays in the history and cannot be approved or published. The person who made it sees that it was declined{value}.",
                  { value: declineReason === "" ? "" : t(" and why") },
                )}
              </p>
              <label>
                {t("Reason (optional)")}
                <select
                  value={declineReason}
                  disabled={locked}
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
              </label>
              <div className="store-setup-publish__more">
                <button
                  type="button"
                  data-variant="danger"
                  disabled={locked}
                  onClick={() => {
                    setDeclining(false);
                    void withdrawLatest(declineReason === "" ? undefined : declineReason);
                  }}
                >
                  {t("Decline this change")}
                </button>
                <button type="button" disabled={locked} onClick={() => setDeclining(false)}>
                  {t("Keep it")}
                </button>
              </div>
            </div>
          )}
          {openYours && latest && withdrawing && (
            <div role="group" aria-label={t("Withdraw this change")}>
              <p>
                {t(
                  "Withdraw this change? It stays in the history and can no longer be approved or published. The Store keeps running as it does today.",
                )}
              </p>
              <div className="store-setup-publish__more">
                <button
                  type="button"
                  data-variant="danger"
                  disabled={locked}
                  onClick={() => {
                    setWithdrawing(false);
                    void withdrawLatest();
                  }}
                >
                  {t("Withdraw this change")}
                </button>
                <button type="button" disabled={locked} onClick={() => setWithdrawing(false)}>
                  {t("Keep it")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <div className="store-setup-publish__more">
        {workspace && openYours && latest?.lifecycle === "Draft" && (
          <button type="button" disabled={locked} onClick={() => void act("Validate")}>
            {t("Check the settings again")}
          </button>
        )}
        {workspace && openYours && !withdrawing && (
          <button
            type="button"
            data-variant="danger"
            disabled={locked}
            onClick={() => setWithdrawing(true)}
          >
            {t("Withdraw this change")}
          </button>
        )}
        {workspace && openByAnother && !declining && (
          <button
            type="button"
            data-variant="danger"
            disabled={locked}
            onClick={() => setDeclining(true)}
          >
            {t("Decline this change")}
          </button>
        )}
        <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>
          {t("Refresh the status")}
        </button>
      </div>
      <details
        className="store-setup-publish__history"
        onToggle={(event) => {
          // b22: opening the list reads it (see the effect above), also when offline at first.
          setHistoryOpen(event.currentTarget.open);
        }}
      >
        <summary>{t("Earlier changes")}</summary>
        <section aria-label={t("Store configuration operation history")}>
          {historyBusy && <p role="status">{t("Loading earlier changes…")}</p>}
          {historyError && history.length === 0 && online && <p role="alert">{historyError}</p>}
          {historyLoaded && history.length === 0 && (
            <p>{t("No changes have been recorded yet.")}</p>
          )}
          <StoreConfigurationHistoryView entries={history} />
          {nextHistory !== null && (
            <button
              type="button"
              disabled={historyBusy || !online}
              onClick={() => void loadHistory(true)}
            >
              {t("Load older changes")}
            </button>
          )}
          {/* b21: a failed "load older" keeps the rows shown and says so beside the button. */}
          {historyError && history.length > 0 && online && (
            <p role="alert" className="store-setup-publish__history-error">
              {historyError}
            </p>
          )}
          {/* b22: offline, the rows stay; the list loads again by itself once the connection is back. */}
          {!online && (
            <p role="status" className="store-setup-publish__history-error">
              {t("Offline. Earlier changes load again by themselves once the connection is back.")}
            </p>
          )}
        </section>
      </details>
    </section>
  );
}

/** One step Store setup offers: the command, its button label and what it does, in staff words. */
export interface StoreConfigurationStep {
  readonly action: StoreConfigurationOrdinaryAction | "SoleOperator";
  readonly label: string;
  readonly effect: string;
  /**
   * b19 review: when the setup was saved again after your own open change was made, the next step
   * is to create the change again (as before, it replaces the open one); the open change's own step
   * stays offered as this quieter alternative, so nothing the old screen allowed is lost.
   */
  readonly alternative?: {
    readonly action: StoreConfigurationOrdinaryAction | "SoleOperator";
    readonly label: string;
  };
}
/**
 * b19: the one step Store setup offers next, from the state of the latest change (the same
 * commands and conditions as before; only one is the solid next step). "SoleOperator" is the
 * Owner's own approval with a step-up, shown by its own section.
 */
export function storeConfigurationNextStep(state: {
  readonly saved: boolean;
  readonly setupIncomplete: boolean;
  readonly setupOutdated: boolean;
  readonly openByAnother: boolean;
  readonly openYours: boolean;
  readonly lifecycle: "Draft" | "PendingApproval" | "Approved" | null;
  readonly ownChange: boolean;
  readonly soleOperator: boolean;
}): StoreConfigurationStep | null {
  // As before b19: a change can be created from the saved setup whenever it is saved, complete and
  // up to date and no one else has a change open — also over your own open change, which it replaces.
  const canCreate =
    state.saved && !state.setupIncomplete && !state.setupOutdated && !state.openByAnother;
  const own = (): StoreConfigurationStep | null => {
    switch (state.lifecycle) {
      case "Draft":
        return state.openYours
          ? {
              action: "Submit",
              label: t("Send it for approval"),
              effect: t(
                "Another person with Owner access approves it, then it can be published. The Store keeps running as it does today until then.",
              ),
            }
          : null;
      case "PendingApproval":
        if (state.ownChange)
          return state.soleOperator ? { action: "SoleOperator", label: "", effect: "" } : null;
        return {
          action: "Approve",
          label: t("Approve this change"),
          effect: t(
            "Once approved, it can be published. The Store keeps running as it does today until then.",
          ),
        };
      case "Approved":
        return {
          action: "Publish",
          label: t("Publish to the Store"),
          effect: t(
            "Publishing makes these settings live at once: customers and staff see them straight away.",
          ),
        };
      case null:
        return null;
    }
  };
  const step = own();
  if (!canCreate) return step;
  if (state.lifecycle === null || !state.openYours)
    return (
      step ?? {
        action: "Materialize",
        label: t("Create the change from the saved setup"),
        effect: t(
          "Each setting is checked against the Store as it runs today. Nothing changes for customers yet.",
        ),
      }
    );
  const recreate: StoreConfigurationStep = {
    action: "Materialize",
    label: t("Create the change again from the saved setup"),
    effect:
      state.lifecycle === "Draft"
        ? t(
            "The setup was saved again after this change was made, so what was saved since is not in it. Creating it again replaces this change with one that has it; nothing changes for customers yet.",
          )
        : state.lifecycle === "PendingApproval"
          ? t(
              "The setup was saved again after this change was sent, so what was saved since is not in the change waiting for approval. Creating it again replaces that change; the new one is then sent for approval again.",
            )
          : t(
              "The setup was saved again after this change was approved, so what was saved since is not in it. Creating it again replaces the approved change; the new one has to be approved again before it is published.",
            ),
  };
  if (step === null) return recreate;
  return {
    ...recreate,
    alternative: {
      action: step.action,
      label:
        step.action === "Submit"
          ? t("Or send this change for approval as it is")
          : step.action === "Publish"
            ? t("Or publish the approved change as it is")
            : step.label,
    },
  };
}

/** b19: where the latest change stands, in one sentence (no version numbers). */
function StoreConfigurationStatus({
  latest,
  current,
  withdrawal,
  openLatest,
  openByAnother,
}: {
  readonly latest: StoreConfigurationSnapshot | null;
  readonly current: StoreConfigurationSnapshot | null;
  readonly withdrawal: StoreConfigurationOrdinaryWorkspace["latestWithdrawal"];
  readonly openLatest: boolean;
  readonly openByAnother: boolean;
}) {
  if (withdrawal !== undefined)
    return (
      <>
        {withdrawal.kind === "Withdrawn"
          ? withdrawal.byYou
            ? t("You withdrew the last change on")
            : t("The last change was withdrawn on")
          : withdrawal.byYou
            ? t("You declined the last change on")
            : t("The last change was declined on")}
        {wordGap()}
        <StaffTime instant={withdrawal.withdrawnAt} />
        {t("; it will not be published.")}
      </>
    );
  if (openLatest && latest !== null)
    return (
      <>
        {openByAnother ? t("A change made by someone else: ") : null}
        {storeConfigurationStateLabel(latest.lifecycle)}
        {t(".")}
      </>
    );
  if (current !== null)
    return (
      <>
        {t("Published on")}
        {wordGap()}
        <StaffTime instant={current.updatedAt} />
        {t(".")}
      </>
    );
  return <>{t("Nothing has been published yet.")}</>;
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
/**
 * b22: the newest page read again (after reconnecting, or opening the list again) on top of the rows
 * already shown. Where it reaches the rows shown, they are kept below it, each newer row read from
 * the page; a page that does not reach them (more than a page of newer changes) is shown alone.
 */
export function mergeNewestStoreConfigurationHistory(
  previous: readonly StoreConfigurationOrdinaryHistoryEntry[],
  previousNext: number | null,
  page: StoreConfigurationOrdinaryHistory,
): {
  readonly entries: readonly StoreConfigurationOrdinaryHistoryEntry[];
  readonly nextBeforeSequence: number | null;
} {
  const first = previous[0],
    last = page.entries.at(-1);
  if (page.beforeSequence !== null) throw new StoreSetupClientError("Conflict");
  if (first === undefined || last === undefined)
    return { entries: page.entries, nextBeforeSequence: page.nextBeforeSequence };
  const reaches = page.nextBeforeSequence === null || last.sequenceNumber <= first.sequenceNumber;
  if (!reaches) return { entries: page.entries, nextBeforeSequence: page.nextBeforeSequence };
  const older = previous.filter((e) => e.sequenceNumber < last.sequenceNumber);
  return {
    entries: Object.freeze([...page.entries, ...older]),
    nextBeforeSequence: older.length > 0 ? previousNext : page.nextBeforeSequence,
  };
}
export function StoreConfigurationHistoryView({
  entries,
}: {
  readonly entries: readonly StoreConfigurationOrdinaryHistoryEntry[];
}) {
  return (
    <ol>
      {entries.flatMap((entry) => [
        // b20 (v15 live check): a withdrawal or decline is listed too, newest first, so the history
        // never suggests a change is still waiting.
        ...(entry.withdrawal === undefined
          ? []
          : [
              <li key={entry.operationReference + ":withdrawal"}>
                <span>
                  {entry.withdrawal.kind === "Withdrawn"
                    ? entry.withdrawal.byYou
                      ? t("Withdrawn by you")
                      : t("Withdrawn")
                    : entry.withdrawal.byYou
                      ? t("Declined by you")
                      : t("Declined")}
                </span>{" "}
                <span className="store-setup-publish__when">
                  <StaffTime instant={entry.withdrawal.withdrawnAt} />
                </span>
              </li>,
            ]),
        <li key={entry.operationReference}>
          {/* b19: what was done and when; no version numbers. */}
          <span>{actionLabel[entry.command] ?? t("Changed")}</span>{" "}
          <span className="store-setup-publish__when">
            <StaffTime instant={entry.occurredAt} />
          </span>
        </li>,
      ])}
    </ol>
  );
}
