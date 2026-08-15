import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceTraceabilityPageError,
  parseComplianceTraceabilityView,
  unavailableComplianceTraceabilityClient,
  type ComplianceTraceabilityClient,
  type ComplianceTraceabilityPageErrorCode,
  type ComplianceTraceabilityView,
} from "./compliance-traceability-page.js";

type PageState =
  | { readonly kind: "Loading" | ComplianceTraceabilityPageErrorCode }
  | { readonly kind: "Found"; readonly view: ComplianceTraceabilityView };
export function ComplianceTraceabilityState({
  state,
}: {
  readonly state: "Loading" | ComplianceTraceabilityPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading traceability", "Loading authorized source references…", "neutral"],
    PermissionDenied: ["Permission denied", "Food Safety trace permission is required.", "error"],
    NotFound: ["Trace not found", "No authorized Trace Run exists.", "neutral"],
    FeatureDisabled: ["Traceability disabled", "This Phase capability is not enabled.", "neutral"],
    Stale: ["Trace projection stale", "Gaps and stale owner facts must be reviewed.", "offline"],
    Conflict: ["Trace changed", "Refresh the pinned Run before acting.", "offline"],
    CommandFailed: [
      "Trace action failed",
      "No Evidence Set, export, or Recall was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached trace facts cannot authorize actions.", "offline"],
    Unavailable: ["Traceability unavailable", "No complete chain is inferred.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
const label = (value: string) => value.replace(/([a-z])([A-Z])/gu, "$1 $2");
export function ComplianceTraceability({ view }: { readonly view: ComplianceTraceabilityView }) {
  const result = view.result;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">TRACE-EXPLORER · Restricted Food Safety</p>
          <h1>Forward / Backward Traceability</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Traceability filters">
        <label>
          Direction
          <input value={view.filters.direction} readOnly />
        </label>
        <label>
          Exact seed
          <input
            value={`${label(view.filters.seedKind)} · ${view.filters.seedReference}`}
            readOnly
          />
        </label>
        <label>
          Period from
          <input value={view.filters.periodFrom} readOnly />
        </label>
        <label>
          Period to
          <input value={view.filters.periodTo} readOnly />
        </label>
        <label>
          Store
          <input value={view.filters.storeReference ?? "All authorized"} readOnly />
        </label>
      </form>
      {result === null ? (
        <StatePanel heading="No trace result" tone="neutral" status>
          <p>No authorized source node matches the exact seed and period.</p>
        </StatePanel>
      ) : (
        <>
          <section className="detail-section" aria-label="Trace Run summary">
            <p className="bop-eyebrow">
              Run {result.runReference} · Projection {view.projectionVersionReference}
            </p>
            <h2>{view.completeness} chain</h2>
            <p>
              Requested {result.requestedAt} · completed {result.completedAt}
            </p>
            <p>
              {result.nodes.length} nodes · {result.edges.length} links · {result.gaps.length} gaps
            </p>
            <div className="card-actions">
              {view.permissions.mayPinEvidenceSet && result.evidenceSet === null ? (
                <button>Pin restricted Evidence Set</button>
              ) : null}
              {view.permissions.mayExportRestrictedArtifact && result.evidenceSet !== null ? (
                <button>Export restricted Case artifact</button>
              ) : null}
              {view.permissions.mayOpenRecall && result.recallOutcome === null ? (
                <button>Open Recall from Trace</button>
              ) : null}
            </div>
          </section>
          {result.gaps.length > 0 ? (
            <StatePanel heading="Trace gaps require review" tone="offline" status>
              <p>Partial results never claim a complete transaction chain.</p>
            </StatePanel>
          ) : null}
          <section className="card-list" aria-label="Trace timeline">
            {result.nodes.map((item) => (
              <article className="summary-card" key={item.nodeReference}>
                <p className="bop-eyebrow">
                  {label(item.kind)} · {item.ownerDomain}
                </p>
                <h2>{item.sourceReference ?? "Restricted Customer reference"}</h2>
                <p>
                  Node {item.nodeReference} · {item.occurredAt}
                </p>
                <p>
                  Snapshot {item.snapshotDigest} · {item.accessClass}
                </p>
              </article>
            ))}
          </section>
          <section className="card-list" aria-label="Trace links and gaps">
            {result.edges.map((item) => (
              <article className="summary-card" key={item.edgeReference}>
                <p className="bop-eyebrow">{label(item.relationship)}</p>
                <h2>{item.edgeReference}</h2>
                <p>
                  {item.fromNodeReference} → {item.toNodeReference}
                </p>
              </article>
            ))}
            {result.gaps.map((item) => (
              <article className="summary-card" key={item.gapReference}>
                <p className="bop-eyebrow">Explicit {label(item.reason)} gap</p>
                <h2>{label(item.expectedKind)} expected</h2>
                <p>
                  {item.direction} from {item.adjacentNodeReference} · detected {item.detectedAt}
                </p>
              </article>
            ))}
          </section>
          {result.evidenceSet !== null ? (
            <section className="detail-section" aria-label="Pinned Evidence Set">
              <p className="bop-eyebrow">Restricted Evidence Set</p>
              <h2>{result.evidenceSet.evidenceSetReference}</h2>
              <p>
                Case {result.evidenceSet.caseReference} · revision {result.evidenceSet.revision}
              </p>
              <p>
                Selected {result.evidenceSet.selectedNodeCount} nodes ·{" "}
                {result.evidenceSet.selectedEdgeCount} links · {result.evidenceSet.selectedGapCount}{" "}
                gaps
              </p>
              <p>
                Retention {result.evidenceSet.retentionPolicyReference} · legal hold{" "}
                {result.evidenceSet.legalHold ? "Active" : "Not active"}
              </p>
            </section>
          ) : null}
          {result.exportReceipt !== null ? (
            <p role="status">
              Restricted artifact {result.exportReceipt.artifactReference} recorded{" "}
              {result.exportReceipt.recordedAt}
            </p>
          ) : null}
          {result.recallOutcome !== null ? (
            <p role="status">
              Recall owner outcome {result.recallOutcome.recallReference} recorded{" "}
              {result.recallOutcome.recordedAt}
            </p>
          ) : null}
        </>
      )}
      <p role="note">
        This view uses stable owner references. It never rewrites source transactions, assumes a
        missing link, exposes Customer identity, or returns artifact bytes and signed URLs.
      </p>
    </main>
  );
}
export function ComplianceTraceabilityPage({
  client = unavailableComplianceTraceabilityClient,
}: {
  readonly client?: ComplianceTraceabilityClient;
}) {
  const [state, setState] = useState<PageState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseComplianceTraceabilityView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceTraceabilityPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ComplianceTraceability view={state.view} />
  ) : (
    <ComplianceTraceabilityState state={state.kind} />
  );
}
