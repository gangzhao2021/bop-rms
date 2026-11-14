import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningReference,
  type DiningInstant,
  type DiningReference,
} from "./dining-session.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26): when dine-in guests pay. "PayFirst": each round
 * is paid before it goes to the kitchen (the way it worked so far, and the default). "PayLater":
 * rounds go straight to the kitchen and the table pays once at the end. A table keeps the timing it
 * was opened with.
 */
export const diningPaymentTimings = ["PayFirst", "PayLater"] as const;
export type DiningPaymentTiming = (typeof diningPaymentTimings)[number];

export function parseDiningPaymentTiming(value: unknown): DiningPaymentTiming {
  if (value !== "PayFirst" && value !== "PayLater")
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  return value;
}

/** The Store's current choice; version 0 (and no author) while it never chose: PayFirst. */
export interface StoreDiningPaymentTiming {
  readonly paymentTiming: DiningPaymentTiming;
  readonly version: number;
  readonly changedAt: DiningInstant | null;
  readonly changedByActorReference: DiningReference | null;
}

export interface StoreDiningPaymentTimingCommand {
  readonly operationReference: DiningReference;
  readonly paymentTiming: DiningPaymentTiming;
  /** The version the staff member saw; a change made meanwhile is a conflict, never overwritten. */
  readonly expectedVersion: number;
  readonly actorReference: DiningReference;
  readonly observedAt: DiningInstant;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  return value as Record<string, unknown>;
}

export function parseStoreDiningPaymentTimingCommand(
  value: unknown,
): StoreDiningPaymentTimingCommand {
  const raw = exact(value, [
    "operationReference",
    "paymentTiming",
    "expectedVersion",
    "actorReference",
    "observedAt",
  ]);
  if (
    typeof raw.expectedVersion !== "number" ||
    !Number.isSafeInteger(raw.expectedVersion) ||
    raw.expectedVersion < 0
  )
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  return Object.freeze({
    operationReference: parseDiningReference(raw.operationReference),
    paymentTiming: parseDiningPaymentTiming(raw.paymentTiming),
    expectedVersion: raw.expectedVersion,
    actorReference: parseDiningReference(raw.actorReference),
    observedAt: parseDiningInstant(raw.observedAt),
  });
}

/** What the operation means, for its idempotency hash (a replay must mean the same change). */
export function storeDiningPaymentTimingIntent(command: StoreDiningPaymentTimingCommand): string {
  return `StoreDiningPaymentTiming:${command.paymentTiming}:${command.expectedVersion}:${command.actorReference}`;
}
