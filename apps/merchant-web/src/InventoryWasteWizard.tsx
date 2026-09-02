import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  InventoryWasteClientError,
  parseInventoryWasteView,
  unavailableInventoryWasteClient,
  type InventoryWasteClientErrorCode,
  type InventoryWasteProjectionClient,
  type InventoryWasteView,
} from "./inventory-waste-wizard.js";

type State =
  | { readonly kind: "Loading" | InventoryWasteClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryWasteView };

export function InventoryWasteState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized source Balance…", "neutral"],
    Empty: ["No waste draft", "Select an authorized Item and Stock Scope to begin.", "neutral"],
    PermissionDenied: ["Permission denied", "Waste execution permission is required.", "error"],
    NotFound: ["Stock context unavailable", "The Item or Balance is not in this scope.", "neutral"],
    FeatureDisabled: ["Waste disabled", "This Store does not enable Stock Waste.", "neutral"],
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
    CommandFailed: ["Waste failed", "No Balance or Movement fact was changed.", "error"],
    Offline: ["Offline read-only", "Cached Balance cannot authorize an Waste.", "offline"],
    Unavailable: ["Waste unavailable", "No quantity or approval result is inferred.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}

export function InventoryWasteWizard({ view }: { readonly view: InventoryWasteView }) {
  const waste = view.waste;
  const sourceUnsafe = view.freshness !== "Current" || view.partial;
  const needsApproval = waste.status === "Submitted";
  return (
    <section className="detail-section" aria-labelledby="waste-wizard-heading">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-WASTE-WIZARD · operational entry</p>
          <h2 id="waste-wizard-heading">Record Waste</h2>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
        <strong>{waste.status}</strong>
      </header>
      {sourceUnsafe ? (
        <StatePanel heading="Source stale / partial — posting disabled" tone="offline" status>
          <p>Waste must revalidate the authoritative Balance version.</p>
        </StatePanel>
      ) : null}
      <div className="list-filters">
        <label>
          Item / exact barcode
          <input disabled readOnly value={`${waste.internalCode} · ${waste.itemName}`} />
        </label>
        <label>
          Lot / location
          <input
            disabled
            readOnly
            value={`${waste.lotReference ?? "No lot"} · ${waste.locationLabel}`}
          />
        </label>
        <label>
          Waste quantity / Unit
          <input
            disabled
            readOnly
            value={`${waste.quantity ?? "Enter quantity"} ${waste.unitCode}`}
          />
        </label>
        <label>
          Controlled reason
          <input disabled readOnly value={waste.reasonCode ?? "Required"} />
        </label>
      </div>
      <section className="detail-section">
        <h3>Source Balance and impact</h3>
        <p>
          On Hand {waste.currentOnHand} → {waste.projectedOnHand ?? "Validate"} {waste.baseUnitCode}{" "}
          · Available {waste.currentAvailable} → {waste.projectedAvailable ?? "Validate"}
        </p>
        <p>
          Reserved {waste.currentReserved} · In Transit {waste.currentInTransit} · Balance v
          {waste.balanceVersion} · conversion × {waste.conversionMultiplier}
        </p>
        <p>
          Negative policy: {waste.negativeStockPolicy} · impact warnings:{" "}
          {waste.warnings.join(", ") || "None"}
        </p>
      </section>
      <section className="detail-section">
        <h3>Source, evidence, cost and approval</h3>
        <p>
          Source: {waste.sourceType} · {waste.sourceReference ?? "Inventory observation"}
        </p>
        <p>
          Evidence:{" "}
          {waste.evidenceReferences === null
            ? "Restricted"
            : `${waste.evidenceReferences.length} authorized reference(s)`}{" "}
          · submitter {waste.submittedByDisplay ?? "—"} · approver {waste.approvedByDisplay ?? "—"}
        </p>
        <p>
          Cost:{" "}
          {waste.costSummary === null
            ? "Restricted or unavailable"
            : `${waste.costSummary.currencyCode} minor units ${waste.costSummary.minorUnits}`}{" "}
          · approval threshold: {waste.approvalRequirement ?? "Validate first"}
        </p>
        {needsApproval ? (
          <p role="status">Independent approval is required; the submitter cannot approve.</p>
        ) : null}
        <p>
          Food Safety and Kitchen facts remain in their owning Domains. Posting creates exactly one
          linked immutable Waste Movement.
        </p>
      </section>
      <div className="card-actions">
        <button disabled>Validate current Balance</button>
        <button disabled>Submit by threshold</button>
        <button disabled>Approve impact</button>
        <button disabled>Reject with reason</button>
        <button disabled>Post one immutable Movement</button>
        <button disabled>Cancel</button>
      </div>
      {waste.movementReference ? <p>Posted Movement: {waste.movementReference}</p> : null}
    </section>
  );
}

export function InventoryWasteContext({
  client = unavailableInventoryWasteClient,
}: {
  readonly client?: InventoryWasteProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryWasteView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryWasteClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <InventoryWasteWizard view={state.view} />
  ) : (
    <InventoryWasteState state={state.kind} />
  );
}

export function InventoryWastePage({
  client = unavailableInventoryWasteClient,
}: {
  readonly client?: InventoryWasteProjectionClient;
}) {
  return (
    <main className="page-shell">
      <InventoryWasteContext client={client} />
    </main>
  );
}
