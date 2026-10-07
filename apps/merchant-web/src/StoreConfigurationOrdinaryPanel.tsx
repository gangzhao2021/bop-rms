import { useEffect, useMemo, useRef, useState } from "react";
import {
  createStoreConfigurationOrdinaryClient,
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
} from "./store-configuration-pending-journal.js";
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
import { StoreConfigurationFeeBasisView } from "./StoreConfigurationEditor.js";
export interface StoreConfigurationOrdinaryPanelProps {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly saved: StoreSetupSnapshot | null;
  readonly freshDisabled?: boolean;
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
  Unavailable: "Configuration is unavailable. Retry without discarding a pending original.",
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
    [notice, setNotice] = useState<string | null>(null);
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
        if (current()) setError(message(e));
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
      setNotice(`${action}: ${receipt.outcome}. Current configuration refreshed.`);
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
          `Original ${original.action}: ${result.receipt.outcome}. Current configuration refreshed.`,
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
  const latest = workspace?.latest,
    current = workspace?.current,
    locked = busy || historyBusy || !!pending || !!props.freshDisabled;
  return (
    <section className="store-setup-review" aria-label="Store configuration publication">
      <h3>Store configuration publication</h3>
      <p>
        Saved setup drafts are not effective Store configuration. Validation and publication use the
        saved source and current permissions.
      </p>
      {busy && <p role="status">Loading Store configuration…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <>
          <p>
            A configuration {pending.action} request needs original recovery. Its saved source is
            retained.
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
        <p>
          Immutable recorded operations, separate from the latest configuration and original
          recovery.
        </p>
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
          <p>No recorded configuration operations returned.</p>
        )}
        <StoreConfigurationHistoryView entries={history} />
        {nextHistory !== null && (
          <button
            type="button"
            disabled={busy || historyBusy || !!props.freshDisabled}
            onClick={() => void loadHistory(true)}
          >
            Load older configuration operations
          </button>
        )}
      </section>
      {workspace && (
        <>
          <dl>
            <dt>Latest recorded configuration</dt>
            <dd>
              {latest
                ? `Version ${latest.configurationVersion} · ${latest.lifecycle}`
                : "None recorded"}
            </dd>
            <dt>Current published configuration</dt>
            <dd>
              {current
                ? `Version ${current.configurationVersion} · ${current.lifecycle}`
                : "None returned"}
            </dd>
            <dt>Business references</dt>
            <dd>Not evaluated by this workspace read</dd>
          </dl>
          {latest && <StoreConfigurationFeeBasisView configuration={latest} />}{" "}
          {workspace.original && (
            <p>
              Original {workspace.original.action}: {workspace.original.outcome} ·{" "}
              {workspace.original.occurredAt}. This is an immutable original result, separate from
              the current head.
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
              disabled={locked || latest?.lifecycle !== "Draft"}
              onClick={() => void act("Submit")}
            >
              Submit configuration for review
            </button>
            <button
              type="button"
              disabled={
                locked ||
                latest?.lifecycle !== "PendingApproval" ||
                latest.authoredByReference === props.scope.actorReference
              }
              onClick={() => void act("Approve")}
            >
              Approve configuration independently
            </button>
            <button
              type="button"
              disabled={locked || latest?.lifecycle !== "Approved"}
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
            {entry.command} · Version {entry.configuration.configurationVersion} ·{" "}
            {entry.configuration.lifecycle} ·{" "}
            <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
          </p>
          <details>
            <summary>Recorded author and audit details</summary>
            <dl>
              <dt>Original author</dt>
              <dd>{entry.actorReference}</dd>
              <dt>Audit reference</dt>
              <dd>{entry.auditReference}</dd>
              <dt>Purpose</dt>
              <dd>{entry.purposeCode}</dd>
            </dl>
          </details>
        </li>
      ))}
    </ol>
  );
}
