import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  parseRuleProblems,
  pointsRateText,
  ruleProblems,
  ruleProblemText,
} from "./MemberPointsPage.js";

afterEach(() => setLanguageForTest("en"));
const rule = {
  earnPointsPerDollar: 1,
  redeemPointsPerDollar: 100,
  minimumRedemptionPoints: 100,
  redemptionIncrementPoints: 10,
  inactivityExpiryDays: 548,
  expiryNoticeDays: 30,
};

describe("M135: each wrong points rule says why under its own field", () => {
  it("checks the same limits the server does, before sending", () => {
    expect(ruleProblems(rule)).toEqual([]);
    expect(
      ruleProblems({
        ...rule,
        expiryNoticeDays: 120,
        redeemPointsPerDollar: 0,
        earnPointsPerDollar: 1.5,
      }),
    ).toEqual([
      { field: "earnPointsPerDollar", rule: "WholeNumber", limit: null },
      { field: "redeemPointsPerDollar", rule: "AtLeast", limit: 1 },
      { field: "expiryNoticeDays", rule: "AtMost", limit: 89 },
    ]);
    expect(ruleProblems({ ...rule, inactivityExpiryDays: 90, expiryNoticeDays: 89 })).toEqual([]);
    expect(ruleProblems({ ...rule, inactivityExpiryDays: 90, expiryNoticeDays: 90 })).toEqual([
      { field: "expiryNoticeDays", rule: "AtMost", limit: 89 },
    ]);
  });
  it("says each problem plainly, in English and Chinese", () => {
    const below = { field: "expiryNoticeDays", rule: "BelowExpiry", limit: 60 } as const;
    expect(ruleProblemText(below)).toBe("Must be fewer days than the expiry (60).");
    setLanguageForTest("zh-Hans");
    expect(ruleProblemText(below)).toBe("必须少于过期天数（60）。");
  });
  it("reads only the server's known problems", () => {
    expect(
      parseRuleProblems({
        error: "rule_invalid",
        problems: [{ field: "expiryNoticeDays", rule: "AtMost", limit: 89 }],
      }),
    ).toEqual([{ field: "expiryNoticeDays", rule: "AtMost", limit: 89 }]);
    expect(parseRuleProblems({ error: "member_points_invalid" })).toBeNull();
    expect(
      parseRuleProblems({ error: "rule_invalid", problems: [{ field: "secret", rule: "AtMost" }] }),
    ).toBeNull();
  });
  it("says what the numbers give back, and when it is more than most stores", () => {
    expect(pointsRateText(1, 100)).toBe(
      "About 1% back: a guest earns 1 point per $1 and 100 points take $1 off.",
    );
    expect(pointsRateText(3, 200)).toBe(
      "About 1.5% back: a guest earns 3 points per $1 and 200 points take $1 off.",
    );
    expect(pointsRateText(20, 100)).toContain("more than most stores (2–5%)");
    expect(pointsRateText(0, 100)).toBe("Guests earn no points with these numbers.");
    setLanguageForTest("zh-Hans");
    expect(pointsRateText(1, 100)).toBe("约返 1%：每消费 $1 得 1 分，100 分抵 $1。");
  });
});
