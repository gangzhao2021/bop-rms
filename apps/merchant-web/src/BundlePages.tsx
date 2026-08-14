import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import {
  BundleClientError,
  parseBundleEditorView,
  parseBundleListView,
  parseBundleRouteReference,
  unavailableBundleClient,
  type BundleClient,
  type BundleClientErrorCode,
  type BundleEditorView,
  type BundleListView,
} from "./bundle-pages.js";

type LoadState<T> =
  | { readonly kind: "Loading" | BundleClientErrorCode }
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
          setState({ kind: error instanceof BundleClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}

export function BundleStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Bundle projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your Catalog scope does not allow this Bundle view.",
        "error",
      ],
      NotFound: [
        "Bundle unavailable",
        "This Bundle is not available in the current authorized Brand scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Bundles disabled",
        "This phase capability is disabled for the current Brand.",
        "neutral",
      ],
      Stale: [
        "Bundle data is stale",
        "Refresh before validating, simulating or publishing.",
        "offline",
      ],
      Conflict: [
        "Bundle changed",
        "Reload the authoritative Expected Version before another command.",
        "offline",
      ],
      CommandFailed: [
        "Command failed",
        "No Bundle fact changed. Retry with the same idempotency reference.",
        "error",
      ],
      Offline: [
        "Offline read-only",
        "Cached Bundle facts may be viewed, but commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Bundle service unavailable",
        "The Bundle BFF is unavailable. No Catalog fact was changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
      <Link to="/app/commerce/bundles">Return to Bundles</Link>
    </StatePanel>
  );
}

export function BundleListScreen({ view }: { readonly view: BundleListView }) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("All");
  const [priceMode, setPriceMode] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const items = view.items.filter(
    (item) =>
      (lifecycle === "All" || item.lifecycle === lifecycle) &&
      (priceMode === "All" || item.priceMode === priceMode) &&
      (needle === "" ||
        [item.name, item.internalCode].some((text) =>
          text.toLocaleLowerCase("en-CA").includes(needle),
        )),
  );
  return (
    <AppFrame title="Bundles" description="CAT-BUNDLE-LIST · permission-trimmed Catalog projection">
      <header className="screen-heading">
        <div>
          <h2>Authorized Bundles</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Bundle BFF is not connected">
          Create Bundle
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Search name or code
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Lifecycle
          <select value={lifecycle} onChange={(event) => setLifecycle(event.currentTarget.value)}>
            {["All", "Draft", "Published", "Suspended", "Discontinued", "Archived"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Price mode
          <select value={priceMode} onChange={(event) => setPriceMode(event.currentTarget.value)}>
            {["All", "Fixed", "Computed"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Bundles" status>
          <p>Change the safe filters or create an authorized Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <article className="store-card" key={item.bundleReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">{item.internalCode}</p>
                  <h3>{item.name}</h3>
                </div>
                <strong>{item.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Price</dt>
                  <dd>{item.priceMode}</dd>
                </div>
                <div>
                  <dt>Components / choices</dt>
                  <dd>
                    {item.componentCount} / {item.choiceCount}
                  </dd>
                </div>
                <div>
                  <dt>Menu references</dt>
                  <dd>{item.menuReferenceCount}</dd>
                </div>
                <div>
                  <dt>Effective version</dt>
                  <dd>{item.effectiveVersion}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/commerce/bundles/${item.bundleReference}/edit`}>Edit Bundle</Link>
                <button disabled title="A command-capable Bundle BFF is not connected">
                  Duplicate
                </button>
                <button disabled title="A command-capable Bundle BFF is not connected">
                  Validate
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function BundleEditorScreen({ view }: { readonly view: BundleEditorView }) {
  return (
    <AppFrame
      title={view.name}
      description={`CAT-BUNDLE-EDITOR · ${view.lifecycle} · Expected Version ${view.aggregateVersion}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.internalCode}</p>
          <h2>Bundle editor</h2>
          <p>
            {view.priceSummary} · {view.availabilitySummary}
          </p>
        </div>
        <Link className="shell-action" to="/app/commerce/bundles">
          All Bundles
        </Link>
      </header>
      <section aria-labelledby="component-groups">
        <h3 id="component-groups">Component groups</h3>
        <div className="detail-section-grid">
          {view.componentGroups.map((group, index) => (
            <StatePanel key={group.groupReference} heading={`${index + 1}. ${group.name}`}>
              <p>
                {group.bounds} · {group.eligibleSellableCount} eligible Sellables
              </p>
              <p>{group.upgradeRuleSummary}</p>
              <button
                aria-label={`Move ${group.name} up with keyboard`}
                disabled
                title="A command-capable Bundle BFF is not connected"
              >
                Move up
              </button>
            </StatePanel>
          ))}
        </div>
      </section>
      <StatePanel heading="History and validation">
        <p>{view.historySummary}</p>
        <p>Nested Bundle depth 0 · exact published references required.</p>
      </StatePanel>
      <div className="card-actions" aria-label="Bundle actions">
        {["Save Draft", "Validate", "Simulate configuration", "Submit review", "Publish"].map(
          (action) => (
            <button disabled key={action} title="A command-capable Bundle BFF is not connected">
              {action}
            </button>
          ),
        )}
      </div>
    </AppFrame>
  );
}

export function BundleListPage({
  client = unavailableBundleClient,
}: {
  readonly client?: BundleClient;
}) {
  const load = useCallback(() => client.listBundles().then(parseBundleListView), [client]);
  const state = useLoad(load, "bundles");
  return state.kind === "Found" ? (
    <BundleListScreen view={state.view} />
  ) : (
    <AppFrame title="Bundles" description="CAT-BUNDLE-LIST">
      <BundleStatePanel state={state.kind} />
    </AppFrame>
  );
}
export function BundleEditorPage({
  client = unavailableBundleClient,
}: {
  readonly client?: BundleClient;
}) {
  let reference: string | null = null;
  try {
    reference = parseBundleRouteReference(useParams().id);
  } catch {
    reference = null;
  }
  const load = useCallback(
    () =>
      reference === null
        ? Promise.reject(new BundleClientError("NotFound"))
        : client.loadEditor(reference).then((value) => {
            const view = parseBundleEditorView(value);
            if (view.bundleReference !== reference) throw new BundleClientError("NotFound");
            return view;
          }),
    [client, reference],
  );
  const state = useLoad(load, reference ?? "invalid");
  return state.kind === "Found" ? (
    <BundleEditorScreen view={state.view} />
  ) : (
    <AppFrame title="Bundle" description="CAT-BUNDLE-EDITOR">
      <BundleStatePanel state={state.kind} />
    </AppFrame>
  );
}
