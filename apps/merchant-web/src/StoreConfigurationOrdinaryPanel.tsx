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
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
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
}) {
  const check = () => {
    if (!input.isCurrent() || input.signal.aborted) denied();
  };
  check();
  await input.journal.reserve(input.prepared.cursor);
  input.onReserved(input.prepared.cursor);
  check();
  if (!input.canDispatch()) throw new StoreSetupClientError("Conflict");
  const receipt = await input.client.execute(input.prepared, {
    csrf: input.csrf,
    signal: input.signal,
  });
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
  OutcomeUnknown:
    "The result is unknown. Recover the original request before sending another command.",
};
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
    [notOffered, setNotOffered] = useState(false);
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
  async function act(action: StoreConfigurationOrdinaryAction) {
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
      });
      setWorkspace(after);
      setPending(null);
      setNotice(`${outcomeText(action, receipt.outcome)} Current configuration refreshed.`);
    } catch (e) {
      if (current()) setError(message(e));
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
  const onLive = props.onLiveConfiguration;
  useEffect(() => {
    if (workspace && onLive)
      onLive({ current: workspace.current, observedAt: workspace.observedAt });
  }, [workspace, onLive]);
  const latest = workspace?.latest,
    current = workspace?.current,
    checks = workspace?.publicationChecks,
    ready = checksPass(checks),
    locked = busy || historyBusy || !!pending || !!props.freshDisabled;
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
                ? `Version ${latest.configurationVersion} · ${storeConfigurationStateLabel(latest.lifecycle)}`
                : "None recorded"}
            </dd>
            <dt>Current published configuration</dt>
            <dd>
              {current
                ? `Version ${current.configurationVersion} · ${storeConfigurationStateLabel(current.lifecycle)}`
                : "Nothing published yet"}
            </dd>
          </dl>
          {latest && <StoreConfigurationFeeBasisView configuration={latest} />}{" "}
          {checks && <StoreConfigurationPublicationChecklist checks={checks} />}
          {latest?.setupBasis !== undefined &&
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
          {latest?.lifecycle === "PendingApproval" &&
            latest.authoredByReference === props.scope.actorReference && (
              <p>
                Another person with Owner access must approve this configuration. You cannot approve
                a change you made.
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
              disabled={locked || !props.saved}
              onClick={() => void act("Materialize")}
            >
              Create configuration from saved setup
            </button>
            <button
              type="button"
              disabled={locked || latest?.lifecycle !== "Draft"}
              onClick={() => void act("Validate")}
            >
              Validate configuration
            </button>
            <button
              type="button"
              disabled={locked || latest?.lifecycle !== "Draft" || !ready}
              onClick={() => void act("Submit")}
            >
              Submit configuration for review
            </button>
            <button
              type="button"
              disabled={
                locked ||
                latest?.lifecycle !== "PendingApproval" ||
                latest.authoredByReference === props.scope.actorReference ||
                !ready
              }
              onClick={() => void act("Approve")}
            >
              Approve configuration independently
            </button>
            <button
              type="button"
              disabled={locked || latest?.lifecycle !== "Approved" || !ready}
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
