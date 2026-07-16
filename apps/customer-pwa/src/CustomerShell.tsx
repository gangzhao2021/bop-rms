import { AppFrame, StatePanel } from "@bop-rms/ui";
export function CustomerShell() {
  return (
    <AppFrame
      title="Order at BOP"
      description="Synthetic customer shell · no menu, cart, quote, or payment data"
    >
      <section className="shell-intro">
        <h2>Welcome</h2>
        <p>
          The customer foundation is mobile-first, food-forward, and explicit about what remains
          safe when the network is unavailable.
        </p>
        <p className="bop-muted">
          Demo location · Menu functionality is intentionally not implemented in WP-0004.
        </p>
      </section>
      <div className="bop-state-grid" id="customer-states">
        <StatePanel heading="Loading" status>
          <p>Checking the latest public experience…</p>
        </StatePanel>
        <StatePanel heading="Something went wrong" tone="error">
          <p>Your order was not submitted. Try again when the service is available.</p>
        </StatePanel>
        <StatePanel heading="Offline" tone="offline">
          <p>No cached menu is enabled. Checkout and every transaction remain unavailable.</p>
        </StatePanel>
      </div>
      <div className="shell-actions">
        <a className="shell-action" href="#customer-states">
          Review availability states
        </a>
      </div>
    </AppFrame>
  );
}
