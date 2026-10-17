import { createHttpPickupCodeClient } from "./pickup-code-client.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPickupCodeController, type PickupCodeController } from "./pickup-code-controller.js";
import { endSentence, formatClockTime } from "../journey/format.js";

export function PickupCodePanel({
  orderReference,
  orderNumber,
  controller: provided,
  autoReveal = false,
  refreshToken,
  remaking = false,
}: {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly controller?: PickupCodeController | undefined;
  /** The order is ready: show the code without a tap, and re-check it whenever the status refreshes. */
  readonly autoReveal?: boolean;
  /** Changes when the parent status refreshed; triggers a re-check of a missing or expired code. */
  readonly refreshToken?: string | undefined;
  /** WP-2423 Q26: the kitchen is remaking part of the order; the code is kept, with a wait note. */
  readonly remaking?: boolean;
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
  useEffect(() => {
    controller.followUntilReady?.(autoReveal);
  }, [autoReveal, controller]);
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
      <h2 id="pickup-code-heading">
        {state.status === "ready-without-code" ? "Pickup" : "Pickup code"}
      </h2>
      {state.status === "hidden" ? (
        autoReveal ? (
          <p role="status">Checking your pickup code…</p>
        ) : !remaking ? (
          // WP-2423 (v15 2026-10-17): before the order is ready there is no code to show, so no
          // button that can only answer "not yet". The page checks the order and shows the code
          // by itself once the kitchen has finished.
          <p>Your pickup code appears here as soon as your order is ready.</p>
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
          <p role="status">
            {autoReveal
              ? "Your order is ready. Your pickup code appears here in a moment."
              : "Your order isn’t ready yet. The code appears here when it is."}
          </p>
          {autoReveal ? null : closeButton}
        </>
      ) : null}
      {state.status === "permission-denied" ? (
        <>
          <p role="alert">
            Your visit on this phone has ended, so the code can’t be shown here. Give your name or
            order number at the counter.
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
      {state.status === "ready-without-code" ? (
        // WP-2423: ready, but no code to show; staff hand it over after checking name or phone.
        <div className="pickup-code__ready" role="status">
          <p className="bop-eyebrow">{remaking ? "Almost ready" : "Ready for pickup"}</p>
          {remaking ? (
            <p className="pickup-code__wait">
              Part of your order is being remade. Please wait until it&apos;s ready before
              collecting it.
            </p>
          ) : null}
          <p>
            {state.reason === "CounterOrder"
              ? "Your order is ready at the counter."
              : state.reason === "CodePending"
                ? "Your order is ready. Your pickup code appears here in a moment. If you’re already at the counter, show your order number — staff will check your name or phone number."
                : "Your order is ready. Show your order number at the counter — staff will check your name or phone number."}
          </p>
          <div className="pickup-code__visual pickup-code__visual--short">
            <span>Your order number</span>
            <code>{state.orderNumber}</code>
          </div>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div className="pickup-code__ready" role="status">
          <p className="bop-eyebrow">{remaking ? "Almost ready" : "Ready for pickup"}</p>
          {remaking ? (
            <p className="pickup-code__wait">
              Part of your order is being remade. Please wait until it&apos;s ready before showing
              this code.
            </p>
          ) : null}
          <h3>{state.view.storeDisplayName}</h3>
          <p>{state.view.pickupInstruction}</p>
          {/* Screen readers hear the code one character at a time; the large code is visual only. */}
          <p className="sr-only">
            {`Order ${state.view.orderNumber}. Pickup code ${(state.view.counterCode ?? state.view.proofValue).split("").join(" ")}`}
          </p>
          {state.view.counterCode ? (
            // WP-2423 (DEC-PICKUP-COUNTER-CODE): six digits staff can type, read in two groups.
            <div className="pickup-code__visual pickup-code__visual--short" aria-hidden="true">
              <span>Order {state.view.orderNumber}</span>
              <code>
                {state.view.counterCode.slice(0, 3)} {state.view.counterCode.slice(3)}
              </code>
            </div>
          ) : (
            <div className="pickup-code__visual" aria-hidden="true">
              <span>Order {state.view.orderNumber}</span>
              <code>{state.view.proofValue}</code>
            </div>
          )}
          <p>
            {state.view.counterCode
              ? "Show or read this code to staff to collect your order. Valid until "
              : "Show this code to staff to collect your order. Valid until "}
            <time dateTime={state.view.expiresAt}>
              {endSentence(formatClockTime(state.view.expiresAt))}
            </time>
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
