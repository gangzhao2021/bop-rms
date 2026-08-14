import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  DeliveryTrackingError,
  parseCustomerDeliveryTracking,
  unavailableCustomerDeliveryTrackingClient,
  type CustomerDeliveryTrackingClient,
  type CustomerDeliveryTrackingView,
  type DeliveryTrackingErrorCode,
} from "./delivery-status-client.js";
type State =
  | { readonly kind: "Loading" | DeliveryTrackingErrorCode }
  | { readonly kind: "Ready"; readonly view: CustomerDeliveryTrackingView };
export function DeliveryTrackingContent({ view }: { readonly view: CustomerDeliveryTrackingView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <>
      {readOnly ? (
        <section role="status">
          <h2>Status may be delayed</h2>
          <p>Refresh before changing delivery instructions.</p>
        </section>
      ) : null}
      <section aria-labelledby="delivery-progress">
        <p className="cart-page__eyebrow">CUST-DELIVERY-STATUS</p>
        <h2 id="delivery-progress">{view.status}</h2>
        <p>
          {view.eta
            ? `Estimated arrival ${view.eta.earliestUtc} – ${view.eta.latestUtc}`
            : "Estimated arrival is not available yet."}
        </p>
        <dl>
          <div>
            <dt>Store handoff</dt>
            <dd>{view.handoffSummary}</dd>
          </div>
          <div>
            <dt>Delivery confirmation</dt>
            <dd>{view.proofSummary}</dd>
          </div>
        </dl>
        <p>Courier contact and precise location are never shown here.</p>
      </section>
      <section>
        <h2>Delivery options</h2>
        <button type="button" disabled={readOnly || !view.instructionUpdateAllowed}>
          Update approved instruction before cutoff
        </button>
        <Link to={view.supportPath}>Contact support</Link>
      </section>
    </>
  );
}
export function DeliveryStatusPage({
  client = unavailableCustomerDeliveryTrackingClient,
}: {
  readonly client?: CustomerDeliveryTrackingClient;
}) {
  const { orderReference = "" } = useParams(),
    [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load(orderReference)
      .then((value) => {
        if (active) setState({ kind: "Ready", view: parseCustomerDeliveryTracking(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind:
              error instanceof DeliveryTrackingError
                ? error.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, orderReference]);
  return (
    <main id="main-content" className="order-status">
      <header>
        <h1>Track your delivery</h1>
        <p>Your authorized Guest Session—not this reference alone—grants access.</p>
      </header>
      {state.kind === "Loading" ? (
        <section role="status">
          <h2>Loading delivery status</h2>
        </section>
      ) : null}
      {state.kind !== "Loading" && state.kind !== "Ready" ? (
        <section role="alert">
          <h2>
            {state.kind === "PermissionDenied"
              ? "Delivery access denied"
              : state.kind === "FeatureDisabled"
                ? "Delivery tracking is disabled"
                : state.kind === "InvalidReference"
                  ? "Delivery link is invalid"
                  : state.kind === "NotFound"
                    ? "Delivery not found"
                    : "Delivery status unavailable"}
          </h2>
          <p>No courier, location or proof fact is inferred.</p>
        </section>
      ) : null}
      {state.kind === "Ready" ? <DeliveryTrackingContent view={state.view} /> : null}
      <Link to={`/orders/${orderReference}`}>Back to order status</Link>
    </main>
  );
}
