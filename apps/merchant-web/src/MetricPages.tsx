import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  MetricPageError,
  parseMetricCatalogView,
  parseMetricDetailView,
  unavailableMetricCatalogClient,
  unavailableMetricDetailClient,
  type MetricCatalogClient,
  type MetricCatalogView,
  type MetricDetailClient,
  type MetricDetailView,
  type MetricPageErrorCode,
} from "./metric-pages.js";

export function MetricState({ state }: { readonly state: "Loading" | MetricPageErrorCode }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading metrics", "Loading authorized semantic and lineage metadata…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Metric definitions are unavailable for this scope.",
      "error",
    ],
    NotFound: ["Metric not found", "No authorized Metric Definition exists.", "neutral"],
    FeatureDisabled: [
      "Metrics disabled",
      "Business Intelligence metrics are disabled for this scope.",
      "neutral",
    ],
    Stale: ["Projection stale", "Refresh before comparing, validating, or certifying.", "offline"],
    Conflict: [
      "Metric changed",
      "Refresh the latest immutable Version before continuing.",
      "offline",
    ],
    CommandFailed: [
      "Action failed",
      "No Metric Version or certification evidence was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached metadata cannot authorize Metric actions.", "offline"],
    Unavailable: [
      "Metrics unavailable",
      "No formulas, source facts, quality results, or zero values are inferred.",
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

export function MetricCatalog({ view }: { readonly view: MetricCatalogView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">BI-METRIC-CATALOG · Business intelligence</p>
          <h1>Metric catalog</h1>
          <p>Generated {view.generatedAt}</p>
        </div>
        {view.permissions.mayCreate ? <button>Create Metric draft</button> : null}
      </header>
      <form className="list-filters" aria-label="Metric filters">
        <label>
          Name / ID
          <input value={view.filters.nameOrCode ?? ""} readOnly />
        </label>
        <label>
          Domain
          <input value={view.filters.domainCode ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.lifecycle ?? ""} readOnly />
        </label>
        <label>
          Owner
          <input value={view.filters.ownerReference ?? ""} readOnly />
        </label>
      </form>
      {view.metrics.length === 0 ? (
        <StatePanel heading="No metrics" tone="neutral" status>
          <p>No Metric Definitions match this authorized filter snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Metric Definitions">
          {view.metrics.map((metric) => (
            <article className="summary-card" key={metric.metricReference}>
              <p className="bop-eyebrow">
                {metric.stableCode} · {metric.ownerDomainCode}
              </p>
              <h2>{metric.displayNameCode}</h2>
              <p>{metric.businessDefinitionCode}</p>
              <p>
                Version {metric.versionNumber} · {metric.versionReference} · {metric.lifecycle}
              </p>
              <p>
                Grain {metric.grainCode} · owner {metric.businessOwnerReference}
              </p>
              <p>
                Lineage {metric.lineageStatus} · quality {metric.dataQualityStatus} · SLO{" "}
                {metric.dataFreshnessSeconds}s
              </p>
              {metric.replacementMetricReference ? (
                <p>Replacement {metric.replacementMetricReference}</p>
              ) : null}
              <div className="card-actions">
                {view.permissions.mayCompare ? <button>Compare versions</button> : null}
                {view.permissions.mayValidate ? (
                  <button>Validate semantics and lineage</button>
                ) : null}
                {view.permissions.maySubmit && metric.lifecycle === "Draft" ? (
                  <button>Submit review</button>
                ) : null}
                {view.permissions.mayCertify && metric.lifecycle === "InReview" ? (
                  <button>Certify with dual-owner evidence</button>
                ) : null}
                {view.permissions.mayDeprecate && metric.lifecycle === "Certified" ? (
                  <button>Deprecate Metric</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Every formal consumer pins an immutable Metric Version. This page never executes formulas or
        edits source facts.
      </p>
    </main>
  );
}

export function MetricDetail({ view }: { readonly view: MetricDetailView }) {
  const metric = view.metric;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">BI-METRIC-DETAIL · {metric.stableCode}</p>
          <h1>{metric.displayNameCode}</h1>
          <p>{metric.businessDefinitionCode}</p>
        </div>
      </header>
      <section className="summary-card" aria-label="Semantic contract">
        <h2>Semantic contract</h2>
        <p>
          Formula reference {metric.formulaReference} · base Fact {metric.baseFactReference}
        </p>
        <p>
          Grain {metric.grainCode} · dimensions {metric.allowedDimensionCodes.join(", ")}
        </p>
        <p>Required filters {metric.requiredFilterCodes.join(", ") || "None"}</p>
        <p>
          Time {metric.timeSemantics} · {metric.timezone} · currency {metric.currencySemantics}
          {metric.currencyCode ? ` ${metric.currencyCode}` : ""}
        </p>
        <p>
          Include {metric.inclusionRuleCodes.join(", ") || "None"} · exclude{" "}
          {metric.exclusionRuleCodes.join(", ") || "None"} · nulls {metric.nullPolicy}
        </p>
        <p>Examples {metric.exampleCodes.join(", ") || "None"}</p>
      </section>
      <section className="summary-card" aria-label="Metric lineage">
        <h2>Lineage and quality</h2>
        <p>Datasets {metric.datasetVersionReferences.join(", ")}</p>
        <p>Transformations {metric.transformationVersionReferences.join(", ")}</p>
        <p>Query / expression reference {metric.queryExpressionReference}</p>
        <p>Dependencies {metric.dependencyMetricVersionReferences.join(", ") || "None"}</p>
        <p>
          Last successful build {metric.lastSuccessfulBuildAt ?? "Unavailable"} · quality{" "}
          {metric.dataQualityStatus} · SLO {metric.dataFreshnessSeconds}s
        </p>
        <div className="card-actions">
          {view.permissions.mayOpenSource ? <button>Open authorized source metadata</button> : null}
          {view.permissions.mayOpenDependentReports ? (
            <button>Open dependent reports</button>
          ) : null}
          {view.permissions.mayCreateRevision ? <button>Create immutable revision</button> : null}
          {view.permissions.mayRunValidation ? <button>Run validation</button> : null}
        </div>
      </section>
      <section className="summary-card" aria-label="Metric history">
        <h2>Version history</h2>
        {metric.history.map((item) => (
          <p key={item.versionReference}>
            v{item.versionNumber} · {item.lifecycle} · {item.effectiveFrom}
          </p>
        ))}
      </section>
      <p role="note">
        Lineage is metadata: Metric → Dataset / transformation → authorized source Event or
        Snapshot. No private source row is exposed.
      </p>
    </main>
  );
}

type CatalogState =
  | { readonly kind: "Loading" | MetricPageErrorCode }
  | { readonly kind: "Found"; readonly view: MetricCatalogView };
export function MetricCatalogPage({
  client = unavailableMetricCatalogClient,
}: {
  readonly client?: MetricCatalogClient;
}) {
  const [state, setState] = useState<CatalogState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseMetricCatalogView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof MetricPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <MetricCatalog view={state.view} />
  ) : (
    <MetricState state={state.kind} />
  );
}
type DetailState =
  | { readonly kind: "Loading" | MetricPageErrorCode }
  | { readonly kind: "Found"; readonly view: MetricDetailView };
export function MetricDetailPage({
  client = unavailableMetricDetailClient,
}: {
  readonly client?: MetricDetailClient;
}) {
  const { id = "" } = useParams();
  const [state, setState] = useState<DetailState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load(id).then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseMetricDetailView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof MetricPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client, id]);
  return state.kind === "Found" ? (
    <MetricDetail view={state.view} />
  ) : (
    <MetricState state={state.kind} />
  );
}
