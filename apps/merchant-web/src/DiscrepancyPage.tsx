import { StatePanel } from "@bop-rms/ui";
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
  ) : (
    <DiscrepancyState state={state.kind} />
  );
}
