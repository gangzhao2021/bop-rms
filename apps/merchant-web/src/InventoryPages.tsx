import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { InventoryAdjustmentContext } from "./InventoryAdjustmentWizard.js";
import type { InventoryAdjustmentProjectionClient } from "./inventory-adjustment-wizard.js";
import {
  InventoryClientError,
  parseInventoryView,
  unavailableInventoryClient,
  type InventoryClientErrorCode,
  type InventoryItemView,
  type InventoryProjectionClient,
  type InventoryScreenId,
  type InventoryView,
} from "./inventory-pages.js";
type State =
  | { readonly kind: "Loading" | InventoryClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryView };
export function InventoryState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Inventory data…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Inventory permission and scope are required.",
      "error",
    ],
    NotFound: [
      "Inventory item unavailable",
      "No Item is available in this Brand scope.",
      "neutral",
    ],
    FeatureDisabled: ["Inventory disabled", "Inventory is not enabled for this Store.", "neutral"],
    Stale: [
      "Stock projection stale",
      "Refresh Ledger projection before any stock action.",
      "offline",
    ],
    Conflict: [
      "Inventory Item changed",
      "Refresh the aggregate version before retrying.",
      "offline",
    ],
    CommandFailed: ["Command failed", "No Item, quantity or Movement fact is assumed.", "error"],
    Offline: ["Offline read-only", "Cached inventory cannot authorize a command.", "offline"],
    Unavailable: [
      "Inventory unavailable",
      "The authorized Inventory BFF is not connected.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/app">Return to Merchant Home</Link>
    </StatePanel>
  );
}
const quantities = (item: InventoryItemView) =>
  item.quantities
    ? `${item.quantities.onHand} on hand · ${item.quantities.reserved} reserved · ${item.quantities.available} available · ${item.quantities.inTransit} in transit · ${item.quantities.unitCode}`
    : "Location Scope Missing — quantity and reorder hidden";
