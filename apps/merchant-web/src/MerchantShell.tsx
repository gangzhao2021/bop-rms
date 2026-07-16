import { AppFrame, StatePanel } from "@bop-rms/ui";
export function MerchantShell() {
  return (
    <AppFrame
      title="Merchant workspace"
      description="Synthetic application shell · no Store or business data"
      navigation={
        <>
          <a href="#overview">Overview</a>
          <a href="#states">System states</a>
        </>
      }
    >
      <section className="shell-intro" id="overview">
        <h2>Foundation ready</h2>
        <p>
          This calm, store-scoped shell proves navigation, hierarchy, focus, and state treatment
          before any Section 88 business screen is implemented.
        </p>
        <p className="bop-muted">
          Scope: Training store · Synthetic content · No authentication connected
        </p>
      </section>
      <div className="bop-state-grid" id="states">
        <StatePanel heading="Loading" status>
          <p>Preparing the authorized workspace…</p>
        </StatePanel>
        <StatePanel heading="Unable to load" tone="error">
          <p>No business action was attempted. Retry after connectivity is restored.</p>
        </StatePanel>
        <StatePanel heading="Offline read-only" tone="offline">
          <p>Operational commands are unavailable while disconnected.</p>
        </StatePanel>
      </div>
      <div className="shell-actions">
        <a className="shell-action" href="#states">
          Review system states
        </a>
      </div>
    </AppFrame>
  );
}
