import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  InventoryLotExpiryClientError,
  parseInventoryLotExpiryView,
  unavailableInventoryLotExpiryClient,
  type InventoryLotExpiryClientErrorCode,
  type InventoryLotExpiryProjectionClient,
  type InventoryLotExpiryView,
} from "./inventory-lot-expiry.js";

type LoadState =
  | { readonly kind: "Loading" | InventoryLotExpiryClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryLotExpiryView };

export function InventoryLotExpiryState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Lot and Expiry facts…", "neutral"],
    Empty: ["No lots", "No Lot matches this explicit Stock Scope and filter.", "neutral"],
    PermissionDenied: ["Permission denied", "This scoped Lot view is not available.", "error"],
    NotFound: ["Lot not found", "The Lot is unavailable in the authorized Stock Scope.", "neutral"],
    FeatureDisabled: [
      "Lot tracking disabled",
      "This Store does not enable Lot tracking.",
      "neutral",
    ],
    Stale: ["Projection stale", "Refresh before quarantine, release or handoff.", "offline"],
    Conflict: ["Lot changed", "Refresh Hold and Balance versions before retrying.", "offline"],
    CommandFailed: [
      "Hold command failed",
      "No quarantine, release or quantity fact was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Lot facts cannot authorize an operation.", "offline"],
    Unavailable: [
      "Lot view unavailable",
      "No quantity, trace or hold status is inferred.",
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

export function InventoryLotExpiry({ view }: { readonly view: InventoryLotExpiryView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-LOT-EXPIRY · Inventory / Food Safety</p>
          <h1>Lots, Expiry and Holds</h1>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
      </header>
      {readOnly ? <InventoryLotExpiryState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Lot / Item / Barcode
          <input disabled placeholder="Exact or prefix search" />
        </label>
        <label>
          Expiry window / Location
          <select disabled>
            <option>All authorized lots</option>
          </select>
        </label>
        <label>
          Hold / Supplier / FEFO exception
          <select disabled>
            <option>All visible statuses</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <InventoryLotExpiryState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((lot) => (
            <article className="summary-card" key={lot.lotReference}>
              <div>
                <p className="bop-eyebrow">
                  {lot.status}
                  {lot.fefoException ? " · FEFO exception" : ""}
                </p>
                <h2>
                  {lot.itemName} · {lot.lotCode}
                </h2>
                <p>
                  {lot.internalCode} · {lot.locationLabel} · expiry {lot.expiryDate ?? "Not set"}
                </p>
              </div>
              <p>
                Received {lot.receivedQuantity} · on hand {lot.onHand} · reserved {lot.reserved}{" "}
                {lot.unitCode}
              </p>
              <p>
                Receipt {lot.receiptReference ?? "Restricted / unavailable"} · Supplier{" "}
                {lot.supplierLabel ?? "Restricted / unavailable"}
              </p>
              {lot.holdReference ? (
                <p>
                  Hold v{lot.holdVersion} · {lot.holdReasonCode}
                </p>
              ) : null}
              <div className="card-actions">
                <button
                  disabled={
                    readOnly || !view.permissions.manageHold || lot.status === "Quarantined"
                  }
                >
                  Quarantine through Compliance
                </button>
                <button
                  disabled={
                    readOnly || !view.permissions.manageHold || lot.status !== "Quarantined"
                  }
                >
                  Release with decision
                </button>
                <button disabled>Open trace</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {view.trace ? (
        <section className="detail-section">
          <h2>Authorized trace handoff</h2>
          <p>
            Receipt {view.trace.receiptReference ?? "Restricted"} · Supplier{" "}
            {view.trace.supplierReference ?? "Restricted"} · Movements{" "}
            {view.trace.movementReferences.length}
          </p>
          <p>
            Compliance trace {view.trace.complianceTraceReference ?? "Restricted or unavailable"}
          </p>
          <div className="card-actions">
            <Link to={view.trace.wasteHref}>Start Waste</Link>
            <Link to={view.trace.transferHref}>Start Transfer</Link>
            <Link to={view.trace.countHref}>Start Count</Link>
          </div>
        </section>
      ) : null}
      {view.nextCursor ? <button disabled>Load next page</button> : null}
    </main>
  );
}

export function InventoryLotExpiryPage({
  client = unavailableInventoryLotExpiryClient,
}: {
  readonly client?: InventoryLotExpiryProjectionClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryLotExpiryView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryLotExpiryClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <InventoryLotExpiry view={state.view} />
  ) : (
    <InventoryLotExpiryState state={state.kind} />
  );
}
