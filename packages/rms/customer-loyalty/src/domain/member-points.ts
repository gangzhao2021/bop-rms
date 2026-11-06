import { CustomerProfileError } from "./customer-profile.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the rules of a Brand's points and the arithmetic on them. Money
 * is integer cents; rounding always favours the guest. Pure; the ledger is `loyalty-account.ts`.
 */
export interface MemberPointsReward {
  /** The dish this reward makes free when it is on the bill. */
  readonly productReference: string;
  readonly displayName: string;
  readonly pointsCost: number;
}
export interface MemberPointsRule {
  readonly version: number;
  readonly earnPointsPerDollar: number;
  readonly redeemPointsPerDollar: number;
  readonly minimumRedemptionPoints: number;
  readonly redemptionIncrementPoints: number;
  readonly inactivityExpiryDays: number;
  readonly expiryNoticeDays: number;
  readonly rewards: readonly MemberPointsReward[];
}
/** The rule before a Brand changes anything (version 0: nothing recorded yet). */
export const memberPointsDefaultRule: MemberPointsRule = Object.freeze({
  version: 0,
  earnPointsPerDollar: 3,
  redeemPointsPerDollar: 100,
  minimumRedemptionPoints: 300,
  redemptionIncrementPoints: 100,
  inactivityExpiryDays: 548,
  expiryNoticeDays: 30,
  rewards: Object.freeze([]),
});
/** A guest's member page warns this long before points expire, on top of the text message. */
export const memberPointsPageWarningDays = 60;
export const memberCodeLifetimeMs = 10 * 60_000;
export const memberCodeMaxAttempts = 5;
export const memberSessionLifetimeMs = 30 * 24 * 3_600_000;
/** Budgets for sending and checking codes: what happens at each is a 429 with a wait. */
export const memberCodeBudgets = Object.freeze({
  sendPerPhoneHour: 5,
  sendPerPhoneDay: 10,
  sendPerAddressHour: 30,
  checkPerAddressHour: 60,
});

const fail = (): never => {
  throw new CustomerProfileError("CUSTOMER_PROFILE_INVALID");
};
const whole = (value: unknown, minimum: number, maximum: number): number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fail();

/** WP-2423 M135: which rule number is wrong and why, so the page says it under that field. */
export type MemberPointsRuleField =
  | "earnPointsPerDollar"
  | "redeemPointsPerDollar"
  | "minimumRedemptionPoints"
  | "redemptionIncrementPoints"
  | "inactivityExpiryDays"
  | "expiryNoticeDays";
export interface MemberPointsRuleProblem {
  readonly field: MemberPointsRuleField;
  readonly rule: "WholeNumber" | "AtLeast" | "AtMost" | "BelowExpiry";
  readonly limit: number | null;
}
const ruleLimits: readonly (readonly [MemberPointsRuleField, number, number])[] = [
  ["earnPointsPerDollar", 0, 100],
  ["redeemPointsPerDollar", 1, 10_000],
  ["minimumRedemptionPoints", 1, 1_000_000],
  ["redemptionIncrementPoints", 1, 1_000_000],
  ["inactivityExpiryDays", 90, 3650],
  ["expiryNoticeDays", 7, 89],
];
/** Every wrong rule number of a change, first problem per field, in the page's field order. */
export function memberPointsRuleProblems(value: unknown): readonly MemberPointsRuleProblem[] {
  const raw = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const problems: MemberPointsRuleProblem[] = [];
  for (const [field, minimum, maximum] of ruleLimits) {
    const number = raw[field];
    if (!Number.isSafeInteger(number)) problems.push({ field, rule: "WholeNumber", limit: null });
    else if ((number as number) < minimum)
      problems.push({ field, rule: "AtLeast", limit: minimum });
    else if ((number as number) > maximum) problems.push({ field, rule: "AtMost", limit: maximum });
    else if (
      field === "expiryNoticeDays" &&
      Number.isSafeInteger(raw.inactivityExpiryDays) &&
      (number as number) >= (raw.inactivityExpiryDays as number)
    )
      problems.push({ field, rule: "BelowExpiry", limit: raw.inactivityExpiryDays as number });
  }
  return Object.freeze(problems.map((problem) => Object.freeze(problem)));
}
/** A rule change with wrong numbers; `problems` names each one (WP-2423 M135). */
export class MemberPointsRuleInvalidError extends CustomerProfileError {
  constructor(readonly problems: readonly MemberPointsRuleProblem[]) {
    super("CUSTOMER_PROFILE_INVALID");
    this.name = "MemberPointsRuleInvalidError";
  }
}

