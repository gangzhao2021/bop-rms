import { createHttpPickupCodeClient } from "./pickup-code-client.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPickupCodeController, type PickupCodeController } from "./pickup-code-controller.js";
import { formatClockTime } from "../journey/format.js";

export function PickupCodePanel({
  orderReference,
  orderNumber,
  controller: provided,
  autoReveal = false,
  refreshToken,
}: {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly controller?: PickupCodeController | undefined;
  /** The order is ready: show the code without a tap, and re-check it whenever the status refreshes. */
  readonly autoReveal?: boolean;
  /** Changes when the parent status refreshed; triggers a re-check of a missing or expired code. */
  readonly refreshToken?: string | undefined;
}) {
  const [controller] = useState(
    () =>
      provided ??
      createPickupCodeController(orderReference, orderNumber, createHttpPickupCodeClient()),
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
  const checkedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoReveal) return;
    const pending =
      state.status === "hidden" || state.status === "not-ready" || state.status === "expired";
    if (!pending || checkedFor.current === refreshToken) return;
    checkedFor.current = refreshToken;
    void controller.reveal();
  }, [autoReveal, controller, refreshToken, state.status]);
  const closeButton = (
    <button type="button" onClick={() => controller.close()}>
      Close
    </button>
  );
  return (
    <section className="pickup-code" aria-labelledby="pickup-code-heading">
      <h2 id="pickup-code-heading">Pickup code</h2>
      {state.status === "hidden" ? (
        autoReveal ? (
          <p role="status">Checking your pickup code…</p>
        ) : (
          <>
            <p>Your pickup code appears here once your order is ready.</p>
            <button type="button" onClick={() => void controller.reveal()}>
              Show pickup code
            </button>
          </>
        )
      ) : null}
      {state.status === "loading" ? <p role="status">Checking your pickup code…</p> : null}
      {state.status === "not-ready" ? (
        <>
          <p role="status">Your order isn’t ready yet. The code appears here when it is.</p>
          {autoReveal ? null : closeButton}
        </>
      ) : null}
      {state.status === "permission-denied" ? (
        <>
          <p role="alert">
            This code can’t be shown in this session. Open the order in the browser you used at
            checkout, or ask staff.
          </p>
          {closeButton}
        </>
      ) : null}
      {state.status === "not-found" ? (
        <>
          <p role="alert">No pickup code is available for this order. Ask staff for help.</p>
          {closeButton}
        </>
      ) : null}
      {state.status === "feature-disabled" ? (
        <>
          <p role="alert">Pickup codes are not used at this location. Ask staff at pickup.</p>
          {closeButton}
        </>
      ) : null}
      {state.status === "conflict" ? (
        <>
          <p role="alert">Your pickup code changed. Check again.</p>
          <button type="button" onClick={() => void controller.reveal()}>
            Check again
          </button>
        </>
      ) : null}
      {state.status === "unavailable" ? (
        <>
          <p role="alert">Your pickup code can’t be shown right now. Try again or ask staff.</p>
          <button type="button" onClick={() => void controller.reveal()}>
            Try again
          </button>
        </>
      ) : null}
      {state.status === "offline" ? (
        <>
          <p role="alert">Reconnect to show your pickup code.</p>
          {closeButton}
        </>
      ) : null}
      {state.status === "expired" ? (
        <>
          <p role="alert">
            This pickup code expired. Ask staff at the counter; they can check your order number.
          </p>
          <button type="button" onClick={() => void controller.reveal()}>
            Check again
          </button>
        </>
      ) : null}
      {state.status === "ready" ? (
        <div className="pickup-code__ready" role="status">
          <p className="bop-eyebrow">Ready for pickup</p>
          <h3>{state.view.storeDisplayName}</h3>
          <p>{state.view.pickupInstruction}</p>
          <div
            className="pickup-code__visual"
            aria-label={`Pickup code ${state.view.proofValue.split("").join(" ")}`}
          >
            <span>Order {state.view.orderNumber}</span>
            <code>{state.view.proofValue}</code>
          </div>
          <p>
            Show this code to staff to collect your order. Valid until{" "}
            <time dateTime={state.view.expiresAt}>{formatClockTime(state.view.expiresAt)}</time>.
          </p>
          <div className="pickup-code__actions">
            <button
              type="button"
              disabled={state.refreshing}
              onClick={() => void controller.refresh()}
            >
              {state.refreshing ? "Refreshing…" : "Refresh code"}
            </button>
            {autoReveal ? null : (
              <button type="button" onClick={() => controller.close()}>
                Hide code
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
