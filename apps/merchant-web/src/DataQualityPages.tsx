import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DataQualityPageError,
  parseDataQualityView,
  parseReconciliationView,
  unavailableDataQualityClient,
  unavailableReconciliationClient,
  type DataQualityClient,
  type DataQualityPageErrorCode,
  type DataQualityView,
  type ReconciliationClient,
  type ReconciliationView,
} from "./data-quality-pages.js";

export function DataQualityState({
  state,
}: {
  readonly state: "Loading" | DataQualityPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: [
      "Loading data quality",
      "Loading authorized checks and reconciliation results…",
      "neutral",
    ],
    PermissionDenied: [
      "Permission denied",
      "Reporting quality controls are unavailable for this scope.",
      "error",
    ],
    NotFound: [
      "Result not found",
      "No authorized quality or reconciliation result exists.",
      "neutral",
    ],
    FeatureDisabled: [
      "Data quality disabled",
      "Reporting quality controls are disabled for this scope.",
      "neutral",
    ],
    Stale: [
      "Projection stale",
      "Refresh before acknowledging, assigning, or recording resolution.",
      "offline",
    ],
    Conflict: [
      "Result changed",
      "Refresh the latest append-only state before continuing.",
      "offline",
    ],
    CommandFailed: [
      "Action failed",
      "No issue action, rerun, or resolution was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached results cannot authorize quality actions.", "offline"],
    Unavailable: [
      "Data quality unavailable",
      "No source values, private rows, or successful reruns are inferred.",
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

export function DataQuality({ view }: { readonly view: DataQualityView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">BI-DATA-QUALITY · Business intelligence</p>
          <h1>Data quality</h1>
          <p>Generated {view.generatedAt}</p>
        </div>
        {view.permissions.mayRunCheck ? <button>Run check</button> : null}
      </header>
      <form className="list-filters" aria-label="Data Quality filters">
        <label>
          Check
          <input value={view.filters.checkReference ?? ""} readOnly />
        </label>
        <label>
          Dataset
          <input value={view.filters.datasetVersionReference ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? ""} readOnly />
        </label>
        <label>
          Severity
          <input value={view.filters.severity ?? ""} readOnly />
        </label>
        <label>
          Owner
          <input value={view.filters.ownerReference ?? ""} readOnly />
        </label>
        <label>
          Date
          <input value={view.filters.dateFrom ?? ""} readOnly />
        </label>
      </form>
      {view.issues.length === 0 ? (
        <StatePanel heading="No quality issues" tone="neutral" status>
          <p>No failures match this authorized filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Data Quality issues">
          {view.issues.map((issue) => (
            <article className="summary-card" key={issue.resultReference}>
              <p className="bop-eyebrow">
                {issue.checkKind} · {issue.severity} · {issue.status}
              </p>
              <h2>{issue.partitionCode}</h2>
              <p>
                Check {issue.checkReference} · dataset {issue.datasetVersionReference}
              </p>
              <p>
                First failure {issue.firstFailureAt} · last failure {issue.lastFailureAt}
              </p>
              <p>
                Affected {issue.affectedFrom} to {issue.affectedUntil} · scope {issue.scopeCode}
              </p>
              <p>Owner {issue.ownerReference ?? "Unassigned"}</p>
              {issue.reconciliationExceptionReference ? (
                <p>Reconciliation exception {issue.reconciliationExceptionReference}</p>
              ) : null}
              <div className="card-actions">
                {view.permissions.mayAcknowledge && issue.status === "Open" ? (
                  <button>Acknowledge</button>
                ) : null}
                {view.permissions.mayAssign && issue.status !== "Resolved" ? (
                  <button>Assign</button>
                ) : null}
                {view.permissions.mayRequestBackfill && issue.status !== "Resolved" ? (
                  <button>Request backfill</button>
                ) : null}
                {view.permissions.mayOpenIncident && issue.status !== "Resolved" ? (
                  <button>Open incident</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Critical failures may pause formal report publication only. Quality actions never modify
        source facts or pause business transactions.
      </p>
    </main>
  );
}

export function Reconciliation({ view }: { readonly view: ReconciliationView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">BI-RECONCILIATION · Business intelligence</p>
          <h1>Reconciliation</h1>
          <p>Generated {view.generatedAt}</p>
        </div>
        <div className="card-actions">
          {view.permissions.mayRun ? <button>Run reconciliation</button> : null}
          {view.permissions.mayCreateException ? <button>Create exception</button> : null}
        </div>
      </header>
      <form className="list-filters" aria-label="Reconciliation filters">
        <label>
          Control
          <input value={view.filters.control ?? ""} readOnly />
        </label>
        <label>
          Period
          <input value={view.filters.periodFrom ?? ""} readOnly />
        </label>
        <label>
          Scope
          <input value={view.filters.scopeCode ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? ""} readOnly />
        </label>
        <label>
          Differences only
          <input type="checkbox" checked={view.filters.differenceOnly} readOnly />
        </label>
      </form>
      {view.controls.length === 0 ? (
        <StatePanel heading="No reconciliation results" tone="neutral" status>
          <p>No controls match this authorized filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Reconciliation controls">
          {view.controls.map((control) => (
            <article className="summary-card" key={control.runReference}>
              <p className="bop-eyebrow">
                {control.control} · {control.status}
              </p>
              <h2>
                {control.differenceValue} {control.unitCode}
              </h2>
              <p>
                Period {control.periodFrom} to {control.periodUntil} · scope {control.scopeCode}
              </p>
              <p>Owner {control.ownerReference ?? "Unassigned"}</p>
              <div className="card-actions">
                {view.permissions.mayDrill ? (
                  <button>Drill into authorized observations</button>
                ) : null}
                {view.permissions.mayRecordResolution && control.status === "Investigating" ? (
                  <button>Record resolution after matched rerun</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Differences create append-only exceptions. Resolution requires a matched rerun and never
        changes either source.
      </p>
    </main>
  );
}

type PageState<T> =
  | { readonly kind: "Loading" | DataQualityPageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function DataQualityPage({
  client = unavailableDataQualityClient,
}: {
  readonly client?: DataQualityClient;
}) {
  const [state, setState] = useState<PageState<DataQualityView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseDataQualityView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof DataQualityPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <DataQuality view={state.view} />
  ) : (
    <DataQualityState state={state.kind} />
  );
}
export function ReconciliationPage({
  client = unavailableReconciliationClient,
}: {
  readonly client?: ReconciliationClient;
}) {
  const [state, setState] = useState<PageState<ReconciliationView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseReconciliationView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof DataQualityPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <Reconciliation view={state.view} />
  ) : (
    <DataQualityState state={state.kind} />
  );
}