function ItemCard({
  item,
  onAdjust,
}: {
  readonly item: InventoryItemView;
  readonly onAdjust?: (() => void) | undefined;
}) {
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {item.internalCode} · {item.itemType}
          </p>
          <h3>{item.localizedName}</h3>
        </div>
        <strong>{item.lifecycle}</strong>
      </header>
      <p>
        {item.baseUnitCode} · {item.trackingMode} · negative {item.negativeStockPolicy}
      </p>
      <p>{quantities(item)}</p>
      <p>
        Reorder: {item.reorderStatus} · Supplier: {item.preferredSupplierSummary}
      </p>
      <div className="card-actions">
        <Link to={`/app/supply/items/${item.itemReference}`}>Open item</Link>
        <button disabled>View movements</button>
        <button disabled>Start count</button>
        <button disabled={!onAdjust} onClick={onAdjust}>
          Adjust stock
        </button>
        <button disabled>Waste / transfer</button>
      </div>
    </article>
  );
}
export function InventoryScreen({
  view,
  adjustmentClient,
}: {
  readonly view: InventoryView;
  readonly adjustmentClient?: InventoryAdjustmentProjectionClient | undefined;
}) {
  const selected =
    view.items.find((item) => item.itemReference === view.selectedItemReference) ?? null;
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("All");
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const normalized = query.trim().toUpperCase();
  const items = view.items.filter(
    (item) =>
      (lifecycle === "All" || item.lifecycle === lifecycle) &&
      (normalized.length === 0 ||
        item.internalCode.includes(normalized) ||
        item.localizedName.toUpperCase().includes(normalized)),
  );
  const stale = view.freshness !== "Current" || view.partial;
  const title =
    view.screenId === "INV-STOCK-OVERVIEW"
      ? "Stock Overview"
      : view.screenId === "INV-ITEM-LIST"
        ? "Inventory Items"
        : view.screenId === "INV-ITEM-CREATE"
          ? "Create Inventory Item"
          : view.screenId === "INV-ITEM-EDIT"
            ? "Edit Inventory Item"
            : "Inventory Item Detail";
  return (
    <AppFrame title={title} description={`${view.screenId} · ${view.projectionName}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Inventory-owned master data · Ledger-owned quantity</p>
          <h2>{title}</h2>
          <p>
            {view.stockScope
              ? `${view.stockScope.scopeType} · ${view.stockScope.scopeLabel}`
              : "Location Scope Missing · identity-only"}{" "}
            · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Create Item</button>
          <button disabled>Import master data only</button>
          <button disabled>Scoped export</button>
        </div>
      </header>
      {stale ? (
        <StatePanel heading="Projection stale / partial — read-only" tone="offline" status>
          <p>Stock actions require a source Balance version and current single Stock Scope.</p>
        </StatePanel>
      ) : null}
      {view.screenId === "INV-ITEM-CREATE" || view.screenId === "INV-ITEM-EDIT" ? (
        <section className="detail-section">
          <h3>Identity, units and tracking policy</h3>
          <div className="list-filters">
            <label>
              Internal code
              <input disabled value={selected?.internalCode ?? ""} readOnly />
            </label>
            <label>
              Localized name
              <input disabled value={selected?.localizedName ?? ""} readOnly />
            </label>
            <label>
              Base Unit
              <input disabled value={selected?.baseUnitCode ?? ""} readOnly />
            </label>
            <label>
              Tracking / lot / expiry
              <input disabled value={selected?.trackingMode ?? ""} readOnly />
            </label>
            <label>
              Negative stock policy
              <input disabled value={selected?.negativeStockPolicy ?? ""} readOnly />
            </label>
          </div>
          <p>
            Base Unit or tracking changes after Movement require high-risk policy review / migration
            evidence. Quantity and opening balance are never Item fields.
          </p>
          <div className="card-actions">
            <button disabled>Save with expected version</button>
            <button disabled>Review unit / tracking impact</button>
            <button disabled>Set Store-scoped reorder policy</button>
          </div>
        </section>
      ) : null}
      {view.screenId === "INV-ITEM-DETAIL" && selected ? (
        <>
          <section className="detail-section">
            <h3>{selected.localizedName} · configuration</h3>
            <p>
              {selected.internalCode} · {selected.itemType} · {selected.lifecycle} · Unit{" "}
              {selected.baseUnitCode}
            </p>
            <p>{quantities(selected)}</p>
            <div className="card-actions">
              <button disabled>Edit</button>
              <button disabled>Duplicate without identity / balance</button>
              <button disabled>Deactivate / Archive impact</button>
              <button disabled>Restore to Inactive</button>
            </div>
          </section>
          <section className="detail-section">
            <h3>Related contracts and history</h3>
            <p>
              Units and Conversions · Tracking and Lot / Expiry · Stock by Location · Movements ·
              Reorder Policies · Supplier Mappings · Recipe / SKU Usage · Counts and Adjustments ·
              History / masked Audit / Compare
            </p>
            <p>
              Supplier Offering is Procurement-owned and currently Unavailable; Item Detail cannot
              write its price or contract.
            </p>
          </section>
        </>
      ) : null}
      {view.screenId === "INV-ITEM-LIST" || view.screenId === "INV-STOCK-OVERVIEW" ? (
        <>
          <div className="list-filters" role="search">
            <label>
              Item / internal code / barcode / supplier item code
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </label>
            <label>
              Lifecycle
              <select
                value={lifecycle}
                onChange={(event) => setLifecycle(event.currentTarget.value)}
              >
                <option>All</option>
                <option>Active</option>
                <option>Inactive</option>
                <option>Archived</option>
              </select>
            </label>
            <label>
              Quantity / reorder scope
              <select disabled value={view.stockScope ? "Explicit" : "Missing"}>
                <option>{view.stockScope ? "Explicit" : "Missing"}</option>
              </select>
            </label>
          </div>
          {items.length === 0 ? (
            <StatePanel heading="No matching Inventory Items" status>
              <p>No Item matches the current authorized filters.</p>
            </StatePanel>
          ) : (
            <div className="store-card-grid">
              {items.map((item) => (
                <ItemCard
                  key={item.itemReference}
                  item={item}
                  onAdjust={
                    adjustmentClient && view.stockScope && !stale
                      ? () => setAdjustmentOpen(true)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </>
      ) : null}
      {adjustmentOpen && adjustmentClient ? (
        <InventoryAdjustmentContext client={adjustmentClient} />
      ) : null}
    </AppFrame>
  );
}
function Page({
  screenId,
  client = unavailableInventoryClient,
  adjustmentClient,
}: {
  readonly screenId: InventoryScreenId;
  readonly client?: InventoryProjectionClient;
  readonly adjustmentClient?: InventoryAdjustmentProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        const view = parseInventoryView(value);
        if (view.screenId !== screenId) throw new InventoryClientError("Unavailable");
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof InventoryClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, screenId]);
  return state.kind === "Found" ? (
    <InventoryScreen view={state.view} adjustmentClient={adjustmentClient} />
  ) : (
    <InventoryState state={state.kind} />
  );
}
interface InventoryPageProps {
  readonly client?: InventoryProjectionClient;
  readonly adjustmentClient?: InventoryAdjustmentProjectionClient;
}
export const StockOverviewPage = (props: InventoryPageProps) => (
  <Page {...props} screenId="INV-STOCK-OVERVIEW" />
);
export const InventoryItemListPage = (props: InventoryPageProps) => (
  <Page {...props} screenId="INV-ITEM-LIST" />
);
export const InventoryItemDetailPage = (props: InventoryPageProps) => (
  <Page {...props} screenId="INV-ITEM-DETAIL" />
);
export const InventoryItemCreatePage = (props: InventoryPageProps) => (
  <Page {...props} screenId="INV-ITEM-CREATE" />
);
export const InventoryItemEditPage = (props: InventoryPageProps) => (
  <Page {...props} screenId="INV-ITEM-EDIT" />
);
