import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  LoyaltyProgramEditor,
  LoyaltyProgramList,
  LoyaltyProgramState,
} from "./LoyaltyProgramPages.js";
import { LoyaltyProgramClientError, parseLoyaltyProgramView } from "./loyalty-program-pages.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fixture = (screenId: "LOY-PROGRAM-LIST" | "LOY-PROGRAM-EDITOR", visible = true) => ({
  projectionName: "loyalty_program_v1",
  projectionVersion: 1,
  screenId,
  brandLabel: "Synthetic Brand",
  asOfUtc: "2026-08-14T11:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayViewRules: visible, mayEdit: true, mayApprove: true },
  rows: [
    {
      programReference: id(1),
      programCode: "SYNTHETIC",
      name: "Synthetic Rewards",
      lifecycle: "Validated",
      currentVersion: 2,
      memberCount: 10,
      earnSummary: visible ? "1 per 100 minor" : null,
      redeemSummary: visible ? "10 point increments" : null,
      scopeSummary: "One Store · Web · Pickup",
      effectiveFromUtc: "2026-08-14T08:00:00.000Z",
      effectiveToUtc: null,
    },
  ],
  detail:
    screenId === "LOY-PROGRAM-EDITOR"
      ? {
          programReference: id(1),
          aggregateVersion: 3,
          programCode: "SYNTHETIC",
          versionNumber: 2,
          lifecycle: "Validated",
          eligibility: "OPEN",
          earnActivation: "Captured + Fulfilled",
          redemption: "Minimum 10 · increment 10",
          expiry: "365 days · reservation TTL 15 minutes",
          tiers: visible ? ["BASE 0", "GOLD 100"] : null,
          rewards: visible ? ["REWARD 50"] : null,
          refundReversal: "Reverse earned and return redeemed",
          effectivePeriod: "2026-08-14 onward",
          customerCopy: visible ? "Synthetic customer copy" : null,
          validationIssues: [],
          simulation: visible
            ? {
                earnedPending: 100,
                activatedAvailable: 100,
                reserved: 50,
                redeemed: 50,
                released: 0,
                reversedEarned: 0,
                returnedRedeemed: 0,
                expired: 0,
                endingAvailable: 50,
                pointsDebt: 0,
                tierCode: "GOLD",
                rewardCodes: ["REWARD"],
                pointsConserved: true,
                monetaryBenefitCalculated: false,
                paymentTenderUsed: false,
              }
            : null,
        }
      : null,
});
describe("Loyalty Program pages", () => {
  it("strictly parses both canonical screens and rejects undeclared monetary output", () => {
    expect(parseLoyaltyProgramView(fixture("LOY-PROGRAM-LIST"))).toMatchObject({
      screenId: "LOY-PROGRAM-LIST",
    });
    expect(parseLoyaltyProgramView(fixture("LOY-PROGRAM-EDITOR"))).toMatchObject({
      detail: { lifecycle: "Validated" },
    });
    expect(() =>
      parseLoyaltyProgramView({ ...fixture("LOY-PROGRAM-LIST"), discountAmountMinor: 100 }),
    ).toThrow(LoyaltyProgramClientError);
  });
  it("renders list filters, scope and lifecycle actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LoyaltyProgramList view={parseLoyaltyProgramView(fixture("LOY-PROGRAM-LIST"))} />
      </MemoryRouter>,
    );
    for (const value of [
      "LOY-PROGRAM-LIST",
      "Name / code",
      "Status / Store scope / scheduled",
      "Create Program",
      "Open Program",
      "Members 10",
    ])
      expect(html).toContain(value);
  });
  it("renders full editor simulation and immutable ownership boundaries", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LoyaltyProgramEditor view={parseLoyaltyProgramView(fixture("LOY-PROGRAM-EDITOR"))} />
      </MemoryRouter>,
    );
    for (const value of [
      "LOY-PROGRAM-EDITOR",
      "Earn / activation",
      "Refund reversal",
      "Tiers BASE",
      "Rewards / entitlements",
      "Validate points conservation",
      "Simulate lifecycle",
      "Review / publish or schedule",
      "never rewrite historical Points",
      "not Payment tender",
      "Pricing calculates monetary impact",
    ])
      expect(html).toContain(value);
  });
  it("trims restricted rules and covers all page states", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LoyaltyProgramEditor
          view={parseLoyaltyProgramView({
            ...fixture("LOY-PROGRAM-EDITOR", false),
            freshness: "Stale",
          })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Tiers BASE");
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "Validation",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<LoyaltyProgramState state={state} />)).toContain("status");
  });
});
