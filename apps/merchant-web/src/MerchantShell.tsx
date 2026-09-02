import { AppFrame, StatePanel } from "@bop-rms/ui";
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
  readonly preview?: boolean;
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

function ShowcaseOverview() {
  const modules = [
    {
      eyebrow: "OPERATIONS",
      title: "Order Queue",
      detail: "1 submitted order · 2 items",
      status: "Live preview",
      href: "/operations/orders",
    },
    {
      eyebrow: "KITCHEN",
      title: "Kitchen Board",
      detail: "1 queued work item · allergen review required",
      status: "Needs attention",
      href: "/operations/kitchen",
    },
    {
      eyebrow: "CATALOG",
      title: "Menus",
      detail: "1 approved menu · 1 unresolved validation issue",
      status: "Review",
      href: "/app/commerce/menus",
    },
    {
      eyebrow: "ORGANIZATION",
      title: "Store Configuration",
      detail: "Training Store · draft version 3",
      status: "Draft",
      href: "/app/organization/stores",
    },
    {
      eyebrow: "COMPLIANCE",
      title: "Compliance Dashboard",
      detail: "1 overdue signal · evidence 1 of 2",
      status: "Action required",
      href: "/app/compliance",
    },
    {
      eyebrow: "PLATFORM · NONPRODUCTION",
      title: "Support Cases",
      detail: "1 synthetic case · no active access grant",
      status: "Read only",
      href: "/platform/support-cases",
    },
  ] as const;
  return (
    <>
      <section className="showcase-summary" aria-label="Synthetic daily summary">
        <article>
          <span>Orders today</span>
          <strong>42</strong>
          <small>+8% synthetic trend</small>
        </article>
        <article>
          <span>Net sales</span>
          <strong>CAD $1,284.60</strong>
          <small>Training data only</small>
        </article>
        <article>
          <span>Kitchen queue</span>
          <strong>1 item</strong>
          <small>Oldest age 12 min</small>
        </article>
        <article>
          <span>Compliance</span>
          <strong>1 overdue</strong>
          <small>Evidence incomplete</small>
        </article>
      </section>
      <section className="showcase-section" aria-labelledby="workspace-heading">
        <div className="showcase-section-heading">
          <div>
            <p className="bop-eyebrow">WORKSPACE</p>
            <h3 id="workspace-heading">Explore the operating system</h3>
          </div>
          <p className="bop-muted">Every card opens a deterministic, read-only workflow.</p>
        </div>
        <div className="showcase-module-grid">
          {modules.map((module) => (
            <a className="showcase-module-card" href={module.href} key={module.href}>
              <span className="bop-eyebrow">{module.eyebrow}</span>
              <span className="showcase-module-title">{module.title}</span>
              <span className="bop-muted">{module.detail}</span>
              <span className="showcase-module-footer">
                <span>{module.status}</span>
                <span aria-hidden="true">Open →</span>
              </span>
            </a>
          ))}
        </div>
      </section>
      <section className="showcase-activity" aria-labelledby="activity-heading">
        <div>
          <p className="bop-eyebrow">RECENT ACTIVITY</p>
          <h3 id="activity-heading">Synthetic operating timeline</h3>
        </div>
        <ol>
          <li>
            <strong>Order ORD-1001 submitted</strong>
            <span>Pickup · QR · 2 items</span>
          </li>
          <li>
            <strong>Kitchen work queued</strong>
            <span>Mushroom rice bowl · allergen review required</span>
          </li>
          <li>
            <strong>Menu validation needs review</strong>
            <span>Synthetic All Day · 1 unresolved issue</span>
          </li>
        </ol>
      </section>
    </>
  );
}

export function MerchantShell({ state, onSwitchStore, preview = false }: MerchantShellProps) {
  const ready = state.kind === "Ready" ? state : null;
  return (
    <AppFrame
      title="Merchant overview"
      description="Permission-trimmed Store workspace"
      navigation={
        ready ? (
          <nav aria-label="Authorized Merchant navigation">
            {ready.workspace.navigation.map((item) => (
              <a key={item.screenId} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
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
          {preview ? (
            <ShowcaseOverview />
          ) : (
            <div className="overview-grid">
              <StatePanel heading="Live Store status" status>
                <strong>{ready.workspace.storeStatus}</strong>
                <p>Business Date {ready.workspace.businessDate}</p>
              </StatePanel>
              <StatePanel heading="Today summary">
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </StatePanel>
              <StatePanel heading="Open tasks and exceptions">
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </StatePanel>
              <StatePanel heading="System and Provider health">
                <p>Unavailable until the WP-1905 dashboard projection is connected.</p>
              </StatePanel>
            </div>
          )}
        </section>
      )}
    </AppFrame>
  );
}
