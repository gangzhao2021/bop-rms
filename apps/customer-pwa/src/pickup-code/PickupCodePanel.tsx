import { t } from "../i18n/i18n.js";
import { createHttpPickupCodeClient } from "./pickup-code-client.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPickupCodeController, type PickupCodeController } from "./pickup-code-controller.js";
import { endSentence, formatClockTime } from "../journey/format.js";

/**
 * The pilot's configured pickup instruction (tooling/environment/pilot-api.mjs), shown in the
 * guest's language; any other instruction a Store configures is shown as written.
 */
const standardPickupInstruction = "Show this pickup confirmation to staff at the pickup counter.";

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
      {t("Close")}
    </button>
  );
  return (
    <section className="pickup-code" aria-labelledby="pickup-code-heading">
      <h2 id="pickup-code-heading">
        {state.status === "ready-without-code" || state.status === "collected"
          ? t("Pickup")
          : t("Pickup code")}
      </h2>
      {state.status === "hidden" ? (
        autoReveal ? (
          <p role="status">{t("Checking your pickup code…")}</p>
        ) : !remaking ? (
          // WP-2423 (v15 2026-10-17): before the order is ready there is no code to show, so no
          // button that can only answer "not yet". The page checks the order and shows the code
          // by itself once the kitchen has finished.
          <p>{t("Your pickup code appears here as soon as your order is ready.")}</p>
        ) : (
          <>
            <p>{t("Your pickup code appears here once your order is ready.")}</p>
            <button type="button" onClick={() => void controller.reveal()}>
              {t("Show pickup code")}
            </button>
          </>
        )
      ) : null}
      {state.status === "loading" ? <p role="status">{t("Checking your pickup code…")}</p> : null}
      {state.status === "collected" ? (
        <p role="status">{t("Your order has been collected.")}</p>
      ) : null}
      {state.status === "not-ready" ? (
        <>
          <p role="status">
            {autoReveal
              ? t("Your order is ready. Your pickup code appears here in a moment.")
              : t("Your order isn’t ready yet. The code appears here when it is.")}
          </p>
          {autoReveal ? null : closeButton}
        </>
      ) : null}
      {state.status === "permission-denied" ? (
        <>
          <p role="alert">
            {t(
              "Your visit on this phone has ended, so the code can’t be shown here. Give your name or order number at the counter.",
            )}
          </p>
          {closeButton}
        </>
      ) : null}
      {state.status === "not-found" ? (
        <>
          <p role="alert">{t("No pickup code is available for this order. Ask staff for help.")}</p>
          {closeButton}
        </>
      ) : null}
      {state.status === "feature-disabled" ? (
        <>
          <p role="alert">
            {t("Pickup codes are not used at this location. Ask staff at pickup.")}
          </p>
          {closeButton}
        </>
      ) : null}
      {state.status === "conflict" ? (
        <>
          <p role="alert">{t("Your pickup code changed. Check again.")}</p>
          <button type="button" onClick={() => void controller.reveal()}>
            {t("Check again")}
          </button>
        </>
      ) : null}
      {state.status === "unavailable" ? (
        <>
          <p role="alert">
            {t("Your pickup code can’t be shown right now. Try again or ask staff.")}
          </p>
          <button type="button" onClick={() => void controller.reveal()}>
            {t("Try again")}
          </button>
        </>
      ) : null}
      {state.status === "offline" ? (
        <>
          <p role="alert">{t("Reconnect to show your pickup code.")}</p>
          {closeButton}
        </>
      ) : null}
      {state.status === "expired" ? (
        <>
          <p role="alert">
            {t(
              "This pickup code expired. Ask staff at the counter; they can check your order number.",
            )}
          </p>
          <button type="button" onClick={() => void controller.reveal()}>
            {t("Check again")}
          </button>
        </>
      ) : null}
      {state.status === "ready-without-code" ? (
        // WP-2423: ready, but no code to show; staff hand it over after checking name or phone.
        <div className="pickup-code__ready" role="status">
          <p className="bop-eyebrow">{remaking ? t("Almost ready") : t("Ready for pickup")}</p>
          {remaking ? (
            <p className="pickup-code__wait">
              {t(
                "Part of your order is being remade. Please wait until it's ready before collecting it.",
              )}
            </p>
          ) : null}
          <p>
            {state.reason === "CounterOrder"
              ? t("Your order is ready at the counter.")
              : state.reason === "CodePending"
                ? t(
                    "Your order is ready. Your pickup code appears here in a moment. If you’re already at the counter, show your order number — staff will check your name or phone number.",
                  )
                : t(
                    "Your order is ready. Show your order number at the counter — staff will check your name or phone number.",
                  )}
          </p>
          <div className="pickup-code__visual pickup-code__visual--short">
            <span>{t("Your order number")}</span>
            <code>{state.orderNumber}</code>
          </div>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div className="pickup-code__ready" role="status">
          <p className="bop-eyebrow">{remaking ? t("Almost ready") : t("Ready for pickup")}</p>
          {remaking ? (
            <p className="pickup-code__wait">
              {t(
                "Part of your order is being remade. Please wait until it's ready before showing this code.",
              )}
            </p>
          ) : null}
          <h3>{state.view.storeDisplayName}</h3>
          <p>
            {state.view.pickupInstruction === standardPickupInstruction
              ? t("Show this pickup confirmation to staff at the pickup counter.")
              : state.view.pickupInstruction}
          </p>
          {/* Screen readers hear the code one character at a time; the large code is visual only. */}
          <p className="sr-only">
            {t("Order {orderNumber}. Pickup code {value1}", {
              orderNumber: state.view.orderNumber,
              value1: (state.view.counterCode ?? state.view.proofValue).split("").join(" "),
            })}
          </p>
          {state.view.counterCode ? (
            // WP-2423 (DEC-PICKUP-COUNTER-CODE): six digits staff can type, read in two groups.
            <div className="pickup-code__visual pickup-code__visual--short" aria-hidden="true">
              <span>
                {t("Order")} {state.view.orderNumber}
              </span>
              <code>
                {state.view.counterCode.slice(0, 3)} {state.view.counterCode.slice(3)}
              </code>
            </div>
          ) : (
            <div className="pickup-code__visual" aria-hidden="true">
              <span>
                {t("Order")} {state.view.orderNumber}
              </span>
              <code>{state.view.proofValue}</code>
            </div>
          )}
          <p>
            {state.view.counterCode
              ? t("Show or read this code to staff to collect your order. Valid until ")
              : t("Show this code to staff to collect your order. Valid until ")}
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
              {state.refreshing ? "Refreshing…" : t("Refresh code")}
            </button>
            {autoReveal ? null : (
              <button type="button" onClick={() => controller.close()}>
                {t("Hide code")}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
