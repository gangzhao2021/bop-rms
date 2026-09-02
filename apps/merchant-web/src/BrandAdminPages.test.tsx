import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandAdminState, Brands } from "./BrandAdminPages.js";
import { parseBrandAdminView } from "./brand-admin-pages.js";
const id = (n: number) => `018f9e90-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z";
const brand = () => ({
  brandReference: id(1),
  code: "NORTH",
  displayName: "Synthetic North",
  lifecycle: "Draft",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  storeCount: 1,
  catalogSourceReference: id(2),
  mediaThemeReference: id(3),
  configurationVersion: 2,
  configurationStatus: "Approved",
  effectiveFrom: at,
  effectiveUntil: null,
  storeMemberships: [
    { storeReference: id(4), storeCode: "TORONTO_1", action: "Added", effectiveAt: at },
  ],
  inheritance: [
    {
      fieldCode: "DISPLAY.THEME",
      valueReference: id(5),
      source: "BrandBase",
      sourceVersionReference: id(6),
      effectiveFrom: at,
      effectiveUntil: null,
      overrideAllowed: true,
      platformHardRequirement: false,
    },
  ],
  historyReferences: [id(7)],
  auditSummaryReference: id(8),
});
const view = () => ({
  screenId: "ORG-BRAND-DETAIL",
  queryName: "brand_admin_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: at,
  freshness: "Fresh",
  completeness: "Complete",
  permissions: {
    mayCreate: true,
    mayEdit: true,
    mayActivate: true,
    mayArchive: true,
    mayPublish: true,
    mayManageStoreMembership: true,
  },
  filters: { nameOrCode: null, status: null, countryCode: null, locale: null },
  brands: [brand()],
});
describe("WP-2191 Brand screens", () => {
  it("renders configuration, membership, inheritance source and actions", () => {
    const html = renderToStaticMarkup(<Brands view={parseBrandAdminView(view())} />);
    for (const v of [
      "ORG-BRAND-DETAIL",
      "Synthetic North",
      "Catalog source",
      "TORONTO_1 Added",
      "DISPLAY.THEME",
      "Publish configuration through approval",
      "Manage Store membership",
    ])
      expect(html).toContain(v);
  });
  it("rejects unknown fields, duplicate membership, invalid locale and hard override", () => {
    expect(() =>
      parseBrandAdminView({ ...view(), foreignConfigurationValue: "forbidden" }),
    ).toThrow();
    const member = brand().storeMemberships[0];
    if (!member) throw new Error("synthetic membership missing");
    expect(() =>
      parseBrandAdminView({
        ...view(),
        brands: [{ ...brand(), storeMemberships: [member, member] }],
      }),
    ).toThrow();
    expect(() =>
      parseBrandAdminView({ ...view(), brands: [{ ...brand(), supportedLocales: ["fr-CA"] }] }),
    ).toThrow();
    expect(() =>
      parseBrandAdminView({
        ...view(),
        brands: [
          {
            ...brand(),
            inheritance: [
              { ...brand().inheritance[0], source: "StoreOverride", platformHardRequirement: true },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("disables stale actions and hides ungranted actions", () => {
    expect(
      renderToStaticMarkup(
        <Brands view={parseBrandAdminView({ ...view(), freshness: "Stale" })} />,
      ),
    ).toContain('<button disabled="">Manage Store membership</button>');
    const denied = {
      ...view(),
      permissions: {
        mayCreate: false,
        mayEdit: false,
        mayActivate: false,
        mayArchive: false,
        mayPublish: false,
        mayManageStoreMembership: false,
      },
    };
    expect(renderToStaticMarkup(<Brands view={parseBrandAdminView(denied)} />)).not.toContain(
      "<button",
    );
  });
  it("renders list empty and all canonical states", () => {
    const empty = { ...view(), screenId: "ORG-BRAND-LIST", brands: [] };
    expect(renderToStaticMarkup(<Brands view={parseBrandAdminView(empty)} />)).toContain(
      "No Brands",
    );
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<BrandAdminState state={state} />)).toContain('role="status"');
  });
});
