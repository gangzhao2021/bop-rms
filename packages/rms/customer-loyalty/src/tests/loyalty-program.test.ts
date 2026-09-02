import { describe, expect, it, vi } from "vitest";
import {
  createLoyaltyProgram,
  customerInstant,
  customerReference,
  executeLoyaltyProgram,
  publishLoyaltyProgramVersion,
  simulateLoyaltyLifecycle,
  validateLoyaltyProgramVersion,
  type LoyaltyProgramCommand,
  type LoyaltyProgramVersion,
} from "../index.js";
const id = (n: number) =>
  customerReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (hour: number) =>
  customerInstant(`2026-08-14T${String(hour).padStart(2, "0")}:00:00.000Z`);
const config = () => ({
  name: "Synthetic Rewards",
  pointsName: "Points",
  eligibilityCode: "OPEN",
  earnNumerator: 1,
  earnDenominatorMinor: 100,
  activationDelayDays: 0,
  minimumRedemptionPoints: 10,
  redemptionIncrementPoints: 10,
  expirationDays: 365,
  reservationTtlMinutes: 15,
  refundPolicy: "ReverseEarnedAndReturnRedeemed" as const,
  tiers: [
    { code: "BASE", threshold: 0, benefitReference: null },
    { code: "GOLD", threshold: 100, benefitReference: id(20) },
  ],
  rewards: [{ code: "REWARD", pointsCost: 50, benefitReference: id(21), usageLimit: 1 }],
  storeReferences: [id(30)],
  channels: ["Web" as const],
  orderTypes: ["Pickup" as const],
  effectiveFromUtc: at(8),
  effectiveToUtc: null,
  customerCopy: "Earn synthetic points on eligible spend.",
});
const program = () =>
  createLoyaltyProgram({
    programReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    programCode: "SYNTHETIC",
    versionReference: id(4),
    config: config(),
    actorReference: id(5),
    occurredAt: at(9),
  });
