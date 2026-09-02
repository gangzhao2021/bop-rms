import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  parseStaffOrderEntryView,
  StaffOrderEntryClientError,
  unavailableStaffOrderEntryClient,
  type StaffOrderEntryClientErrorCode,
  type StaffOrderEntryProjectionClient,
  type StaffOrderEntryView,
} from "./staff-order-entry.js";

type State =
  | { readonly kind: "Loading" | StaffOrderEntryClientErrorCode }
  | { readonly kind: "Found"; readonly view: StaffOrderEntryView };

export function StaffOrderEntryState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Staff Order Entry context…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Both Staff Ordering permissions and Store scope are required.",
      "error",
    ],
    NotFound: [
      "Context unavailable",
      "The Store or ordering context is not available in this scope.",
      "neutral",
    ],
    FeatureDisabled: [
      "Staff ordering disabled",
      "Staff Order Entry is not enabled for this Store.",
      "neutral",
    ],
    Stale: [
      "Ordering context is stale",
      "Refresh Menu, Cart, Quote and eligibility evidence before continuing.",
      "offline",
    ],
    Conflict: [
      "Cart changed",
      "Recover the current Cart version and Quote before retrying.",
      "offline",
    ],
    CommandFailed: [
      "Command failed",
      "No Cart, Order, Batch or Payment success is assumed.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached context cannot submit an Order or start Terminal payment.",
      "offline",
    ],
    Unavailable: [
      "Staff Order Entry unavailable",
      "The authorized shared-contract BFF is not connected.",
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

const formatMoney = (amountMinor: number) => `CAD ${(amountMinor / 100).toFixed(2)}`;

export function StaffOrderEntryScreen({ view }: { readonly view: StaffOrderEntryView }) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("All");
  const [availability, setAvailability] = useState("AvailableNow");
  const sections = useMemo(
    () => [...new Set(view.menuItems.map((item) => item.sectionCode))].sort(),
    [view.menuItems],
  );
  const normalized = query.trim().toLocaleUpperCase();
  const items = view.menuItems.filter(
    (item) =>
      (section === "All" || item.sectionCode === section) &&
      (availability === "All" || item.availability === availability) &&
      (normalized.length === 0 ||
        item.code.includes(normalized) ||
        item.localizedName.toLocaleUpperCase().includes(normalized)),
  );
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <AppFrame
      title="Staff Order Entry"
      description="OPS-ORDER-ENTRY · merchant_staff_order_entry_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Fixed Store / named Staff / shared Ordering truth</p>
          <h2>
            {view.storeLabel} · {view.serviceMode}
          </h2>
          <p>
            {view.actorLabel} · channel {view.sourceChannel} · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        <button disabled>Create staff-scoped Cart</button>
      </header>
      {readOnly ? (
        <StatePanel heading="Read-only dependency context" tone="offline" status>
          <p>
            Menu, Quote, Dining, allergen and Payment evidence must be current before a command.
          </p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="staff-menu">
        <h3 id="staff-menu">Public-effective Menu and Sellable configurator</h3>
        <p className="bop-muted">
          Menu snapshot {view.menuSnapshotReference}. Price and tax are server-derived; no override
          is accepted.
        </p>
        <div className="list-filters" role="search">
          <label>
            Localized item / code
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <label>
            Section
            <select value={section} onChange={(event) => setSection(event.currentTarget.value)}>
              <option>All</option>
              {sections.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Availability
            <select
              value={availability}
              onChange={(event) => setAvailability(event.currentTarget.value)}
            >
              <option>AvailableNow</option>
              <option>All</option>
              <option>Unavailable</option>
            </select>
          </label>
          <label>
            Service mode
            <select value={view.serviceMode} disabled>
              <option>{view.serviceMode}</option>
            </select>
          </label>
        </div>
        {items.length === 0 ? (
          <StatePanel heading="No matching Sellables" status>
            <p>No public-effective item matches the current filters.</p>
          </StatePanel>
        ) : (
          <div className="store-card-grid">
            {items.map((item) => (
              <article className="store-card" key={item.sellableReference}>
                <header>
                  <div>
                    <p className="bop-eyebrow">
                      {item.sectionCode} · {item.code}
                    </p>
                    <h3>{item.localizedName}</h3>
                  </div>
                  <strong>{formatMoney(item.configuredPrice.amountMinor)}</strong>
                </header>
                <p>
                  {item.availability} · allergen {item.allergenRequirement}
                </p>
                <button disabled>Configure and add</button>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="detail-grid">
        <section className="detail-section">
          <h3>Staff Cart / canonical Quote</h3>
          {view.cart === null ? (
            <p>No staff Cart has been created.</p>
          ) : (
            <dl>
              <div>
                <dt>Cart / version</dt>
                <dd>
                  {view.cart.cartReference} · {view.cart.cartVersion}
                </dd>
              </div>
              <div>
                <dt>Lines</dt>
                <dd>{view.cart.lineCount}</dd>
              </div>
              <div>
                <dt>Quote</dt>
                <dd>
                  {view.cart.quoteStatus} · {view.cart.quoteReference ?? "Missing"}
                </dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>
                  {view.cart.total
                    ? formatMoney(view.cart.total.amountMinor)
                    : "Awaiting server Quote"}
                </dd>
              </div>
            </dl>
          )}
          <div className="card-actions">
            <button disabled>Requote</button>
            <button disabled>Submit Order / Batch idempotently</button>
          </div>
        </section>
        <section className="detail-section">
          <h3>Dining Session / verified Customer reference</h3>
          <p>
            Dining eligibility: {view.diningSession.eligibility} ·{" "}
            {view.diningSession.sessionReference ?? "No session attached"}
          </p>
          <p>
            Customer reference:{" "}
            {view.customerReference.verified
              ? view.customerReference.maskedReference
              : "Not attached"}
          </p>
          <button disabled>Attach eligible Dining Session</button>
        </section>
      </div>
      <section className="detail-section">
        <h3>Structured allergen review</h3>
        <p>
          Status: {view.allergenReview}. No allergy / health free text is displayed or stored by
          this screen.
        </p>
        <button disabled>Record Staff allergen assistance</button>
      </section>
      <section className="detail-section">
        <h3>Cashless Terminal handoff</h3>
        <p>
          Terminal status: {view.terminalStatus}. A start command may report Pending only; Provider
          truth owns finality.
        </p>
        <button disabled>Start Terminal payment</button>
      </section>
    </AppFrame>
  );
}

export function StaffOrderEntryPage({
  client = unavailableStaffOrderEntryClient,
}: {
  readonly client?: StaffOrderEntryProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStaffOrderEntryView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof StaffOrderEntryClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <StaffOrderEntryScreen view={state.view} />
  ) : (
    <StaffOrderEntryState state={state.kind} />
  );
}
