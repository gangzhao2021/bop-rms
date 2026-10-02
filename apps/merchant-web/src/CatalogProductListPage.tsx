import { createStoreCapabilityClient } from "./store-capability-client.js";
import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  createProductListClient,
  initialProductListFilters,
  parseProductListFilters,
  ProductListClientError,
  type ProductListClient,
  type ProductListFilters,
  type ProductListView,
  type ProductListCategory,
  type ProductListErrorCode,
} from "./catalog-product-list-client.js";

function PrimaryCategory({ value }: { readonly value: ProductListCategory }) {
  if (value.status === "Unavailable") return <>Unavailable</>;
  return (
    <div className="product-list-category-summary">
      {value.primary === null ? "Primary category not set" : value.primary.name}
      {value.primary?.localeFallback ? <small>Name in {value.primary.nameLocale}</small> : null}
      <small>
        Draft classification · observed{" "}
        <time dateTime={value.source.asOfUtc}>
          {value.source.asOfUtc.replace("T", " ").replace(".000Z", " UTC")}
        </time>
      </small>
    </div>
  );
}
type State =
  | { readonly kind: "Loading" | ProductListErrorCode; readonly key: string }
  | { readonly kind: "Found"; readonly key: string; readonly view: ProductListView };
export function ProductListState({
  state,
}: {
  readonly state: "Loading" | "Empty" | ProductListErrorCode;
}) {
  const copy: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading products", "Loading products for the current Brand and Store…", "neutral"],
    Empty: ["No products", "No products match these filters in the current scope.", "neutral"],
    Denied: [
      "Permission denied",
      "Product data is unavailable for this session and scope.",
      "error",
    ],
    FeatureDisabled: [
      "Product management disabled",
      "Product List is unavailable for this scope.",
      "neutral",
    ],
    NotFound: [
      "Products not found",
      "Product data is unavailable in the current scope.",
      "neutral",
    ],
    Stale: [
      "Product data stale",
      "Refresh the first page to load current product data.",
      "offline",
    ],
    Conflict: ["Product data changed", "Refresh the first page before continuing.", "offline"],
    CommandFailed: ["Action failed", "No product change has been confirmed.", "error"],
    Offline: ["Offline", "Connect to load current product data.", "offline"],
    Unavailable: [
      "Product data unavailable",
      "Current product data could not be loaded. Try refreshing.",
      "error",
    ],
  };
  const [heading, body, tone] = copy[state];
  return (
    <StatePanel heading={heading} tone={tone} status>
      <p>{body}</p>
    </StatePanel>
  );
}
const typeLabel = (value: ProductListView["items"][number]["productType"]) =>
  value === "PreparedFood" ? "Prepared food" : "Non-alcoholic beverage";
