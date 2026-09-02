import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  LiveGatePageError,
  parseLiveGatePageView,
  parseLiveGateRouteReference,
  unavailableLiveGatePageClient,
  type LiveGatePageClient,
  type LiveGatePageErrorCode,
  type LiveGatePageView,
} from "./live-gate-pages.js";
type State =
  | { readonly kind: "Loading" | LiveGatePageErrorCode }
  | { readonly kind: "Found"; readonly view: LiveGatePageView };
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized Live Gate evidence metadata…",
    PermissionDenied:
      "Owner, Compliance, Finance or authorized Platform Release permission is required.",
    NotFound: "The requested Live Gate is unavailable in this scope.",
    FeatureDisabled: "Live Gate administration is disabled.",
    Stale: "The projection is stale. Refresh before acting.",
    Conflict: "The source version changed. Refresh before acting.",
    CommandFailed: "No evidence or gate decision was inferred.",
    Offline: "Offline read-only. Gate actions are disabled.",
    Unavailable: "Live Gate metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading Live Gates" : "Live Gates unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
function Screen({ view }: { readonly view: LiveGatePageView }) {
  const [status, setStatus] = useState("All"),
    [query, setQuery] = useState("");
  const gates = useMemo(
    () =>
      view.gates.filter(
        (gate) =>
          (status === "All" || gate.status === status) &&
          `${gate.gateId} ${gate.store} ${gate.tenant}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [query, status, view.gates],
  );
  return (
    <AppFrame
      title={view.screenId === "STORE-LIVE-GATE" ? "Store live gate" : "Platform live gates"}
      description={`${view.screenId} · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Production evidence gates</h2>
          <p>Source as of {view.sourceAsOf}</p>
        </div>
      </header>
      <div className="list-filters" role="search">
        <label>
          Gate, Store, or Tenant
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Blocked</option>
            <option>InReview</option>
            <option>Approved</option>
            <option>Rejected</option>
            <option>Reopened</option>
          </select>
        </label>
      </div>
      {gates.length === 0 ? (
        <StatePanel heading="No matching Live Gates" status>
          <p>Change the safe filters.</p>
        </StatePanel>
      ) : (
        gates.map((gate) => (
          <section key={gate.gateReference}>
            <StatePanel
              heading={gate.gateId}
              tone={gate.status === "Approved" ? "neutral" : "offline"}
            >
              <p>
                <strong>{gate.status}</strong> · {gate.tenant} · {gate.store}
              </p>
              <p>
                Owner {gate.owner} · last review {gate.lastReviewedAt ?? "Not reviewed"}
              </p>
              <button
                disabled={
                  !view.mayManage || view.freshness !== "Fresh" || view.completeness !== "Complete"
                }
                title="Requires exact permission, expected version and segregation"
              >
                Request review
              </button>
            </StatePanel>
            <div className="detail-section-grid">
              {gate.requirements.map((item) => (
                <StatePanel
                  key={item.requirementId}
                  heading={item.category}
                  tone={item.status === "Accepted" ? "neutral" : "error"}
                >
                  <h3>{item.requirement}</h3>
                  <p>
                    {item.status} · owner {item.owner}
                  </p>
                  <p>Expiry {item.expiry ?? "Unavailable"}</p>
                  {item.blockingReason ? (
                    <p>
                      <strong>Blocking:</strong> {item.blockingReason}
                    </p>
                  ) : null}
                  <button
                    disabled
                    title="Attach only an approved evidence reference; evidence bytes remain with their owner"
                  >
                    Attach evidence reference
                  </button>
                </StatePanel>
              ))}
            </div>
            <StatePanel heading="Approval history">
              <ul>
                {gate.history.length === 0 ? (
                  <li>No review decision recorded.</li>
                ) : (
                  gate.history.map((item) => (
                    <li key={`${item.occurredAt}-${item.decision}`}>
                      {item.decision} · {item.actor} · {item.occurredAt}
                    </li>
                  ))
                )}
              </ul>
            </StatePanel>
          </section>
        ))
      )}
    </AppFrame>
  );
}
function Page({
  screenId,
  client,
}: {
  readonly screenId: LiveGatePageView["screenId"];
  readonly client: LiveGatePageClient;
}) {
  const { id } = useParams();
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    let request: Promise<unknown>;
    try {
      request =
        screenId === "STORE-LIVE-GATE"
          ? client.loadStoreGate(parseLiveGateRouteReference(id))
          : client.loadPlatformGates();
    } catch {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void request
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseLiveGatePageView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof LiveGatePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, id, screenId]);
  return state.kind === "Found" ? <Screen view={state.view} /> : <Status state={state.kind} />;
}
export function StoreLiveGatePage({
  client = unavailableLiveGatePageClient,
}: {
  readonly client?: LiveGatePageClient;
}) {
  return <Page screenId="STORE-LIVE-GATE" client={client} />;
}
export function PlatformLiveGatePage({
  client = unavailableLiveGatePageClient,
}: {
  readonly client?: LiveGatePageClient;
}) {
  return <Page screenId="PLT-LIVE-GATE" client={client} />;
}
