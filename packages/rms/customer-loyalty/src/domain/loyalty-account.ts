import {
  CustomerProfileError,
  customerInstant,
  customerReference,
  type CustomerInstant,
  type CustomerReference,
} from "./customer-profile.js";
export type LoyaltyAccountStatus = "Pending" | "Active" | "Suspended" | "Closed";
export type PointsTransactionType =
  "Earn" | "Activate" | "Reserve" | "Release" | "Redeem" | "Reverse" | "Adjust" | "Expire";
export interface PointsReservationSummary {
  readonly reservationReference: CustomerReference;
  readonly redemptionRequestReference: CustomerReference;
  readonly targetReference: CustomerReference;
  readonly points: number;
  readonly expiresAt: CustomerInstant;
  readonly status: "Reserved" | "Released" | "Redeemed";
}
export interface LoyaltyAccount {
  readonly accountReference: CustomerReference;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly customerProfileReference: CustomerReference;
  readonly programReference: CustomerReference;
  readonly programVersionReference: CustomerReference;
  readonly status: LoyaltyAccountStatus;
  readonly tierCode: string | null;
  readonly pendingPoints: number;
  readonly availablePoints: number;
  readonly reservedPoints: number;
  readonly lifetimeEarnedPoints: number;
  readonly pointsDebt: number;
  readonly expiringPoints: number;
  readonly reservations: readonly PointsReservationSummary[];
  readonly aggregateVersion: number;
  readonly createdAt: CustomerInstant;
  readonly updatedAt: CustomerInstant;
}
export interface PointsTransaction {
  readonly transactionReference: CustomerReference;
  readonly accountReference: CustomerReference;
  readonly type: PointsTransactionType;
  readonly points: number;
  readonly sourceType:
    "Order" | "Payment" | "Refund" | "Reservation" | "ExpiryJob" | "AuthorizedCorrection";
  readonly sourceReference: CustomerReference;
  readonly programVersionReference: CustomerReference;
  readonly ruleVersionReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly effectiveAt: CustomerInstant;
  readonly expiryAt: CustomerInstant | null;
  readonly idempotencyReference: CustomerReference;
  readonly originalTransactionReference: CustomerReference | null;
  readonly reservationReference: CustomerReference | null;
  readonly actorReference: CustomerReference;
  readonly reasonCode: string;
  readonly historicalSourceMutated: false;
}
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const integer = (v: unknown, min = 0) =>
  Number.isSafeInteger(v) && (v as number) >= min ? (v as number) : fail();
