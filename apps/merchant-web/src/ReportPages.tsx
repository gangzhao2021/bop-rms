import { AppFrame, StatePanel } from "@bop-rms/ui";
import type { ReactNode } from "react";
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
    <ReportCatalogShell>
      <header className="report-catalog-heading">
        <div>
          <h2>Reports</h2>
          <p className="bop-eyebrow">RPT-REPORT-CATALOG · PHASE 2</p>
          <p className="bop-muted">
            {view.scopeLabel} · generated {view.generatedAt}
          </p>
        </div>
        {view.permissions.mayCreate ? (
          <button
            disabled
            aria-describedby="report-actions-unavailable"
            className="report-disabled-action"
          >
            Create report
          </button>
        ) : null}
      </header>
      <ReportCatalogFilters
        name={view.filters.nameCode}
        domain={view.filters.domain}
        certified={view.filters.certifiedOnly}
        owner={view.filters.ownerReference}
        scheduled={view.filters.scheduledOnly}
      />
      <p id="report-actions-unavailable" className="report-catalog-command-note" role="note">
        Reporting commands are not connected. This page is read-only; no report, certification,
        schedule, run, or artifact will be changed here.
      </p>
      {view.reports.length === 0 ? (
        <ReportCatalogResults>
          <h3>No reports</h3>
          <p>No report definitions match this authorized filter snapshot.</p>
        </ReportCatalogResults>
      ) : (
        <ReportCatalogResults>
          <table className="report-catalog-table">
            <caption className="visually-hidden">Authorized report definitions</caption>
            <thead>
              <tr>
                {[
                  "Report",
                  "Domain",
                  "Certification",
                  "Owner",
                  "Scope",
                  "Last run",
                  "Schedule",
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.reports.map((report) => (
                <tr key={report.reportReference}>
                  <td data-label="Report">
                    <strong>{report.nameCode}</strong>
                    {view.permissions.mayEdit ? <a href={report.editTarget}>Open builder</a> : null}
                    {view.permissions.mayCertify && report.certificationStatus === "InReview" ? (
                      <button
                        disabled
                        aria-describedby="report-actions-unavailable"
                        className="report-disabled-action"
                      >
                        Certify
                      </button>
                    ) : null}
                    {view.permissions.maySchedule && report.certificationStatus === "Certified" ? (
                      <button
                        disabled
                        aria-describedby="report-actions-unavailable"
                        className="report-disabled-action"
                      >
                        Schedule
                      </button>
                    ) : null}
                  </td>
                  <td data-label="Domain">{report.domain}</td>
                  <td data-label="Certification">{report.certificationStatus}</td>
                  <td data-label="Owner">Unavailable</td>
                  <td data-label="Scope">{report.scope}</td>
                  <td data-label="Last run">{report.lastRunAt ?? "Never"}</td>
                  <td data-label="Schedule">{report.scheduleStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportCatalogResults>
      )}
      <p className="report-catalog-boundary" role="note">
        Owner display names require an authorized label; opaque owner references are not shown.
      </p>
    </ReportCatalogShell>
  );
}

function ReportCatalogShell({ children }: { readonly children: ReactNode }) {
  return (
    <AppFrame title="OPERATIONS" description="" className="report-catalog-shell">
      <div className="report-catalog-page">{children}</div>
    </AppFrame>
  );
}

function ReportCatalogFilters({
  name,
  domain,
  certified,
  owner,
  scheduled,
}: {
  readonly name: string | null;
  readonly domain: string | null;
  readonly certified: boolean;
  readonly owner: string | null;
  readonly scheduled: boolean;
}) {
  return (
    <fieldset
      className="report-catalog-filters"
      disabled
      aria-describedby="report-catalog-filter-note"
    >
      <legend className="visually-hidden">Report catalog filters</legend>
      <label className="report-catalog-filter-name">
        <span>Report name</span>
        <input
          value={name ?? ""}
          placeholder="Name or description"
          readOnly
          aria-label="Report name"
        />
      </label>
      <label>
        <span>Domain</span>
        <select defaultValue={domain ?? ""} aria-label="Domain">
          <option value={domain ?? ""}>{domain ?? "All domains"}</option>
        </select>
      </label>
      <label>
        <span>Certified</span>
        <select defaultValue={certified ? "yes" : "all"} aria-label="Certified">
          <option value="all">All reports</option>
          <option value="yes">Certified only</option>
        </select>
      </label>
      <label>
        <span>Owner</span>
        <select defaultValue={owner === null ? "" : "selected"} aria-label="Owner">
          <option value="">All owners</option>
          {owner === null ? null : <option value="selected">Selected owner unavailable</option>}
        </select>
      </label>
      <label>
        <span>Scheduled</span>
        <select defaultValue={scheduled ? "yes" : "all"} aria-label="Scheduled">
          <option value="all">All</option>
          <option value="yes">Scheduled only</option>
        </select>
      </label>
      <p id="report-catalog-filter-note">
        Filters are unavailable until the authorized catalog source is connected.
      </p>
    </fieldset>
  );
}

function ReportCatalogResults({ children }: { readonly children: ReactNode }) {
  return (
    <section className="report-catalog-results" aria-label="Report catalog">
      <header>
        <h3>Report catalog</h3>
        <p>Report data unavailable</p>
      </header>
      <div className="report-catalog-results__surface">{children}</div>
    </section>
  );
}

function ReportCatalogUnavailable() {
  return (
    <ReportCatalogShell>
      <header className="report-catalog-heading">
        <div>
          <h2>Reports</h2>
          <p className="bop-eyebrow">RPT-REPORT-CATALOG · PHASE 2 · DESIGN REVIEW</p>
          <p className="bop-muted">Review layout · source values unavailable</p>
        </div>
        <button
          disabled
          className="report-disabled-action"
          aria-describedby="report-actions-unavailable"
        >
          Create report
        </button>
      </header>
      <ReportCatalogFilters
        name={null}
        domain={null}
        certified={false}
        owner={null}
        scheduled={false}
      />
      <ReportCatalogResults>
        <table className="report-catalog-table">
          <caption className="visually-hidden">Authorized report catalog</caption>
          <thead>
            <tr>
              {["Report", "Domain", "Certification", "Owner", "Scope", "Last run", "Schedule"].map(
                (label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7}>
                <div className="report-catalog-empty" role="status">
                  <h4>Authorized report catalog unavailable</h4>
                  <p>
                    No reports are shown until a scoped Business Intelligence projection is
                    connected to this route. Owner display values and scope labels must come from
                    that source.
                  </p>
                  <div
                    className="report-catalog-empty__actions"
                    aria-label="Report actions unavailable"
                  >
                    {["View", "Run", "Duplicate", "Archive"].map((action) => (
                      <button
                        disabled
                        key={action}
                        aria-describedby="report-actions-unavailable"
                        className="report-disabled-action"
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                  <p id="report-actions-unavailable">
                    View, Run, Duplicate and Archive remain disabled until authorized reads and
                    commands are composed.
                  </p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </ReportCatalogResults>
      <p className="report-catalog-boundary">
        Names, owners, certification, scope, last-run time and schedules remain unavailable; no
        report results or sample business records are shown.
      </p>
    </ReportCatalogShell>
  );
}

export function ReportBuilder({ view }: { readonly view: ReportBuilderView }) {
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
            <button disabled aria-describedby="report-actions-unavailable">
              Submit review
            </button>
          ) : null}
          {view.permissions.mayCertify ? (
            <button disabled aria-describedby="report-actions-unavailable">
              Certify
            </button>
          ) : null}
          {view.permissions.maySchedule ? (
            <button disabled aria-describedby="report-actions-unavailable">
              Schedule
            </button>
          ) : null}
        </div>
      </header>
      <p id="report-actions-unavailable" role="note">
        Reporting commands are not connected. This page is read-only; no report, certification,
        schedule, run, or artifact will be changed here.
      </p>
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

const reportBuilderDefinitionFields = [
  "Report name",
  "Purpose",
  "Default time range",
  "Dimensions",
  "Filters",
  "Sort",
  "Visualization / table",
  "Row limit",
  "Scope policy",
  "Freshness requirement",
  "Access / export policy",
  "Effective period",
] as const;
const reportBuilderSourceFields = ["Approved datasets", "Metric versions"] as const;
const reportBuilderScheduleFields = [
  "Cadence",
  "Time zone",
  "Delivery channel",
  "Format",
  "Recipient scope",
] as const;
const reportBuilderValidationFields = ["Lineage validation", "Permission validation"] as const;

function ReportBuilderUnavailableField({ label }: { readonly label: string }) {
  return (
    <label className="report-builder-review__field">
      {label}
      <input aria-label={label} disabled placeholder="Unavailable" />
    </label>
  );
}

function ReportBuilderUnavailableCard({
  title,
  fields,
  className,
}: {
  readonly title: string;
  readonly fields: readonly string[];
  readonly className?: string;
}) {
  return (
    <section className={`report-builder-review__card ${className ?? ""}`}>
      <h2>{title}</h2>
      <div className="report-builder-review__fields">
        {fields.map((label) => (
          <ReportBuilderUnavailableField key={label} label={label} />
        ))}
      </div>
    </section>
  );
}

export function ReportBuilderUnavailable() {
  return (
    <main className="report-builder-review">
      <div className="report-builder-review__brand" aria-label="BOP Operations">
        <strong>BOP</strong>
        <span>OPERATIONS</span>
      </div>
      <div className="report-builder-review__content">
        <header className="report-builder-review__heading">
          <h1>Report Builder</h1>
          <p className="bop-eyebrow">RPT-REPORT-BUILDER · PHASE 3 · DESIGN REVIEW</p>
          <p>Review layout · authorized report source unavailable</p>
        </header>
        <section className="report-builder-review__notice" role="status">
          <h2>Authorized report definition is unavailable</h2>
          <p>
            Dataset and metric versions, report configuration, preview results and delivery settings
            remain hidden until the authorized projection is connected.
          </p>
        </section>
        <div className="report-builder-review__layout">
          <ReportBuilderUnavailableCard
            title="Report definition"
            fields={reportBuilderDefinitionFields}
            className="report-builder-review__definition"
          />
          <div className="report-builder-review__side">
            <ReportBuilderUnavailableCard
              title="Approved sources"
              fields={reportBuilderSourceFields}
            />
            <ReportBuilderUnavailableCard
              title="Schedule and delivery"
              fields={reportBuilderScheduleFields}
            />
            <section className="report-builder-review__card report-builder-review__validation">
              <h2>Validation and preview</h2>
              <div className="report-builder-review__fields">
                {reportBuilderValidationFields.map((label) => (
                  <ReportBuilderUnavailableField key={label} label={label} />
                ))}
              </div>
              <p>Sample preview and row count · Unavailable</p>
            </section>
          </div>
        </div>
        <p className="report-builder-review__boundary">
          Phase 3 authoring is not enabled in this Review. No report values, permission, preview,
          certification or schedule is inferred.
        </p>
      </div>
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
  ) : state.kind === "Unavailable" ? (
    <ReportCatalogUnavailable />
  ) : (
    <ReportCatalogShell>
      <ReportPageState state={state.kind} />
    </ReportCatalogShell>
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
  ) : state.kind === "Unavailable" ? (
    <ReportBuilderUnavailable />
  ) : (
    <ReportPageState state={state.kind} />
  );
}