export function parseMemberPointsRuleChange(value: unknown): Omit<MemberPointsRule, "version"> {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return fail();
  const problems = memberPointsRuleProblems(raw);
  if (problems.length > 0) throw new MemberPointsRuleInvalidError(problems);
  const inactivityExpiryDays = whole(raw.inactivityExpiryDays, 90, 3650);
  const rewards = raw.rewards;
  if (!Array.isArray(rewards) || rewards.length > 100) return fail();
  const seen = new Set<string>();
  return Object.freeze({
    earnPointsPerDollar: whole(raw.earnPointsPerDollar, 0, 100),
    redeemPointsPerDollar: whole(raw.redeemPointsPerDollar, 1, 10_000),
    minimumRedemptionPoints: whole(raw.minimumRedemptionPoints, 1, 1_000_000),
    redemptionIncrementPoints: whole(raw.redemptionIncrementPoints, 1, 1_000_000),
    inactivityExpiryDays,
    expiryNoticeDays: whole(raw.expiryNoticeDays, 7, Math.min(89, inactivityExpiryDays - 1)),
    rewards: Object.freeze(
      (rewards as readonly Record<string, unknown>[]).map((reward) => {
        const productReference = reward?.productReference;
        const displayName = reward?.displayName;
        if (
          typeof productReference !== "string" ||
          !/^[0-9a-f-]{36}$/u.test(productReference) ||
          seen.has(productReference) ||
          typeof displayName !== "string" ||
          displayName.length < 1 ||
          displayName.length > 120
        )
          return fail();
        seen.add(productReference);
        return Object.freeze({
          productReference,
          displayName,
          pointsCost: whole(reward.pointsCost, 1, 1_000_000),
        });
      }),
    ),
  });
}

/** What dishes paid for earns; a part-point is the guest's loss of nothing: rounded down at the bill. */
export function pointsForPaidDishes(paidDishesMinor: bigint, rule: MemberPointsRule): number {
  if (paidDishesMinor <= 0n) return 0;
  return Number((paidDishesMinor * BigInt(rule.earnPointsPerDollar)) / 100n);
}

/** The value of these points off the dishes, in cents; refused when they aren't a valid amount. */
export function redemptionValueMinor(points: number, rule: MemberPointsRule): bigint | null {
  if (
    !Number.isSafeInteger(points) ||
    points < rule.minimumRedemptionPoints ||
    (points - rule.minimumRedemptionPoints) % rule.redemptionIncrementPoints !== 0
  )
    return null;
  const cents = BigInt(points) * 100n;
  const per = BigInt(rule.redeemPointsPerDollar);
  return cents % per === 0n ? cents / per : null;
}

/** The most this balance can take off these dishes, on the rule's steps; 0 when below the minimum. */
export function largestRedemptionPoints(
  available: number,
  dishesMinor: bigint,
  rule: MemberPointsRule,
): number {
  const affordable = (dishesMinor * BigInt(rule.redeemPointsPerDollar)) / 100n;
  const most = affordable < BigInt(available) ? Number(affordable) : available;
  if (most < rule.minimumRedemptionPoints) return 0;
  const steps = Math.floor((most - rule.minimumRedemptionPoints) / rule.redemptionIncrementPoints);
  return rule.minimumRedemptionPoints + steps * rule.redemptionIncrementPoints;
}

/**
 * How many of these points follow a refund: its share of what was paid, rounded down (the guest
 * keeps the part-point), and all of them once everything has gone back.
 */
export function pointsForRefundedShare(
  points: number,
  refundedMinor: bigint,
  paidMinor: bigint,
): number {
  if (points <= 0 || refundedMinor <= 0n || paidMinor <= 0n) return 0;
  if (refundedMinor >= paidMinor) return points;
  return Number((BigInt(points) * refundedMinor) / paidMinor);
}

/** When these points expire if nothing happens: only inactivity counts, never a date alone. */
export function memberPointsExpireAt(lastActivityAt: string, rule: MemberPointsRule): string {
  return new Date(
    Date.parse(lastActivityAt) + rule.inactivityExpiryDays * 86_400_000,
  ).toISOString();
}

export type MemberExpiryStep = "None" | "SendNotice" | "Expire";
/**
 * The expiry sweep's decision. A notice goes out `expiryNoticeDays` before; points expire only once
 * a notice for this stretch of inactivity is at least that old, so a failed text delays the expiry
 * instead of surprising the guest.
 */
export function memberExpiryStep(input: {
  readonly lastActivityAt: string;
  readonly availablePoints: number;
  readonly noticeSentAt: string | null;
  readonly now: string;
  readonly rule: MemberPointsRule;
}): MemberExpiryStep {
  if (input.availablePoints <= 0) return "None";
  const due = Date.parse(memberPointsExpireAt(input.lastActivityAt, input.rule));
  const now = Date.parse(input.now);
  const lead = input.rule.expiryNoticeDays * 86_400_000;
  if (now < due - lead) return "None";
  if (input.noticeSentAt === null) return "SendNotice";
  return now >= due && now >= Date.parse(input.noticeSentAt) + lead ? "Expire" : "None";
}

/** A Canadian or US mobile number as +1 and ten digits, or null. Never logged. */
export function parseMemberPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  if (!/^[+\d\s().-]+$/u.test(value)) return null;
  const digits = value.replace(/\D/gu, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/u.test(national) ? "+1" + national : null;
}
