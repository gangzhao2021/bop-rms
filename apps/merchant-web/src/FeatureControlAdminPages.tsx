import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  FeatureAdminError,
  parseFeatureAdminRouteReference,
  parseFeatureAdminView,
  unavailableFeatureAdminClient,
  type FeatureAdminClient,
  type FeatureAdminErrorCode,
  type FeatureAdminView,
} from "./feature-control-admin.js";
type State =
  | { readonly kind: "Loading" | FeatureAdminErrorCode }
  | { readonly kind: "Found"; readonly view: FeatureAdminView };
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized Feature Control metadata…",
    PermissionDenied: "Platform or authorized Owner permission is required.",
    NotFound: "The requested Store or control is unavailable in this scope.",
    FeatureDisabled: "Feature Control administration is disabled.",
    Stale: "The projection is stale. Refresh before acting.",
    Conflict: "The source version changed. Refresh before acting.",
    CommandFailed: "No capability, flag or publication outcome was inferred.",
    Offline: "Offline read-only. Feature Control actions are disabled.",
    Unavailable: "Feature Control metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading Feature Control" : "Feature Control unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
function Screen({ view }: { readonly view: FeatureAdminView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const items = useMemo(
    () =>
      view.items.filter(
        (item) =>
          (status === "All" || item.lifecycle === status) &&
          `${item.key} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query, status, view.items],
  );
  return (
    <AppFrame
      title={view.screenId === "STORE-CAPABILITY" ? "Store capabilities" : "Feature flags"}
      description={`${view.screenId} · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Capability and Feature Control</h2>
          <p>Source as of {view.sourceAsOf}</p>
        </div>
        <button
          disabled={
            !view.mayManage || view.freshness !== "Fresh" || view.completeness !== "Complete"
          }
        >
          Create config draft
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Key or description
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Draft</option>
            <option>PendingApproval</option>
            <option>Approved</option>
            <option>Published</option>
            <option>Disabled</option>
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching controls" status>
          <p>Change the safe filters.</p>
        </StatePanel>
      ) : (
        <div className="detail-section-grid">
          {items.map((item) => (
            <StatePanel
              key={item.controlId}
              heading={item.key}
              tone={
                item.dependencies.some((dependency) => dependency.status === "Unsatisfied")
                  ? "offline"
                  : "neutral"
              }
            >
              <p>{item.description}</p>
              <dl className="detail-list">
                <div>
                  <dt>Effective value / source</dt>
                  <dd>
                    {item.effectiveValue} · {item.source}
                  </dd>
                </div>
                <div>
                  <dt>Scope / status</dt>
                  <dd>
                    {item.scope} · {item.lifecycle}
                  </dd>
                </div>
                <div>
                  <dt>Effective period</dt>
                  <dd>
                    {item.effectiveFrom} to {item.effectiveUntil ?? "open"}
                  </dd>
                </div>
                <div>
                  <dt>Expiry / owner</dt>
                  <dd>
                    {item.expiresAt ?? "not temporary"} · {item.owner}
                  </dd>
                </div>
              </dl>
              <h3>Dependencies and impact</h3>
              {item.dependencies.length === 0 ? (
                <p>No dependencies declared.</p>
              ) : (
                <ul>
                  {item.dependencies.map((dependency) => (
                    <li key={`${item.controlId}-${dependency.key}`}>
                      {dependency.kind}: {dependency.key} — {dependency.status}
                    </li>
                  ))}
                </ul>
              )}
              <button
                disabled
                title="Requires exact permission, expected version, independent approval and satisfied dependencies"
              >
                Submit / approve / publish
              </button>
            </StatePanel>
          ))}
        </div>
      )}
    </AppFrame>
  );
}
function Page({
  client,
  screenId,
}: {
  readonly client: FeatureAdminClient;
  readonly screenId: FeatureAdminView["screenId"];
}) {
  const params = useParams();
  const storeReference = screenId === "STORE-CAPABILITY" ? params.id : undefined;
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    let load: Promise<unknown>;
    try {
      load =
        screenId === "STORE-CAPABILITY"
          ? client.loadStoreCapabilities(parseFeatureAdminRouteReference(storeReference))
          : client.loadFeatures();
    } catch {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void load
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseFeatureAdminView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof FeatureAdminError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, screenId, storeReference]);
  return state.kind === "Found" ? <Screen view={state.view} /> : <Status state={state.kind} />;
}
export function StoreCapabilityPage({
  client = unavailableFeatureAdminClient,
}: {
  readonly client?: FeatureAdminClient;
}) {
  return <Page client={client} screenId="STORE-CAPABILITY" />;
}
export function FeatureFlagListPage({
  client = unavailableFeatureAdminClient,
}: {
  readonly client?: FeatureAdminClient;
}) {
  return <Page client={client} screenId="FEATURE-FLAG-LIST" />;
}