const command = (
  action: LoyaltyProgramCommand["action"],
  actor = id(5),
): LoyaltyProgramCommand => ({
  tenantReference: id(2),
  brandReference: id(3),
  actorReference: actor,
  purpose: "LoyaltyProgramAdministration",
  permission:
    action === "Publish" || action === "Schedule"
      ? "loyalty.program.approve"
      : "loyalty.program.edit",
  operationReference: id(action === "Validate" ? 41 : action === "Publish" ? 42 : 40),
  occurredAt: at(11),
  action,
  payload:
    action === "Create"
      ? {
          programReference: id(1),
          programCode: "SYNTHETIC",
          versionReference: id(4),
          config: config(),
        }
      : { programReference: id(1), expectedVersion: action === "Publish" ? 2 : 1 },
});
const ports = (loaded = program()) => ({
  authorization: {
    authorize: vi.fn(async () => ({
      authorized: true,
      mayViewRules: true,
      mayEdit: true,
      mayApprove: true,
    })),
  },
  validation: {
    validate: vi.fn(async () => ({
      valid: true,
      evidenceReference: id(50),
      simulation: simulateLoyaltyLifecycle(loaded.versions[0] as LoyaltyProgramVersion, {
        eligibleSpendMinor: 10000,
        captured: true,
        fulfilled: true,
        activationDelayElapsed: true,
        redeemPoints: 50,
        checkoutSucceeded: true,
        refund: false,
        expiryReached: false,
        qualificationValue: 120,
      }),
      pricingCalculatedMoney: false as const,
      pointsUsedAsTender: false as const,
      effectiveVersionConflict: false as const,
    })),
  },
  approval: {
    validate: vi.fn(async () => ({
      approved: true,
      approvalReference: id(51),
      approverReference: id(6),
    })),
  },
  repository: {
    load: vi.fn(async () => loaded),
    resolveOperation: vi.fn(async () => null),
    commit: vi.fn(async (record) => record),
  },
  projection: { query: vi.fn(async () => ({}) as never) },
  audit: { create: vi.fn(async () => ({}) as never) },
  references: {
    hashIntent: vi.fn(() => "digest"),
    equals: vi.fn((a: string, b: string) => a === b),
  },
});
describe("Loyalty Program", () => {
  it("creates an immutable Brand-scoped Draft version with exact integer rules", () => {
    expect(program()).toMatchObject({
      brandReference: id(3),
      lifecycle: "Draft",
      versions: [{ versionNumber: 1, earnDenominatorMinor: 100 }],
    });
  });
  it("simulates conservation without calculating money or using Points as tender", () => {
    const result = simulateLoyaltyLifecycle(program().versions[0] as LoyaltyProgramVersion, {
      eligibleSpendMinor: 10000,
      captured: true,
      fulfilled: true,
      activationDelayElapsed: true,
      redeemPoints: 50,
      checkoutSucceeded: true,
      refund: false,
      expiryReached: false,
      qualificationValue: 120,
    });
    expect(result).toMatchObject({
      earnedPending: 100,
      redeemed: 50,
      endingAvailable: 50,
      tierCode: "GOLD",
      pointsConserved: true,
      monetaryBenefitCalculated: false,
      paymentTenderUsed: false,
    });
  });
  it("fails closed when redemption breaks increments or available points", () => {
    expect(() =>
      simulateLoyaltyLifecycle(program().versions[0] as LoyaltyProgramVersion, {
        eligibleSpendMinor: 1000,
        captured: true,
        fulfilled: true,
        activationDelayElapsed: true,
        redeemPoints: 11,
        checkoutSucceeded: false,
        refund: false,
        expiryReached: false,
        qualificationValue: 0,
      }),
    ).toThrow();
  });
  it("does not activate before the configured activation delay evidence", () => {
    const result = simulateLoyaltyLifecycle(program().versions[0] as LoyaltyProgramVersion, {
      eligibleSpendMinor: 10000,
      captured: true,
      fulfilled: true,
      activationDelayElapsed: false,
      redeemPoints: 0,
      checkoutSucceeded: false,
      refund: false,
      expiryReached: false,
      qualificationValue: 0,
    });
    expect(result).toMatchObject({ earnedPending: 100, activatedAvailable: 0 });
  });
  it("models an insufficient refund reversal as Points Debt, not lost history", () => {
    const debtProgram = createLoyaltyProgram({
      programReference: id(60),
      tenantReference: id(2),
      brandReference: id(3),
      programCode: "DEBT",
      versionReference: id(61),
      config: { ...config(), refundPolicy: "ReverseEarned" },
      actorReference: id(5),
      occurredAt: at(9),
    });
    const result = simulateLoyaltyLifecycle(debtProgram.versions[0] as LoyaltyProgramVersion, {
      eligibleSpendMinor: 10000,
      captured: true,
      fulfilled: true,
      activationDelayElapsed: true,
      redeemPoints: 50,
      checkoutSucceeded: true,
      refund: true,
      expiryReached: false,
      qualificationValue: 0,
    });
    expect(result).toMatchObject({
      reversedEarned: 100,
      returnedRedeemed: 0,
      endingAvailable: 0,
      pointsDebt: 50,
    });
  });
  it("requires validation evidence before publish and a distinct Approver", () => {
    const validated = validateLoyaltyProgramVersion(program(), {
      expectedVersion: 1,
      evidenceReference: id(50),
      actorReference: id(5),
      occurredAt: at(10),
    });
    expect(() =>
      publishLoyaltyProgramVersion(validated, {
        expectedVersion: 2,
        approvalReference: id(51),
        approverReference: id(5),
        occurredAt: at(11),
        schedule: false,
      }),
    ).toThrow();
    expect(
      publishLoyaltyProgramVersion(validated, {
        expectedVersion: 2,
        approvalReference: id(51),
        approverReference: id(6),
        occurredAt: at(11),
        schedule: false,
      }).lifecycle,
    ).toBe("Published");
  });
  it("service rejects validation that delegates money or permits tender semantics", async () => {
    const dependencies = ports();
    dependencies.validation.validate.mockResolvedValue({
      ...(await dependencies.validation.validate()),
      pricingCalculatedMoney: true as never,
    });
    await expect(executeLoyaltyProgram(command("Validate"), dependencies)).rejects.toMatchObject({
      code: "CUSTOMER_PROFILE_PROOF_REQUIRED",
    });
  });
  it("publishes through validated approval evidence and idempotent commit", async () => {
    const validated = validateLoyaltyProgramVersion(program(), {
      expectedVersion: 1,
      evidenceReference: id(50),
      actorReference: id(5),
      occurredAt: at(10),
    });
    const dependencies = ports(validated);
    const result = await executeLoyaltyProgram(command("Publish", id(6)), dependencies);
    expect(result.after).toMatchObject({ lifecycle: "Published", aggregateVersion: 3 });
    expect(dependencies.audit.create).toHaveBeenCalledOnce();
  });
});
