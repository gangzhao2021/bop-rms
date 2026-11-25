import { t, wordGap } from "../i18n/i18n.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createConnectivityController,
  type ConnectivityController,
} from "./connectivity-controller.js";

export function ConnectivityBanner({
  controller: provided,
}: {
  readonly controller?: ConnectivityController | undefined;
}) {
  const [controller] = useState(() => provided ?? createConnectivityController());
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
  if (state.status === "online") return null;
  return (
    <aside
      className={`connectivity-banner connectivity-banner--${state.status}`}
      role="status"
      aria-live="polite"
    >
      {state.status === "offline" ? (
        <>
          {/* Batch 63 (F10): one plain message, with what to do now (ask staff), instead of
              "paused" and "sent in the background". */}
          <strong>{t("No connection.")}</strong>
          {wordGap()}
          <span>{t("Your cart is kept on this phone. To order now, ask a staff member.")}</span>
        </>
      ) : (
        <>
          <div>
            <strong>{t("Connection restored.")}</strong>
            {wordGap()}
            <span>
              {/* WP-2423 M17: a payment confirmed just before the drop may have gone through; M94: the page reads again by itself. */}
              {t(
                "Updating this page… It will show anything that went through before the connection dropped.",
              )}
            </span>
          </div>
          <button type="button" onClick={() => controller.dismissRestored()}>
            {t("Dismiss")}
          </button>
        </>
      )}
    </aside>
  );
}
