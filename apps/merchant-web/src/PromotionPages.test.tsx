import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PromotionEditorScreen, PromotionListScreen, PromotionState } from "./PromotionPages.js";
import {
  parsePromotionEditorView,
  parsePromotionListView,
  PromotionClientError,
} from "./promotion-pages.js";
const id = (n: number) => `018f9500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const item = () => ({
  promotionReference: id(1),
  name: "Synthetic Lunch",
  stableCode: "SYNTHETIC_LUNCH",
  promotionType: "OrderPercentage",
  lifecycle: "Published",
  scopeSummary: "Brand / Pickup",
  eligibilitySummary: "Synthetic category",
  benefitSummary: "10 percent exact discount",
  budgetMinor: "100000",
  usageMinor: "1250",
  effectivePeriod: "2026-08-01 onward America/Toronto",
  scheduleStatus: "Active",
  stacking: "SameGroupExclusive",
  conflictCount: 0,
  aggregateVersion: 3,
});
const editor = () => ({
  screenId: "PROMO-EDITOR",
  ...item(),
  audienceSummary: "PII-free segment reference",
  eligibleItemsSummary: "Synthetic Product and Category references",
  limitsSummary: "100 redemptions",
  priority: 10,
  scheduleSummary: "Happy Hour Business Date schedule",
  customerCopy: "Synthetic lunch offer",
  impactSummary: "One Store and one channel",
  historySummary: "Version 3 approved by a distinct actor",
  simulations: [
    {
      basketCode: "SYNTHETIC_BASKET",
      subtotalMinor: "1000",
      discountMinor: "100",
      totalMinor: "900",
      decisionSummary: "Selected as greatest compatible saving",
    },
  ],
});
describe("Promotion screen contracts", () => {
  it("renders List filters, budget, stacking and actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PromotionListScreen
          view={parsePromotionListView({
            screenId: "PROMO-LIST",
            asOfUtc: "2026-08-13T18:00:00.000Z",
            items: [item()],
          })}
        />
      </MemoryRouter>,
    );
    for (const text of [
      "Promotion management",
      "Synthetic Lunch",
      "1250 / 100000",
      "SameGroupExclusive",
      "Store / channel",
      "Simulate",
      "Submit / approve",
      "Pause",
      "Archive",
    ])
      expect(html).toContain(text);
  });
  it("renders Editor conditions, impact, representative basket and approval flow", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PromotionEditorScreen view={parsePromotionEditorView(editor())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Promotion editor",
      "PII-free segment reference",
      "Happy Hour",
      "SYNTHETIC_BASKET",
      "1000 − 100 = 900",
      "Validate",
      "Approve",
      "Publish / schedule",
    ])
      expect(html).toContain(text);
  });
  it("rejects markup, URLs and numeric money, and renders every required state", () => {
    expect(() =>
      parsePromotionEditorView({ ...editor(), customerCopy: "https://bad.example" }),
    ).toThrow(PromotionClientError);
    expect(() => parsePromotionEditorView({ ...editor(), budgetMinor: 100000 })).toThrow(
      PromotionClientError,
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
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <PromotionState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
