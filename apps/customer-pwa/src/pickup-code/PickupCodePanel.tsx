import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createPickupCodeController,
  createUnavailablePickupCodeClient,
  type PickupCodeController,
} from "./pickup-code-controller.js";

export function PickupCodePanel({
  orderReference,
  orderNumber,
  controller: provided,
}: {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly controller?: PickupCodeController | undefined;
}) {
  const [controller] = useState(
    () =>
      provided ??
      createPickupCodeController(orderReference, orderNumber, createUnavailablePickupCodeClient()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => {
    const offline = () => controller.setOnline(false);
    const online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      controller.dispose();
    };
  }, [controller]);
  return (
    <section className="pickup-code" aria-labelledby="pickup-code-heading">
      <h2 id="pickup-code-heading">Pickup confirmation</h2>
      {state.status === "hidden" ? (
        <>
          <p>Your pickup proof stays hidden until you explicitly check readiness.</p>
          <button type="button" onClick={() => void controller.reveal()}>
            Check pickup readiness
          </button>
        </>
      ) : null}
      {state.status === "loading" ? <p role="status">Checking pickup readiness</p> : null}
      {state.status === "not-ready" ? (
        <>
          <p role="status">Pickup is not ready yet.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "permission-denied" ? (
        <>
          <p role="alert">Pickup proof access was denied for this Guest Session.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "not-found" ? (
        <>
          <p role="alert">No authorized pickup proof was found.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "feature-disabled" ? (
        <>
          <p role="alert">Pickup proof is disabled for this journey.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "conflict" ? (
        <>
          <p role="alert">Pickup proof changed. Close and check readiness again.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "unavailable" ? (
        <>
          <p role="alert">Pickup confirmation is not available. No proof was retained.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "offline" ? (
        <>
          <p role="alert">Pickup proof is unavailable offline and has been cleared.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "expired" ? (
        <>
          <p role="alert">Pickup proof expired and has been cleared.</p>
          <button type="button" onClick={() => controller.close()}>
            Close
          </button>
        </>
      ) : null}
      {state.status === "ready" ? (
        <div className="pickup-code__ready" role="status">
          <p className="cart-page__eyebrow">Ready for pickup</p>
          <h3>{state.view.storeDisplayName}</h3>
          <p>{state.view.pickupInstruction}</p>
          <div
            className="pickup-code__visual"
            aria-label={`Pickup proof ${state.view.proofValue.split("").join(" ")}`}
          >
            <span>{state.view.proofKind === "HumanCode" ? "Pickup code" : "Pickup proof"}</span>
            <code>{state.view.proofValue}</code>
          </div>
          <p>
            Order {state.view.orderNumber} · Expires{" "}
            {new Date(state.view.expiresAt).toLocaleTimeString()}
          </p>
          <p>Show this proof to authorized staff. It does not complete the Order by itself.</p>
          <div className="pickup-code__actions">
            <button
              type="button"
              disabled={state.refreshing}
              onClick={() => void controller.refresh()}
            >
              {state.refreshing ? "Refreshing…" : "Refresh proof"}
            </button>
            <button type="button" onClick={() => controller.close()}>
              Hide proof
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
