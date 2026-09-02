import { useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { isSafeUpdatePath } from "./service-worker-policy.js";
import { pwaUpdateStore, type PwaUpdateStore } from "./update-store.js";

export function PwaUpdateBanner({ store = pwaUpdateStore }: { readonly store?: PwaUpdateStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const location = useLocation();
  if (state.status === "idle") return null;
  const safe = isSafeUpdatePath(location.pathname);
  return (
    <aside className="pwa-update" role="status" aria-live="polite">
      <div>
        <strong>
          {state.status === "applying"
            ? "Applying application update."
            : "Application update ready."}
        </strong>{" "}
        <span>
          {safe
            ? "This route is safe for an explicit update."
            : "Finish or leave this sensitive flow before updating."}
        </span>
      </div>
      {state.status === "waiting" && safe ? (
        <button type="button" onClick={() => void store.activate(location.pathname)}>
          Update now
        </button>
      ) : null}
      {state.status === "waiting" && !safe ? <Link to="/menu">Go to a safe menu route</Link> : null}
    </aside>
  );
}
