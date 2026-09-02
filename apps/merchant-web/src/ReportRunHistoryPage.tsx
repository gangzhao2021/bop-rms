import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  parseReportRunHistoryView,
  ReportRunHistoryError,
  unavailableReportRunHistoryClient,
  type ReportRunHistoryClient,
  type ReportRunHistoryErrorCode,
  type ReportRunHistoryView,
} from "./report-run-history-page.js";
type State =
  | { readonly kind: "Loading" | ReportRunHistoryErrorCode }
  | { readonly kind: "Found"; readonly view: ReportRunHistoryView };
export function ReportRunHistoryState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading report runs", "Loading authorized immutable run facts…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Report Run history is unavailable for this scope.",
      "error",
    ],
    NotFound: ["Run not found", "No authorized Report Run exists.", "neutral"],
    FeatureDisabled: [
      "Reporting disabled",
      "Report execution is disabled for this scope.",
      "neutral",
    ],
    Stale: ["Projection stale", "Refresh before acting on run or artifact metadata.", "offline"],
    Conflict: ["Run changed", "Refresh the latest append-only state before continuing.", "offline"],
    CommandFailed: [
      "Action failed",
      "No rerun, cancellation, revocation, or download authorization was recorded.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached metadata cannot authorize run or artifact actions.",
      "offline",
    ],
    Unavailable: [
      "Report runs unavailable",
      "No runs, artifacts, rows, or zero values are inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function ReportRunHistory({ view }: { readonly view: ReportRunHistoryView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RPT-RUN-HISTORY · Business intelligence</p>
          <h1>Report Run history</h1>
          <p>Generated {view.generatedAt}</p>
        </div>
      </header>
      <form className="list-filters" aria-label="Report Run filters">
        <label>
          Run reference
          <input value={view.filters.runReference ?? ""} readOnly />
        </label>
        <label>
          Report reference
          <input value={view.filters.reportReference ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? ""} readOnly />
        </label>
        <label>
          Trigger
          <input value={view.filters.triggerKind ?? ""} readOnly />
        </label>
      </form>
      {view.runs.length === 0 ? (
        <StatePanel heading="No report runs" tone="neutral" status>
          <p>No immutable run facts match this authorized filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Report Runs">
          {view.runs.map((run) => (
            <article className="summary-card" key={run.runReference}>
              <p className="bop-eyebrow">
                {run.reportNameCode} · {run.triggerKind}
              </p>
              <h2>{run.status}</h2>
              <p>
                Run {run.runReference} · version {run.reportVersionReference}
              </p>
              <p>
                {run.scopeLabel} · rows {run.rowCount ?? "Unavailable"} · data as of{" "}
                {run.dataAsOf ?? "Unavailable"} · duration{" "}
                {run.durationMilliseconds ?? "Unavailable"} ms
              </p>
              <p>
                Parameters {run.parameterSnapshotDigest} · requester {run.requesterReference}
              </p>
              {run.errorCode !== null && view.permissions.mayViewError ? (
                <p role="alert">Error {run.errorCode}</p>
              ) : null}
              {run.artifact ? (
                <p>
                  Artifact {run.artifact.format} · expires {run.artifact.expiresAt} ·{" "}
                  {run.artifact.revoked ? "Revoked" : "Available"}
                </p>
              ) : (
                <p>No artifact</p>
              )}
              <div className="card-actions">
                {view.permissions.mayRerun ? (
                  <button>Rerun exact version and parameters</button>
                ) : null}
                {view.permissions.mayCancel &&
                (run.status === "Queued" || run.status === "Running") ? (
                  <button>Cancel</button>
                ) : null}
                {view.permissions.mayDownload && run.artifact && !run.artifact.revoked ? (
                  <button>Authorize download</button>
                ) : null}
                {view.permissions.mayRevoke && run.artifact && !run.artifact.revoked ? (
                  <button>Revoke artifact</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Reruns create a new Run. Artifact actions use opaque references and current authorization;
        this page never exposes storage URLs or edits historical results.
      </p>
    </main>
  );
}
export function ReportRunHistoryPage({
  client = unavailableReportRunHistoryClient,
}: {
  readonly client?: ReportRunHistoryClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseReportRunHistoryView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof ReportRunHistoryError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ReportRunHistory view={state.view} />
  ) : (
    <ReportRunHistoryState state={state.kind} />
  );
}
