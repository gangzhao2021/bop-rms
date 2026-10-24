import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  createOptionSetListClient,
  OptionSetListClientError,
  type OptionSetListRequest,
  type OptionSetListView,
  type OptionSetListPresence,
} from "./option-set-list-client.js";

export interface OptionSetListPageProps {
  readonly brandReference: string | null;
  readonly storeReference: string | null;
  readonly brandLabel?: string;
  readonly storeLabel?: string;
  readonly csrf: string;
  readonly client?: ReturnType<typeof createOptionSetListClient>;
  readonly capabilityClient?: ReturnType<typeof createStoreCapabilityClient>;
}
const initial: OptionSetListRequest = {
  locale: "en-CA",
  search: null,
  lifecycle: null,
  selectionType: null,
  includeArchived: false,
  hasProductBinding: null,
  hasPricingReference: null,
  hasConsumptionReference: null,
  hasConflict: null,
  missingTranslationLocale: null,
  publishingStatus: null,
  sort: "updatedAt",
  direction: "DESC",
  limit: 25,
  cursor: null,
};
type Failure = OptionSetListClientError["code"] | "Offline";
interface LoadState {
  readonly key: string;
  readonly kind: "Loading" | "Found" | Failure;
  readonly view?: OptionSetListView;
  readonly createAllowed?: boolean;
}
export function OptionSetListState({ state }: { readonly state: "Loading" | "Empty" | Failure }) {
  const copy = {
    Loading: ["Loading Option Sets", "Reading current records for this Brand and Store."],
    Empty: ["No Option Sets", "No records match the current filters."],
    Invalid: ["Invalid filters", "Check the filters and refresh the first page."],
    Denied: ["Permission denied", "Option Set records are unavailable for this session and scope."],
    FeatureDisabled: [
      "Option Set List disabled",
      "This capability is disabled for the selected Store.",
    ],
    Stale: [
      "Option Set source changed",
      "The page cursor is stale. Refresh the first page to read current records.",
    ],
    ScopeChanged: ["Scope changed", "Refresh in the current Brand and Store before continuing."],
    Unavailable: [
      "Option Sets unavailable",
      "Current records could not be loaded. Retry the first page.",
    ],
    Offline: ["Offline", "Connect before reading current Option Set records."],
  } as const;
  return (
    <StatePanel
      heading={copy[state][0]}
      tone={
        state === "Offline"
          ? "offline"
          : state === "Loading" || state === "Empty"
            ? "neutral"
            : "error"
      }
      status
    >
      <p>{copy[state][1]}</p>
    </StatePanel>
  );
}
const presence = (value: OptionSetListPresence) =>
  value.status === "Unknown" ? "Unknown" : value.present ? "Recorded" : "Not recorded";
