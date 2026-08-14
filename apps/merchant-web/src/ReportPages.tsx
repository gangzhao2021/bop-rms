import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  parseReportBuilderView,
  parseReportCatalogView,
  ReportPageError,
  unavailableReportBuilderClient,
  unavailableReportCatalogClient,
  type ReportBuilderClient,
  type ReportBuilderView,
  type ReportCatalogClient,
  type ReportCatalogView,
  type ReportPageErrorCode,
} from "./report-pages.js";

type State<T> =
  { readonly kind: "Loading" | ReportPageErrorCode } | { readonly kind: "Found"; readonly view: T };

export function ReportPageState({
  state,
}: {
  readonly state: Exclude<State<never>["kind"], "Found">;
}) {
  const states: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading reports", "Loading authorized report definitions…", "neutral"],
    PermissionDenied: ["Permission denied", "Reporting is unavailable for this scope.", "error"],
    NotFound: ["Report not found", "No authorized report definition exists.", "neutral"],
    FeatureDisabled: [
      "Reporting disabled",
      "Report authoring is disabled for this scope.",
      "neutral",
    ],
    Stale: ["Projection stale", "Refresh before editing or certifying this report.", "offline"],
    Conflict: ["Report changed", "Refresh the version before continuing.", "offline"],
    CommandFailed: [
      "Action failed",
      "No report, certification, or schedule change was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached report metadata cannot authorize changes.", "offline"],
    Unavailable: [
      "Reports unavailable",
      "No report definitions, runs, or schedules are inferred.",
      "error",
    ],
  };
  const value = states[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}

export function ReportCatalog({ view }: { readonly view: ReportCatalogView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RPT-REPORT-CATALOG · Business intelligence</p>
          <h1>Report catalog</h1>
          <p>
            {view.scopeLabel} · generated {view.generatedAt}
          </p>
        </div>
        {view.permissions.mayCreate ? <button>Create report draft</button> : null}
      </header>
      <form className="list-filters" aria-label="Report catalog filters">
        <label>
          Name
          <input value={view.filters.nameCode ?? ""} readOnly />
        </label>
        <label>
          Domain
          <input value={view.filters.domain ?? ""} readOnly />
        </label>
        <label>
          <input type="checkbox" checked={view.filters.certifiedOnly} readOnly /> Certified only
        </label>
        <label>
          <input type="checkbox" checked={view.filters.scheduledOnly} readOnly /> Scheduled only
        </label>
      </form>
      {view.reports.length === 0 ? (
        <StatePanel heading="No reports" tone="neutral" status>
          <p>No report definitions match this authorized filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Report definitions">
          {view.reports.map((report) => (
            <article className="summary-card" key={report.reportReference}>
              <p className="bop-eyebrow">
                {report.domain} · {report.scope}
              </p>
              <h2>{report.nameCode}</h2>
              <p>
                {report.certificationStatus} · {report.scheduleStatus}
              </p>
              <p>
                Owner {report.ownerReference} · last run {report.lastRunAt ?? "Never"}
              </p>
              <div className="card-actions">
                {view.permissions.mayEdit ? (
                  <a className="shell-action" href={report.editTarget}>
                    Open builder
                  </a>
                ) : null}
                {view.permissions.mayCertify && report.certificationStatus === "InReview" ? (
                  <button>Certify</button>
                ) : null}
                {view.permissions.maySchedule && report.certificationStatus === "Certified" ? (
                  <button>Schedule</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

export function ReportBuilder({ view }: { readonly view: ReportBuilderView }) {
  const readOnly = view.lifecycle === "Archived" || !view.permissions.mayEdit;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RPT-REPORT-BUILDER · Version {view.aggregateVersion}</p>
          <h1>{view.nameCode}</h1>
          <p>
            {view.lifecycle} · {view.certificationStatus} · {view.scopePolicy}
          </p>
        </div>
        <div className="card-actions">
          {view.permissions.maySubmitReview ? (
            <button disabled={readOnly}>Submit review</button>
          ) : null}
          {view.permissions.mayCertify ? (
            <button disabled={view.lifecycle !== "InReview"}>Certify</button>
          ) : null}
          {view.permissions.maySchedule ? (
            <button disabled={view.certificationStatus !== "Certified"}>Schedule</button>
          ) : null}
        </div>
      </header>
      <section className="overview-grid" aria-label="Report builder contract">
        <article className="summary-card">
          <h2>Approved sources</h2>
          <p>
            Datasets {view.datasetVersionReferences.length} · metrics{" "}
            {view.metricVersionReferences.length}
          </p>
          <p>Dimensions {view.dimensions.join(", ") || "None"}</p>
        </article>
        <article className="summary-card">
          <h2>Presentation</h2>
          <p>
            {view.visualization} · maximum {view.rowLimit} rows
          </p>
          <p>
            Sorts {view.sorts.length} · filters {view.filters.length}
          </p>
        </article>
        <article className="summary-card">
          <h2>Validation and preview</h2>
          <p>
            Validation {view.validation.status} · preview {view.preview.status}
          </p>
          <p>Preview rows {view.preview.rowCount ?? "Unavailable"}</p>
        </article>
        <article className="summary-card">
          <h2>Schedule</h2>
          <p>
            {view.schedule.status} · {view.schedule.cadence ?? "No cadence"} ·{" "}
            {view.schedule.format ?? "No format"}
          </p>
        </article>
      </section>
      <p role="note">
        The builder accepts approved version references and constrained fields only. It does not
        accept raw SQL, expressions, URLs, or recipient details.
      </p>
    </main>
  );
}

export function ReportCatalogPage({
  client = unavailableReportCatalogClient,
}: {
  readonly client?: ReportCatalogClient;
}) {
  const [state, setState] = useState<State<ReportCatalogView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseReportCatalogView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof ReportPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ReportCatalog view={state.view} />
  ) : (
    <ReportPageState state={state.kind} />
  );
}

export function ReportBuilderPage({
  client = unavailableReportBuilderClient,
}: {
  readonly client?: ReportBuilderClient;
}) {
  const { id = "" } = useParams();
  const [state, setState] = useState<State<ReportBuilderView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load(id).then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseReportBuilderView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof ReportPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client, id]);
  return state.kind === "Found" ? (
    <ReportBuilder view={state.view} />
  ) : (
    <ReportPageState state={state.kind} />
  );
}
