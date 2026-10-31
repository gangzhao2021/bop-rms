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

export function InventoryOverviewUnavailable() {
  const balances = ["On hand", "Reserved", "Available"] as const;
  return (
    <AppFrame className="inventory-overview-shell" title="OPERATIONS" description="">
      <div className="inventory-overview-unavailable">
        <header className="inventory-overview-heading">
          <div>
            <p className="bop-eyebrow">INV-STOCK-OVERVIEW · PHASE 2</p>
            <h2>Stock overview</h2>
            <p>Store scope unavailable · freshness unavailable</p>
          </div>
          <button type="button" disabled aria-describedby="inventory-overview-source-boundary">
            Refresh unavailable
          </button>
        </header>
        <section
          className="inventory-overview-source-boundary"
          id="inventory-overview-source-boundary"
          role="status"
          aria-label="Stock source unavailable"
        >
          <h3>Stock projection unavailable</h3>
          <p>
            No authorized Inventory overview query is connected. Scope, balances, alerts and
            freshness are unavailable.
          </p>
        </section>
        <section aria-labelledby="inventory-overview-balances-title">
          <h3 id="inventory-overview-balances-title">Stock balances</h3>
          <div className="inventory-overview-balances">
            {balances.map((label) => (
              <article className="inventory-overview-balance" key={label}>
                <p>{label}</p>
                <strong>Unavailable</strong>
                <small>Authorized balance source missing</small>
              </article>
            ))}
          </div>
        </section>
        <section className="inventory-overview-alerts" aria-labelledby="inventory-alerts-title">
          <h3 id="inventory-alerts-title">Inventory alerts · unavailable</h3>
          <p>Reorder · expiry · negative stock · count</p>
          <small>The authorized source provides no alert counts or freshness.</small>
        </section>
        <fieldset className="inventory-overview-filters" disabled>
          <legend>Find and filter items</legend>
          <label>
            Item / code / barcode / supplier item code
            <input aria-label="Search inventory items" placeholder="Unavailable" />
          </label>
          <div className="inventory-overview-filter-grid">
            {[
              "Category",
              "Location",
              "Availability",
              "Below reorder",
              "Expiry",
              "Negative stock",
              "Tracking",
            ].map((label) => (
              <label key={label}>
                {label}
                <select aria-label={`${label} filter`} defaultValue="Unavailable">
                  <option>Unavailable</option>
                </select>
              </label>
            ))}
          </div>
        </fieldset>
        <section className="inventory-overview-empty" aria-labelledby="inventory-items-title">
          <h3 id="inventory-items-title">Stock items unavailable</h3>
          <p>
            Connect the authorized projection to view item identity, scoped quantity, reorder policy
            and movements.
          </p>
        </section>
        <p className="inventory-overview-cost-gate">
          Inventory value remains separately permission-gated.
        </p>
      </div>
    </AppFrame>
  );
}

