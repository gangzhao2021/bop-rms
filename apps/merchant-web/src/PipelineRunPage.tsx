import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  parsePipelineRunView,
  PipelineRunPageError,
  unavailablePipelineRunClient,
  type PipelineRunClient,
  type PipelineRunErrorCode,
  type PipelineRunView,
} from "./pipeline-run-page.js";
type State =
  | { readonly kind: "Loading" | PipelineRunErrorCode }
  | { readonly kind: "Found"; readonly view: PipelineRunView };
export function PipelineRunState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Pipeline Runs", "Loading authorized lineage and run evidence…", "neutral"],
    PermissionDenied: ["Permission denied", "Data Operations access is required.", "error"],
    NotFound: ["Run not found", "No authorized Pipeline Run exists.", "neutral"],
    FeatureDisabled: [
      "Pipelines disabled",
      "Pipeline operations are disabled for this scope.",
      "neutral",
    ],
    Stale: [
      "Projection stale",
      "Refresh the latest append-only Run state before acting.",
      "offline",
    ],
    Conflict: ["Run changed", "Refresh before retrying or changing Backfill state.", "offline"],
    CommandFailed: [
      "Action failed",
      "No retry, Backfill, approval, or incident action was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached lineage cannot authorize Pipeline actions.", "offline"],
    Unavailable: [
      "Pipeline Runs unavailable",
      "No run, count, watermark, or approval is inferred.",
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
export function PipelineRunList({ view }: { readonly view: PipelineRunView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">BI-PIPELINE-RUN · Data Operations</p>
          <h1>Pipeline Runs</h1>
          <p>Generated {view.generatedAt}</p>
        </div>
      </header>
      <form className="list-filters" aria-label="Pipeline Run filters">
        <label>
          Pipeline
          <input value={view.filters.pipelineReference ?? ""} readOnly />
        </label>
        <label>
          Run
          <input value={view.filters.runReference ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? ""} readOnly />
        </label>
        <label>
          Environment
          <input value={view.filters.environmentCode ?? ""} readOnly />
        </label>
      </form>
      {view.runs.length === 0 ? (
        <StatePanel heading="No Pipeline Runs" tone="neutral" status>
          <p>No immutable Run facts match this filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Pipeline Runs">
          {view.runs.map((run) => (
            <article className="summary-card" key={run.runReference}>
              <p className="bop-eyebrow">
                {run.environmentCode} · {run.executionKind}
              </p>
              <h2>
                {run.status === "SucceededWithWarning" ? "Succeeded with Warning" : run.status}
              </h2>
              <p>
                Pipeline {run.pipelineReference} · version {run.pipelineVersionReference}
              </p>
              <p>
                Run {run.runReference} · watermark {run.watermarkOccurredAt ?? "Unavailable"} ·
                duration {run.durationMilliseconds ?? "Unavailable"} ms
              </p>
              <p>
                Late {run.recordsLate ?? "Unavailable"} · rejected{" "}
                {run.recordsRejected ?? "Unavailable"} · partition {run.outputPartitionCode}
              </p>
              <p>
                Lineage: transformation {run.transformationVersionReference} · checkpoint{" "}
                {run.inputCheckpointReference} · dataset {run.outputDatasetVersionReference}
              </p>
              <p>
                Data Quality {run.dataQualityResultReference ?? "Unavailable"} · pre/post
                reconciliation {run.preReconciliationRunReference ?? "Unavailable"} /{" "}
                {run.postReconciliationRunReference ?? "Unavailable"}
              </p>
              {run.errorCode !== null ? <p role="alert">Error {run.errorCode}</p> : null}
              <div className="card-actions">
                {view.permissions.mayRetry && run.status === "Failed" ? (
                  <button>Retry idempotent stage</button>
                ) : null}
                {view.permissions.mayRequestBackfill ? <button>Request Backfill</button> : null}
                {view.permissions.mayApproveBackfill &&
                run.backfillRequestVersionReference !== null ? (
                  <button>Review Backfill approval</button>
                ) : null}
                {view.permissions.mayOpenIncident &&
                (run.status === "Failed" || run.status === "SucceededWithWarning") ? (
                  <button>Open incident</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Retries preserve the logical batch and pinned lineage. Backfills require distinct approval
        and reconciliation; this screen never edits source Facts.
      </p>
    </main>
  );
}
export function PipelineRunPage({
  client = unavailablePipelineRunClient,
}: {
  readonly client?: PipelineRunClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parsePipelineRunView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof PipelineRunPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <PipelineRunList view={state.view} />
  ) : (
    <PipelineRunState state={state.kind} />
  );
}
