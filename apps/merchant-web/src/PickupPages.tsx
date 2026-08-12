import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  parsePickupQueueView,
  PickupClientError,
  unavailablePickupClient,
  type PickupClient,
  type PickupQueueItem,
  type PickupQueueView,
} from "./pickup.js";
type State =
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
  | { readonly kind: "Found"; readonly view: PickupQueueView };
export function PickupStatePanel({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: ["Loading", "Loading the authorized Pickup Queue…"],
    PermissionDenied: [
      "Permission denied",
      "Your Fulfillment permission or Store scope does not allow this queue.",
    ],
    NotFound: ["Pickup unavailable", "This Pickup is not available in the authorized Store scope."],
    Offline: ["Offline read-only", "Reconnect and refresh before any Pickup action."],
    Conflict: ["Source changed", "Refresh the authoritative Fulfillment version before retrying."],
    CommandFailed: ["Command failed", "No handoff or Fulfillment transition is assumed."],
    Unavailable: [
      "Pickup Queue unavailable",
      "The Fulfillment browser adapter is not connected. No command was sent.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}
function PickupCard({
  item,
  observedAt,
  readOnly,
}: {
  readonly item: PickupQueueItem;
  readonly observedAt: string;
  readonly readOnly: boolean;
}) {
  const wait = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.readyAt)) / 60_000),
  );
  const canComplete = !readOnly && item.phase !== "Completed" && item.proofReadiness === "Ready";
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            Ready {wait} minutes · {item.phase}
          </p>
          <h3>{item.publicOrderNumber}</h3>
        </div>
        <strong>{wait >= 15 ? "Overdue" : "Waiting"}</strong>
      </header>
      <dl>
        <div>
          <dt>Proof</dt>
          <dd>{item.proofReadiness}</dd>
        </div>
        <div>
          <dt>Staging</dt>
          <dd>{item.stagingLocation ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{item.claimStatus}</dd>
        </div>
        <div>
          <dt>Exception</dt>
          <dd>{item.exceptionStatus}</dd>
        </div>
        <div>
          <dt>Packages</dt>
          <dd>{item.packageCount}</dd>
        </div>
        <div>
          <dt>Allergen cue</dt>
          <dd>{item.allergenCue}</dd>
        </div>
      </dl>
      <div className="card-actions">
        <button disabled={readOnly || item.claimStatus === "Unavailable"}>Claim</button>
        <button disabled={!canComplete}>Open proof verification</button>
        <button disabled>Report exception</button>
      </div>
      {canComplete ? (
        <StatePanel heading="Explicit handoff confirmation required" status>
          <p>
            Verify the signed proof, confirm this exact Order and submit one idempotent Complete
            Pickup Handoff command.
          </p>
          <button disabled>Complete handoff — adapter unavailable</button>
        </StatePanel>
      ) : null}
    </article>
  );
}
export function PickupQueueScreen({ view }: { readonly view: PickupQueueView }) {
  const [filter, setFilter] = useState("All");
  const readOnly = view.freshnessStatus !== "Fresh";
  const items = view.items.filter(
    (item) =>
      filter === "All" ||
      (filter === "Overdue"
        ? Date.parse(view.projectedAt) - Date.parse(item.readyAt) >= 900_000
        : item.phase === filter),
  );
  return (
    <AppFrame title="Pickup Queue" description={`FUL-PICKUP-QUEUE · ${view.storeLabel}`}>
      <header className="screen-heading">
        <div>
          <h2>Ready for pickup</h2>
          <p>
            {view.freshnessStatus} · {view.projectedAt}
          </p>
        </div>
        <button disabled>Refresh from source</button>
      </header>
      {readOnly ? (
        <StatePanel heading="Queue stale — read-only" tone="offline" status>
          <p>A fresh Fulfillment source is required before claim, proof verification or handoff.</p>
        </StatePanel>
      ) : null}
      <div className="list-filters">
        <label>
          Queue filter
          <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
            <option>All</option>
            <option>Ready</option>
            <option>InProgress</option>
            <option>Completed</option>
            <option>Overdue</option>
          </select>
        </label>
      </div>
      {items.length ? (
        <div className="store-card-grid">
          {items.map((item) => (
            <PickupCard
              key={item.fulfillmentReference}
              item={item}
              observedAt={view.projectedAt}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : (
        <StatePanel heading="No matching pickups" status>
          <p>No authorized Fulfillment matches this filter.</p>
        </StatePanel>
      )}
    </AppFrame>
  );
}
export function PickupQueuePage({
  client = unavailablePickupClient,
}: {
  readonly client?: PickupClient;
}) {
  const load = useCallback(() => client.loadQueue().then(parsePickupQueueView), [client]);
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PickupClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [load]);
  return state.kind === "Found" ? (
    <PickupQueueScreen view={state.view} />
  ) : (
    <PickupStatePanel state={state.kind} />
  );
}
