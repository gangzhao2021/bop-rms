import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DeliveryExceptionClientError,
  parseDeliveryExceptionView,
  unavailableDeliveryExceptionClient,
  type DeliveryExceptionClient,
  type DeliveryExceptionClientErrorCode,
  type DeliveryExceptionView,
} from "./delivery-exception-pages.js";
type State =
  | { readonly kind: "Loading" | DeliveryExceptionClientErrorCode }
  | { readonly kind: "Ready"; readonly view: DeliveryExceptionView };
export function DeliveryExceptionState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Ready">;
}) {
  const map: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading Delivery exceptions…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Exception evidence requires an approved purpose.",
      "error",
    ],
    NotFound: ["No exceptions", "No matching exception is available.", "neutral"],
    FeatureDisabled: ["Delivery disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh before remedy action.", "offline"],
    Conflict: ["Exception changed", "Refresh the exact version.", "offline"],
    Validation: ["Remedy blocked", "Required owning-domain evidence is incomplete.", "error"],
    CommandFailed: ["Command failed", "No exception history was overwritten.", "error"],
    Offline: ["Offline read-only", "Cached exceptions cannot authorize remedies.", "offline"],
    Unavailable: [
      "Exceptions unavailable",
      "No cancellation, refund or compensation is inferred.",
      "error",
    ],
  };
  const value = map[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function DeliveryExceptionWorkbench({ view }: { readonly view: DeliveryExceptionView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">FUL-DELIVERY-EXCEPTION</p>
          <h1>Delivery exceptions</h1>
          <p>Remedy coordination · owning-domain finality required</p>
        </div>
      </header>
      {readOnly ? <DeliveryExceptionState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Task / Order / safe reference
          <input disabled placeholder="Exact reference" />
        </label>
        <label>
          Type / status / provider / owner / overdue
          <select disabled>
            <option>All exceptions</option>
          </select>
        </label>
      </div>
      <div className="card-list">
        {view.rows.map((row) => (
          <article className="summary-card" key={row.exceptionReference}>
            <p className="bop-eyebrow">
              {row.severity} · {row.lifecycle}
            </p>
            <p>
              Task {row.taskReference} · Order {row.orderReference}
            </p>
            <p>
              {row.reason} · customer impact {row.customerImpact} · deadline{" "}
              {row.resolutionDeadline}
            </p>
            <div className="card-actions">
              {view.permissions.mayAcknowledge ? (
                <button disabled={readOnly || row.lifecycle === "Resolved"}>Acknowledge</button>
              ) : null}
              {view.permissions.mayAssign ? (
                <button disabled={readOnly || row.lifecycle === "Resolved"}>Assign owner</button>
              ) : null}
              {view.permissions.mayReroute ? (
                <button
                  disabled={readOnly || !["ActionRequired", "Escalated"].includes(row.lifecycle)}
                >
                  Reroute / reattempt
                </button>
              ) : null}
              {view.permissions.mayRequestCancel ? (
                <button disabled={readOnly || row.lifecycle === "Resolved"}>
                  Request Ordering cancellation
                </button>
              ) : null}
              {view.permissions.mayHandoffSupport ? (
                <button disabled={readOnly}>Handoff to support</button>
              ) : null}
              {view.permissions.mayResolve ? (
                <button disabled={readOnly || row.lifecycle === "Resolved"}>
                  Resolve after source finality
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
export function DeliveryExceptionPage({
  client = unavailableDeliveryExceptionClient,
}: {
  readonly client?: DeliveryExceptionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Ready", view: parseDeliveryExceptionView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind:
              error instanceof DeliveryExceptionClientError
                ? error.code
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
    <DeliveryExceptionWorkbench view={state.view} />
  ) : (
    <DeliveryExceptionState state={state.kind} />
  );
}