export function OptionSetListRecords({ view }: { readonly view: OptionSetListView }) {
  return (
    <>
      <div
        className="product-list-table"
        tabIndex={0}
        role="region"
        aria-label="Option Set records"
      >
        <table>
          <caption>Current Option Set authoring records</caption>
          <thead>
            <tr>
              <th scope="col">Name / code</th>
              <th scope="col">Draft / selection</th>
              <th scope="col">Options / bindings</th>
              <th scope="col">Recorded references</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((row) => (
              <tr key={row.optionSetReference}>
                <th scope="row">
                  <Link to={`/app/commerce/option-sets/${row.optionSetReference}`}>{row.name}</Link>
                  <small>{row.internalCode}</small>
                  {row.localeFallback ? (
                    <small>Name in {row.nameLocale} (locale fallback)</small>
                  ) : null}
                </th>
                <td>
                  {row.lifecycle}
                  <small>Draft version {row.aggregateVersion}</small>
                  <small>
                    {row.selectionRule.displayStyle}: {row.selectionRule.minimumSelection}–
                    {row.selectionRule.maximumSelection ?? "Unbounded"} selections
                  </small>
                </td>
                <td>
                  {row.activeOptionCount} active / {row.optionCount} total
                  <small>{row.productBindingCount} recorded Product bindings</small>
                </td>
                <td>
                  Pricing: {presence(row.recordedPricingReference)}
                  <small>Consumption: {presence(row.recordedConsumptionReference)}</small>
                  <small>Conflict: {presence(row.recordedConflict)}</small>
                </td>
                <td>
                  <time dateTime={row.updatedAt}>
                    {row.updatedAt.replace("T", " ").replace("Z", " UTC")}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="product-list-cards">
        {view.items.map((row) => (
          <article key={row.optionSetReference} className="product-list-card">
            <h3>
              <Link to={`/app/commerce/option-sets/${row.optionSetReference}`}>{row.name}</Link>
            </h3>
            <p>
              {row.internalCode} · {row.lifecycle} · Draft version {row.aggregateVersion}
            </p>
            {row.localeFallback ? <p>Name in {row.nameLocale} (locale fallback)</p> : null}
            <dl>
              <div>
                <dt>Selection</dt>
                <dd>
                  {row.selectionRule.displayStyle}: {row.selectionRule.minimumSelection}–
                  {row.selectionRule.maximumSelection ?? "Unbounded"} selections
                </dd>
              </div>
              <div>
                <dt>Options / bindings</dt>
                <dd>
                  {row.activeOptionCount} active / {row.optionCount} total ·{" "}
                  {row.productBindingCount} recorded Product bindings
                </dd>
              </div>
              <div>
                <dt>Recorded references</dt>
                <dd>
                  Pricing: {presence(row.recordedPricingReference)} · Consumption:{" "}
                  {presence(row.recordedConsumptionReference)} · Conflict:{" "}
                  {presence(row.recordedConflict)}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={row.updatedAt}>{row.updatedAt}</time>
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}
export function OptionSetListPage(props: OptionSetListPageProps) {
  const client = useMemo(() => props.client ?? createOptionSetListClient(), [props.client]);
  const capabilities = useMemo(
    () => props.capabilityClient ?? createStoreCapabilityClient(),
    [props.capabilityClient],
  );
  const [draft, setDraft] = useState(initial);
  const [filters, setFilters] = useState(initial);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );
  const scopeKey = JSON.stringify([props.brandReference, props.storeReference, props.csrf]);
  const key = JSON.stringify([scopeKey, filters, refresh, offline]);
  const [state, setState] = useState<LoadState>({ key: "", kind: "Loading" });
  const originalScope = useRef<{ key: string; scope: OptionSetListView["scope"] } | null>(null);
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!props.storeReference || offline) return;
    const controller = new AbortController();
    const storeReference = props.storeReference;
    const current = () => !controller.signal.aborted;
    void (async () => {
      try {
        const observed = await capabilities.load(
          {
            scope: {
              storeReference,
              ...(props.brandReference ? { brandReference: props.brandReference } : {}),
            },
            capabilityKey: "catalog.cat_optionset_list",
            csrf: props.csrf,
          },
          controller.signal,
        );
        if (!current()) return;
        if (observed.backendExecution !== "Allow" || observed.frontendVisibility !== "Show")
          throw new OptionSetListClientError(
            observed.reason === "Disabled" ? "FeatureDisabled" : "Unavailable",
          );
        const expectedScope = { brandReference: observed.brandReference, storeReference };
        const prior = originalScope.current;
        const view = await client.load({
          filters,
          expectedScope,
          csrf: props.csrf,
          signal: controller.signal,
          ...(prior?.key === scopeKey ? { expectedFullScope: prior.scope } : {}),
        });
        if (!current()) return;
        originalScope.current = { key: scopeKey, scope: view.scope };
        setState({ key, kind: "Found", view, createAllowed: false });
        // Separate actual create observation; failure cannot certify a Create entry.
        try {
          const create = await capabilities.load(
            {
              scope: expectedScope,
              capabilityKey: "catalog.cat_optionset_create",
              csrf: props.csrf,
            },
            controller.signal,
          );
          if (
            current() &&
            create.brandReference === view.scope.brandReference &&
            create.storeReference === view.scope.storeReference &&
            create.backendExecution === "Allow" &&
            create.frontendVisibility === "Show"
          )
            setState({ key, kind: "Found", view, createAllowed: true });
        } catch {
          /* List remains readable; Create permission is enforced again by its command. */
        }
      } catch (error) {
        if (!current()) return;
        const code =
          error instanceof OptionSetListClientError
            ? error.code
            : error instanceof StoreCapabilityClientError
              ? error.code
              : "Unavailable";
        setState({ key, kind: code });
        if (code === "ScopeChanged") originalScope.current = null;
        if (code === "Stale" && filters.cursor !== null) {
          setNotice(scopeKey);
          setFilters((previous) => ({ ...previous, cursor: null }));
        }
      }
    })();
    return () => controller.abort();
  }, [
    client,
    capabilities,
    props.brandReference,
    props.storeReference,
    props.csrf,
    filters,
    scopeKey,
    key,
    offline,
  ]);
  const active = state.key === key ? state : { key, kind: "Loading" as const };
  const firstPage = () => {
    setNotice(null);
    setFilters({ ...filters, cursor: null });
    setRefresh((n) => n + 1);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters({ ...draft, search: draft.search?.trim() || null, cursor: null });
  };
  const set = <K extends keyof OptionSetListRequest>(field: K, value: OptionSetListRequest[K]) =>
    setDraft((previous) => ({ ...previous, [field]: value, cursor: null }));
  if (!props.storeReference)
    return (
      <section className="product-list-page">
        <h1>Option Sets</h1>
        <StatePanel heading="Select a Store" tone="neutral" status>
          <p>Select a Store to read Option Sets in its current Brand.</p>
        </StatePanel>
      </section>
    );
  return (
    <section className="product-list-page" aria-labelledby="option-list-heading">
      <header className="product-list-heading">
        <div>
          <h1 id="option-list-heading">Option Sets</h1>
          <p>
            {props.brandLabel ?? "Current Brand"} · {props.storeLabel ?? "Selected Store"}
          </p>
        </div>
        {!offline && active.kind === "Found" && active.createAllowed ? (
          <Link className="primary-button" to="/app/commerce/option-sets/new">
            Create Option Set
          </Link>
        ) : null}
      </header>
      <form className="product-list-filters" onSubmit={submit} aria-label="Option Set filters">
        <div className="product-list-filter-grid">
          <label>
            Search names, codes or Options
            <input
              type="search"
              maxLength={200}
              value={draft.search ?? ""}
              onChange={(e) => set("search", e.target.value || null)}
            />
          </label>
          <label>
            Locale
            <input
              value={draft.locale}
              maxLength={35}
              onChange={(e) => set("locale", e.target.value)}
            />
          </label>
          <label>
            Lifecycle
            <select
              value={draft.lifecycle ?? ""}
              onChange={(e) => {
                const lifecycle =
                  e.target.value === "Draft"
                    ? "Draft"
                    : e.target.value === "Archived"
                      ? "Archived"
                      : null;
                setDraft((previous) => ({
                  ...previous,
                  lifecycle,
                  includeArchived: lifecycle === "Archived" ? true : previous.includeArchived,
                }));
              }}
            >
              <option value="">Any</option>
              <option>Draft</option>
              <option>Archived</option>
            </select>
          </label>
          <label>
            Selection type
            <select
              value={draft.selectionType ?? ""}
              onChange={(e) =>
                set(
                  "selectionType",
                  e.target.value === "SingleChoice"
                    ? "SingleChoice"
                    : e.target.value === "MultiChoice"
                      ? "MultiChoice"
                      : e.target.value === "Quantity"
                        ? "Quantity"
                        : null,
                )
              }
            >
              <option value="">Any</option>
              <option>SingleChoice</option>
              <option>MultiChoice</option>
              <option>Quantity</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.includeArchived}
              onChange={(e) => {
                const includeArchived = e.target.checked;
                setDraft((previous) => ({
                  ...previous,
                  includeArchived,
                  lifecycle:
                    !includeArchived && previous.lifecycle === "Archived"
                      ? null
                      : previous.lifecycle,
                }));
              }}
            />
            Include Archived Option Sets
          </label>
          {(
            [
              ["hasProductBinding", "Recorded Product bindings"],
              ["hasPricingReference", "Recorded pricing references"],
              ["hasConsumptionReference", "Recorded consumption references"],
              ["hasConflict", "Recorded conflicts"],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <select
                value={draft[field] === null ? "" : String(draft[field])}
                onChange={(e) =>
                  set(field, e.target.value === "" ? null : e.target.value === "true")
                }
              >
                <option value="">Any</option>
                <option value="true">Recorded</option>
                <option value="false">Not recorded</option>
              </select>
            </label>
          ))}
          <label>
            Missing translation locale
            <input
              value={draft.missingTranslationLocale ?? ""}
              maxLength={35}
              onChange={(e) => set("missingTranslationLocale", e.target.value || null)}
            />
          </label>
          <label>
            Sort by
            <select
              value={draft.sort}
              onChange={(e) =>
                set(
                  "sort",
                  e.target.value === "name"
                    ? "name"
                    : e.target.value === "createdAt"
                      ? "createdAt"
                      : e.target.value === "internalCode"
                        ? "internalCode"
                        : "updatedAt",
                )
              }
            >
              <option value="updatedAt">Updated time</option>
              <option value="createdAt">Created time</option>
              <option value="internalCode">Code</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label>
            Sort direction
            <select
              value={draft.direction}
              onChange={(e) => set("direction", e.target.value === "ASC" ? "ASC" : "DESC")}
            >
              <option value="DESC">Descending</option>
              <option value="ASC">Ascending</option>
            </select>
          </label>
        </div>
        <div className="product-list-filter-actions">
          <button type="submit" disabled={offline}>
            Apply filters
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(initial);
              setFilters(initial);
              setRefresh((n) => n + 1);
            }}
            disabled={offline}
          >
            Reset filters
          </button>
        </div>
      </form>
      <section
        className="product-list-records"
        aria-label="Option Set results"
        aria-busy={!offline && active.kind === "Loading"}
      >
        {notice === scopeKey ? (
          <p role="status">
            Option Set source changed. The stale cursor was cleared and the first page is being
            refreshed.
          </p>
        ) : null}
        <aside className="product-list-boundary">
          Partial authoring view. Publishing status unavailable; reference eligibility not
          evaluated. Recorded references and bindings do not establish current publication, pricing
          or availability.
        </aside>
        {offline ? (
          <OptionSetListState state="Offline" />
        ) : active.kind === "Found" && active.view ? (
          <>
            <p>
              Observed{" "}
              <time dateTime={active.view.projection.asOfUtc}>
                {active.view.projection.asOfUtc}
              </time>
            </p>
            {active.view.items.length ? (
              <OptionSetListRecords view={active.view} />
            ) : (
              <OptionSetListState state="Empty" />
            )}
          </>
        ) : (
          <OptionSetListState state={active.kind === "Found" ? "Unavailable" : active.kind} />
        )}
      </section>
      <nav className="product-list-pagination" aria-label="Option Set pages">
        <button type="button" onClick={firstPage} disabled={offline}>
          Refresh first page
        </button>
        <button
          type="button"
          disabled={
            offline || active.kind !== "Found" || !active.view?.hasMore || !active.view?.nextCursor
          }
          onClick={() => {
            const cursor = active.view?.nextCursor;
            if (cursor) setFilters({ ...filters, cursor });
          }}
        >
          Next page
        </button>
      </nav>
    </section>
  );
}
