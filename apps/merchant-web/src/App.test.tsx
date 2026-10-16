import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MerchantShell } from "./MerchantShell.js";
import { ShowcaseOverview } from "./merchant-demo-ui.js";
import type { MerchantWorkspaceSnapshot } from "./merchant-workspace.js";

const workspace: MerchantWorkspaceSnapshot = Object.freeze({
  screenId: "HOME-OVERVIEW",
  selectedScope: Object.freeze({
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: "018f7f9a-ad3e-7a11-8d01-000000000003",
  }),
  authorizedStores: Object.freeze([
    Object.freeze({
      brandLabel: "Synthetic Brand",
      storeLabel: "Training Store",
      storeReference: "018f7f9a-ad3e-7a11-8d01-000000000003",
    }),
    Object.freeze({
      brandLabel: "Synthetic Brand",
      storeLabel: "Second Store",
      storeReference: "018f7f9a-ad3e-7a11-8d01-000000000004",
    }),
  ]),
  businessDate: "2026-08-12",
  storeStatus: "Open",
  freshness: "Stale",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: Object.freeze([
    Object.freeze({
      screenId: "HOME-OVERVIEW",
      label: "Overview",
      href: "/app",
      permission: "merchant.access",
    }),
    Object.freeze({
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    }),
  ]),
});

describe("HOME-OVERVIEW Merchant shell", () => {
  it("renders the secure sign-in gate without Store or Provider detail", () => {
    const html = renderToStaticMarkup(
      <MerchantShell state={{ kind: "SignedOut" }} onSwitchStore={vi.fn()} />,
    );
    expect(html).toContain("Sign in required");
    // WP-2423 Q18: the sign-in path comes from the server (no hard-coded, possibly dead, link).
    expect(html).toContain("Finding the sign-in page");
    expect(html).not.toContain("/merchant/login");
    expect(html).toContain('href="#main-content"');
    expect(html).not.toContain("synthetic-provider-error");
  });

  it("renders the complete permission-trimmed overview and explicit WP-1905 boundary", () => {
    const html = renderToStaticMarkup(
      <MerchantShell
        state={{
          kind: "Ready",
          switching: false,
          switchFailed: false,
          workspace,
        }}
        onSwitchStore={vi.fn()}
      />,
    );
    expect(html).not.toContain("HOME-OVERVIEW");
    expect(html).toContain("Training Store");
    expect(html).toContain('data-freshness="Stale"');
    expect(html).not.toContain("Training Store · Stale");
    expect(html).toContain("Second Store");
    expect(html).toContain("Store status");
    expect(html).toContain("not available in this release");
    expect(html).not.toContain("WP-1905");
    expect(html).toContain("Stale data");
    expect(html).toContain("Data may be out of date");
    // The navigation belongs to the workspace layout, not the page.
    expect(html).not.toContain("<nav");
    expect(html).toContain('id="main-content"');
    expect(html).toContain("Switch Store");
  });

  it("keeps the previous scope visible on a non-color-only switch failure", () => {
    const html = renderToStaticMarkup(
      <MerchantShell
        state={{ kind: "Ready", switching: false, switchFailed: true, workspace }}
        onSwitchStore={vi.fn()}
      />,
    );
    expect(html).toContain("Training Store");
    expect(html).toContain("Your previous Store is unchanged");
    expect(html).toContain('role="alert"');
  });

  it("WP-2423: a PIN sign-in refused a Store switch gets the verify step, not a failure", () => {
    const html = renderToStaticMarkup(
      <MerchantShell
        state={{
          kind: "Ready",
          switching: false,
          switchFailed: "FullSignInRequired",
          csrf: "C".repeat(43),
          workspace,
        }}
        onSwitchStore={vi.fn()}
      />,
    );
    expect(html).toContain("You signed in with a PIN");
    expect(html).toContain("Verify it&#x27;s you");
    expect(html).toContain("Your previous Store is unchanged");
    expect(html).not.toContain("Store switch failed");
    expect(html).not.toContain("FullSignInRequired");
  });

  it("renders the visibly synthetic showcase without changing normal workspace contracts", () => {
    const html = renderToStaticMarkup(
      <MerchantShell
        overview={<ShowcaseOverview />}
        state={{ kind: "Ready", switching: false, switchFailed: false, workspace }}
        onSwitchStore={vi.fn()}
      />,
    );
    for (const value of [
      "Synthetic daily summary",
      "Orders today",
      "$1,284.60",
      "Explore the operating system",
      "Orders",
      "Kitchen Board",
      "Store Configuration",
      "Compliance Dashboard",
      "PLATFORM · NONPRODUCTION",
      "Synthetic operating timeline",
    ])
      expect(html).toContain(value);
    expect(html).toContain('href="/platform/support-cases"');
    expect(html).not.toContain("Unavailable until the WP-1905");
  });
});

describe("WP-2423 session-gated pages", () => {
  it("show a neutral loading state, not a refusal, while the session answer is in flight", async () => {
    const { App } = await import("./App.js");
    const { MemoryRouter } = await import("react-router");
    const pending = {
      bootstrap: () => new Promise<never>(() => undefined),
      switchStore: () => new Promise<never>(() => undefined),
    };
    for (const path of [
      "/app/reports/operations",
      "/app/operations/payment-reconciliation",
      "/app/approvals",
      "/operations/kitchen",
      "/app/organization/stores/018f7f9a-ad3e-7a11-8d01-000000000003/setup",
    ]) {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
          <App client={pending} />
        </MemoryRouter>,
      );
      expect(html, path).toContain("Loading this page…");
      expect(html, path).not.toContain("A current merchant session");
      expect(html, path).not.toContain("unavailable");
    }
  });
});
