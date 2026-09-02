import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DeliveryDetailClientError,
  parseDeliveryDetailView,
  unavailableDeliveryDetailClient,
  type DeliveryDetailClient,
  type DeliveryDetailClientErrorCode,
  type DeliveryDetailView,
} from "./delivery-detail-pages.js";
type State =
  | { readonly kind: "Loading" | DeliveryDetailClientErrorCode }
  | { readonly kind: "Ready"; readonly view: DeliveryDetailView };
export function DeliveryDetailState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Ready">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading field-masked Delivery Detail…", "neutral"],
    PermissionDenied: ["Permission denied", "Delivery facts require an approved purpose.", "error"],
    NotFound: ["Task not found", "No Delivery Task matches this reference.", "neutral"],
    FeatureDisabled: ["Delivery disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh before any revision or dispatch command.", "offline"],
    Conflict: ["Task changed", "Refresh the exact Aggregate version.", "offline"],
    Validation: ["Revision rejected", "The last accepted snapshot remains effective.", "error"],
    CommandFailed: ["Command failed", "No snapshot or history was overwritten.", "error"],
    Offline: ["Offline read-only", "Cached detail cannot authorize a revision.", "offline"],
    Unavailable: [
      "Delivery unavailable",
      "No address, price or Provider fact is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function DeliveryDetail({ view }: { readonly view: DeliveryDetailView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">FUL-DELIVERY-DETAIL</p>
          <h1>Delivery detail</h1>
          <p>Task {view.taskReference} · immutable snapshot / append-only revisions</p>
        </div>
      </header>
      {readOnly ? <DeliveryDetailState state="Stale" /> : null}
      <section className="summary-card">
        <h2>Address and contact</h2>
        <p>{view.maskedAddress}</p>
        <p>{view.maskedContact}</p>
        <p>Unmasked fields require owning-system purpose authorization.</p>
      </section>
      <section className="summary-card">
        <h2>Promise and fees snapshot</h2>
        <p>
          Requested {view.requestedWindow.startUtc} – {view.requestedWindow.endUtc}
        </p>
        <p>
          Confirmed {view.confirmedWindow.startUtc} – {view.confirmedWindow.endUtc}
        </p>
        <p>
          {view.currency} {view.feeMinor} minor units · status {view.executionStatus} /{" "}
          {view.assignmentStatus}
        </p>
      </section>
      <section className="summary-card">
        <h2>Evidence timeline</h2>
        <p>
          {view.proofReferences.length} proof · {view.contactAttemptReferences.length} contact ·{" "}
          {view.timelineReferences.length} timeline references
        </p>
      </section>
      <div className="card-actions">
        {view.permissions.mayRevise ? (
          <button disabled={readOnly}>Revise before cutoff</button>
        ) : null}
        {view.permissions.mayDispatch ? <button disabled={readOnly}>Dispatch</button> : null}
        {view.permissions.mayReassign ? <button disabled={readOnly}>Reassign</button> : null}
        {view.permissions.mayCancel ? (
          <button disabled={readOnly}>Cancel under policy</button>
        ) : null}
        {view.permissions.mayRecordException ? (
          <button disabled={readOnly}>Record exception</button>
        ) : null}
      </div>
    </main>
  );
}
export function DeliveryDetailPage({
  client = unavailableDeliveryDetailClient,
}: {
  readonly client?: DeliveryDetailClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Ready", view: parseDeliveryDetailView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind:
              error instanceof DeliveryDetailClientError
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
    <DeliveryDetail view={state.view} />
  ) : (
    <DeliveryDetailState state={state.kind} />
  );
}
