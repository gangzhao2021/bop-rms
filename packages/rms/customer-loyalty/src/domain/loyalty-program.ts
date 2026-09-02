import {
  CustomerProfileError,
  customerInstant,
  customerReference,
  type CustomerInstant,
  type CustomerReference,
} from "./customer-profile.js";
export type LoyaltyProgramLifecycle =
  "Draft" | "Validated" | "Scheduled" | "Published" | "Suspended";
export interface LoyaltyTierRule {
  readonly code: string;
  readonly threshold: number;
  readonly benefitReference: CustomerReference | null;
}
export interface LoyaltyRewardRule {
  readonly code: string;
  readonly pointsCost: number;
  readonly benefitReference: CustomerReference;
  readonly usageLimit: number;
}
export interface LoyaltyProgramVersion {
  readonly versionReference: CustomerReference;
  readonly versionNumber: number;
  readonly lifecycle: LoyaltyProgramLifecycle;
  readonly name: string;
  readonly pointsName: string;
  readonly eligibilityCode: string;
  readonly earnNumerator: number;
  readonly earnDenominatorMinor: number;
  readonly activationDelayDays: number;
  readonly minimumRedemptionPoints: number;
  readonly redemptionIncrementPoints: number;
  readonly expirationDays: number;
  readonly reservationTtlMinutes: number;
  readonly refundPolicy: "ReverseEarned" | "ReverseEarnedAndReturnRedeemed";
  readonly tiers: readonly LoyaltyTierRule[];
  readonly rewards: readonly LoyaltyRewardRule[];
  readonly storeReferences: readonly CustomerReference[];
  readonly channels: readonly ("Web" | "Staff" | "Kiosk")[];
  readonly orderTypes: readonly ("Pickup" | "Delivery" | "DineIn")[];
  readonly effectiveFromUtc: CustomerInstant;
  readonly effectiveToUtc: CustomerInstant | null;
  readonly customerCopy: string;
  readonly createdBy: CustomerReference;
  readonly createdAt: CustomerInstant;
  readonly validationEvidenceReference: CustomerReference | null;
  readonly approvalReference: CustomerReference | null;
}
export interface LoyaltyProgram {
  readonly programReference: CustomerReference;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly programCode: string;
  readonly lifecycle: LoyaltyProgramLifecycle;
  readonly versions: readonly LoyaltyProgramVersion[];
  readonly aggregateVersion: number;
  readonly createdBy: CustomerReference;
  readonly createdAt: CustomerInstant;
  readonly updatedAt: CustomerInstant;
}
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fail();
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : fail();
const text = (value: unknown, maximum = 300) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length <= maximum &&
  /^[^\p{Cc}\p{Cf}<>{}$]{1,300}$/u.test(value)
    ? value
    : fail();
