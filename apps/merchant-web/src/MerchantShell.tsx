import { AppFrame, StatePanel } from "@bop-rms/ui";
import type { ReactNode } from "react";
import type { MerchantWorkspaceSnapshot } from "./merchant-workspace.js";

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
}

function StateView({ state }: { readonly state: Exclude<MerchantShellState, { kind: "Ready" }> }) {
  const states: Record<
    Exclude<MerchantShellState, { kind: "Ready" }>["kind"],
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: ["Loading workspace", "Checking your authorized Merchant Session…", "neutral"],
    SignedOut: ["Sign in required", "Sign in to open your authorized Store workspace.", "neutral"],
    Offline: [
      "Offline read-only",
      "A current authorized scope cannot be loaded while offline.",
      "offline",
    ],
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

export function MerchantShell({ state, onSwitchStore, overview = null }: MerchantShellProps) {
  const ready = state.kind === "Ready" ? state : null;
  return (
    <AppFrame
      className="bop-shell--home-overview"
      title="OPERATIONS"
      description={
        ready ? ready.workspace.selectedScope.storeLabel : "Permission-trimmed Store workspace"
      }
      headerStatus={
        ready ? (
          <span data-freshness={ready.workspace.freshness}>{ready.workspace.freshness}</span>
        ) : undefined
      }
      navigation={
        ready ? (
          <>
            <span className="home-overview-navigation-label">WORKSPACE</span>
            {ready.workspace.navigation.map((item) => (
              <a
                key={item.screenId}
                href={item.href}
                aria-current={item.screenId === "HOME-OVERVIEW" ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </>
        ) : undefined
      }
    >
      {ready === null ? (
        <StateView state={state as Exclude<MerchantShellState, { kind: "Ready" }>} />
      ) : (
        <section id="overview" aria-labelledby="overview-heading">
          <div className="overview-heading">
            <div>
              <p className="bop-eyebrow">HOME-OVERVIEW · {ready.workspace.businessDate}</p>
              <h2 id="overview-heading">{ready.workspace.selectedScope.storeLabel}</h2>
              <p className="bop-muted">{ready.workspace.selectedScope.brandLabel}</p>
            </div>
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
                key={ready.workspace.selectedScope.storeReference}
                id="store-scope"
                name="store"
                defaultValue={ready.workspace.selectedScope.storeReference}
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
          </div>
          {ready.switchFailed ? (
            <p className="command-error" role="alert">
              Store switch failed. Your previous authorized scope is unchanged.
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
                <h3 id="live-store-status-heading">Live Store status</h3>
                <p className="overview-status-value">
                  <span>{ready.workspace.storeStatus}</span>
                </p>
                <p>Business Date {ready.workspace.businessDate}</p>
              </section>
              <section className="overview-card" aria-labelledby="today-summary-heading">
                <h3 id="today-summary-heading">Today summary</h3>
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </section>
              <section className="overview-card" aria-labelledby="tasks-summary-heading">
                <h3 id="tasks-summary-heading">Open tasks and exceptions</h3>
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </section>
              <section className="overview-card" aria-labelledby="health-summary-heading">
                <h3 id="health-summary-heading">System and Provider health</h3>
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </section>
            </div>
          )}
        </section>
      )}
    </AppFrame>
  );
}
