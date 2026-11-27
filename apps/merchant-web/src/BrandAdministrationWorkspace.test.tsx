import { renderToStaticMarkup as renderStatic } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BrandAdministrationView } from "./BrandAdministrationWorkspace.js";
import { parseMerchantBrandWorkspace } from "./merchant-brand-workspace.js";

// v15 run: in-app links are router links, so pages render inside a router as in the app.
const renderToStaticMarkup = (element: ReactElement) =>
  renderStatic(<MemoryRouter>{element}</MemoryRouter>);
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

// Batch 41 (v15 b40 live, owner2-brand-zh-Hans-1440.png): with Chinese chosen the Brand page
// stopped at "Brand administration unavailable / Brand access could not be confirmed…" in English.
it("batch 41: the Brand page's frame and every state it stops at read in Chinese", async () => {
  const { setLanguageForTest } = await import("./i18n/i18n.js");
  setLanguageForTest("zh-Hans");
  try {
    // The skip link's words are given at the app's root (main.tsx), not by the page.
    const textOf = (html: string) =>
      html
        .replace(/<a class="bop-skip-link"[^>]*>[^<]*<\/a>/u, " ")
        .replace(/<[^>]*>/gu, " ")
        .replace(/\bBOP\b/gu, " ")
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, " ")
        .replace(/&[a-z]+;/gu, " ");
    const unavailable = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind: "Unavailable" }} {...actions} />,
    );
    expect(unavailable).toContain("暂时打不开品牌管理");
    expect(unavailable).toContain("暂时无法确认你的品牌权限。请点“重新确认品牌权限”再试。");
    expect(unavailable).toContain(">重新确认品牌权限</button>");
    for (const kind of [
      "Loading",
      "AccessRequired",
      "Unavailable",
      "Offline",
      "NotFound",
      "ScopeChanged",
      "OutcomeUnknown",
    ] as const) {
      const text = textOf(
        renderToStaticMarkup(<BrandAdministrationView state={{ kind }} {...actions} />),
      );
      expect(text, kind).not.toMatch(/[A-Za-z]{3,}/u);
    }
    for (const kind of ["MfaRequired", "LogoutPending"] as const) {
      const text = textOf(
        renderToStaticMarkup(
          <BrandAdministrationView state={{ kind, csrf: "c".repeat(43) }} {...actions} />,
        ),
      );
      expect(text, kind).not.toMatch(/[A-Za-z]{3,}/u);
    }
    // The frame of a Brand that opened: its own name aside, the status reads in staff words.
    const ready = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind: "Ready", value: value(false) }} {...actions} />,
    );
    expect(textOf(ready).replaceAll("Synthetic Brand", "")).not.toMatch(/[A-Za-z]{3,}/u);
    const panels = renderToStaticMarkup(
      <BrandAdministrationView state={{ kind: "Ready", value: value() }} {...actions} />,
    );
    expect(panels).toContain("品牌状态：有效");
    expect(panels).toContain(">重新登录</button>");
    expect(panels).toContain(">打开门店工作台</a>");
  } finally {
    setLanguageForTest("en");
  }
});