const uniqueRefs = (items: readonly unknown[]) => {
  if (!Array.isArray(items) || items.length > 100) fail();
  const values = items.map(customerReference);
  if (new Set(values).size !== values.length) fail();
  return Object.freeze(values);
};
const validateRules = (
  input: Omit<
    LoyaltyProgramVersion,
    | "versionReference"
    | "versionNumber"
    | "lifecycle"
    | "createdBy"
    | "createdAt"
    | "validationEvidenceReference"
    | "approvalReference"
  >,
) => {
  integer(input.earnNumerator, 0, 1_000_000);
  integer(input.earnDenominatorMinor, 1, 1_000_000_000);
  integer(input.activationDelayDays, 0, 3650);
  integer(input.minimumRedemptionPoints, 1);
  integer(input.redemptionIncrementPoints, 1);
  integer(input.expirationDays, 1, 36500);
  integer(input.reservationTtlMinutes, 1, 10080);
  if (
    input.reservationTtlMinutes > input.expirationDays * 1440 ||
    input.tiers.length > 20 ||
    input.rewards.length > 100
  )
    fail();
  let prior = -1;
  const tierCodes = new Set<string>();
  for (const tier of input.tiers) {
    const threshold = integer(tier.threshold);
    if (threshold <= prior || tierCodes.has(code(tier.code))) fail();
    prior = threshold;
    tierCodes.add(tier.code);
    if (tier.benefitReference !== null) customerReference(tier.benefitReference);
  }
  const rewardCodes = new Set<string>();
  for (const reward of input.rewards) {
    if (rewardCodes.has(code(reward.code))) fail();
    rewardCodes.add(reward.code);
    integer(reward.pointsCost, 1);
    integer(reward.usageLimit, 1);
    customerReference(reward.benefitReference);
  }
  if (
    input.effectiveToUtc !== null &&
    customerInstant(input.effectiveToUtc) <= customerInstant(input.effectiveFromUtc)
  )
    fail();
  if (!["ReverseEarned", "ReverseEarnedAndReturnRedeemed"].includes(input.refundPolicy)) fail();
  if (
    new Set(input.channels).size !== input.channels.length ||
    input.channels.some((v) => !["Web", "Staff", "Kiosk"].includes(v))
  )
    fail();
  if (
    new Set(input.orderTypes).size !== input.orderTypes.length ||
    input.orderTypes.some((v) => !["Pickup", "Delivery", "DineIn"].includes(v))
  )
    fail();
  uniqueRefs(input.storeReferences);
  text(input.name);
  text(input.pointsName, 60);
  code(input.eligibilityCode);
  text(input.customerCopy);
};
export function createLoyaltyProgram(input: {
  programReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  programCode: unknown;
  versionReference: unknown;
  config: Omit<
    LoyaltyProgramVersion,
    | "versionReference"
    | "versionNumber"
    | "lifecycle"
    | "createdBy"
    | "createdAt"
    | "validationEvidenceReference"
    | "approvalReference"
  >;
  actorReference: unknown;
  occurredAt: unknown;
}): LoyaltyProgram {
  validateRules(input.config);
  const occurredAt = customerInstant(input.occurredAt);
  const actor = customerReference(input.actorReference);
  const version = Object.freeze({
    ...input.config,
    versionReference: customerReference(input.versionReference),
    versionNumber: 1,
    lifecycle: "Draft" as const,
    storeReferences: uniqueRefs(input.config.storeReferences),
    tiers: Object.freeze(input.config.tiers.map((item) => Object.freeze(item))),
    rewards: Object.freeze(input.config.rewards.map((item) => Object.freeze(item))),
    channels: Object.freeze([...input.config.channels]),
    orderTypes: Object.freeze([...input.config.orderTypes]),
    createdBy: actor,
    createdAt: occurredAt,
    validationEvidenceReference: null,
    approvalReference: null,
  });
  return Object.freeze({
    programReference: customerReference(input.programReference),
    tenantReference: customerReference(input.tenantReference),
    brandReference: customerReference(input.brandReference),
    programCode: code(input.programCode),
    lifecycle: "Draft",
    versions: Object.freeze([version]),
    aggregateVersion: 1,
    createdBy: actor,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
export function appendLoyaltyProgramVersion(
  program: LoyaltyProgram,
  input: {
    expectedVersion: number;
    versionReference: unknown;
    config: Omit<
      LoyaltyProgramVersion,
      | "versionReference"
      | "versionNumber"
      | "lifecycle"
      | "createdBy"
      | "createdAt"
      | "validationEvidenceReference"
      | "approvalReference"
    >;
    actorReference: unknown;
    occurredAt: unknown;
  },
): LoyaltyProgram {
  if (
    program.aggregateVersion !== input.expectedVersion ||
    program.versions.at(-1)?.lifecycle === "Draft"
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  validateRules(input.config);
  const next = createLoyaltyProgram({
    programReference: program.programReference,
    tenantReference: program.tenantReference,
    brandReference: program.brandReference,
    programCode: program.programCode,
    versionReference: input.versionReference,
    config: input.config,
    actorReference: input.actorReference,
    occurredAt: input.occurredAt,
  }).versions[0] as LoyaltyProgramVersion;
  return Object.freeze({
    ...program,
    lifecycle: "Draft",
    versions: Object.freeze([
      ...program.versions,
      Object.freeze({ ...next, versionNumber: program.versions.length + 1 }),
    ]),
    aggregateVersion: program.aggregateVersion + 1,
    updatedAt: next.createdAt,
  });
}
export interface LoyaltyLifecycleSimulation {
  readonly earnedPending: number;
  readonly activatedAvailable: number;
  readonly reserved: number;
  readonly redeemed: number;
  readonly released: number;
  readonly reversedEarned: number;
  readonly returnedRedeemed: number;
  readonly expired: number;
  readonly endingAvailable: number;
  readonly pointsDebt: number;
  readonly tierCode: string | null;
  readonly rewardCodes: readonly string[];
  readonly pointsConserved: true;
  readonly monetaryBenefitCalculated: false;
  readonly paymentTenderUsed: false;
}
export function simulateLoyaltyLifecycle(
  version: LoyaltyProgramVersion,
  input: {
    eligibleSpendMinor: unknown;
    captured: boolean;
    fulfilled: boolean;
    activationDelayElapsed: boolean;
    redeemPoints: unknown;
    checkoutSucceeded: boolean;
    refund: boolean;
    expiryReached: boolean;
    qualificationValue: unknown;
  },
): LoyaltyLifecycleSimulation {
  const spend = integer(input.eligibleSpendMinor);
  const requested = integer(input.redeemPoints);
  const qualification = integer(input.qualificationValue);
  if (
    requested !== 0 &&
    (requested < version.minimumRedemptionPoints ||
      requested % version.redemptionIncrementPoints !== 0)
  )
    fail();
  const earnProduct = spend * version.earnNumerator;
  if (!Number.isSafeInteger(earnProduct)) fail();
  const earnedPending = input.captured ? Math.floor(earnProduct / version.earnDenominatorMinor) : 0;
  if (!Number.isSafeInteger(earnedPending)) fail();
  const activated = input.fulfilled && input.activationDelayElapsed ? earnedPending : 0;
  if (requested > activated) fail();
  const redeemed = input.checkoutSucceeded ? requested : 0;
  const released = input.checkoutSucceeded ? 0 : requested;
  const reversedEarned = input.refund ? earnedPending : 0;
  const returnedRedeemed =
    input.refund && version.refundPolicy === "ReverseEarnedAndReturnRedeemed" ? redeemed : 0;
  const netAvailable = activated - redeemed - reversedEarned + returnedRedeemed;
  const pointsDebt = Math.max(0, -netAvailable);
  const beforeExpiry = Math.max(0, netAvailable);
  const expired = input.expiryReached ? beforeExpiry : 0;
  const tierCode =
    [...version.tiers].reverse().find((tier) => qualification >= tier.threshold)?.code ?? null;
  return Object.freeze({
    earnedPending,
    activatedAvailable: activated,
    reserved: requested,
    redeemed,
    released,
    reversedEarned,
    returnedRedeemed,
    expired,
    endingAvailable: beforeExpiry - expired,
    pointsDebt,
    tierCode,
    rewardCodes: Object.freeze(
      version.rewards
        .filter((reward) => activated >= reward.pointsCost)
        .map((reward) => reward.code),
    ),
    pointsConserved: true,
    monetaryBenefitCalculated: false,
    paymentTenderUsed: false,
  });
}
export function validateLoyaltyProgramVersion(
  program: LoyaltyProgram,
  input: {
    expectedVersion: number;
    evidenceReference: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): LoyaltyProgram {
  if (program.aggregateVersion !== input.expectedVersion) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const current = program.versions.at(-1);
  if (!current || current.lifecycle !== "Draft") fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const draft = current as LoyaltyProgramVersion;
  const updated: LoyaltyProgramVersion = Object.freeze({
    ...draft,
    lifecycle: "Validated" as const,
    validationEvidenceReference: customerReference(input.evidenceReference),
  });
  return Object.freeze({
    ...program,
    lifecycle: "Validated",
    versions: Object.freeze([...program.versions.slice(0, -1), updated]),
    aggregateVersion: program.aggregateVersion + 1,
    updatedAt: customerInstant(input.occurredAt),
  });
}
export function publishLoyaltyProgramVersion(
  program: LoyaltyProgram,
  input: {
    expectedVersion: number;
    approvalReference: unknown;
    approverReference: unknown;
    occurredAt: unknown;
    schedule: boolean;
  },
): LoyaltyProgram {
  if (program.aggregateVersion !== input.expectedVersion) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const current = program.versions.at(-1);
  const approver = customerReference(input.approverReference);
  if (!current || current.lifecycle !== "Validated" || current.createdBy === approver)
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const validated = current as LoyaltyProgramVersion;
  const lifecycle = input.schedule ? ("Scheduled" as const) : ("Published" as const);
  const updated: LoyaltyProgramVersion = Object.freeze({
    ...validated,
    lifecycle,
    approvalReference: customerReference(input.approvalReference),
  });
  return Object.freeze({
    ...program,
    lifecycle,
    versions: Object.freeze([...program.versions.slice(0, -1), updated]),
    aggregateVersion: program.aggregateVersion + 1,
    updatedAt: customerInstant(input.occurredAt),
  });
}
