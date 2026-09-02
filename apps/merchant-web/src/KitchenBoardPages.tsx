import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  KitchenBoardClientError,
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemView,
  unavailableKitchenBoardClient,
  type KitchenBoardClient,
  type KitchenBoardItem,
  type KitchenBoardView,
} from "./kitchen-board.js";

type LoadState<T> =
  | {
      readonly kind:
        | "Loading"
        | "PermissionDenied"
        | "NotFound"
        | "Offline"
        | "Conflict"
        | "CommandFailed"
        | "Unavailable";
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
          setState({ kind: error instanceof KitchenBoardClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}

export function KitchenBoardStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const copy = {
    Loading: ["Loading", "Loading the authorized Kitchen queue…"],
    PermissionDenied: [
      "Permission denied",
      "Your Kitchen permission or Store scope does not allow this board.",
    ],
    NotFound: [
      "Work item unavailable",
      "This work item is unavailable in the authorized Store scope.",
    ],
    Offline: [
      "Offline read-only",
      "Reconnect and refresh from the authoritative queue before any action.",
    ],
    Conflict: ["Source changed", "Refresh the authoritative work item version before retrying."],
    CommandFailed: ["Command failed", "No Kitchen transition is assumed. Refresh before retrying."],
    Unavailable: [
      "Kitchen Board unavailable",
      "The Kitchen browser adapter is not connected. No command was sent.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}

function WorkCard({
  item,
  readOnly,
  observedAt,
}: {
  readonly item: KitchenBoardItem;
  readonly readOnly: boolean;
  readonly observedAt: string;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.createdAt)) / 60_000),
  );
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {item.stationLabel} · {age} minutes
          </p>
          <h3>{item.displayName}</h3>
        </div>
        <strong>{item.status}</strong>
      </header>
      <dl>
        <div>
          <dt>Quantity</dt>
          <dd>
            {item.completedQuantity} / {item.requiredQuantity}
          </dd>
        </div>
        <div>
          <dt>Allergen safety</dt>
          <dd>{item.allergenCue}</dd>
        </div>
        <div>
          <dt>Exception</dt>
          <dd>{item.exceptionStatus}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>Named operator</dd>
        </div>
      </dl>
      <div className="card-actions">
        <Link to={`/operations/kitchen/work-items/${item.workItemReference}`}>Open work item</Link>
        <button disabled={readOnly || item.status !== "Queued"}>Accept</button>
        <button disabled={readOnly || !["Queued", "In Progress"].includes(item.status)}>
          Start / ready by policy
        </button>
        <button disabled>Hold / prioritize unavailable</button>
      </div>
    </article>
  );
}

export function KitchenBoardScreen({ view }: { readonly view: KitchenBoardView }) {
  const [station, setStation] = useState("All");
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const stations = [...new Set(view.items.map((item) => item.stationLabel))];
  const items = view.items.filter((item) => station === "All" || item.stationLabel === station);
  return (
    <AppFrame title="Kitchen Board" description={`KIT-KITCHEN-QUEUE · ${view.storeLabel}`}>
      <header className="screen-heading">
        <div>
          <h2>Active work</h2>
          <p>
            {view.freshnessStatus} · {view.operatorStatus} operator · {view.projectedAt}
          </p>
        </div>
        <button disabled>Refresh from source</button>
      </header>
      {readOnly ? (
        <StatePanel heading="Board locked — read-only" tone="offline" status>
          <p>
            A fresh projection and named unlocked operator session are required for Kitchen
            commands.
          </p>
        </StatePanel>
      ) : null}
      <div className="list-filters" role="search">
        <label>
          Station
          <select value={station} onChange={(event) => setStation(event.currentTarget.value)}>
            <option>All</option>
            {stations.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No active work" status>
          <p>No authorized work item matches this station.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <WorkCard
              key={item.workItemReference}
              item={item}
              readOnly={readOnly}
              observedAt={view.projectedAt}
            />
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function KitchenWorkItemScreen({ item }: { readonly item: KitchenBoardItem }) {
  return (
    <AppFrame
      title={item.displayName}
      description="KIT-WORK-ITEM · privacy-minimized execution snapshot"
    >
      <WorkCard item={item} readOnly observedAt={item.createdAt} />
      <StatePanel heading="Safety and lifecycle authority">
        <p>
          Allergen acknowledgement, timers, dependencies, history and policy actions require a fresh
          authoritative detail response; absent facts are not inferred.
        </p>
      </StatePanel>
      <Link to="/operations/kitchen">Return to Kitchen Board</Link>
    </AppFrame>
  );
}

export function KitchenBoardPage({
  client = unavailableKitchenBoardClient,
}: {
  readonly client?: KitchenBoardClient;
}) {
  const load = useCallback(() => client.loadQueue().then(parseKitchenBoardView), [client]);
  const state = useLoad(load, "queue");
  return state.kind === "Found" ? (
    <KitchenBoardScreen view={state.view} />
  ) : (
    <KitchenBoardStatePanel state={state.kind} />
  );
}
export function KitchenWorkItemPage({
  client = unavailableKitchenBoardClient,
}: {
  readonly client?: KitchenBoardClient;
}) {
  const { id = "" } = useParams();
  let reference: string;
  try {
    reference = parseKitchenRouteReference(id);
  } catch {
    return <KitchenBoardStatePanel state="NotFound" />;
  }
  const load = useCallback(
    () => client.loadWorkItem(reference).then(parseKitchenWorkItemView),
    [client, reference],
  );
  const state = useLoad(load, reference);
  return state.kind === "Found" ? (
    <KitchenWorkItemScreen item={state.view} />
  ) : (
    <KitchenBoardStatePanel state={state.kind} />
  );
}
