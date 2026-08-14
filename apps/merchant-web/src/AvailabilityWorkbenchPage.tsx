import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  AvailabilityClientError,
  parseAvailabilityWorkbenchView,
  unavailableAvailabilityClient,
  type AvailabilityClient,
  type AvailabilityClientErrorCode,
  type AvailabilityWorkbenchView,
} from "./availability-workbench.js";

type LoadState =
  | { readonly kind: "Loading" | AvailabilityClientErrorCode }
  | { readonly kind: "Found"; readonly view: AvailabilityWorkbenchView };

export function AvailabilityStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Availability projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your current Tenant, Brand, Store and field scope does not permit this view.",
        "error",
      ],
      NotFound: [
        "Availability rule unavailable",
        "The rule is not visible in the current authorized scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Availability disabled",
        "This phase capability is disabled for the current Brand.",
        "neutral",
      ],
      Stale: [
        "Availability data is stale",
        "Refresh before simulating or issuing a command.",
        "offline",
      ],
      Conflict: [
        "Availability rule changed",
        "Reload the authoritative Expected Version before retrying.",
        "offline",
      ],
      CommandFailed: [
        "Command failed",
        "No Availability fact changed. Retry with the same idempotency reference.",
        "error",
      ],
      Offline: [
        "Offline read-only",
        "Cached rules may be viewed, but simulations and commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Availability service unavailable",
        "The Workbench BFF is unavailable. No Catalog fact changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
      <Link to="/app">Return to workspace</Link>
    </StatePanel>
  );
}

export function AvailabilityWorkbenchScreen({
  view,
}: {
  readonly view: AvailabilityWorkbenchView;
}) {
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("All");
  const [source, setSource] = useState("All");
  const [timing, setTiming] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const stores = ["All", ...new Set(view.items.map((item) => item.storeName))];
  const items = view.items.filter(
    (item) =>
      (store === "All" || item.storeName === store) &&
      (source === "All" || item.source === source) &&
      (timing === "All" ||
        (timing === "Unavailable"
          ? item.effectiveResult === "Unavailable"
          : item.lifecycle === timing)) &&
      (needle === "" ||
        [item.itemName, item.internalCode].some((text) =>
          text.toLocaleLowerCase("en-CA").includes(needle),
        )),
  );
  return (
    <AppFrame
      title="Availability"
      description="CAT-AVAILABILITY · query.cat_availability · catalog_availability_workbench_v1"
    >
      <header className="screen-heading">
        <div>
          <h2>Availability Rule Workbench</h2>
          <p className="bop-muted">
            {view.businessDate} · {view.timeZone} · as of {view.asOfUtc}
          </p>
        </div>
        <button disabled title="A command-capable Availability BFF is not connected">
          Create rule
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Search item or code
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Store
          <select value={store} onChange={(event) => setStore(event.currentTarget.value)}>
            {stores.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={(event) => setSource(event.currentTarget.value)}>
            {["All", "Manual", "Stock", "KillSwitch"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={timing} onChange={(event) => setTiming(event.currentTarget.value)}>
            {["All", "Active", "Draft", "Inactive", "Archived", "Unavailable"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <StatePanel heading="Effective-result simulation">
        <p>
          Scenario uses the selected Store, channel, UTC instant, IANA time zone and Business Date.
          Stock and Kill Switch evidence must be fresh and exact scoped.
        </p>
        <div className="card-actions">
          <button disabled title="A simulation-capable Availability BFF is not connected">
            Simulate effective result
          </button>
          <button disabled title="A command-capable Availability BFF is not connected">
            Kill Switch with reason
          </button>
        </div>
      </StatePanel>
      {items.length === 0 ? (
        <StatePanel heading="No matching Availability rules" status>
          <p>Change the safe filters or create an authorized Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <article className="store-card" key={item.ruleReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">
                    {item.internalCode} · {item.sellableType}
                  </p>
                  <h3>{item.itemName}</h3>
                </div>
                <strong>{item.effectiveResult}</strong>
              </header>
              <dl>
                <div>
                  <dt>Scope</dt>
                  <dd>
                    {item.storeName} · {item.channelSummary}
                  </dd>
                </div>
                <div>
                  <dt>Schedule</dt>
                  <dd>{item.scheduleSummary}</dd>
                </div>
                <div>
                  <dt>Source / priority</dt>
                  <dd>
                    {item.source} / {item.priority}
                  </dd>
                </div>
                <div>
                  <dt>Lifecycle / version</dt>
                  <dd>
                    {item.lifecycle} / {item.aggregateVersion}
                  </dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{item.reasonCode}</dd>
                </div>
              </dl>
              <div className="card-actions">
                {["Edit rule", "Schedule", item.lifecycle === "Active" ? "Pause" : "Resume"].map(
                  (action) => (
                    <button
                      disabled
                      key={action}
                      title="A command-capable Availability BFF is not connected"
                    >
                      {action}
                    </button>
                  ),
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function AvailabilityWorkbenchPage({
  client = unavailableAvailabilityClient,
}: {
  readonly client?: AvailabilityClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  const load = useCallback(
    () => client.loadWorkbench().then(parseAvailabilityWorkbenchView),
    [client],
  );
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof AvailabilityClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [load]);
  return state.kind === "Found" ? (
    <AvailabilityWorkbenchScreen view={state.view} />
  ) : (
    <AppFrame title="Availability" description="CAT-AVAILABILITY">
      <AvailabilityStatePanel state={state.kind} />
    </AppFrame>
  );
}
