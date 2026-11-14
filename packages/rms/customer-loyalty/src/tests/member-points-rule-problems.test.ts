import { describe, expect, it } from "vitest";
import {
  MemberPointsRuleInvalidError,
  memberPointsRuleProblems,
  parseMemberPointsRuleChange,
} from "../domain/member-points.js";

const rule = {
  earnPointsPerDollar: 1,
  redeemPointsPerDollar: 100,
  minimumRedemptionPoints: 100,
  redemptionIncrementPoints: 10,
  inactivityExpiryDays: 548,
  expiryNoticeDays: 30,
  rewards: [],
};

describe("WP-2423 M135: a rule change names each wrong number", () => {
  it("lists every field and the rule it broke", () => {
    expect(memberPointsRuleProblems(rule)).toEqual([]);
    expect(
      memberPointsRuleProblems({ ...rule, earnPointsPerDollar: 101, expiryNoticeDays: "30" }),
    ).toEqual([
      { field: "earnPointsPerDollar", rule: "AtMost", limit: 100 },
      { field: "expiryNoticeDays", rule: "WholeNumber", limit: null },
    ]);
    expect(
      memberPointsRuleProblems({ ...rule, inactivityExpiryDays: 90, expiryNoticeDays: 90 }),
    ).toEqual([{ field: "expiryNoticeDays", rule: "AtMost", limit: 89 }]);
    expect(
      memberPointsRuleProblems({ ...rule, inactivityExpiryDays: 95, expiryNoticeDays: 95 }),
    ).toEqual([{ field: "expiryNoticeDays", rule: "AtMost", limit: 89 }]);
  });
  it("refuses the change with those problems, and accepts a valid one as before", () => {
    expect(parseMemberPointsRuleChange(rule).earnPointsPerDollar).toBe(1);
    try {
      parseMemberPointsRuleChange({ ...rule, redeemPointsPerDollar: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MemberPointsRuleInvalidError);
      expect((error as MemberPointsRuleInvalidError).code).toBe("CUSTOMER_PROFILE_INVALID");
      expect((error as MemberPointsRuleInvalidError).problems).toEqual([
        { field: "redeemPointsPerDollar", rule: "AtLeast", limit: 1 },
      ]);
    }
  });
});