export function InventoryItemListUnavailable() {
  const filters = ["Lifecycle / type", "Tracking / lot-expiry", "Store scope / quantity"] as const;
  const fields = [
    "Item / code",
    "Lifecycle / units",
    "Store scope / quantity",
    "Reorder / usage / supplier",
    "History",
  ] as const;
  return (
    <AppFrame className="inventory-item-list-shell" title="OPERATIONS" description="">
      <div className="inventory-item-list-review">
        <header className="inventory-item-list-heading">
          <div>
            <p className="bop-eyebrow">INV-ITEM-LIST · PHASE 2</p>
            <h2>Inventory items</h2>
            <p>Item identity · quantity requires one authorized stock scope</p>
          </div>
          <button type="button" disabled aria-describedby="inventory-item-list-source-boundary">
            Create item · unavailable
          </button>
        </header>
        <section
          className="inventory-item-list-source-boundary"
          id="inventory-item-list-source-boundary"
          role="status"
          aria-label="Inventory Item source unavailable"
        >
          <h3>PHASE 2 · ITEM PROJECTION UNAVAILABLE</h3>
          <p>
            No authorized Inventory Item query is connected. Store scope, Ledger quantity, reorder,
            usage, supplier and history facts are unavailable.
          </p>
        </section>
        <fieldset className="inventory-item-list-filters" disabled>
          <legend>Find and filter items</legend>
          <label>
            Item name / code / barcode
            <input aria-label="Search inventory items" placeholder="Unavailable" />
          </label>
          {filters.map((label) => (
            <label key={label}>
              {label}
              <select aria-label={`${label} filter`} defaultValue="Unavailable">
                <option>Unavailable</option>
              </select>
            </label>
          ))}
          <p>Filters are disabled until an authorized source and scope are connected.</p>
        </fieldset>
        <section
          className="inventory-item-list-records"
          aria-labelledby="inventory-item-list-title"
        >
          <h3 id="inventory-item-list-title">Item records</h3>
          <div className="inventory-item-list-table">
            <div className="inventory-item-list-table-head" aria-hidden="true">
              {[
                "Item / code",
                "Lifecycle",
                "Units / tracking",
                "Reorder",
                "Usage / supplier",
                "History",
              ].map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className="inventory-item-list-empty">
              <div className="inventory-item-list-notice">
                <h4>Authorized Item source unavailable</h4>
                <p>No Item, Store, quantity, reorder, supplier, usage or history rows are shown.</p>
              </div>
              <dl>
                {fields.map((label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>Unavailable</dd>
                  </div>
                ))}
              </dl>
              <p className="inventory-item-list-empty-detail">
                Connect the Inventory owner query and scoped Ledger projection to display authorized
                records.
              </p>
            </div>
          </div>
        </section>
        <p className="inventory-item-list-footer">
          Quantity, reorder and related workflows need explicit authorized scope.
        </p>
      </div>
    </AppFrame>
  );
}

export function InventoryItemDetailUnavailable() {
  const sections = [
    {
      title: "Descriptive fields",
      fields: [
        "Category / classification",
        "Localized description",
        "Barcode records",
        "Storage / handling references",
      ],
    },
    {
      title: "Units & conversions",
      fields: [
        "Base unit",
        "Measurement dimension",
        "Display / ledger precision",
        "Conversion revisions",
      ],
    },
    {
      title: "Tracking & lot / expiry",
      fields: ["Stock tracking", "Lot policy", "Expiry policy", "Issue policy"],
    },
    {
      title: "Stock by location · scope required",
      fields: [
        "Store / Site / Location scope",
        "Scope-gated balance fields",
        "Unit + Ledger freshness",
        "Scope-specific status",
      ],
    },
    {
      title: "Reorder policies",
      fields: [
        "Scope / effective period",
        "Reorder point / safety stock",
        "Target level",
        "Preferred mapping",
      ],
    },
    {
      title: "Supplier mappings",
      fields: [
        "Procurement-owned Offering",
        "Purchase unit / terms",
        "Supplier / coverage summary",
        "Price ownership",
      ],
    },
    {
      title: "Recipe / SKU usage",
      fields: ["SKU references", "Recipe usage summary", "Coverage / projection freshness"],
    },
    {
      title: "Movements, counts & history",
      fields: ["Movement / Count links", "History / masked Audit", "Compare / source evidence"],
    },
  ] as const;
  const identityFields = [
    "Localized name",
    "Internal code",
    "Item type",
    "Lifecycle",
    "Base unit",
    "Tracking policy",
    "Store / Site scope",
    "Current availability",
    "Last updated",
  ] as const;
  const tabs = [
    "Overview",
    "Units & conversions",
    "Tracking & expiry",
    "Stock by location",
    "Movements",
    "Reorder policies",
    "Supplier mappings",
    "Recipe / SKU usage",
    "Counts & adjustments",
    "History",
  ] as const;

  return (
    <AppFrame className="inventory-item-detail-shell" title="OPERATIONS" description="">
      <div className="inventory-item-detail-review">
        <header className="inventory-item-detail-heading">
          <div>
            <p className="bop-eyebrow">INV-ITEM-DETAIL · PHASE 2</p>
            <h2>Inventory Item detail</h2>
            <p>Inventory-owned identity · quantity needs one authorized Stock Scope.</p>
          </div>
          <div
            className="inventory-item-detail-heading__actions"
            aria-label="Unavailable Item actions"
          >
            <button type="button" disabled aria-describedby="inventory-item-detail-source-boundary">
              Edit unavailable
            </button>
            <button type="button" disabled aria-describedby="inventory-item-detail-source-boundary">
              Duplicate unavailable
            </button>
            <button type="button" disabled aria-describedby="inventory-item-detail-source-boundary">
              Manage policy unavailable
            </button>
          </div>
        </header>
        <aside
          className="inventory-item-detail-source-boundary"
          id="inventory-item-detail-source-boundary"
          role="status"
          aria-label="Inventory Item detail source unavailable"
        >
          <h3>PHASE 2 · AUTHORIZED ITEM DETAIL QUERY UNAVAILABLE</h3>
          <p>
            No Item, Stock Scope, Store / Site, Ledger, reorder, supplier, usage or history values
            are shown. Inventory actions stay disabled.
          </p>
        </aside>
        <section aria-labelledby="inventory-item-detail-sections-title">
          <h3
            className="inventory-item-detail-section-title"
            id="inventory-item-detail-sections-title"
          >
            Inventory Item detail
          </h3>
          <nav className="inventory-item-detail-tabs" aria-label="Inventory Item detail sections">
            {tabs.map((tab, index) => (
              <button
                key={tab}
                type="button"
                disabled={index !== 0}
                aria-current={index === 0 ? "page" : undefined}
              >
                {tab}
              </button>
            ))}
          </nav>
        </section>
        <section
          className="inventory-item-detail-summary"
          aria-labelledby="inventory-item-detail-summary-title"
        >
          <h3 id="inventory-item-detail-summary-title">Item identity</h3>
          <p>
            Name, code, type, lifecycle, base unit, tracking policy, scope and availability are
            unavailable.
          </p>
          <dl>
            {identityFields.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>Unavailable</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="inventory-item-detail-grid">
          {sections.map((section) => (
            <section
              className="inventory-item-detail-card"
              key={section.title}
              aria-label={`${section.title} unavailable`}
            >
              <h3>{section.title}</h3>
              <dl>
                {section.fields.map((field) => (
                  <div key={field}>
                    <dt>{field}</dt>
                    <dd>Unavailable</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <section
          className="inventory-item-detail-actions"
          aria-labelledby="inventory-item-detail-actions-title"
        >
          <h3 id="inventory-item-detail-actions-title">Registered actions · unavailable</h3>
          <p>
            Edit · duplicate · archive / restore · unit / tracking review · reorder policy · related
            workflows
          </p>
        </section>
        <p className="inventory-item-detail-footer">
          Stock, Movement, Count, Supplier and Recipe facts stay with their owner projections.
          Review only · not an Accepted Screen.
        </p>
      </div>
    </AppFrame>
  );
}

export function InventoryItemFormUnavailable({ mode }: { readonly mode: "CREATE" | "EDIT" }) {
  const fields = [
    "Internal code",
    "Localized name",
    "Item type / category",
    "Base unit",
    "Tracking mode",
    "Lot / expiry policy",
    "Negative stock policy",
    "Reorder policy · Store scoped",
  ] as const;
  const isCreate = mode === "CREATE";
  const title = isCreate ? "Create inventory item" : "Edit inventory item";
  const prefix = `inventory-item-form-${mode.toLowerCase()}`;
  return (
    <AppFrame className="inventory-item-form-shell" title="OPERATIONS" description="">
      <div className="inventory-item-form-review">
        <header className="inventory-item-form-heading">
          <div>
            <p className="bop-eyebrow">INV-ITEM-{mode} · PHASE 2</p>
            <h2>{title}</h2>
            <p>Inventory master data · source projection unavailable</p>
          </div>
        </header>
        <aside
          className="inventory-item-form-source-boundary"
          id={`${prefix}-source-boundary`}
          role="status"
          aria-label="Authorized Item source unavailable"
        >
          <h3>AUTHORIZED ITEM SOURCE UNAVAILABLE</h3>
          <p>No source values or Store scope are available. Review only.</p>
        </aside>
        <nav className="inventory-item-form-tabs" aria-label="Inventory Item form sections">
          {["Details", "Units", "Tracking", "Reorder"].map((tab, index) => (
            <button
              key={tab}
              type="button"
              disabled
              aria-current={index === 0 ? "page" : undefined}
            >
              {tab}
            </button>
          ))}
        </nav>
        <section className="inventory-item-form-card" aria-labelledby={`${prefix}-fields-title`}>
          <h3 id={`${prefix}-fields-title`}>Identity and handling</h3>
          <dl>
            {fields.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>Unavailable</dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="inventory-item-form-invariant">
          Quantity and opening balance are never Item fields.
        </p>
        <div className="inventory-item-form-actions" aria-label="Registered Item actions">
          <button type="button" disabled aria-describedby={`${prefix}-source-boundary`}>
            {isCreate ? "Save item unavailable" : "Save changes unavailable"}
          </button>
          <button type="button" disabled aria-describedby={`${prefix}-source-boundary`}>
            Review impact unavailable
          </button>
          {!isCreate ? (
            <button type="button" disabled aria-describedby={`${prefix}-source-boundary`}>
              Archive unavailable
            </button>
          ) : null}
        </div>
        <p className="inventory-item-form-footer">DESIGN REVIEW ONLY · NOT AN ACCEPTED SCREEN</p>
      </div>
    </AppFrame>
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
  if (state.kind === "Found")
    return <InventoryScreen view={state.view} adjustmentClient={adjustmentClient} />;
  if (screenId === "INV-STOCK-OVERVIEW" && state.kind === "Unavailable")
    return <InventoryOverviewUnavailable />;
  if (screenId === "INV-ITEM-LIST" && state.kind === "Unavailable")
    return <InventoryItemListUnavailable />;
  if (screenId === "INV-ITEM-DETAIL" && state.kind === "Unavailable")
    return <InventoryItemDetailUnavailable />;
  if (
    (screenId === "INV-ITEM-CREATE" || screenId === "INV-ITEM-EDIT") &&
    state.kind === "Unavailable"
  )
    return (
      <InventoryItemFormUnavailable mode={screenId === "INV-ITEM-CREATE" ? "CREATE" : "EDIT"} />
    );
  return <InventoryState state={state.kind} />;
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