const sortLabels = {
  name: "Name",
  updatedAt: "Updated time",
  createdAt: "Created time",
  internalCode: "Internal code",
  lifecycle: "Lifecycle",
  activeSkuCount: "Active SKU count",
} as const;
const timeLabels = {
  updatedFrom: "Updated from (UTC, included)",
  updatedUntil: "Updated until (UTC, excluded)",
  createdFrom: "Created from (UTC, included)",
  createdUntil: "Created until (UTC, excluded)",
} as const;
export function ProductListRecords({
  view,
  historyNavigation = false,
}: {
  readonly view: ProductListView;
  readonly historyNavigation?: boolean;
}) {
  if (view.items.length === 0) return <ProductListState state="Empty" />;
  return (
    <>
      <div className="product-list-table">
        <table aria-label="Product records">
          <thead>
            <tr>
              {[
                "Product",
                "Code",
                "Category",
                "Type",
                "Status",
                "Sellable",
                "Active SKUs",
                "Menus",
                "Coverage",
                "Tax",
                "Updated",
                "Updated by",
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.items.map((row) => (
              <tr key={row.productReference}>
                <th scope="row">
                  <strong>{row.name}</strong>
                  {historyNavigation ? (
                    <Link
                      className="product-list-history-link"
                      to={`/app/commerce/products/${row.productReference}/edit`}
                      state={{
                        productReference: row.productReference,
                        expectedAggregateVersion: row.aggregateVersion,
                      }}
                    >
                      Publication history
                    </Link>
                  ) : null}
                  <small>Draft configuration · v{row.aggregateVersion}</small>
                  {row.localeFallback ? <small>Name in {row.nameLocale}</small> : null}
                </th>
                <td>{row.internalCode}</td>
                <td>
                  <PrimaryCategory value={row.category} />
                </td>
                <td>{typeLabel(row.productType)}</td>
                <td>{row.lifecycle}</td>
                <td>Unavailable</td>
                <td>
                  {row.activeSkuCount} active / {row.skuCount} total
                </td>
                <td>Unavailable</td>
                <td>Unavailable</td>
                <td>Unavailable</td>
                <td>
                  <time dateTime={row.updatedAt}>
                    {row.updatedAt.replace("T", " ").replace(".000Z", " UTC")}
                  </time>
                  <small>
                    Created <time dateTime={row.createdAt}>{row.createdAt}</time>
                  </small>
                </td>
                <td>Unavailable</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="product-list-cards">
        {view.items.map((row) => (
          <article className="product-list-card" key={row.productReference}>
            <h3>{row.name}</h3>
            {historyNavigation ? (
              <Link
                className="product-list-history-link"
                to={`/app/commerce/products/${row.productReference}/edit`}
                state={{
                  productReference: row.productReference,
                  expectedAggregateVersion: row.aggregateVersion,
                }}
              >
                Publication history
              </Link>
            ) : null}
            <p>
              Draft configuration · v{row.aggregateVersion}
              {row.localeFallback ? " · Name in " + row.nameLocale : ""}
            </p>
            <dl>
              <div>
                <dt>Product / code</dt>
                <dd>
                  {row.name} / {row.internalCode}
                </dd>
              </div>
              <div>
                <dt>Primary category</dt>
                <dd>
                  <PrimaryCategory value={row.category} />
                </dd>
              </div>
              <div>
                <dt>Type / status</dt>
                <dd>
                  {typeLabel(row.productType)} / {row.lifecycle}
                </dd>
              </div>
              <div>
                <dt>Sellable / active SKUs</dt>
                <dd>
                  Sellable unavailable · {row.activeSkuCount} active / {row.skuCount} total
                </dd>
              </div>
              <div>
                <dt>Menus / coverage</dt>
                <dd>Unavailable / unavailable</dd>
              </div>
              <div>
                <dt>Tax / updated</dt>
                <dd>
                  Tax unavailable · <time dateTime={row.updatedAt}>{row.updatedAt}</time>
                  <br />
                  Created <time dateTime={row.createdAt}>{row.createdAt}</time>
                </dd>
              </div>
              <div>
                <dt>Updated by / availability</dt>
                <dd>Unavailable / unavailable</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}
export function CatalogProductListPage({
  storeReference,
  storeLabel,
  brandLabel,
  client: injectedClient,
  csrf,
}: {
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly brandLabel: string;
  readonly client?: ProductListClient;
  readonly csrf?: string;
}) {
  const client = useMemo(() => injectedClient ?? createProductListClient(), [injectedClient]);
  const [draft, setDraft] = useState(initialProductListFilters);
  const [invalidFilters, setInvalidFilters] = useState(false);
  const [request, setRequest] = useState({ filters: initialProductListFilters, revision: 0 });
  const key = storeReference + ":" + JSON.stringify(request);
  const [state, setState] = useState<State>({ kind: "Loading", key });
  const [historyNavigation, setHistoryNavigation] = useState<{
    key: string;
    brandReference: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      controller.abort();
      if (active) setHistoryNavigation(null);
    };
    setHistoryNavigation(null);
    window.addEventListener("offline", clear);
    if (csrf && navigator.onLine)
      void createStoreCapabilityClient()
        .load(
          { scope: { storeReference }, csrf, capabilityKey: "catalog.cat_product_edit" },
          controller.signal,
        )
        .then((gate) => {
          if (
            !active ||
            controller.signal.aborted ||
            gate.backendExecution !== "Allow" ||
            gate.frontendVisibility !== "Show"
          )
            return;
          const remaining = Date.parse(gate.observedAt) + 5000 - Date.now();
          if (remaining <= 0) return;
          setHistoryNavigation({ key, brandReference: gate.brandReference });
          timer = setTimeout(() => {
            if (active) setHistoryNavigation(null);
          }, remaining);
        })
        .catch(() => {
          if (active) setHistoryNavigation(null);
        });
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("offline", clear);
    };
  }, [csrf, key, storeReference]);

  const [creationNavigation, setCreationNavigation] = useState<{
    key: string;
    brandReference: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      controller.abort();
      if (active) setCreationNavigation(null);
    };
    setCreationNavigation(null);
    window.addEventListener("offline", clear);
    if (csrf && navigator.onLine)
      void createStoreCapabilityClient()
        .load(
          { scope: { storeReference }, csrf, capabilityKey: "catalog.cat_product_create" },
          controller.signal,
        )
        .then((gate) => {
          if (
            !active ||
            controller.signal.aborted ||
            gate.backendExecution !== "Allow" ||
            gate.frontendVisibility !== "Show"
          )
            return;
          const remaining = Date.parse(gate.observedAt) + 5000 - Date.now();
          if (remaining <= 0) return;
          setCreationNavigation({ key, brandReference: gate.brandReference });
          timer = setTimeout(() => {
            if (active) setCreationNavigation(null);
          }, remaining);
        })
        .catch(() => {
          if (active) setCreationNavigation(null);
        });
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("offline", clear);
    };
  }, [csrf, key, storeReference]);

  const refresh = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: "Loading", key });
    const offline = () => {
      controller.abort();
      if (expiry) clearTimeout(expiry);
      if (active) setState({ kind: "Offline", key });
    };
    const online = () =>
      setRequest((previous) => ({
        filters: { ...previous.filters, cursor: null },
        revision: previous.revision + 1,
      }));
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (navigator.onLine === false) offline();
    else
      void client
        .load(request.filters, storeReference, controller.signal)
        .then((view) => {
          if (!active || controller.signal.aborted) return;
          setState({ kind: "Found", key, view });
          expiry = setTimeout(
            () => {
              if (active) setState({ kind: "Stale", key });
            },
            Math.max(0, 30_000 - (Date.now() - Date.parse(view.projection.asOfUtc))),
          );
        })
        .catch((error: unknown) => {
          if (active && !controller.signal.aborted)
            setState({
              kind: error instanceof ProductListClientError ? error.code : "Unavailable",
              key,
            });
        });
    return () => {
      active = false;
      controller.abort();
      if (expiry) clearTimeout(expiry);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [client, key, request.filters, storeReference]);
  const current = state.key === key ? state : { kind: "Loading" as const, key };
  const categoryOptions =
    current.kind === "Found" ? current.view.categoryOptions : { status: "Unavailable" as const };
  const load = (filters: ProductListFilters) => {
    setRequest((previous) => ({ filters, revision: previous.revision + 1 }));
    refresh.current?.focus();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      setInvalidFilters(false);
      load(
        parseProductListFilters({ ...draft, search: draft.search?.trim() || null, cursor: null }),
      );
    } catch {
      setInvalidFilters(true);
    }
  };
  return (
    <div className="product-list-screen">
      <a className="bop-skip-link" href="#product-list-main">
        Skip to products
      </a>
      <header className="product-list-commerce">
        <strong>BOP</strong>
        <span>Commerce</span>
        <Link to="/app">Workspace</Link>
      </header>
      <main id="product-list-main" tabIndex={-1}>
        <header className="product-list-heading">
          <div>
            <h1>Products</h1>
            <p className="product-list-eyebrow">CAT-PRODUCT-LIST · PHASE 1</p>
            <p>
              {brandLabel} · {storeLabel}
            </p>
          </div>
          {current.kind === "Found" &&
          creationNavigation?.key === key &&
          creationNavigation.brandReference === current.view.scope.brandReference ? (
            <Link to="/app/commerce/products/new">Create product</Link>
          ) : (
            <button disabled title="Current Product creation access is unavailable in this view">
              Create product · unavailable
            </button>
          )}
        </header>
        <form className="product-list-filters" onSubmit={submit}>
          <h2>Find products</h2>
          <div className="product-list-filter-grid">
            <label>
              Product / code / SKU
              <input
                value={draft.search ?? ""}
                maxLength={100}
                placeholder="Name or code"
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, search: event.target.value || null }))
                }
              />
            </label>
            <label>
              Status
              <select
                value={draft.lifecycle ?? ""}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    lifecycle:
                      event.target.value === ""
                        ? null
                        : (event.target.value as ProductListFilters["lifecycle"]),
                  }))
                }
              >
                <option value="">All statuses</option>
                {["Draft", "Active", "Suspended", "Discontinued", "Archived"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Product type
              <select
                value={draft.productType ?? ""}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    productType:
                      event.target.value === ""
                        ? null
                        : (event.target.value as ProductListFilters["productType"]),
                  }))
                }
              >
                <option value="">All types</option>
                <option value="PreparedFood">Prepared food</option>
                <option value="NonAlcoholicBeverage">Non-alcoholic beverage</option>
              </select>
            </label>
            <label className="product-list-wide-filter">
              <span id="product-list-active-sku-label">Active SKUs</span>
              <select
                aria-labelledby="product-list-active-sku-label"
                value={draft.hasActiveSku === null ? "" : String(draft.hasActiveSku)}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    hasActiveSku: event.target.value === "" ? null : event.target.value === "true",
                  }))
                }
              >
                <option value="">Any active SKU count</option>
                <option value="true">Has active SKUs</option>
                <option value="false">No active SKUs</option>
              </select>
            </label>
            <label className="product-list-wide-filter">
              Draft name missing locale
              <input
                value={draft.missingTranslationLocale ?? ""}
                maxLength={35}
                placeholder="e.g. fr-CA"
                aria-describedby="product-list-translation-help"
                aria-invalid={invalidFilters || undefined}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    missingTranslationLocale: event.target.value || null,
                  }))
                }
              />
            </label>
            {(["updatedFrom", "updatedUntil", "createdFrom", "createdUntil"] as const).map(
              (field) => (
                <label key={field} className="product-list-wide-filter">
                  {timeLabels[field]}
                  <input
                    type="datetime-local"
                    step="60"
                    value={draft[field]?.slice(0, 16) ?? ""}
                    aria-describedby="product-list-time-help"
                    aria-invalid={
                      (invalidFilters &&
                        (field.startsWith("created")
                          ? draft.createdFrom !== null &&
                            draft.createdUntil !== null &&
                            draft.createdFrom >= draft.createdUntil
                          : draft.updatedFrom !== null &&
                            draft.updatedUntil !== null &&
                            draft.updatedFrom >= draft.updatedUntil)) ||
                      undefined
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((previous) => ({
                        ...previous,
                        [field]: value === "" ? null : value + ":00.000Z",
                      }));
                    }}
                  />
                </label>
              ),
            )}
            <label className="product-list-wide-filter">
              <span id="product-list-sort-label">Sort products by</span>
              <select
                aria-labelledby="product-list-sort-label"
                value={draft.sort}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    sort: event.target.value as ProductListFilters["sort"],
                  }))
                }
              >
                {Object.entries(sortLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                <option disabled>Publishing status · unavailable</option>
              </select>
            </label>
            <label className="product-list-wide-filter">
              <span id="product-list-direction-label">Sort direction</span>
              <select
                aria-labelledby="product-list-direction-label"
                value={draft.direction}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    direction: event.target.value as ProductListFilters["direction"],
                  }))
                }
              >
                <option value="DESC">Descending</option>
                <option value="ASC">Ascending</option>
              </select>
            </label>
            <label className="product-list-wide-filter">
              <span id="product-list-category-label">Category</span>
              <select
                aria-labelledby="product-list-category-label"
                value={draft.categoryReference ?? ""}
                disabled={categoryOptions.status !== "Known" && draft.categoryReference == null}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    categoryReference: event.target.value === "" ? null : event.target.value,
                    cursor: null,
                  }))
                }
              >
                <option value="">
                  {categoryOptions.status === "Known" || draft.categoryReference != null
                    ? "All categories"
                    : "Unavailable"}
                </option>
                {categoryOptions.status === "Known"
                  ? categoryOptions.items.map((item) => (
                      <option key={item.categoryReference} value={item.categoryReference}>
                        {item.name} ({item.internalCode})
                        {item.localeFallback ? " · " + item.nameLocale : ""}
                      </option>
                    ))
                  : null}
                {draft.categoryReference != null &&
                (categoryOptions.status !== "Known" ||
                  !categoryOptions.items.some(
                    (item) => item.categoryReference === draft.categoryReference,
                  )) ? (
                  <option value={draft.categoryReference}>Current category filter</option>
                ) : null}
              </select>
            </label>
            <label>
              Store coverage
              <select disabled>
                <option>Unavailable</option>
              </select>
            </label>
            <label>
              Sellable status
              <select disabled>
                <option>Unavailable</option>
              </select>
            </label>
          </div>
          <p id="product-list-time-help">
            Update and creation times use UTC, to the minute. The start is included and the end is
            excluded.
          </p>
          {invalidFilters ? (
            <p role="alert">
              Filters were not applied. Check the search text and UTC times. If both times are set,
              the start must be earlier than the end.
            </p>
          ) : null}
          <div className="product-list-filter-actions">
            <label>
              <input
                type="checkbox"
                checked={draft.includeArchived}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, includeArchived: event.target.checked }))
                }
              />
              Include archived
            </label>
            <button type="submit">Apply filters</button>
          </div>
          <p id="product-list-translation-help">
            Missing locale filters the current Draft name; a fallback name does not count as a
            translation. Barcode, alternate reference, Menu, tax and image filters are unavailable.
            Publishing-status sorting is unavailable.
          </p>
        </form>
        <section className="product-list-records" aria-labelledby="product-list-records-heading">
          <div className="product-list-records-heading">
            <div>
              <h2 id="product-list-records-heading">Product records</h2>
              <p>
                {current.kind === "Found"
                  ? current.view.items.length +
                    " on this page · " +
                    current.view.projection.asOfUtc +
                    " · " +
                    sortLabels[request.filters.sort] +
                    " " +
                    (request.filters.direction === "ASC" ? "ascending" : "descending")
                  : "Current product records"}
              </p>
            </div>
            <button
              ref={refresh}
              type="button"
              onClick={() => load({ ...request.filters, cursor: null })}
            >
              Refresh products
            </button>
          </div>
          <div className="product-list-results" aria-busy={current.kind === "Loading"}>
            {current.kind === "Found" ? (
              <>
                <aside className="product-list-boundary" role="status">
                  <strong>Partial product data</strong>
                  <p>
                    Draft names and SKU counts are available. Primary categories are shown where
                    available. Menus, sellability, store coverage, tax and updater details are
                    unavailable.
                  </p>
                </aside>
                <ProductListRecords
                  view={current.view}
                  historyNavigation={
                    historyNavigation?.key === key &&
                    historyNavigation.brandReference === current.view.scope.brandReference
                  }
                />
              </>
            ) : (
              <ProductListState state={current.kind} />
            )}
          </div>
          <nav className="product-list-pagination" aria-label="Product pages">
            <button
              disabled={current.kind !== "Found" || request.filters.cursor === null}
              onClick={() => load({ ...request.filters, cursor: null })}
            >
              First page
            </button>
            <button
              disabled={current.kind !== "Found" || !current.view.hasMore}
              onClick={() => {
                if (current.kind === "Found" && current.view.nextCursor)
                  load({ ...request.filters, cursor: current.view.nextCursor });
              }}
            >
              Next page
            </button>
          </nav>
        </section>
      </main>
    </div>
  );
}
