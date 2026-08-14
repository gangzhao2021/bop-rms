import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  InventoryReplenishmentClientError,
  parseInventoryReplenishmentView,
  unavailableInventoryReplenishmentClient,
  type InventoryReplenishmentClientErrorCode,
  type InventoryReplenishmentProjectionClient,
  type InventoryReplenishmentView,
} from "./inventory-replenishment.js";

type LoadState =
  | { readonly kind: "Loading" | InventoryReplenishmentClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryReplenishmentView };
export function InventoryReplenishmentState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Replenishment Needs…", "neutral"],
    Empty: [
      "No replenishment needs",
      "No Need matches this explicit Stock Scope and filter.",
      "neutral",
    ],
    PermissionDenied: [
      "Permission denied",
      "This scoped replenishment view is unavailable.",
      "error",
    ],
    NotFound: [
      "Need not found",
      "The Need is unavailable in the authorized Stock Scope.",
      "neutral",
    ],
    FeatureDisabled: [
      "Replenishment disabled",
      "This Store does not enable replenishment planning.",
      "neutral",
    ],
    Stale: [
      "Projection stale",
      "Refresh the Inventory source before acknowledging, dismissing or creating a draft.",
      "offline",
    ],
    Conflict: ["Need changed", "Refresh the Need and source snapshot before retrying.", "offline"],
    ValidationFailed: [
      "Reason required",
      "Choose a controlled dismissal reason before continuing.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Need, Requisition or Purchase Order fact was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Need facts cannot authorize an operation.", "offline"],
    Unavailable: [
      "Replenishment unavailable",
      "No quantity, Supplier or Procurement result is inferred.",
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

export function InventoryReplenishment({ view }: { readonly view: InventoryReplenishmentView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-REPLENISHMENT · Inventory / Buyer</p>
          <h1>Replenishment Needs</h1>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
      </header>
      <p role="note">
        A Requisition draft is internal work only. It is never approval or a Purchase Order issue.
      </p>
      {readOnly ? <InventoryReplenishmentState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Item / Code
          <input disabled placeholder="Exact or prefix search" />
        </label>
        <label>
          Store / Status / Urgency
          <select disabled>
            <option>All authorized needs</option>
          </select>
        </label>
        {view.permissions.supplierSummary ? (
          <label>
            Supplier / Unmapped
            <select disabled>
              <option>All mappings</option>
            </select>
          </label>
        ) : null}
      </div>
      {view.rows.length === 0 ? (
        <InventoryReplenishmentState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((need) => {
            const terminal =
              need.status === "Dismissed" || need.status === "RequisitionDraftCreated";
            return (
              <article className="summary-card" key={need.needReference}>
                <div>
                  <p className="bop-eyebrow">
                    {need.urgency} · {need.status} · v{need.needVersion}
                  </p>
                  <h2>{need.itemName}</h2>
                  <p>
                    {need.internalCode} · required by {need.requiredBy} · {need.reasonCode}
                  </p>
                </div>
                <p>
                  Available {need.available} · reorder {need.reorderPoint} · safety{" "}
                  {need.safetyStock} {need.baseUnitCode}
                </p>
                <p>
                  Forecast {need.forecastQuantity} as of {need.forecastAsOfUtc} · suggested{" "}
                  {need.suggestedQuantity} {need.baseUnitCode}
                </p>
                {view.permissions.supplierSummary ? (
                  <p>Preferred Supplier: {need.preferredSupplierSummary ?? "Unmapped"}</p>
                ) : null}
                {need.requisitionReference ? (
                  <p>Draft Requisition {need.requisitionReference}</p>
                ) : null}
                <div className="card-actions">
                  {view.permissions.acknowledge ? (
                    <button disabled={readOnly || terminal || need.status === "Acknowledged"}>
                      Acknowledge
                    </button>
                  ) : null}
                  {view.permissions.createRequisitionDraft ? (
                    <button disabled={readOnly || terminal}>Create Requisition draft</button>
                  ) : null}
                  {view.permissions.dismiss ? (
                    <button disabled={readOnly || terminal}>Dismiss with reason</button>
                  ) : null}
                </div>
                {readOnly ? <p>Actions require a current, complete source projection.</p> : null}
              </article>
            );
          })}
        </div>
      )}
      {view.nextCursor ? <button disabled>Load next page</button> : null}
    </main>
  );
}

export function InventoryReplenishmentPage({
  client = unavailableInventoryReplenishmentClient,
}: {
  readonly client?: InventoryReplenishmentProjectionClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryReplenishmentView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryReplenishmentClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <InventoryReplenishment view={state.view} />
  ) : (
    <InventoryReplenishmentState state={state.kind} />
  );
}
