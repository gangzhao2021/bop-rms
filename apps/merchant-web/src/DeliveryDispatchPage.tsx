import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DeliveryDispatchClientError,
  parseDeliveryDispatchView,
  unavailableDeliveryDispatchClient,
  type DeliveryDispatchClient,
  type DeliveryDispatchClientErrorCode,
  type DeliveryDispatchView,
} from "./delivery-dispatch-pages.js";
type State =
  | { readonly kind: "Loading" | DeliveryDispatchClientErrorCode }
  | { readonly kind: "Ready"; readonly view: DeliveryDispatchView };
export function DeliveryDispatchState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Ready">;
}) {
  const map: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading Delivery Task queue…", "neutral"],
    PermissionDenied: ["Permission denied", "Dispatch facts are unavailable.", "error"],
    NotFound: ["No tasks", "No Delivery Task matches this Store.", "neutral"],
    FeatureDisabled: ["Delivery disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh before assignment action.", "offline"],
    Conflict: ["Task changed", "Refresh assignment version.", "offline"],
    Validation: ["Dispatch blocked", "Candidate, policy or TTL evidence is invalid.", "error"],
    CommandFailed: ["Command failed", "No Assignment Attempt was overwritten.", "error"],
    Offline: ["Offline read-only", "Cached queue cannot authorize dispatch.", "offline"],
    Unavailable: ["Delivery unavailable", "No worker or Provider result is inferred.", "error"],
  };
  const v = map[state];
  return (
    <StatePanel heading={v[0]} tone={v[2]} status>
      <p>{v[1]}</p>
    </StatePanel>
  );
}
export function DeliveryDispatchBoard({ view }: { readonly view: DeliveryDispatchView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">FUL-DELIVERY-DISPATCH</p>
          <h1>Delivery dispatch</h1>
          <p>{view.storeLabel} · one active offer per Task</p>
        </div>
      </header>
      {readOnly ? <DeliveryDispatchState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Order / task ref
          <input disabled placeholder="Exact reference" />
        </label>
        <label>
          State / zone / provider / overdue / exception
          <select disabled>
            <option>All lanes</option>
          </select>
        </label>
      </div>
      <div className="card-list">
        {view.rows.map((r) => (
          <article className="summary-card" key={r.taskReference}>
            <p className="bop-eyebrow">
              {r.executionStatus} · {r.assignmentStatus}
            </p>
            <p>
              Task {r.taskReference} · Order {r.orderReference}
            </p>
            <p>
              Zone {r.zoneReference} · handoff {r.handoffState} · age {r.ageSeconds}s
            </p>
            <div className="card-actions">
              {view.permissions.mayAssign ? (
                <button
                  disabled={
                    readOnly ||
                    !["Unassigned", "Searching", "ReassignmentRequired"].includes(
                      r.assignmentStatus,
                    )
                  }
                >
                  Assign / offer
                </button>
              ) : null}
              {view.permissions.mayAccept ? (
                <button disabled={readOnly || r.assignmentStatus !== "Offered"}>
                  Accept current offer
                </button>
              ) : null}
              {view.permissions.mayStart ? (
                <button disabled={readOnly || r.assignmentStatus !== "Accepted"}>Start</button>
              ) : null}
              {view.permissions.mayReassign ? (
                <button disabled={readOnly || r.assignmentStatus !== "ReassignmentRequired"}>
                  Reassign under pinned policy
                </button>
              ) : null}
              {view.permissions.mayOpenException ? (
                <button disabled={readOnly}>Open exception</button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
export function DeliveryDispatchPage({
  client = unavailableDeliveryDispatchClient,
}: {
  readonly client?: DeliveryDispatchClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((v) => {
        if (active) setState({ kind: "Ready", view: parseDeliveryDispatchView(v) });
      })
      .catch((e: unknown) => {
        if (active)
          setState({
            kind:
              e instanceof DeliveryDispatchClientError
                ? e.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Offline",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Ready" ? (
    <DeliveryDispatchBoard view={state.view} />
  ) : (
    <DeliveryDispatchState state={state.kind} />
  );
}