const code = (v: unknown) =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(v) ? v : fail();
export function createLoyaltyAccount(input: {
  accountReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  customerProfileReference: unknown;
  programReference: unknown;
  programVersionReference: unknown;
  actorReference: unknown;
  occurredAt: unknown;
}): LoyaltyAccount {
  const occurredAt = customerInstant(input.occurredAt);
  customerReference(input.actorReference);
  return Object.freeze({
    accountReference: customerReference(input.accountReference),
    tenantReference: customerReference(input.tenantReference),
    brandReference: customerReference(input.brandReference),
    customerProfileReference: customerReference(input.customerProfileReference),
    programReference: customerReference(input.programReference),
    programVersionReference: customerReference(input.programVersionReference),
    status: "Pending",
    tierCode: null,
    pendingPoints: 0,
    availablePoints: 0,
    reservedPoints: 0,
    lifetimeEarnedPoints: 0,
    pointsDebt: 0,
    expiringPoints: 0,
    reservations: Object.freeze([]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
const evolve = (
  account: LoyaltyAccount,
  patch: Partial<LoyaltyAccount>,
  occurredAt: unknown,
): LoyaltyAccount =>
  Object.freeze({
    ...account,
    ...patch,
    aggregateVersion: account.aggregateVersion + 1,
    updatedAt: customerInstant(occurredAt),
  });
export function transitionLoyaltyAccount(
  account: LoyaltyAccount,
  input: {
    expectedVersion: number;
    targetStatus: LoyaltyAccountStatus;
    actorReference: unknown;
    reasonCode: unknown;
    occurredAt: unknown;
  },
): LoyaltyAccount {
  if (account.aggregateVersion !== input.expectedVersion) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  customerReference(input.actorReference);
  if (customerInstant(input.occurredAt) < account.updatedAt)
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  code(input.reasonCode);
  const allowed: Record<LoyaltyAccountStatus, readonly LoyaltyAccountStatus[]> = {
    Pending: ["Active", "Closed"],
    Active: ["Suspended", "Closed"],
    Suspended: ["Active", "Closed"],
    Closed: [],
  };
  if (
    !allowed[account.status].includes(input.targetStatus) ||
    (input.targetStatus === "Closed" && account.reservations.some((v) => v.status === "Reserved"))
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  return evolve(account, { status: input.targetStatus }, input.occurredAt);
}
export interface PointsOperationInput {
  readonly expectedVersion: number;
  readonly transactionReference: unknown;
  readonly type: PointsTransactionType;
  readonly points: unknown;
  readonly sourceType: PointsTransaction["sourceType"];
  readonly sourceReference: unknown;
  readonly ruleVersionReference: unknown;
  readonly occurredAt: unknown;
  readonly effectiveAt: unknown;
  readonly expiryAt: unknown;
  readonly idempotencyReference: unknown;
  readonly originalTransactionReference: unknown;
  readonly reservationReference: unknown;
  readonly redemptionRequestReference: unknown;
  readonly targetReference: unknown;
  readonly actorReference: unknown;
  readonly reasonCode: unknown;
}
export function applyPointsOperation(
  account: LoyaltyAccount,
  input: PointsOperationInput,
): { account: LoyaltyAccount; transaction: PointsTransaction } {
  if (account.aggregateVersion !== input.expectedVersion || account.status !== "Active")
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const points = integer(input.points, 1),
    occurredAt = customerInstant(input.occurredAt),
    effectiveAt = customerInstant(input.effectiveAt);
  if (effectiveAt < occurredAt || occurredAt < account.updatedAt) fail();
  const original =
    input.originalTransactionReference === null
      ? null
      : customerReference(input.originalTransactionReference);
  const reservationReference =
    input.reservationReference === null ? null : customerReference(input.reservationReference);
  let pending = account.pendingPoints,
    available = account.availablePoints,
    reserved = account.reservedPoints,
    lifetime = account.lifetimeEarnedPoints,
    debt = account.pointsDebt,
    expiring = account.expiringPoints;
  const reservations = [...account.reservations];
  if (input.type === "Earn") {
    pending += points;
    lifetime += points;
  } else if (input.type === "Activate") {
    if (!original || points > pending) fail();
    pending -= points;
    const paid = Math.min(points, debt);
    debt -= paid;
    available += points - paid;
  } else if (input.type === "Reserve") {
    if (
      reservationReference === null ||
      input.redemptionRequestReference === null ||
      input.targetReference === null ||
      input.expiryAt === null ||
      points > available ||
      reservations.length >= 100 ||
      reservations.some(
        (r) =>
          r.redemptionRequestReference === input.redemptionRequestReference ||
          r.reservationReference === reservationReference,
      )
    )
      fail();
    const expiryAt = customerInstant(input.expiryAt);
    if (expiryAt <= occurredAt) fail();
    const reservedReference = reservationReference as CustomerReference;
    available -= points;
    reserved += points;
    reservations.push(
      Object.freeze({
        reservationReference: reservedReference,
        redemptionRequestReference: customerReference(input.redemptionRequestReference),
        targetReference: customerReference(input.targetReference),
        points,
        expiresAt: expiryAt,
        status: "Reserved",
      }),
    );
  } else if (input.type === "Release" || input.type === "Redeem") {
    if (reservationReference === null) fail();
    const index = reservations.findIndex(
      (r) => r.reservationReference === reservationReference && r.status === "Reserved",
    );
    const current = reservations[index];
    if (!current || current.points !== points) fail();
    const activeReservation = current as PointsReservationSummary;
    reserved -= points;
    if (input.type === "Release") {
      if (activeReservation.expiresAt <= occurredAt) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
      available += points;
    }
    reservations[index] = Object.freeze({
      ...activeReservation,
      status: input.type === "Release" ? "Released" : "Redeemed",
    });
  } else if (input.type === "Reverse") {
    if (!original) fail();
    if (points <= pending) pending -= points;
    else {
      const remainder = points - pending;
      pending = 0;
      const removed = Math.min(available, remainder);
      available -= removed;
      debt += remainder - removed;
    }
  } else if (input.type === "Adjust") {
    if (!original || input.sourceType !== "AuthorizedCorrection") fail();
    const paid = Math.min(points, debt);
    debt -= paid;
    available += points - paid;
  } else if (input.type === "Expire") {
    if (!original) fail();
    if (reservationReference !== null) {
      const index = reservations.findIndex(
        (item) => item.reservationReference === reservationReference && item.status === "Reserved",
      );
      const current = reservations[index];
      if (!current || current.points !== points || current.expiresAt > occurredAt) fail();
      const expiredReservation = current as PointsReservationSummary;
      reserved -= points;
      reservations[index] = Object.freeze({ ...expiredReservation, status: "Released" });
    } else {
      if (points > available) fail();
      available -= points;
      expiring = Math.max(0, expiring - points);
    }
  } else fail();
  for (const value of [pending, available, reserved, lifetime, debt, expiring])
    if (!Number.isSafeInteger(value) || value < 0) fail();
  const transaction = Object.freeze({
    transactionReference: customerReference(input.transactionReference),
    accountReference: account.accountReference,
    type: input.type,
    points,
    sourceType: input.sourceType,
    sourceReference: customerReference(input.sourceReference),
    programVersionReference: account.programVersionReference,
    ruleVersionReference: customerReference(input.ruleVersionReference),
    occurredAt,
    effectiveAt,
    expiryAt: input.expiryAt === null ? null : customerInstant(input.expiryAt),
    idempotencyReference: customerReference(input.idempotencyReference),
    originalTransactionReference: original,
    reservationReference,
    actorReference: customerReference(input.actorReference),
    reasonCode: code(input.reasonCode),
    historicalSourceMutated: false as const,
  });
  return Object.freeze({
    account: evolve(
      account,
      {
        pendingPoints: pending,
        availablePoints: available,
        reservedPoints: reserved,
        lifetimeEarnedPoints: lifetime,
        pointsDebt: debt,
        expiringPoints: expiring,
        reservations: Object.freeze(reservations.slice(-100)),
      },
      occurredAt,
    ),
    transaction,
  });
}

export type PointsExceptionType =
  "DuplicateEarn" | "FailedEarn" | "RefundReversal" | "ExpiredReservation" | "NegativeMismatch";
export interface PointsException {
  readonly exceptionReference: CustomerReference;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly accountReference: CustomerReference;
  readonly sourceReference: CustomerReference;
  readonly type: PointsExceptionType;
  readonly status: "Open" | "Acknowledged" | "Resolved";
  readonly ownerReference: CustomerReference | null;
  readonly dueAt: CustomerInstant;
  readonly correctionTransactionReference: CustomerReference | null;
  readonly aggregateVersion: number;
  readonly createdAt: CustomerInstant;
  readonly updatedAt: CustomerInstant;
}
export function createPointsException(input: {
  exceptionReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  accountReference: unknown;
  sourceReference: unknown;
  type: PointsExceptionType;
  dueAt: unknown;
  occurredAt: unknown;
}): PointsException {
  if (
    ![
      "DuplicateEarn",
      "FailedEarn",
      "RefundReversal",
      "ExpiredReservation",
      "NegativeMismatch",
    ].includes(input.type)
  )
    fail();
  const occurredAt = customerInstant(input.occurredAt),
    dueAt = customerInstant(input.dueAt);
  if (dueAt <= occurredAt) fail();
  return Object.freeze({
    exceptionReference: customerReference(input.exceptionReference),
    tenantReference: customerReference(input.tenantReference),
    brandReference: customerReference(input.brandReference),
    accountReference: customerReference(input.accountReference),
    sourceReference: customerReference(input.sourceReference),
    type: input.type,
    status: "Open",
    ownerReference: null,
    dueAt,
    correctionTransactionReference: null,
    aggregateVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}
export function acknowledgePointsException(
  exception: PointsException,
  input: { expectedVersion: number; ownerReference: unknown; occurredAt: unknown },
): PointsException {
  if (exception.aggregateVersion !== input.expectedVersion || exception.status !== "Open")
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  return Object.freeze({
    ...exception,
    status: "Acknowledged",
    ownerReference: customerReference(input.ownerReference),
    aggregateVersion: exception.aggregateVersion + 1,
    updatedAt: customerInstant(input.occurredAt),
  });
}
export function resolvePointsException(
  exception: PointsException,
  input: {
    expectedVersion: number;
    correctionTransactionReference: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): PointsException {
  if (
    exception.aggregateVersion !== input.expectedVersion ||
    exception.status !== "Acknowledged" ||
    exception.ownerReference !== customerReference(input.actorReference)
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  return Object.freeze({
    ...exception,
    status: "Resolved",
    correctionTransactionReference: customerReference(input.correctionTransactionReference),
    aggregateVersion: exception.aggregateVersion + 1,
    updatedAt: customerInstant(input.occurredAt),
  });
}
