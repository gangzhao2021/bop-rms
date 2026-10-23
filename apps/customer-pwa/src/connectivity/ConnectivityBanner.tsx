import { t } from "../i18n/i18n.js";
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
          <strong>{t("You’re offline.")}</strong>{" "}
          <span>
            {t(
              "Ordering and payment are paused until you reconnect. Nothing is sent in the background.",
            )}
          </span>
        </>
      ) : (
        <>
          <div>
            <strong>{t("Connection restored.")}</strong>{" "}
            <span>
              {t(
                "Check this page, then try again if you need to. Nothing was sent while you were offline.",
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
