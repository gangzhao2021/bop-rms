import { AppFrame, StatePanel } from "@bop-rms/ui";
import type { ReactNode } from "react";
import type { MerchantWorkspaceSnapshot } from "./merchant-workspace.js";
import { Freshness } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";

type MerchantShellState =
  | { readonly kind: "Loading" }
  | { readonly kind: "SignedOut" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Failure" }
  | {
      readonly kind: "Ready";
      readonly switching: boolean;
      readonly switchFailed: boolean;
      readonly workspace: MerchantWorkspaceSnapshot;
    };

export interface MerchantShellProps {
  readonly state: MerchantShellState;
  readonly onSwitchStore: (targetStoreReference: string) => void | Promise<void>;
  readonly overview?: ReactNode;
  /** WP-2423 P2: the live "right now" card; the release note is shown while it is absent. */
  readonly today?: ReactNode;
}

function StateView({ state }: { readonly state: Exclude<MerchantShellState, { kind: "Ready" }> }) {
  const states: Record<
    Exclude<MerchantShellState, { kind: "Ready" }>["kind"],
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: ["Loading workspace", "Checking your session…", "neutral"],
    SignedOut: ["Sign in required", "Sign in to open your Store workspace.", "neutral"],
    Offline: ["You’re offline", "Reconnect to load your Store workspace.", "offline"],
    Failure: [
      "Unable to load",
      "The workspace is unavailable. No business action was attempted.",
      "error",
    ],
  };
  const details = states[state.kind];
  return (
    <StatePanel heading={details[0]} tone={details[2]} status>
      <p>{details[1]}</p>
      {state.kind === "SignedOut" ? (
        <a className="shell-action" href="/merchant/login?returnTo=/app">
          Sign in securely
        </a>
      ) : null}
    </StatePanel>
  );
}

/** HOME: the Store at a glance. Inside the workspace layout once a session exists. */
export function MerchantShell({
  state,
  onSwitchStore,
  overview = null,
  today,
}: MerchantShellProps) {
  if (state.kind !== "Ready")
    return (
      <AppFrame title="Operations" description="Store workspace">
        <StateView state={state} />
      </AppFrame>
    );
  const ready = state;
  const scope = ready.workspace.selectedScope;
  const multiStore = ready.workspace.authorizedStores.length > 1;
  return (
    <WorkspacePage
      className="workspace-page--overview"
      title={scope.storeLabel}
      meta={`${scope.brandLabel} · Business date ${ready.workspace.businessDate}`}
      status={<Freshness status={ready.workspace.freshness} />}
      actions={
        multiStore ? (
          <form
            className="scope-switcher"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const target = data.get("store");
              if (typeof target === "string") void onSwitchStore(target);
            }}
          >
            <label htmlFor="store-scope">Authorized Store</label>
            <select
              key={scope.storeReference}
              id="store-scope"
              name="store"
              defaultValue={scope.storeReference}
              disabled={ready.switching}
            >
              {ready.workspace.authorizedStores.map((store) => (
                <option key={store.storeReference} value={store.storeReference}>
                  {store.storeLabel} · {store.brandLabel}
                </option>
              ))}
            </select>
            <button type="submit" disabled={ready.switching}>
              {ready.switching ? "Switching…" : "Switch Store"}
            </button>
          </form>
        ) : null
      }
    >
      <section id="overview" aria-label="Store overview">
        {ready.switchFailed ? (
          <p className="command-error" role="alert">
            Store switch failed. Your previous Store is unchanged.
          </p>
        ) : null}
        {ready.workspace.freshness === "Stale" ? (
          <p className="stale-warning" role="status">
            Stale data · refresh before relying on operational status.
          </p>
        ) : null}
        {overview ?? (
          <div className="overview-grid">
            <section className="overview-card" aria-labelledby="live-store-status-heading">
              <h3 id="live-store-status-heading">Store status</h3>
              <p className="overview-status-value">
                <span>{ready.workspace.storeStatus}</span>
              </p>
              <p>Business date {ready.workspace.businessDate}</p>
            </section>
            {today ?? (
              <section className="overview-card" aria-labelledby="today-summary-heading">
                <h3 id="today-summary-heading">Today</h3>
                <p>
                  Sales, open orders and exceptions for the day are not available in this release.
                  Use Orders, Kitchen, Pickup and Exceptions from the menu.
                </p>
              </section>
            )}
          </div>
        )}
      </section>
    </WorkspacePage>
  );
}
