import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DiscrepancyClientError,
  parseDiscrepancyView,
  unavailableDiscrepancyClient,
  type DiscrepancyClientErrorCode,
  type DiscrepancyProjectionClient,
  type DiscrepancyView,
} from "./discrepancy-page.js";
type LoadState =
  | { readonly kind: "Loading" | DiscrepancyClientErrorCode }
  | { readonly kind: "Found"; readonly view: DiscrepancyView };
export function DiscrepancyState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized discrepancy facts…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Discrepancies are unavailable for this Stock Site.",
      "error",
    ],
    NotFound: [
      "Discrepancy not found",
      "The case is unavailable in this Brand and Stock Site.",
      "neutral",
    ],
    FeatureDisabled: ["Discrepancies disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh PO and Receipt facts before resolution.", "offline"],
    Conflict: ["Discrepancy changed", "Refresh Expected Version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve policy, approval or collaboration blockers.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Receipt, PO remainder or resolution was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached facts cannot authorize a resolution.", "offline"],
    Unavailable: [
      "Discrepancies unavailable",
      "No contact, evidence, cost or history is inferred.",
      "error",
    ],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}
export function DiscrepancyWorkbench({ view }: { readonly view: DiscrepancyView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PROC-DISCREPANCY · Procurement / Receiving / Compliance</p>
          <h1>Receiving discrepancies</h1>
          <p>
            {view.brandLabel} · {view.stockSiteLabel} · {view.freshness}
          </p>
        </div>
      </header>
      {readOnly ? <DiscrepancyState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          PO / receipt / supplier
          <input disabled placeholder="Reference or authorized supplier" />
        </label>
        <label>
          Type / status / Store
          <select disabled>
            <option>All discrepancy states</option>
          </select>
        </label>
        <label>
          Owner / overdue
          <select disabled>
            <option>All authorized owners</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <StatePanel heading="No discrepancies" tone="neutral" status>
          <p>No case matches these scoped filters.</p>
        </StatePanel>
      ) : (
        <div className="card-list">
          {view.rows.map((row) => (
            <article className="summary-card" key={row.discrepancyReference}>
              <div>
                <p className="bop-eyebrow">
                  {row.type} · {row.status} · {row.overdue ? "Overdue" : "On time"}
                </p>
                <h2>{row.discrepancyReference}</h2>
                <p>
                  {row.supplierSummary} · {row.itemSummary}
                </p>
              </div>
              <p>
                PO {row.purchaseOrderReference} · Receipt {row.goodsReceiptReference}
              </p>
              <p>
                Variance {row.varianceQuantity} {row.unit} · tolerance {row.toleranceQuantity} ·{" "}
                {row.withinTolerance ? "Within policy" : "Outside policy"}
              </p>
              <p>Owner {row.ownerSummary ?? "Unassigned"}</p>
              {view.permissions.mayViewSupplierContact ? (
                <p>Supplier contact {row.supplierContactOutcome ?? "Not recorded"}</p>
              ) : null}
              {view.permissions.mayViewEvidence ? <p>Evidence {row.evidenceCount ?? 0}</p> : null}
              {view.permissions.mayViewCost ? (
                <p>Unit cost {row.unitCost ?? "Unavailable"}</p>
              ) : null}
              {view.permissions.mayViewHistory
                ? row.history?.map((event) => (
                    <p key={`${event.action}-${event.occurredAt}`}>
                      {event.occurredAt} · {event.action}
                    </p>
                  ))
                : null}
              <div className="card-actions">
                {view.permissions.mayManage ? (
                  <>
                    <button disabled={readOnly || row.status !== "Open"}>Acknowledge</button>
                    <button disabled={readOnly || row.status === "Closed"}>Assign owner</button>
                    <button disabled={readOnly || row.type !== "Over" || !row.withinTolerance}>
                      Accept within policy
                    </button>
                    <button disabled={readOnly || row.status === "Closed"}>
                      Request correction
                    </button>
                    <button disabled={readOnly || row.status === "Closed"}>
                      Request replacement
                    </button>
                    <button disabled={readOnly || row.status !== "Resolved"}>Close</button>
                  </>
                ) : null}
                {view.permissions.mayWaiveRemainder ? (
                  <button disabled={readOnly || row.type !== "Short" || row.status === "Closed"}>
                    Waive remainder with approval
                  </button>
                ) : null}
              </div>
              <p role="note">
                Resolution appends a decision. Inventory Receipt and Stock Ledger facts cannot be
                edited here.
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

export function DiscrepancyUnavailable() {
  return (
    <AppFrame
      className="purchase-order-unavailable-shell"
      title="Receiving discrepancies"
      description="Procurement · Brand / Stock Site scope unavailable"
    >
      <div className="purchase-order-unavailable discrepancy-unavailable">
        <p className="bop-eyebrow">PROC-DISCREPANCY · PHASE 3</p>
        <h2>Receiving discrepancy workspace</h2>
        <section
          className="purchase-order-source-boundary"
          role="status"
          aria-label="Discrepancy projection unavailable"
        >
          <h3>Phase 3 · Discrepancy projection unavailable</h3>
          <p>
            No authorized case source is connected. Case, PO / receipt, variance, owner, evidence,
            cost and history values are not shown.
          </p>
        </section>
        <h2>Case, variance and resolution status</h2>
        <section
          aria-label="Case, variance and resolution status"
          className="purchase-order-status-grid"
        >
          {["Case state", "Receipt variance", "Resolution"].map((label) => (
            <article className="purchase-order-status-card" key={label}>
              <p>{label}</p>
              <strong>Unavailable</strong>
              <small>Authorized source not connected</small>
            </article>
          ))}
        </section>
        <h2>Search and filters</h2>
        <fieldset className="purchase-order-filter-panel" aria-label="Search and filters" disabled>
          <p>Filters disabled until source connects.</p>
          <label>
            PO / receipt / supplier ref
            <input
              aria-label="PO, receipt or supplier reference filter unavailable"
              placeholder="Unavailable"
            />
          </label>
          <label>
            Type / status / Stock Site
            <select
              aria-label="Discrepancy type, status or Stock Site filter unavailable"
              defaultValue=""
            >
              <option value="">Unavailable</option>
            </select>
          </label>
          <label>
            Owner / overdue
            <select aria-label="Discrepancy owner or overdue filter unavailable" defaultValue="">
              <option value="">Unavailable</option>
            </select>
          </label>
        </fieldset>
        <section className="purchase-order-empty-panel" aria-labelledby="discrepancy-empty-title">
          <h3 id="discrepancy-empty-title">Discrepancies unavailable</h3>
          <p>
            No authorized case rows are available. Variance, supplier contact, evidence, cost and
            resolution history remain unavailable.
          </p>
        </section>
        <section className="purchase-order-fields-panel" aria-labelledby="discrepancy-fields-title">
          <h3 id="discrepancy-fields-title">Fields when connected</h3>
          <p>
            Type/status/PO/receipt · variance/tolerance/owner/overdue ·
            contact/evidence/cost/history by permission
          </p>
        </section>
        <p className="purchase-order-ownership-note">
          Resolution appends evidence; Goods Receipt and Stock Ledger facts cannot be edited here.
        </p>
      </div>
    </AppFrame>
  );
}

export function DiscrepancyPage({
  client = unavailableDiscrepancyClient,
}: {
  readonly client?: DiscrepancyProjectionClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseDiscrepancyView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof DiscrepancyClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <DiscrepancyWorkbench view={state.view} />
  ) : state.kind === "Unavailable" ? (
    <DiscrepancyUnavailable />
  ) : (
    <DiscrepancyState state={state.kind} />
  );
}
