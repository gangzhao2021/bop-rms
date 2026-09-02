import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  createPromotionSnapshot,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  PromotionError,
  simulatePromotions,
  type PromotionSnapshot,
} from "../index.js";

const id = (n: number) =>
  parsePricingReference(`018f9400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const digest = (c: string) => parsePricingDigest(`sha256:${c.repeat(64)}`);
const at = "2026-08-13T18:00:00.000Z";
function promotion(n: number, overrides: Partial<PromotionSnapshot> = {}): PromotionSnapshot {
  return {
    promotionReference: id(n),
    versionReference: id(n + 20),
    brandReference: id(1),
    stableCode: parsePricingCode(`PROMO_${n}`),
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: digest(String(n % 10)),
    lifecycle: "Published",
    promotionType: "OrderPercentage",
    currencyCode: parseCurrencyCode("CAD"),
    eligibleSellableReferences: [],
    eligibleCategoryReferences: [],
    eligibleSegmentReference: null,
    thresholdMinor: null,
    benefit: {
      scope: "Order",
      calculation: "Percentage",
      value: "0.1",
      maximumDiscountMinor: null,
    },
    stacking: "Stackable",
    stackingGroupCode: null,
    priority: 10,
    budgetMinor: "100000",
    usageMinor: "0",
    usageCount: 0,
    redemptionLimit: 100,
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    }),
    customerCopyCode: parsePricingCode(`PROMO_COPY_${n}`),
    createdAt: at,
    ...overrides,
  };
}
const basket = {
  basketReference: id(90),
  brandReference: id(1),
  currencyCode: parseCurrencyCode("CAD"),
  segmentReference: null,
  evaluatedAt: at,
  lines: [
    {
      lineReference: id(91),
      sellableReference: id(92),
      categoryReferences: [id(93)],
      amountMinor: "1000",
    },
  ],
};

describe("Promotion aggregate and basket simulation", () => {
  it("uses exact integer minor units and stacks compatible benefits", () => {
    const result = simulatePromotions(
      [
        promotion(2),
        promotion(3, {
          benefit: {
            scope: "Order",
            calculation: "Fixed",
            value: "50",
            maximumDiscountMinor: null,
          },
        }),
      ],
      basket,
    );
    expect(result).toMatchObject({
      subtotal: { amountMinor: 1000n },
      discount: { amountMinor: 150n },
      total: { amountMinor: 850n },
    });
    expect(result.selections.every((entry) => entry.decision === "Selected")).toBe(true);
  });
  it("chooses the greatest deterministic saving among exclusive and compatible plans", () => {
    const result = simulatePromotions(
      [
        promotion(2),
        promotion(3),
        promotion(4, {
          stacking: "Exclusive",
          benefit: {
            scope: "Order",
            calculation: "Fixed",
            value: "250",
            maximumDiscountMinor: null,
          },
        }),
      ],
      basket,
    );
    expect(result.discount.amountMinor).toBe(250n);
    expect(result.selections.find((entry) => entry.promotionReference === id(4))?.decision).toBe(
      "Selected",
    );
  });
  it("selects at most one promotion from the same exclusive group", () => {
    const result = simulatePromotions(
      [
        promotion(2, {
          stacking: "SameGroupExclusive",
          stackingGroupCode: parsePricingCode("MEAL"),
        }),
        promotion(3, {
          stacking: "SameGroupExclusive",
          stackingGroupCode: parsePricingCode("MEAL"),
          benefit: {
            scope: "Order",
            calculation: "Fixed",
            value: "125",
            maximumDiscountMinor: null,
          },
        }),
      ],
      basket,
    );
    expect(result.discount.amountMinor).toBe(125n);
    expect(result.selections.filter((entry) => entry.decision === "Selected")).toHaveLength(1);
  });
  it("caps simulated savings by remaining budget without consuming it", () => {
    const source = promotion(2, { budgetMinor: "100", usageMinor: "75" });
    const result = simulatePromotions([source], basket);
    expect(result.discount.amountMinor).toBe(25n);
    expect(source.usageMinor).toBe("75");
  });
  it("fails closed for ambiguous stacking or a percentage above one", () => {
    expect(() => createPromotionSnapshot(promotion(2, { stacking: "SameGroupExclusive" }))).toThrow(
      PromotionError,
    );
    expect(() =>
      createPromotionSnapshot(
        promotion(2, {
          benefit: {
            scope: "Order",
            calculation: "Percentage",
            value: "1.1",
            maximumDiscountMinor: null,
          },
        }),
      ),
    ).toThrow(PromotionError);
  });
});
