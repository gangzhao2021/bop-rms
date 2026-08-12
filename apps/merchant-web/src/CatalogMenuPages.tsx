import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  CatalogMenuClientError,
  parseMenuBuilderView,
  parseMenuListView,
  parseMenuRouteReference,
  unavailableCatalogMenuClient,
  type CatalogMenuClient,
  type MenuBuilderView,
  type MenuListView,
} from "./catalog-menu.js";

type LoadState<T> =
  | {
      readonly kind:
        "Loading" | "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "Unavailable";
    }
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
          setState({
            kind: error instanceof CatalogMenuClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}

type CatalogState = Exclude<LoadState<never>["kind"], "Found">;

export function CatalogMenuStatePanel({ state }: { readonly state: CatalogState }) {
  const states: Record<CatalogState, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Catalog projection…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Your Catalog permission and scope do not allow this view.",
      "error",
    ],
    NotFound: [
      "Menu unavailable",
      "This Menu is unavailable in the current authorized scope.",
      "neutral",
    ],
    Offline: [
      "Offline read-only",
      "Catalog facts cannot be loaded or changed while the owning source is offline.",
      "offline",
    ],
    Conflict: [
      "Source changed",
      "Refresh the authoritative Menu version before another action.",
      "offline",
    ],
    Unavailable: [
      "Catalog unavailable",
      "The Catalog browser contract is not connected. No Menu fact was changed.",
      "error",
    ],
  };
  const content = states[state];
  return (
    <StatePanel heading={content[0]} tone={content[2]} status>
      <p>{content[1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}

export function MenuListScreen({ view }: { readonly view: MenuListView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const normalized = query.trim().toLocaleLowerCase("en-CA");
  const items = view.items.filter(
    (item) =>
      (status === "All" || item.lifecycle === status) &&
      (normalized.length === 0 ||
        [item.name, item.internalCode].some((value) =>
          value.toLocaleLowerCase("en-CA").includes(normalized),
        )),
  );
  return (
    <AppFrame title="Menus" description="CAT-MENU-LIST · permission-trimmed Catalog projection">
      <header className="screen-heading">
        <div>
          <h2>Authorized Menus</h2>
          <p className="bop-muted">Current · as of {view.asOfUtc}</p>
        </div>
        <button disabled title="A Catalog create-draft browser Command is not available">
          Create menu
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Search name or code
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            {["All", "Draft", "InReview", "Approved", "Published", "Superseded", "Archived"].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Menus" status>
          <p>Change the safe search or lifecycle filter.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((menu) => (
            <article className="store-card" key={menu.menuReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">{menu.internalCode}</p>
                  <h3>{menu.name}</h3>
                </div>
                <strong>{menu.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Version</dt>
                  <dd>{menu.version}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{menu.updatedAt}</dd>
                </div>
                <div>
                  <dt>Scope / channels</dt>
                  <dd>Unavailable from catalog_menu_management_v1</dd>
                </div>
                <div>
                  <dt>Effective period</dt>
                  <dd>Unavailable from catalog_menu_management_v1</dd>
                </div>
                <div>
                  <dt>Sections / placements</dt>
                  <dd>Unavailable from catalog_menu_management_v1</dd>
                </div>
                <div>
                  <dt>Validation</dt>
                  <dd>Unavailable from catalog_menu_management_v1</dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/commerce/menus/${menu.menuReference}/edit`}>Open builder</Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function MenuBuilderScreen({ view }: { readonly view: MenuBuilderView }) {
  return (
    <AppFrame
      title={view.name}
      description={`CAT-MENU-BUILDER · ${view.lifecycle} · Expected Version ${view.version}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.internalCode}</p>
          <h2>Menu builder</h2>
          <p>
            {view.scopeSummary} · {view.channelSummary}
          </p>
        </div>
        <Link className="shell-action" to="/app/commerce/menus">
          All menus
        </Link>
      </header>
      <div className="detail-section-grid">
        {view.sections.map((section, index) => (
          <StatePanel
            heading={`${index + 1}. ${section.name}`}
            key={section.sectionReference}
            tone={
              section.validation === "Invalid"
                ? "error"
                : section.validation === "Unavailable"
                  ? "offline"
                  : "neutral"
            }
          >
            <p>
              {section.placementCount} placements · {section.validation}
            </p>
            <button disabled>Move up (keyboard)</button>
          </StatePanel>
        ))}
      </div>
      <StatePanel
        heading="Validation rail"
        tone={view.unresolvedIssueCount > 0 ? "error" : "neutral"}
      >
        <p>
          {view.unresolvedIssueCount} unresolved issues · Publish evidence {view.publishEvidence}
        </p>
      </StatePanel>
      <StatePanel heading="Publish workflow unavailable" tone="offline">
        <p>
          Submit, approve, publish, schedule, rollback-by-new-version and archive require a closed
          browser BFF that supplies the authoritative snapshot digest, effective period, CSRF,
          idempotency key and Expected Version.
        </p>
        <div className="card-actions">
          <button disabled>Save draft</button>
          <button disabled>Submit review</button>
          <button disabled>Approve</button>
          <button disabled>Publish / schedule</button>
          <button disabled>Archive</button>
        </div>
      </StatePanel>
    </AppFrame>
  );
}

export function MenuListPage({
  client = unavailableCatalogMenuClient,
}: {
  readonly client?: CatalogMenuClient;
}) {
  const load = useCallback(() => client.listMenus().then(parseMenuListView), [client]);
  const state = useLoad(load, "menus");
  return state.kind === "Found" ? (
    <MenuListScreen view={state.view} />
  ) : (
    <AppFrame title="Menus" description="CAT-MENU-LIST">
      <CatalogMenuStatePanel state={state.kind} />
    </AppFrame>
  );
}

export function MenuBuilderPage({
  client = unavailableCatalogMenuClient,
}: {
  readonly client?: CatalogMenuClient;
}) {
  let route: string | null = null;
  try {
    route = parseMenuRouteReference(useParams().id);
  } catch {
    route = null;
  }
  const load = useCallback(
    () =>
      route === null
        ? Promise.reject(new CatalogMenuClientError("NotFound"))
        : client.loadBuilder(route).then((value) => {
            const view = parseMenuBuilderView(value);
            if (view.menuReference !== route) throw new Error("MENU_MISMATCH");
            return view;
          }),
    [client, route],
  );
  const state = useLoad(load, route ?? "invalid");
  if (route === null)
    return (
      <AppFrame title="Menu" description="CAT-MENU-BUILDER">
        <CatalogMenuStatePanel state="NotFound" />
      </AppFrame>
    );
  return state.kind === "Found" ? (
    <MenuBuilderScreen view={state.view} />
  ) : (
    <AppFrame title="Menu" description="CAT-MENU-BUILDER">
      <CatalogMenuStatePanel state={state.kind} />
    </AppFrame>
  );
}
