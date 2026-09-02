import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  InventoryAdjustmentClientError,
  parseInventoryAdjustmentView,
  unavailableInventoryAdjustmentClient,
  type InventoryAdjustmentClientErrorCode,
  type InventoryAdjustmentProjectionClient,
  type InventoryAdjustmentView,
} from "./inventory-adjustment-wizard.js";

type State =
  | { readonly kind: "Loading" | InventoryAdjustmentClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryAdjustmentView };

export function InventoryAdjustmentState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized source Balance…", "neutral"],
    Empty: [
      "No adjustment draft",
      "Select an authorized Item and Stock Scope to begin.",
      "neutral",
    ],
    PermissionDenied: [
      "Permission denied",
      "Adjustment execution permission is required.",
      "error",
    ],
    NotFound: ["Stock context unavailable", "The Item or Balance is not in this scope.", "neutral"],
    FeatureDisabled: [
      "Adjustment disabled",
      "This Store does not enable Stock Adjustment.",
      "neutral",
    ],
    Stale: [
      "Source projection stale",
      "Refresh and revalidate the current Balance version.",
      "offline",
    ],
    Conflict: [
      "Balance changed",
      "The draft is preserved; refresh source impact before retrying.",
      "offline",
    ],
    CommandFailed: ["Adjustment failed", "No Balance or Movement fact was changed.", "error"],
    Offline: ["Offline read-only", "Cached Balance cannot authorize an Adjustment.", "offline"],
    Unavailable: ["Adjustment unavailable", "No quantity or approval result is inferred.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}

export function InventoryAdjustmentWizard({ view }: { readonly view: InventoryAdjustmentView }) {
  const adjustment = view.adjustment;
  const sourceUnsafe = view.freshness !== "Current" || view.partial;
  const needsApproval = adjustment.status === "Submitted";
  return (
    <section className="detail-section" aria-labelledby="adjustment-wizard-heading">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-ADJUSTMENT-WIZARD · contextual high-risk action</p>
          <h2 id="adjustment-wizard-heading">Stock Adjustment</h2>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
        <strong>{adjustment.status}</strong>
      </header>
      {sourceUnsafe ? (
        <StatePanel heading="Source stale / partial — posting disabled" tone="offline" status>
          <p>Adjustment must revalidate the authoritative Balance version.</p>
        </StatePanel>
      ) : null}
      <div className="list-filters">
        <label>
          Item / exact barcode
          <input disabled readOnly value={`${adjustment.internalCode} · ${adjustment.itemName}`} />
        </label>
        <label>
          Lot / location
          <input
            disabled
            readOnly
            value={`${adjustment.lotReference ?? "No lot"} · ${adjustment.locationLabel}`}
          />
        </label>
        <label>
          Quantity delta / Unit
          <input
            disabled
            readOnly
            value={`${adjustment.quantityDelta ?? "Enter delta"} ${adjustment.unitCode}`}
          />
        </label>
        <label>
          Controlled reason
          <input disabled readOnly value={adjustment.reasonCode ?? "Required"} />
        </label>
      </div>
      <section className="detail-section">
        <h3>Source Balance and impact</h3>
        <p>
          On Hand {adjustment.currentOnHand} → {adjustment.projectedOnHand ?? "Validate"}{" "}
          {adjustment.baseUnitCode} · Available {adjustment.currentAvailable} →{" "}
          {adjustment.projectedAvailable ?? "Validate"}
        </p>
        <p>
          Reserved {adjustment.currentReserved} · In Transit {adjustment.currentInTransit} · Balance
          v{adjustment.balanceVersion} · conversion × {adjustment.conversionMultiplier}
        </p>
        <p>
          Negative policy: {adjustment.negativeStockPolicy} · impact warnings:{" "}
          {adjustment.warnings.join(", ") || "None"}
        </p>
      </section>
      <section className="detail-section">
        <h3>Evidence and approval</h3>
        <p>
          Evidence:{" "}
          {adjustment.evidenceReferences === null
            ? "Restricted"
            : `${adjustment.evidenceReferences.length} authorized reference(s)`}{" "}
          · submitter {adjustment.submittedByDisplay ?? "—"} · approver{" "}
          {adjustment.approvedByDisplay ?? "—"}
        </p>
        {needsApproval ? (
          <p role="status">Independent approval is required; the submitter cannot approve.</p>
        ) : null}
        <p>
          Original Ledger facts remain immutable. Posting creates exactly one linked Adjustment
          Movement.
        </p>
      </section>
      <div className="card-actions">
        <button disabled>Validate current Balance</button>
        <button disabled>Submit for approval</button>
        <button disabled>Approve impact</button>
        <button disabled>Reject with reason</button>
        <button disabled>Post one immutable Movement</button>
        <button disabled>Cancel</button>
      </div>
      {adjustment.movementReference ? <p>Posted Movement: {adjustment.movementReference}</p> : null}
    </section>
  );
}

export function InventoryAdjustmentContext({
  client = unavailableInventoryAdjustmentClient,
}: {
  readonly client?: InventoryAdjustmentProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryAdjustmentView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryAdjustmentClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <InventoryAdjustmentWizard view={state.view} />
  ) : (
    <InventoryAdjustmentState state={state.kind} />
  );
}
