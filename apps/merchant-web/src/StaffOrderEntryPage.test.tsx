import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StaffOrderEntryScreen, StaffOrderEntryState } from "./StaffOrderEntryPage.js";
import { parseStaffOrderEntryView, StaffOrderEntryClientError } from "./staff-order-entry.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(overrides: Record<string, unknown> = {}) {
  return {
    screenId: "OPS-ORDER-ENTRY",
    projectionVersion: "MERCHANT_STAFF_ORDER_ENTRY_V1",
    asOfUtc: "2026-09-20T18:00:00.000Z",
    freshness: "Current",
    partial: false,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    storeLabel: "Toronto Pilot",
    serviceMode: "DineIn",
    actorReference: id(4),
    actorLabel: "Authorized Counter Staff",
    sourceChannel: "Pos",
    menuSnapshotReference: id(5),
    menuItems: [
      {
        sellableReference: id(6),
        code: "BOWL_01",
        localizedName: "Seasonal bowl",
        sectionCode: "MAINS",
        availability: "AvailableNow",
        configuredPrice: { amountMinor: 1895, currencyCode: "CAD" },
        allergenRequirement: "ReviewRequired",
      },
    ],
    cart: {
      cartReference: id(7),
      cartVersion: 3,
      lineCount: 1,
      quoteReference: id(8),
      quoteStatus: "Current",
      total: { amountMinor: 2141, currencyCode: "CAD" },
    },
    diningSession: { eligibility: "Eligible", sessionReference: id(9) },
    customerReference: { verified: true, maskedReference: "Verified customer ref …92" },
    allergenReview: "Current",
    terminalStatus: "NotStarted",
    ...overrides,
  };
}

describe("OPS-ORDER-ENTRY", () => {
  it("strictly parses the complete shared-contract projection", () => {
    expect(parseStaffOrderEntryView(projection())).toMatchObject({
      screenId: "OPS-ORDER-ENTRY",
      sourceChannel: "Pos",
      cart: { quoteStatus: "Current" },
    });
    expect(() => parseStaffOrderEntryView({ ...projection(), amountOverride: 1 })).toThrow(
      StaffOrderEntryClientError,
    );
  });
  it("renders canonical fields, filters, boundaries and disabled commands", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaffOrderEntryScreen view={parseStaffOrderEntryView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Public-effective Menu and Sellable configurator",
      "Staff Cart / canonical Quote",
      "Dining Session / verified Customer reference",
      "Structured allergen review",
      "Cashless Terminal handoff",
      "Price and tax are server-derived",
      "Pending only",
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/<button disabled="">Submit Order \/ Batch idempotently<\/button>/u);
    expect(html).toMatch(/<button disabled="">Start Terminal payment<\/button>/u);
  });
  it("renders stale partial data read-only and an empty filtered state", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaffOrderEntryScreen
          view={parseStaffOrderEntryView(
            projection({ freshness: "Stale", partial: true, menuItems: [] }),
          )}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Read-only dependency context");
    expect(html).toContain("No matching Sellables");
  });
  it("covers every mandatory state", () => {
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
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <StaffOrderEntryState state={state} />
          </MemoryRouter>,
        ),
      ).toContain("status");
  });
});
