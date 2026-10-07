import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrandAdministrationView } from "./BrandAdministrationWorkspace.js";
import { parseMerchantBrandWorkspace } from "./merchant-brand-workspace.js";
const brand = "018f7f9a-ad3e-7a11-8d01-000000000001",
  actor = "018f7f9a-ad3e-7a11-8d01-000000000002";
const actions = { onRefresh: vi.fn(), onRotate: vi.fn(), onLogout: vi.fn() };
const value = (navigation = true) => ({
  csrf: "c".repeat(43),
  recentMfaRequired: false as const,
  workspace: parseMerchantBrandWorkspace(
    {
      profile: "BrandAdministrationWorkspaceV1",
      selectedScope: { tenantReference: brand, brandReference: brand, actorReference: actor },
      brand: { brandReference: brand, label: "Synthetic Brand", lifecycle: "Active", version: 7 },
      navigation: navigation
        ? [
            {
              screenId: "ORG-BRAND-DETAIL",
              label: "Brand",
              href: `/app/organization/brands/${brand}`,
              permission: "organization.manage",
            },
          ]
        : [],
    },
    brand,
  ),
});
describe("ordinary Brand workspace presentation", () => {
  it("renders Brand configuration and catalog controls without a Store selection", () => {
    const html = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind: "Ready", value: value() }} {...actions} />,
    );
    expect(html).toContain("Synthetic Brand");
    expect(html).toContain("Catalogue source");
    expect(html).toContain("Open Store workspace");
    expect(html).toContain("Renew session");
    expect(html).toContain("Sign out");
    expect(html).not.toContain(actor);
    expect(html).not.toContain("c".repeat(43));
    expect(html).not.toContain("CurrentPublished");
  });
  it("an unavailable navigation entry never exposes business mutation controls", () => {
    const html = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind: "Ready", value: value(false) }} {...actions} />,
    );
    expect(html).toContain("Brand administration disabled");
    expect(html).not.toContain("Register catalogue source");
    expect(html).not.toContain("Save configuration");
  });
  it("keeps access, offline, scope change and unknown results explicit without leaking IDs or source errors", () => {
    for (const kind of [
      "AccessRequired",
      "Offline",
      "ScopeChanged",
      "OutcomeUnknown",
      "Unavailable",
      "NotFound",
    ] as const) {
      const html = renderToStaticMarkup(<BrandAdministrationView state={{ kind }} {...actions} />);
      expect(html).not.toContain("Register catalogue source");
      expect(html).not.toContain(brand);
      expect(html).not.toContain(actor);
      if (kind === "AccessRequired")
        expect(html).toContain('href="/merchant/organization/brands/login"');
      if (kind === "OutcomeUnknown") expect(html).toContain("Session result unknown");
      if (kind === "Offline") expect(html).toContain("Offline read-only");
    }
  });
});

it.each(["MfaRequired", "LogoutPending"] as const)(
  "hides all business panels and credentials during %s",
  (kind) => {
    const html = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind, csrf: "c".repeat(43) }} {...actions} />,
    );
    expect(html).not.toContain("Register catalogue source");
    expect(html).not.toContain("Save configuration");
    expect(html).not.toContain("Refresh Brand access");
    expect(html).not.toContain("c".repeat(43));
    expect(html).not.toContain(brand);
    expect(html).toContain(kind === "MfaRequired" ? "Verify identity" : "Retry sign out");
  },
);

it("renders lifecycle commands only within actual selected administrative identity and refresh ownership", () => {
  const html = renderToStaticMarkup(
    <BrandAdministrationView state={{ kind: "Ready", value: value() }} {...actions} />,
  );
  expect(html).toContain("Brand lifecycle");
  expect(html).toContain("Current Synthetic Brand: Active");
  expect(html).toContain("Archive Brand");
  expect(html).not.toContain("Activate Brand");
});
