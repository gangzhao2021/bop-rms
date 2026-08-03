import { addMoney, createMoney, type Money } from "@rms/pricing";

import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";

export interface OrderPaymentPreparationEvidence {
  readonly preparationReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly sourceCartReference: OrderingReference;
  readonly sourceCartVersion: number;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
  readonly quoteReference: OrderingReference;
  readonly capacityAllocationReference: OrderingReference;
  readonly readiness: "PaymentPending";
  readonly transactionBoundary: "OrderSubmissionPaymentPreparation";
  readonly orderAllocation: Money;
  readonly tip: Money;
  readonly total: Money;
  readonly committedAt: OrderingInstant;
  readonly capacityExpiresAt: OrderingInstant;
  readonly sourceDigest: OrderingHash;
}

export class OrderPaymentPreparationError extends Error {
  readonly code = "ORDER_PAYMENT_PREPARATION_INVALID" as const;

  constructor() {
    super("order payment preparation evidence is invalid");
    this.name = "OrderPaymentPreparationError";
  }
}

function invalid(): never {
  throw new OrderPaymentPreparationError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderPaymentPreparationError) throw error;
    return invalid();
  }
}

function cadMoney(value: unknown, positive: boolean): Money {
  try {
    const money = createMoney(value as Money);
    if (
      money.currencyCode !== "CAD" ||
      (positive ? money.amountMinor <= 0n : money.amountMinor < 0n)
    )
      return invalid();
    return money;
  } catch {
    return invalid();
  }
}

export function parseOrderPaymentPreparationEvidence(
  value: unknown,
): OrderPaymentPreparationEvidence {
  const raw = exact(value, [
    "preparationReference",
    "orderReference",
    "orderBatchReference",
    "submissionReference",
    "sourceCartReference",
    "sourceCartVersion",
    "brandReference",
    "storeReference",
    "guestSessionReference",
    "quoteReference",
    "capacityAllocationReference",
    "readiness",
    "transactionBoundary",
    "orderAllocation",
    "tip",
    "total",
    "committedAt",
    "capacityExpiresAt",
    "sourceDigest",
  ]);
  if (
    raw.readiness !== "PaymentPending" ||
    raw.transactionBoundary !== "OrderSubmissionPaymentPreparation"
  )
    return invalid();
  try {
    const committedAt = parseOrderingInstant(raw.committedAt);
    const capacityExpiresAt = parseOrderingInstant(raw.capacityExpiresAt);
    if (Date.parse(capacityExpiresAt) <= Date.parse(committedAt)) return invalid();
    const orderAllocation = cadMoney(raw.orderAllocation, true);
    const tip = cadMoney(raw.tip, false);
    const total = cadMoney(raw.total, true);
    if (addMoney(orderAllocation, tip).amountMinor !== total.amountMinor) return invalid();
    if (!Number.isSafeInteger(raw.sourceCartVersion) || (raw.sourceCartVersion as number) < 1)
      return invalid();
    return Object.freeze({
      preparationReference: parseOrderingReference(raw.preparationReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      sourceCartReference: parseOrderingReference(raw.sourceCartReference),
      sourceCartVersion: raw.sourceCartVersion as number,
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      quoteReference: parseOrderingReference(raw.quoteReference),
      capacityAllocationReference: parseOrderingReference(raw.capacityAllocationReference),
      readiness: "PaymentPending",
      transactionBoundary: "OrderSubmissionPaymentPreparation",
      orderAllocation,
      tip,
      total,
      committedAt,
      capacityExpiresAt,
      sourceDigest: parseOrderingHash(raw.sourceDigest),
    });
  } catch (error) {
    if (error instanceof OrderPaymentPreparationError) throw error;
    return invalid();
  }
}
