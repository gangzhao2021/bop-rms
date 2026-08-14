import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  parseSupplierPerformanceView,
  SupplierPerformanceClientError,
  unavailableSupplierPerformanceClient,
  type SupplierPerformanceClientErrorCode,
  type SupplierPerformanceProjectionClient,
  type SupplierPerformanceView,
} from "./supplier-performance-page.js";
type LoadState =
  | { readonly kind: "Loading" | SupplierPerformanceClientErrorCode }
  | { readonly kind: "Found"; readonly view: SupplierPerformanceView };
export function SupplierPerformanceState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized performance facts…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Supplier metrics are unavailable for this scope.",
      "error",
    ],
    NotFound: ["Performance not found", "No authorized Supplier projection exists.", "neutral"],
    FeatureDisabled: ["Performance disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Review current source coverage before acting.", "offline"],
    Conflict: ["Review changed", "Refresh before retrying the task handoff.", "offline"],
    CommandFailed: ["Command failed", "No Supplier state or score was changed.", "error"],
    Offline: ["Offline read-only", "Cached metrics cannot authorize tasks or exports.", "offline"],
    Unavailable: ["Performance unavailable", "No private facts or scores are inferred.", "error"],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}
const display = (value: string | null) => (value === null ? "Insufficient coverage" : `${value}%`);
export function SupplierPerformanceDashboard({ view }: { readonly view: SupplierPerformanceView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">SUP-PERFORMANCE · Procurement analytics</p>
          <h1>Supplier performance</h1>
          <p>
            {view.brandLabel} · {view.stockSiteLabel} · {view.freshness} · definition v
            {view.definitionVersion}
          </p>
        </div>
        {view.permissions.mayExport ? (
          <button disabled={readOnly}>Export authorized fields</button>
        ) : null}
      </header>
      {readOnly ? <SupplierPerformanceState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Supplier / item category
          <input disabled placeholder="Authorized supplier or category" />
        </label>
        <label>
          Period / Store / Brand
          <input disabled value={`${view.periodFromUtc} — ${view.periodToUtc}`} />
        </label>
        <label>
          Metric threshold
          <input disabled placeholder="Percent at or below" />
        </label>
      </div>
      {view.rows.length === 0 ? (
        <StatePanel heading="No performance rows" tone="neutral" status>
          <p>No Supplier matches this scoped period and threshold.</p>
        </StatePanel>
      ) : (
        <div className="card-list">
          {view.rows.map((row) => (
            <article
              className="summary-card"
              key={`${row.supplierReference}-${row.offeringReference ?? "all"}-${row.stockSiteReference}`}
            >
              <div>
                <p className="bop-eyebrow">
                  Coverage {row.sourceFactCount} facts · {row.incompleteFactCount} incomplete
                </p>
                <h2>{row.supplierSummary}</h2>
              </div>
              <p>
                On-time {display(row.onTimeDelivery.percent)} · Fill rate{" "}
                {display(row.fillRate.percent)} · Accepted quality{" "}
                {display(row.acceptedQuality.percent)}
              </p>
              <p>
                Over {display(row.overFrequency.percent)} · Short{" "}
                {display(row.shortFrequency.percent)} · Rejected{" "}
                {display(row.rejectedFrequency.percent)} · Damaged{" "}
                {display(row.damagedFrequency.percent)}
              </p>
              <p>
                Acknowledgement response{" "}
                {row.acknowledgementResponseSeconds ?? "Insufficient coverage"} seconds · Decline /
                cancel {display(row.declineCancellationRate.percent)}
              </p>
              {view.permissions.mayViewPriceVariance ? (
                <p>
                  Purchase price variance{" "}
                  {row.purchasePriceVarianceAmount === null
                    ? "Mixed or insufficient currency coverage"
                    : `${row.currency} ${row.purchasePriceVarianceAmount}`}
                </p>
              ) : null}
              {view.permissions.mayDrillFacts ? (
                <p>Authorized source facts {row.factReferences?.length ?? 0}</p>
              ) : null}
              {view.permissions.mayViewManualAssessments ? (
                <p>Independent manual assessments {row.manualAssessments?.length ?? 0}</p>
              ) : null}
              <div className="card-actions">
                {view.permissions.mayDrillFacts ? <button>Drill to facts</button> : null}
                {view.permissions.mayOpenReviewTask ? (
                  <button disabled={readOnly}>Open review task</button>
                ) : null}
              </div>
              <p role="note">
                System metrics are derived from immutable procurement and receipt facts. A review
                never overwrites a score or changes Supplier status.
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
export function SupplierPerformancePage({
  client = unavailableSupplierPerformanceClient,
}: {
  readonly client?: SupplierPerformanceProjectionClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseSupplierPerformanceView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof SupplierPerformanceClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <SupplierPerformanceDashboard view={state.view} />
  ) : (
    <SupplierPerformanceState state={state.kind} />
  );
}
