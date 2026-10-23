import { t } from "../i18n/i18n.js";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
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
          <h2>{t("Status may be delayed")}</h2>
          <p>{t("Refresh before changing delivery instructions.")}</p>
        </section>
      ) : null}
      <section aria-labelledby="delivery-progress">
        <h2 id="delivery-progress">{view.status}</h2>
        <p>
          {view.eta
            ? t("Estimated arrival {earliestUtc} – {latestUtc}", {
                earliestUtc: view.eta.earliestUtc,
                latestUtc: view.eta.latestUtc,
              })
            : t("Estimated arrival is not available yet.")}
        </p>
        <dl>
          <div>
            <dt>{t("Store handoff")}</dt>
            <dd>{view.handoffSummary}</dd>
          </div>
          <div>
            <dt>{t("Delivery confirmation")}</dt>
            <dd>{view.proofSummary}</dd>
          </div>
        </dl>
        <p>{t("Courier contact and precise location are never shown here.")}</p>
      </section>
      <section>
        <h2>{t("Delivery options")}</h2>
        <button type="button" disabled={readOnly || !view.instructionUpdateAllowed}>
          {t("Update approved instruction before cutoff")}
        </button>
        <Link to={view.supportPath}>{t("Contact support")}</Link>
      </section>
    </>
  );
}
export function DeliveryStatusPage({
  client = unavailableCustomerDeliveryTrackingClient,
  store,
}: {
  readonly client?: CustomerDeliveryTrackingClient;
  readonly store?: CustomerStoreContext | undefined;
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
    <CustomerPage
      step="other"
      store={store}
      orderReference={orderReference}
      className="order-status delivery-status"
    >
      <PageHeading eyebrow={t("Delivery")} title={t("Track your delivery")} />
      {state.kind === "Loading" ? (
        <section className="order-status__card" role="status">
          <h2>{t("Loading delivery status")}</h2>
        </section>
      ) : null}
      {state.kind !== "Loading" && state.kind !== "Ready" ? (
        <section className="order-status__unavailable delivery-status__unavailable" role="alert">
          <span className="order-status__unavailable-icon" aria-hidden="true">
            !
          </span>
          <h2 id="delivery-unavailable-heading">
            {state.kind === "PermissionDenied"
              ? t("Delivery access denied")
              : state.kind === "FeatureDisabled"
                ? t("Delivery tracking is disabled")
                : state.kind === "InvalidReference"
                  ? t("Delivery link is invalid")
                  : state.kind === "NotFound"
                    ? t("Delivery not found")
                    : t("Delivery status unavailable")}
          </h2>
          <p>{t("No courier, location or proof details are available.")}</p>
        </section>
      ) : null}
      {state.kind === "Ready" ? <DeliveryTrackingContent view={state.view} /> : null}
      <Link className="order-status__back" to={`/orders/${orderReference}`}>
        {t("Back to order status")}
      </Link>
    </CustomerPage>
  );
}
