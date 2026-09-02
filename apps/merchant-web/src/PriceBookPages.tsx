import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  PriceBookClientError,
  parsePriceBookEditorView,
  parsePriceBookListView,
  parsePriceBookRouteReference,
  unavailablePriceBookClient,
  type PriceBookClient,
  type PriceBookClientErrorCode,
  type PriceBookEditorView,
  type PriceBookListView,
} from "./price-book-pages.js";
type LoadState<T> =
  | { readonly kind: "Loading" | PriceBookClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };
function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PriceBookClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}
export function PriceBookStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Price Book projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your Pricing scope does not allow this view.",
        "error",
      ],
      NotFound: [
        "Price Book unavailable",
        "The Price Book is unavailable in the current authorized Brand scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Pricing administration disabled",
        "This phase capability is disabled for the current Brand.",
        "neutral",
      ],
      Stale: [
        "Pricing data is stale",
        "Refresh before comparing, simulating or publishing.",
        "offline",
      ],
      Conflict: [
        "Price Book changed",
        "Reload the authoritative Expected Version before retrying.",
        "offline",
      ],
      CommandFailed: [
        "Command failed",
        "No Pricing fact changed. Retry with the same idempotency reference.",
        "error",
      ],
      Offline: [
        "Offline read-only",
        "Cached Pricing facts may be viewed, but commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Pricing service unavailable",
        "The Price Book BFF is unavailable. No Pricing fact changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
      <Link to="/app/commerce/pricing">Return to Price Books</Link>
    </StatePanel>
  );
}
export function PriceBookListScreen({ view }: { readonly view: PriceBookListView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [currency, setCurrency] = useState("All");
  const [coverage, setCoverage] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const currencies = ["All", ...new Set(view.items.map((item) => item.currencyCode))];
  const items = view.items.filter(
    (item) =>
      (status === "All" || item.lifecycle === status) &&
      (currency === "All" || item.currencyCode === currency) &&
      (coverage === "All" ||
        (coverage === "Missing" ? item.missingCount > 0 : item.conflictCount > 0)) &&
      (needle === "" ||
        [item.stableCode, item.scopeSummary].some((text) =>
          text.toLocaleLowerCase("en-CA").includes(needle),
        )),
  );
  return (
    <AppFrame
      title="Price Books"
      description="PRICE-BOOK-LIST · query.price_book_list · pricing_price_book_admin_v1"
    >
      <header className="screen-heading">
        <div>
          <h2>Price Book administration</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Pricing BFF is not connected">
          Create draft
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Search Product, SKU or code
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            {["All", "Draft", "Published", "Archived"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <select value={currency} onChange={(event) => setCurrency(event.currentTarget.value)}>
            {currencies.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Coverage
          <select value={coverage} onChange={(event) => setCoverage(event.currentTarget.value)}>
            {["All", "Missing", "Conflict"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Price Books" status>
          <p>Change filters or create an authorized Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <article className="store-card" key={item.priceBookReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">
                    {item.stableCode} · {item.currencyCode}
                  </p>
                  <h3>{item.scopeSummary}</h3>
                </div>
                <strong>{item.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Source / effective period</dt>
                  <dd>
                    {item.sourceSummary} · {item.effectivePeriod}
                  </dd>
                </div>
                <div>
                  <dt>Entries</dt>
                  <dd>{item.entryCount}</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    {item.coveredCount} covered · {item.missingCount} missing · {item.conflictCount}{" "}
                    conflict
                  </dd>
                </div>
                <div>
                  <dt>Expected Version</dt>
                  <dd>{item.aggregateVersion}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/commerce/pricing/${item.priceBookReference}`}>Open editor</Link>
                {["Import", "View coverage", "Compare", "Schedule", "Archive"].map((action) => (
                  <button
                    key={action}
                    disabled
                    title="A command-capable Pricing BFF is not connected"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}
export function PriceBookEditorScreen({ view }: { readonly view: PriceBookEditorView }) {
  const [filter, setFilter] = useState("All");
  const entries = view.entries.filter(
    (entry) => filter === "All" || entry.coverageStatus === filter,
  );
  return (
    <AppFrame
      title={view.stableCode}
      description={`PRICE-BOOK-EDITOR · ${view.lifecycle} · Expected Version ${view.aggregateVersion}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            Version {view.versionNumber} · {view.currencyCode}
          </p>
          <h2>Price Book editor</h2>
          <p>{view.scopeHierarchy}</p>
        </div>
        <Link className="shell-action" to="/app/commerce/pricing">
          All Price Books
        </Link>
      </header>
      <StatePanel heading="Resolution policy">
        <p>
          {view.roundingSummary} · {view.taxCategorySummary}
        </p>
        <p>{view.historySummary}</p>
      </StatePanel>
      <label>
        Coverage rows
        <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
          {["All", "Covered", "Missing", "Conflict"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div className="store-card-grid">
        {entries.map((entry) => (
          <article className="store-card" key={entry.entryReference}>
            <header>
              <div>
                <p className="bop-eyebrow">{entry.sellableCode}</p>
                <h3>{entry.sellableName}</h3>
              </div>
              <strong>{entry.coverageStatus}</strong>
            </header>
            <dl>
              <div>
                <dt>Scope / channel</dt>
                <dd>
                  {entry.scopeSummary} · {entry.channelSummary}
                </dd>
              </div>
              <div>
                <dt>Amount minor</dt>
                <dd>
                  {entry.amountMinor} {view.currencyCode}
                </dd>
              </div>
              <div>
                <dt>Effective period</dt>
                <dd>{entry.effectivePeriod}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{entry.reasonCode}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <div className="card-actions" aria-label="Price Book actions">
        {[
          "Edit draft",
          "Bulk validated import",
          "Simulate resolution",
          "Submit review",
          "Approve",
          "Publish",
        ].map((action) => (
          <button disabled key={action} title="A command-capable Pricing BFF is not connected">
            {action}
          </button>
        ))}
      </div>
    </AppFrame>
  );
}
export function PriceBookListPage({
  client = unavailablePriceBookClient,
}: {
  readonly client?: PriceBookClient;
}) {
  const load = useCallback(() => client.listPriceBooks().then(parsePriceBookListView), [client]);
  const state = useLoad(load, "price-books");
  return state.kind === "Found" ? (
    <PriceBookListScreen view={state.view} />
  ) : (
    <AppFrame title="Price Books" description="PRICE-BOOK-LIST">
      <PriceBookStatePanel state={state.kind} />
    </AppFrame>
  );
}
export function PriceBookEditorPage({
  client = unavailablePriceBookClient,
}: {
  readonly client?: PriceBookClient;
}) {
  let reference: string | null = null;
  try {
    reference = parsePriceBookRouteReference(useParams().id);
  } catch {
    reference = null;
  }
  const load = useCallback(
    () =>
      reference === null
        ? Promise.reject(new PriceBookClientError("NotFound"))
        : client.loadEditor(reference).then((value) => {
            const view = parsePriceBookEditorView(value);
            if (view.priceBookReference !== reference) throw new PriceBookClientError("NotFound");
            return view;
          }),
    [client, reference],
  );
  const state = useLoad(load, reference ?? "invalid");
  return state.kind === "Found" ? (
    <PriceBookEditorScreen view={state.view} />
  ) : (
    <AppFrame title="Price Book" description="PRICE-BOOK-EDITOR">
      <PriceBookStatePanel state={state.kind} />
    </AppFrame>
  );
}
