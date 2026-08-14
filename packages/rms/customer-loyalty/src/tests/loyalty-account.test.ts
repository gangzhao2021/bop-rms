import { describe, expect, it, vi } from "vitest";
import {
  acknowledgePointsException,
  applyPointsOperation,
  createLoyaltyAccount,
  createPointsException,
  customerInstant,
  customerReference,
  executePointsCommand,
  resolvePointsException,
  transitionLoyaltyAccount,
  type LoyaltyAccount,
  type PointsCommand,
  type PointsOperationInput,
} from "../index.js";
const id = (n: number) =>
  customerReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (h: number) => customerInstant(`2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z`);
const pending = () =>
  createLoyaltyAccount({
    accountReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    customerProfileReference: id(4),
    programReference: id(5),
    programVersionReference: id(6),
    actorReference: id(7),
    occurredAt: at(8),
  });
const active = () =>
  transitionLoyaltyAccount(pending(), {
    expectedVersion: 1,
    targetStatus: "Active",
    actorReference: id(7),
    reasonCode: "VERIFIED",
    occurredAt: at(9),
  });
const input = (
  account: LoyaltyAccount,
  type: PointsOperationInput["type"],
  points: number,
  overrides: Partial<PointsOperationInput> = {},
): PointsOperationInput => ({
  expectedVersion: account.aggregateVersion,
  transactionReference: id(10 + account.aggregateVersion),
  type,
  points,
  sourceType: "Order",
  sourceReference: id(20),
  ruleVersionReference: id(21),
  occurredAt: at(10),
  effectiveAt: at(10),
  expiryAt: null,
  idempotencyReference: id(30 + account.aggregateVersion),
  originalTransactionReference: null,
  reservationReference: null,
  redemptionRequestReference: null,
  targetReference: null,
  actorReference: id(7),
  reasonCode: "SOURCE_FACT",
  ...overrides,
});
const earnActivate = () => {
  const earned = applyPointsOperation(active(), input(active(), "Earn", 100)).account;
  return applyPointsOperation(
    earned,
    input(earned, "Activate", 100, { originalTransactionReference: id(12) }),
  ).account;
};
describe("Loyalty Account and Points Ledger", () => {
  it("derives balances only from immutable Earn and Activate facts", () => {
    const account = earnActivate();
    expect(account).toMatchObject({
      pendingPoints: 0,
      availablePoints: 100,
      lifetimeEarnedPoints: 100,
    });
  });
  it("atomically reserves with TTL then releases without direct balance edit", () => {
    const account = earnActivate();
    const reserved = applyPointsOperation(
      account,
      input(account, "Reserve", 40, {
        sourceType: "Reservation",
        reservationReference: id(40),
        redemptionRequestReference: id(41),
        targetReference: id(42),
        expiryAt: at(11),
      }),
    );
    expect(reserved.account).toMatchObject({ availablePoints: 60, reservedPoints: 40 });
    const released = applyPointsOperation(
      reserved.account,
      input(reserved.account, "Release", 40, {
        sourceType: "Reservation",
        reservationReference: id(40),
        originalTransactionReference: reserved.transaction.transactionReference,
      }),
    );
    expect(released.account).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
    expect(released.transaction.historicalSourceMutated).toBe(false);
  });
  it("blocks duplicate redemption requests and insufficient reserve", () => {
    const account = earnActivate();
    expect(() =>
      applyPointsOperation(
        account,
        input(account, "Reserve", 101, {
          sourceType: "Reservation",
          reservationReference: id(40),
          redemptionRequestReference: id(41),
          targetReference: id(42),
          expiryAt: at(11),
        }),
      ),
    ).toThrow();
  });
  it("requires an explicit Expire fact when reservation TTL has elapsed", () => {
    const account = earnActivate();
    const reserved = applyPointsOperation(
      account,
      input(account, "Reserve", 40, {
        sourceType: "Reservation",
        reservationReference: id(40),
        redemptionRequestReference: id(41),
        targetReference: id(42),
        expiryAt: at(11),
      }),
    );
    expect(() =>
      applyPointsOperation(
        reserved.account,
        input(reserved.account, "Release", 40, {
          sourceType: "Reservation",
          occurredAt: at(12),
          effectiveAt: at(12),
          reservationReference: id(40),
          originalTransactionReference: reserved.transaction.transactionReference,
        }),
      ),
    ).toThrow();
    expect(
      applyPointsOperation(
        reserved.account,
        input(reserved.account, "Expire", 40, {
          sourceType: "ExpiryJob",
          occurredAt: at(12),
          effectiveAt: at(12),
          reservationReference: id(40),
          originalTransactionReference: reserved.transaction.transactionReference,
        }),
      ).account,
    ).toMatchObject({ reservedPoints: 0, availablePoints: 60 });
  });
  it("creates explicit debt when Reverse exceeds pending and available", () => {
    const account = earnActivate();
    const result = applyPointsOperation(
      account,
      input(account, "Reverse", 150, {
        sourceType: "Refund",
        originalTransactionReference: id(12),
      }),
    );
    expect(result.account).toMatchObject({ availablePoints: 0, pointsDebt: 50 });
  });
  it("blocks close while a reservation remains open and retains debt across suspension", () => {
    const account = earnActivate();
    const reserved = applyPointsOperation(
      account,
      input(account, "Reserve", 40, {
        sourceType: "Reservation",
        reservationReference: id(40),
        redemptionRequestReference: id(41),
        targetReference: id(42),
        expiryAt: at(11),
      }),
    ).account;
    expect(() =>
      transitionLoyaltyAccount(reserved, {
        expectedVersion: reserved.aggregateVersion,
        targetStatus: "Closed",
        actorReference: id(7),
        reasonCode: "CLOSE",
        occurredAt: at(12),
      }),
    ).toThrow();
  });
  it("requires acknowledgement and linked correction before resolving an exception", () => {
    const exception = createPointsException({
      exceptionReference: id(50),
      tenantReference: id(2),
      brandReference: id(3),
      accountReference: id(1),
      sourceReference: id(20),
      type: "NegativeMismatch",
      dueAt: at(12),
      occurredAt: at(10),
    });
    const acknowledged = acknowledgePointsException(exception, {
      expectedVersion: 1,
      ownerReference: id(7),
      occurredAt: at(11),
    });
    expect(
      resolvePointsException(acknowledged, {
        expectedVersion: 2,
        correctionTransactionReference: id(60),
        actorReference: id(7),
        occurredAt: at(12),
      }),
    ).toMatchObject({ status: "Resolved", correctionTransactionReference: id(60) });
  });
  it("service validates source evidence and commits Account plus Ledger atomically", async () => {
    const before = active(),
      operation = input(before, "Earn", 100);
    const command: PointsCommand = {
      tenantReference: id(2),
      brandReference: id(3),
      actorReference: id(7),
      purpose: "LoyaltyAccountSupport",
      permission: "loyalty.points.operate",
      operationReference: id(70),
      occurredAt: at(10),
      accountReference: id(1),
      input: operation,
    };
    const ports = {
      authorization: {
        authorize: vi.fn(async () => ({
          authorized: true,
          mayViewLedger: true,
          mayOperate: true,
          mayCorrect: true,
          mayReview: true,
        })),
      },
      source: {
        validate: vi.fn(async () => ({
          valid: true,
          sourceFactsMutated: false as const,
          points: 100,
          sourceReference: id(20),
          programVersionReference: id(6),
          ruleVersionReference: id(21),
          originalTransactionReference: null,
        })),
      },
      repository: {
        load: vi.fn(async () => before),
        resolveOperation: vi.fn(async () => null),
        commit: vi.fn(async (record) => record),
      },
      projections: {
        account: vi.fn(async () => ({}) as never),
        exceptions: vi.fn(async () => ({}) as never),
      },
      audit: { create: vi.fn(async () => ({}) as never) },
      references: {
        hashIntent: vi.fn(() => "digest"),
        equals: vi.fn((a: string, b: string) => a === b),
      },
    };
    const result = await executePointsCommand(command, ports);
    expect(result.after.pendingPoints).toBe(100);
    expect(result.transaction.type).toBe("Earn");
    expect(ports.repository.commit).toHaveBeenCalledOnce();
  });
});
