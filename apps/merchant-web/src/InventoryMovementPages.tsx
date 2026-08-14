import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  InventoryMovementClientError,
  parseInventoryMovementView,
  unavailableInventoryMovementClient,
  type InventoryMovementClientErrorCode,
  type InventoryMovementProjectionClient,
  type InventoryMovementRow,
  type InventoryMovementScreenId,
  type InventoryMovementView,
} from "./inventory-movement-pages.js";

type State =
  | { readonly kind: "Loading" | InventoryMovementClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryMovementView };

export function InventoryMovementState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized immutable Movement evidence…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Movement read permission and one Stock Scope are required.",
      "error",
    ],
    NotFound: ["Movement unavailable", "No Movement exists in the authorized scope.", "neutral"],
    FeatureDisabled: [
      "Inventory disabled",
      "Movement Explorer is not enabled for this Store.",
      "neutral",
    ],
    Stale: [
      "Movement projection stale",
      "The Ledger remains authoritative; correction is disabled.",
      "offline",
    ],
    Conflict: [
      "Balance version changed",
      "Refresh before requesting a compensating correction.",
      "offline",
    ],
    CommandFailed: [
      "Correction failed",
      "The original Movement remains immutable and unchanged.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached Movement evidence cannot authorize correction or export.",
      "offline",
    ],
    Unavailable: [
      "Movement service unavailable",
      "No Ledger fact or balance is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/inventory">Return to Stock Overview</Link>
    </StatePanel>
  );
}

function MovementCard({ movement }: { readonly movement: InventoryMovementRow }) {
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {movement.movementReference} · {movement.movementType}
          </p>
          <h3>{movement.itemName}</h3>
        </div>
        <strong>
          {movement.quantityDelta} {movement.unitCode}
        </strong>
      </header>
      <p>
        {movement.internalCode} · {movement.sourceScopeLabel ?? "—"} →{" "}
        {movement.destinationScopeLabel ?? "—"}
      </p>
      <p>
        Balance {movement.balanceBefore} → {movement.balanceAfter} {movement.baseUnitCode} · Ledger
        v{movement.ledgerVersion}
      </p>
      <p>
        {movement.businessSourceType} · {movement.businessSourceReference} · {movement.reasonCode}
      </p>
      <p>
        {movement.performedByDisplay} · {movement.occurredAt}
      </p>
      <div className="card-actions">
        <Link to={`/app/supply/movements/${movement.movementReference}`}>
          View immutable evidence
        </Link>
        <button disabled>Open source</button>
        <button disabled={!movement.correctable}>Create compensating correction</button>
      </div>
    </article>
  );
}

export function InventoryMovementScreen({ view }: { readonly view: InventoryMovementView }) {
  const [query, setQuery] = useState("");
  const [movementType, setMovementType] = useState("All");
  const selected = view.movements.find(
    (row) => row.movementReference === view.selectedMovementReference,
  );
  const normalized = query.trim().toUpperCase();
  const rows = view.movements.filter(
    (row) =>
      (movementType === "All" || row.movementType === movementType) &&
      (normalized.length === 0 ||
        row.movementReference.toUpperCase().includes(normalized) ||
        row.itemName.toUpperCase().includes(normalized) ||
        row.internalCode.includes(normalized) ||
        row.businessSourceReference.toUpperCase().includes(normalized)),
  );
  const title =
    view.screenId === "INV-MOVEMENT-DETAIL"
      ? "Stock Movement Detail"
      : view.screenId === "INV-ITEM-STOCK-HISTORY"
        ? "Item Stock History"
        : "Stock Movements";
  return (
    <AppFrame title={title} description={`${view.screenId} · ${view.projectionName}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Immutable Stock Ledger · corrective actions only</p>
          <h2>{title}</h2>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Scoped export</button>
          <Link to="/operations/inventory">Stock Overview</Link>
        </div>
      </header>
      {view.freshness !== "Current" || view.partial ? (
        <StatePanel heading="Projection stale / partial — read-only" tone="offline" status>
          <p>Correction requires a current source Balance version and authorized Ledger command.</p>
        </StatePanel>
      ) : null}
      {view.screenId === "INV-MOVEMENT-DETAIL" && selected ? (
        <>
          <MovementCard movement={selected} />
          <section className="detail-section">
            <h3>Immutable evidence and correction chain</h3>
            <p>
              Conversion snapshot: {selected.quantityDelta} {selected.unitCode} ×{" "}
              {selected.conversionMultiplier} = {selected.baseQuantityDelta} {selected.baseUnitCode}
            </p>
            <p>
              Lot / expiry: {selected.lotReference ?? "Not applicable"} ·{" "}
              {selected.expiryDate ?? "Not applicable"}
            </p>
            <p>
              Audit: {selected.auditReference} · corrects{" "}
              {selected.correctsMovementReference ?? "none"} · corrected by{" "}
              {selected.correctedByMovementReference ?? "none"}
            </p>
            <p>
              Original evidence cannot be edited or deleted. Eligible errors create one linked
              inverse Movement with a reason and current Balance version.
            </p>
          </section>
        </>
      ) : (
        <>
          <div className="list-filters" role="search">
            <label>
              Movement / item / code / source reference
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </label>
            <label>
              Movement type
              <select
                value={movementType}
                onChange={(event) => setMovementType(event.currentTarget.value)}
              >
                <option>All</option>
                <option>Receive</option>
                <option>Reserve</option>
                <option>Release</option>
                <option>Consume</option>
                <option>Waste</option>
                <option>Transfer</option>
                <option>Adjustment</option>
                <option>CountAdjustment</option>
                <option>Correction</option>
              </select>
            </label>
            <label>
              Scope
              <input disabled readOnly value={view.stockScope.scopeLabel} />
            </label>
          </div>
          {rows.length === 0 ? (
            <StatePanel heading="No matching Stock Movements" status>
              <p>No immutable fact matches the authorized filters.</p>
            </StatePanel>
          ) : (
            <div className="store-card-grid">
              {rows.map((row) => (
                <MovementCard key={row.movementReference} movement={row} />
              ))}
            </div>
          )}
        </>
      )}
    </AppFrame>
  );
}

function Page({
  screenId,
  client = unavailableInventoryMovementClient,
}: {
  readonly screenId: InventoryMovementScreenId;
  readonly client?: InventoryMovementProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        const view = parseInventoryMovementView(value);
        if (view.screenId !== screenId) throw new InventoryMovementClientError("Unavailable");
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryMovementClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, screenId]);
  return state.kind === "Found" ? (
    <InventoryMovementScreen view={state.view} />
  ) : (
    <InventoryMovementState state={state.kind} />
  );
}

export const InventoryMovementListPage = (props: {
  readonly client?: InventoryMovementProjectionClient;
}) => <Page {...props} screenId="INV-MOVEMENT-LIST" />;
export const InventoryMovementDetailPage = (props: {
  readonly client?: InventoryMovementProjectionClient;
}) => <Page {...props} screenId="INV-MOVEMENT-DETAIL" />;
export const InventoryItemStockHistoryPage = (props: {
  readonly client?: InventoryMovementProjectionClient;
}) => <Page {...props} screenId="INV-ITEM-STOCK-HISTORY" />;
