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
  ]),
});

describe("HOME-OVERVIEW Merchant shell", () => {
  it("renders the secure sign-in gate without Store or Provider detail", () => {
    const html = renderToStaticMarkup(
      <MerchantShell state={{ kind: "SignedOut" }} onSwitchStore={vi.fn()} />,
    );
    expect(html).toContain("Sign in required");
    expect(html).toContain("/merchant/login?returnTo=/app");
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
    expect(html).toContain("HOME-OVERVIEW");
    expect(html).toContain("Training Store");
    expect(html).toContain("Second Store");
    expect(html).toContain("Live Store status");
    expect(html).toContain("Today summary");
    expect(html).toContain("Open tasks and exceptions");
    expect(html).toContain("System and Provider health");
    expect(html.match(/Unavailable until the WP-1905/g)).toHaveLength(3);
    expect(html).toContain("Stale data");
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('aria-label="Authorized Merchant navigation"');
    expect(html).toContain('href="/app"');
    expect(html).not.toContain('href="/operations/kitchen"');
  });

  it("keeps the previous scope visible on a non-color-only switch failure", () => {
    const html = renderToStaticMarkup(
      <MerchantShell
        state={{ kind: "Ready", switching: false, switchFailed: true, workspace }}
        onSwitchStore={vi.fn()}
      />,
    );
    expect(html).toContain("Training Store");
    expect(html).toContain("previous authorized scope is unchanged");
    expect(html).toContain('role="alert"');
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
      "CAD $1,284.60",
      "Explore the operating system",
      "Order Queue",
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
