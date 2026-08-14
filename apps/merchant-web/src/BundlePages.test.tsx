import { AppFrame } from "@bop-rms/ui";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { BundleEditorScreen, BundleListScreen, BundleStatePanel } from "./BundlePages.js";
import { parseBundleEditorView, parseBundleListView } from "./bundle-pages.js";
import type { BundleClientErrorCode, BundleEditorView, BundleListView } from "./bundle-pages.js";

const bundleReference = "018fb000-0000-7000-8000-000000000001";
const groupReference = "018fb000-0000-7000-8000-000000000002";
const list: BundleListView = {
  screenId: "CAT-BUNDLE-LIST",
  asOfUtc: "2026-08-13T16:00:00.000Z",
  items: [
    {
      bundleReference,
      name: "Synthetic Lunch",
      internalCode: "LUNCH",
      lifecycle: "Draft",
      priceMode: "Fixed",
      componentCount: 2,
      choiceCount: 4,
      menuReferenceCount: 1,
      effectiveVersion: 3,
    },
  ],
};
const editor: BundleEditorView = {
  screenId: "CAT-BUNDLE-EDITOR",
  bundleReference,
  name: "Synthetic Lunch",
  internalCode: "LUNCH",
  lifecycle: "Draft",
  aggregateVersion: 3,
  priceSummary: "Fixed CAD 12.99",
  availabilitySummary: "2 referenced rules",
  historySummary: "2 prior immutable versions",
  componentGroups: [
    {
      groupReference,
      name: "Main",
      bounds: "Choose exactly 1",
      eligibleSellableCount: 3,
      upgradeRuleSummary: "One CAD 1.25 upgrade",
    },
  ],
};
function route(content: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{content}</MemoryRouter>);
}

describe("CAT-BUNDLE-LIST and CAT-BUNDLE-EDITOR", () => {
  it("renders list fields, safe filters, navigation and bounded actions", () => {
    const html = route(<BundleListScreen view={list} />);
    expect(html).toContain("CAT-BUNDLE-LIST");
    expect(html).toContain("Synthetic Lunch");
    expect(html).toContain("Search name or code");
    expect(html).toContain("Price mode");
    expect(html).toContain("Menu references");
    expect(html).toContain(`/app/commerce/bundles/${bundleReference}/edit`);
    expect(html).toContain("Duplicate");
    expect(html).toContain("Validate");
    expect(html).toContain("A command-capable Bundle BFF is not connected");
  });
  it("renders editor identity, exact-money summary, groups, history and keyboard action", () => {
    const html = route(<BundleEditorScreen view={editor} />);
    for (const expected of [
      "CAT-BUNDLE-EDITOR",
      "Expected Version 3",
      "Fixed CAD 12.99",
      "Component groups",
      "Choose exactly 1",
      "Nested Bundle depth 0",
      "Move Main up with keyboard",
      "Simulate configuration",
      "Submit review",
      "Publish",
    ])
      expect(html).toContain(expected);
    expect(html).toContain("disabled");
  });
  it("renders every fail-closed state with non-color status text", () => {
    const states: readonly ("Loading" | BundleClientErrorCode)[] = [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ];
    for (const state of states) {
      const html = route(
        <AppFrame title="Bundle" description="state">
          <BundleStatePanel state={state} />
        </AppFrame>,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain("Return to Bundles");
    }
  });
  it("keeps fixtures synthetic and excludes secrets, PII and Provider payloads", () => {
    const source = JSON.stringify({ list, editor });
    expect(source).not.toMatch(/@|token|secret|provider|customer|https?:\/\//iu);
  });
  it("fails closed on malformed, accessor-bearing or markup-bearing BFF views", () => {
    expect(() => parseBundleListView({ ...list, secret: "no" })).toThrowError(
      expect.objectContaining({ code: "Unavailable" }),
    );
    expect(() =>
      parseBundleEditorView({ ...editor, name: "<script>unsafe</script>" }),
    ).toThrowError(expect.objectContaining({ code: "Unavailable" }));
    let invoked = false;
    const lookalike = Object.create(null);
    Object.defineProperty(lookalike, "screenId", {
      enumerable: true,
      get() {
        invoked = true;
        return "CAT-BUNDLE-LIST";
      },
    });
    expect(() => parseBundleListView(lookalike)).toThrowError(
      expect.objectContaining({ code: "Unavailable" }),
    );
    expect(invoked).toBe(false);
  });
});
