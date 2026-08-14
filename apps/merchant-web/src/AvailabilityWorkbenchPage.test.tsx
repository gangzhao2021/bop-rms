import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AvailabilityStatePanel,
  AvailabilityWorkbenchScreen,
} from "./AvailabilityWorkbenchPage.js";
import { parseAvailabilityWorkbenchView } from "./availability-workbench.js";

const view = parseAvailabilityWorkbenchView({
  screenId: "CAT-AVAILABILITY",
  asOfUtc: "2026-08-13T16:00:00.000Z",
  timeZone: "America/Toronto",
  businessDate: "2026-08-13",
  items: [
    {
      ruleReference: "018f7000-0000-7000-8000-000000000001",
      itemName: "Lunch Bundle",
      internalCode: "LUNCH_BUNDLE",
      sellableType: "Bundle",
      lifecycle: "Active",
      storeName: "Queen Street",
      channelSummary: "Dine in",
      scheduleSummary: "11:00–14:00 local",
      source: "Manual",
      priority: 20,
      effectiveResult: "Available",
      reasonCode: "CATALOG_ALLOWED",
      aggregateVersion: 3,
    },
  ],
});

describe("CAT-AVAILABILITY", () => {
  it("renders scope, schedule, result, filters and fail-closed commands", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AvailabilityWorkbenchScreen view={view} />
      </MemoryRouter>,
    );
    expect(html).toContain("CAT-AVAILABILITY");
    expect(html).toContain("America/Toronto");
    expect(html).toContain("Lunch Bundle");
    expect(html).toContain("Simulate effective result");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(6);
  });
  it("renders every registered failure and recovery state", () => {
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
    ] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AvailabilityStatePanel state={state} />
        </MemoryRouter>,
      );
      expect(html).toContain('role="status"');
    }
  });
  it("rejects untrusted projection text and mismatched shapes", () => {
    expect(() =>
      parseAvailabilityWorkbenchView({
        ...view,
        items: [{ ...view.items[0], itemName: "<script>" }],
      }),
    ).toThrow();
  });
});

void act;
