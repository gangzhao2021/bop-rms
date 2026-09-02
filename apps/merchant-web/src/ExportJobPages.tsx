import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import {
  ExportJobPageError,
  parseExportJobPageView,
  unavailableExportJobPageClient,
  type ExportJobPageClient,
  type ExportJobPageErrorCode,
  type ExportJobPageView,
} from "./export-job-pages.js";
type State =
  | { readonly kind: "Loading" | ExportJobPageErrorCode }
  | { readonly kind: "Found"; readonly view: ExportJobPageView };
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized export metadata…",
    PermissionDenied: "Export and field permissions are required.",
    NotFound: "The export is unavailable in this scope.",
    FeatureDisabled: "Export is disabled.",
    Stale: "The export projection is stale.",
    Conflict: "The export version changed. Refresh before acting.",
    Expired: "The artifact or one-time grant expired.",
    CommandFailed: "No export, artifact or download outcome was inferred.",
    Offline: "Offline read-only. Export actions are disabled.",
    Unavailable: "Export metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading exports" : "Export center unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
function Screen({ view }: { readonly view: ExportJobPageView }) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("All");
  const jobs = useMemo(
    () =>
      view.jobs.filter(
        (job) =>
          (status === "All" || job.status === status) &&
          `${job.sourceScreen} ${job.sourceView} ${job.requestedBy}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [query, status, view.jobs],
  );
  return (
    <AppFrame
      title="Exports"
      description={`EXPORT-JOB-LIST · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">EXPORT-JOB-LIST</p>
          <h2>Controlled export center</h2>
          <p>Source as of {view.sourceAsOf}</p>
        </div>
        <button
          disabled={
            !view.mayCreate || view.freshness !== "Fresh" || view.completeness !== "Complete"
          }
        >
          Create from source view
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Source or requester
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Queued</option>
            <option>Running</option>
            <option>Completed</option>
            <option>Failed</option>
            <option>Cancelled</option>
            <option>Revoked</option>
            <option>Expired</option>
          </select>
        </label>
      </div>
      {jobs.length === 0 ? (
        <StatePanel heading="No matching exports" status>
          <p>Change the safe filters.</p>
        </StatePanel>
      ) : (
        jobs.map((job) => (
          <StatePanel
            key={job.jobReference}
            heading={`${job.sourceScreen} · ${job.sourceView}`}
            tone={["Failed", "Revoked", "Expired"].includes(job.status) ? "error" : "neutral"}
          >
            <p>
              <strong>{job.status}</strong> · {job.scope} · {job.classification} · {job.format}
            </p>
            <p>
              {job.filterSummary} · {job.rowCount ?? "row count pending"} · requester{" "}
              {job.requestedBy}
            </p>
            <p>
              Expires {job.expiresAt ?? "not generated"} · grant {job.grantState}
            </p>
            <button disabled={!job.mayCancel}>Cancel</button>{" "}
            <button
              disabled={!job.mayDownload}
              title="Consumes a fresh one-time application grant and streams a no-store attachment"
            >
              Download once
            </button>{" "}
            <button disabled={!job.mayRevoke}>Revoke</button>
          </StatePanel>
        ))
      )}
    </AppFrame>
  );
}
export function ExportJobListPage({
  client = unavailableExportJobPageClient,
}: {
  readonly client?: ExportJobPageClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .loadExports()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseExportJobPageView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof ExportJobPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? <Screen view={state.view} /> : <Status state={state.kind} />;
}
