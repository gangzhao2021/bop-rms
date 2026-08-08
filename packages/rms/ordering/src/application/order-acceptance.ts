import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";

export interface OrderAcceptanceEvidence {
  readonly acceptanceReference: OrderingReference;
  readonly checkpointReference: OrderingReference;
  readonly sourceVersion: number;
  readonly sourceDigest: OrderingHash;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly paymentAttemptReference: OrderingReference;
  readonly phase: "Accepted";
  readonly acceptanceKind: "TerminalAuthorization";
  readonly acceptedAt: OrderingInstant;
}

export class OrderAcceptanceError extends Error {
  readonly code = "ORDER_ACCEPTANCE_INVALID" as const;

  constructor() {
    super("order acceptance evidence is invalid");
    this.name = "OrderAcceptanceError";
  }
}

function invalid(): never {
  throw new OrderAcceptanceError();
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
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof OrderAcceptanceError) throw error;
    return invalid();
  }
}

export function parseOrderAcceptanceEvidence(value: unknown): OrderAcceptanceEvidence {
  const raw = exact(value, [
    "acceptanceReference",
    "checkpointReference",
    "sourceVersion",
    "sourceDigest",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "paymentAttemptReference",
    "phase",
    "acceptanceKind",
    "acceptedAt",
  ]);
  if (
    raw.phase !== "Accepted" ||
    raw.acceptanceKind !== "TerminalAuthorization" ||
    !Number.isSafeInteger(raw.sourceVersion) ||
    (raw.sourceVersion as number) < 1
  )
    return invalid();
  try {
    return Object.freeze({
      acceptanceReference: parseOrderingReference(raw.acceptanceReference),
      checkpointReference: parseOrderingReference(raw.checkpointReference),
      sourceVersion: raw.sourceVersion as number,
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      paymentAttemptReference: parseOrderingReference(raw.paymentAttemptReference),
      phase: "Accepted",
      acceptanceKind: "TerminalAuthorization",
      acceptedAt: parseOrderingInstant(raw.acceptedAt),
    });
  } catch (error) {
    if (error instanceof OrderAcceptanceError) throw error;
    return invalid();
  }
}
