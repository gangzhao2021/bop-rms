import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  STORE_SETUP_STEPS,
  StoreAdminClientError,
  parseStoreDetailView,
  parseStoreHoursServiceView,
  parseStoreListView,
  parseStoreRouteReference,
  parseStoreSetupView,
  unavailableStoreAdminClient,
  type StoreAdminClient,
  type StoreDetailView,
  type StoreHoursServiceView,
  type StoreListView,
  type StoreSetupView,
} from "./store-admin.js";

type LoadState<T> =
  | { readonly kind: "Loading" }
  | { readonly kind: "Unavailable" }
  | { readonly kind: "NotFound" }
  | { readonly kind: "PermissionDenied" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Conflict" }
  | { readonly kind: "CommandFailed" }
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
            kind: error instanceof StoreAdminClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}

type StoreAdminState = Exclude<LoadState<never>["kind"], "Found">;

export function LocalDemoNotice() {
  return (
    <aside className="local-demo-notice" role="status" aria-label="Local synthetic preview">
      <strong>Local synthetic preview</strong>
      <span>
        Read-only training data. No API, permission, business fact, or publication is implied.
      </span>
    </aside>
  );
}

export function StoreAdminStatePanel({ state }: { readonly state: StoreAdminState }) {
  const states: Record<
    StoreAdminState,
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: ["Loading", "Loading authorized Store configuration…", "neutral"],
    Unavailable: [
      "Configuration unavailable",
      "The Store administration API is not connected. No draft or business fact was changed.",
      "error",
    ],
    NotFound: ["Store unavailable", "This Store is unavailable in the current scope.", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Your current permission and Store scope do not allow this view.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Store configuration cannot be loaded or changed while the owning source is offline.",
      "offline",
    ],
    Conflict: [
      "Source changed",
      "Refresh the authoritative Store version before attempting another change.",
      "offline",
    ],
    CommandFailed: [
      "Command failed",
      "No Store configuration success is assumed. Review the safe error and retry when allowed.",
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

export function StoreListScreen({ view }: { readonly view: StoreListView }) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("All");
  const normalized = query.trim().toLocaleLowerCase("en-CA");
  const items = view.items.filter(
    (item) =>
      (lifecycle === "All" || item.lifecycle === lifecycle) &&
      (normalized.length === 0 ||
        [item.name, item.code, item.addressSummary].some((value) =>
          value.toLocaleLowerCase("en-CA").includes(normalized),
        )),
  );
  return (
    <AppFrame title="Stores" description="Permission-trimmed Store configuration">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">STORE-LIST</p>
          <h2>Authorized Stores</h2>
          <p className="bop-muted">
            {view.projection.freshness} · as of {view.projection.asOfUtc}
          </p>
        </div>
        <button disabled title="Requires the WP-2192 Store authoring Command">
          Create draft
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Search name, code, or authorized address
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={lifecycle} onChange={(event) => setLifecycle(event.currentTarget.value)}>
            <option>All</option>
            <option>Draft</option>
            <option>Active</option>
            <option>Suspended</option>
            <option>Archived</option>
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Stores" status>
          <p>Change the safe search or status filter.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((store) => (
            <article className="store-card" key={store.storeReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">{store.code}</p>
                  <h3>{store.name}</h3>
                </div>
                <strong>{store.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Timezone</dt>
                  <dd>{store.timeZone}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>{store.addressSummary}</dd>
                </div>
                <div>
                  <dt>Service modes</dt>
                  <dd>{store.serviceModes.join(", ") || "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Today hours</dt>
                  <dd>{store.todayHours}</dd>
                </div>
                <div>
                  <dt>Live gate</dt>
                  <dd>{store.liveGate}</dd>
                </div>
                <div>
                  <dt>Configuration</dt>
                  <dd>{store.configurationSource}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/organization/stores/${store.storeReference}`}>Open detail</Link>
                <Link to={`/app/organization/stores/${store.storeReference}/setup`}>
                  Open setup
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function StoreDetailScreen({ view }: { readonly view: StoreDetailView }) {
  return (
    <AppFrame
      title={view.name}
      description={`STORE-DETAIL · ${view.lifecycle} · version ${view.version}`}
    >
      <header className="screen-heading">
        <div>
          <h2>Store detail</h2>
          <p>
            {view.projection.freshness} · {view.projection.asOfUtc}
          </p>
        </div>
        <Link className="shell-action" to={`/app/organization/stores/${view.storeReference}/setup`}>
          Open setup
        </Link>
        <Link
          className="shell-action"
          to={`/app/organization/stores/${view.storeReference}/service`}
        >
          Hours &amp; service
        </Link>
      </header>
      <div className="detail-section-grid">
        {Object.entries(view.sections).map(([name, status]) => (
          <StatePanel
            heading={name}
            key={name}
            tone={status === "Incomplete" ? "offline" : "neutral"}
          >
            <strong>{status}</strong>
            {status === "Unavailable" ? (
              <p>Owning source is unavailable; no zero/empty value is inferred.</p>
            ) : null}
          </StatePanel>
        ))}
      </div>
    </AppFrame>
  );
}

export function StoreHoursServiceScreen({ view }: { readonly view: StoreHoursServiceView }) {
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return (
    <AppFrame
      title={`${view.name} hours & service`}
      description={`STORE-HOURS-SERVICE · Expected Version ${view.version}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">STORE-HOURS-SERVICE</p>
          <h2>Hours and service configuration</h2>
          <p>
            {view.configurationSource} · effective {view.effectiveFrom}
            {view.effectiveUntil ? ` to ${view.effectiveUntil}` : " onward"}
          </p>
        </div>
        <strong>{view.pauseState}</strong>
      </header>
      <dl className="detail-list">
        <div>
          <dt>Business Day Start</dt>
          <dd>{view.businessDayStartLocalTime} local</dd>
        </div>
        <div>
          <dt>Service modes</dt>
          <dd>{view.enabledServiceModes.join(", ")}</dd>
        </div>
        <div>
          <dt>Exceptions</dt>
          <dd>{view.exceptionCount}</dd>
        </div>
        <div>
          <dt>Projection</dt>
          <dd>
            {view.projection.freshness} · {view.projection.asOfUtc}
          </dd>
        </div>
      </dl>
      <div className="detail-section-grid">
        {view.weeklyDays.map((day, index) => (
          <StatePanel heading={weekdays[index] ?? "Day"} key={day.isoWeekday}>
            <p>{day.hoursSummary}</p>
          </StatePanel>
        ))}
      </div>
      <StatePanel
        heading={view.canManageService ? "Store service controls" : "Permission-trimmed controls"}
        tone={view.canManageService ? "neutral" : "offline"}
      >
        <p>
          Overrides are overlap-validated. Pausing service never changes published hours or external
          configuration.
        </p>
        <div className="card-actions">
          <button disabled={!view.canManageService}>Create override</button>
          <button disabled={!view.canManageService}>Validate overlap</button>
          <button disabled={!view.canManageService}>Schedule</button>
          <button disabled={!view.canManageService}>Pause service safely</button>
        </div>
      </StatePanel>
    </AppFrame>
  );
}

export function StoreSetupScreen({ view }: { readonly view: StoreSetupView }) {
  return (
    <AppFrame
      title={`${view.name} setup`}
      description={`STORE-SETUP · Expected Version ${view.version}`}
    >
      <header className="screen-heading">
        <div>
          <h2>Store setup</h2>
          <p>
            Evidence gate: <strong>{view.evidenceGate}</strong>
          </p>
        </div>
      </header>
      <ol className="setup-steps">
        {view.steps.map((item, index) => (
          <li key={item.step} data-status={item.status}>
            <span>{index + 1}</span>
            <div>
              <strong>{STORE_SETUP_STEPS[index]}</strong>
              <p>{item.status}</p>
            </div>
          </li>
        ))}
      </ol>
      <StatePanel heading="Authoring integration required" tone="offline">
        <p>
          Save draft and Validate step require the WP-2192 server Command. Publish also requires a
          satisfied evidence gate.
        </p>
        <div className="card-actions">
          <button disabled>Save draft</button>
          <button disabled>Validate step</button>
          <button disabled>Publish setup</button>
        </div>
      </StatePanel>
    </AppFrame>
  );
}

export function StoreListPage({
  client = unavailableStoreAdminClient,
}: {
  readonly client?: StoreAdminClient;
}) {
  const load = useCallback(() => client.listStores().then(parseStoreListView), [client]);
  const state = useLoad(load, "list");
  return state.kind === "Found" ? (
    <StoreListScreen view={state.view} />
  ) : (
    <AppFrame title="Stores" description="STORE-LIST">
      <StoreAdminStatePanel state={state.kind} />
    </AppFrame>
  );
}

function storeReference(value: string | undefined): string | null {
  try {
    return parseStoreRouteReference(value);
  } catch {
    return null;
  }
}

export function StoreDetailPage({
  client = unavailableStoreAdminClient,
}: {
  readonly client?: StoreAdminClient;
}) {
  const route = storeReference(useParams().id);
  const load = useCallback(
    () =>
      route === null
        ? Promise.reject(new Error("NOT_FOUND"))
        : client.loadStore(route).then((value) => {
            const view = parseStoreDetailView(value);
            if (view.storeReference !== route) throw new Error("STORE_MISMATCH");
            return view;
          }),
    [client, route],
  );
  const state = useLoad(load, route ?? "invalid");
  if (route === null)
    return (
      <AppFrame title="Store" description="STORE-DETAIL">
        <StoreAdminStatePanel state="NotFound" />
      </AppFrame>
    );
  return state.kind === "Found" ? (
    <StoreDetailScreen view={state.view} />
  ) : (
    <AppFrame title="Store" description="STORE-DETAIL">
      <StoreAdminStatePanel state={state.kind} />
    </AppFrame>
  );
}

export function StoreSetupPage({
  client = unavailableStoreAdminClient,
}: {
  readonly client?: StoreAdminClient;
}) {
  const route = storeReference(useParams().id);
  const load = useCallback(
    () =>
      route === null
        ? Promise.reject(new Error("NOT_FOUND"))
        : client.loadSetup(route).then((value) => {
            const view = parseStoreSetupView(value);
            if (view.storeReference !== route) throw new Error("STORE_MISMATCH");
            return view;
          }),
    [client, route],
  );
  const state = useLoad(load, route ?? "invalid");
  if (route === null)
    return (
      <AppFrame title="Store setup" description="STORE-SETUP">
        <StoreAdminStatePanel state="NotFound" />
      </AppFrame>
    );
  return state.kind === "Found" ? (
    <StoreSetupScreen view={state.view} />
  ) : (
    <AppFrame title="Store setup" description="STORE-SETUP">
      <StoreAdminStatePanel state={state.kind} />
    </AppFrame>
  );
}

export function StoreHoursServicePage({
  client = unavailableStoreAdminClient,
}: {
  readonly client?: StoreAdminClient;
}) {
  const route = storeReference(useParams().id);
  const load = useCallback(
    () =>
      route === null
        ? Promise.reject(new Error("NOT_FOUND"))
        : client.loadHoursService(route).then((value) => {
            const view = parseStoreHoursServiceView(value);
            if (view.storeReference !== route) throw new Error("STORE_MISMATCH");
            return view;
          }),
    [client, route],
  );
  const state = useLoad(load, route ?? "invalid");
  if (route === null)
    return (
      <AppFrame title="Hours & service" description="STORE-HOURS-SERVICE">
        <StoreAdminStatePanel state="NotFound" />
      </AppFrame>
    );
  return state.kind === "Found" ? (
    <StoreHoursServiceScreen view={state.view} />
  ) : (
    <AppFrame title="Hours & service" description="STORE-HOURS-SERVICE">
      <StoreAdminStatePanel state={state.kind} />
    </AppFrame>
  );
}
