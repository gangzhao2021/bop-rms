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
          <strong>You are offline.</strong>{" "}
          <span>
            Transaction and identity actions are unavailable. Nothing will run or replay in the
            background.
          </span>
        </>
      ) : (
        <>
          <div>
            <strong>Connection restored.</strong>{" "}
            <span>
              Review the current screen and retry explicitly. No action ran automatically.
            </span>
          </div>
          <button type="button" onClick={() => controller.dismissRestored()}>
            Dismiss
          </button>
        </>
      )}
    </aside>
  );
}
