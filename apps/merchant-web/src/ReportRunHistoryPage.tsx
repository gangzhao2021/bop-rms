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
const unavailableFilters = [
  "Run reference",
  "Report",
  "Status",
  "Date range",
  "Requester",
  "Trigger",
] as const;
const registeredRunFields = [
  "Run reference",
  "Definition / version",
  "Scope / parameters",
  "Status",
  "Row count / freshness",
  "Duration",
  "Artifact / expiry",
  "Error",
] as const;
export function UnavailableReportRunHistory() {
  return (
    <main className="report-run-history-review page-shell">
      <div className="report-run-history-review__brand" aria-label="BOP Operations">
        <strong>BOP</strong>
        <span>OPERATIONS</span>
      </div>
      <div className="report-run-history-review__content">
        <header className="report-run-history-review__heading">
          <h1>Report Run history</h1>
          <p className="bop-eyebrow">RPT-RUN-HISTORY · PHASE 2–3 · DESIGN REVIEW</p>
          <p>Review layout · current run source unavailable</p>
        </header>
        <section className="report-run-history-review__notice" role="status">
          <h2>Authorized run history is unavailable</h2>
          <p>
            Run records, parameter details, and artifacts remain hidden until the authorized
            reporting projection is connected.
          </p>
        </section>
        <section
          className="report-run-history-review__filters"
          aria-labelledby="report-run-filters"
        >
          <h2 id="report-run-filters">Filters</h2>
          <div className="report-run-history-review__filter-grid">
            {unavailableFilters.map((label) => (
              <label key={label}>
                {label}
                <input aria-label={label} disabled placeholder="Unavailable" />
              </label>
            ))}
          </div>
          <p>
            Run and artifact filters require the authorized run-history projection and remain
            disabled here.
          </p>
        </section>
        <section
          className="report-run-history-review__results"
          aria-labelledby="report-run-results"
        >
          <header>
            <h2 id="report-run-results">Run history</h2>
            <span>Unavailable</span>
          </header>
          <div className="report-run-history-review__surface">
            <table>
              <thead>
                <tr>
                  {registeredRunFields.map((field) => (
                    <th key={field} scope="col">
                      {field}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={registeredRunFields.length}>No run rows shown</td>
                </tr>
              </tbody>
            </table>
            <div
              className="report-run-history-review__mobile-fields"
              aria-label="Registered run fields; no records"
            >
              {registeredRunFields.map((field) => (
                <div key={field}>
                  <strong>{field}</strong>
                  <span>Unavailable</span>
                </div>
              ))}
              <p>No run rows shown</p>
            </div>
            <p className="report-run-history-review__empty-copy">
              The authorized run history projection is not connected. No zero count or artifact
              availability is inferred.
            </p>
          </div>
        </section>
        <p className="report-run-history-review__boundary">
          Historical runs remain immutable; reruns pin the same report version and parameter
          snapshot. Artifact storage URLs are never shown here.
        </p>
      </div>
    </main>
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
      <p id="report-actions-unavailable" role="note">
        Reporting commands are not connected. This page is read-only; no report, certification,
        schedule, run, or artifact will be changed here.
      </p>
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
                  <button disabled aria-describedby="report-actions-unavailable">
                    Rerun exact version and parameters
                  </button>
                ) : null}
                {view.permissions.mayCancel &&
                (run.status === "Queued" || run.status === "Running") ? (
                  <button disabled aria-describedby="report-actions-unavailable">
                    Cancel
                  </button>
                ) : null}
                {view.permissions.mayDownload && run.artifact && !run.artifact.revoked ? (
                  <button disabled aria-describedby="report-actions-unavailable">
                    Authorize download
                  </button>
                ) : null}
                {view.permissions.mayRevoke && run.artifact && !run.artifact.revoked ? (
                  <button disabled aria-describedby="report-actions-unavailable">
                    Revoke artifact
                  </button>
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
  return state.kind === "Unavailable" ? (
    <UnavailableReportRunHistory />
  ) : state.kind === "Found" ? (
    <ReportRunHistory view={state.view} />
  ) : (
    <ReportRunHistoryState state={state.kind} />
  );
}
