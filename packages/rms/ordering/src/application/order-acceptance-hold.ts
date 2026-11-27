import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD). A paid online pickup order must normally be accepted
 * before its capacity expires (30 minutes after the payment request). When that deadline passes
 * while the Store is offline (no staff activity for more than five minutes), Ordering holds the
 * order instead of closing and refunding it. Once staff are back online the deadline becomes the
 * time the Store came back plus 15 minutes; a manager may also choose to refund at once.
 */
export const storeOfflineAfterMilliseconds = 5 * 60_000;
export const heldOrderDecisionMilliseconds = 15 * 60_000;

export type OrderAcceptanceHoldResolution = Readonly<{
  resolution: "StoreBackOnline" | "StaffRefund";
  storeBackOnlineAt: string | null;
  decideBy: string;
  actorReference: string | null;
  recordedAt: string;
}>;

export type OrderAcceptanceHold = Readonly<{
  holdReference: string;
  brandReference: string;
  storeReference: string;
  orderReference: string;
  orderBatchReference: string;
  paymentEventReference: string;
  sequence: number;
  lapsedDeadline: string;
  storeLastSeenAt: string | null;
  heldAt: string;
  resolutions: readonly OrderAcceptanceHoldResolution[];
}>;

/** Current acceptance deadline of one paid batch, derived only from recorded owner facts. */
export type OrderAcceptanceDeadline =
  | Readonly<{ kind: "Standard"; deadline: string }>
  | Readonly<{ kind: "Held"; hold: OrderAcceptanceHold }>
  | Readonly<{
      kind: "Extended";
      hold: OrderAcceptanceHold;
      deadline: string;
      /** The manager chose to refund; the order is closed at once and never held again. */
      refundChosen: boolean;
    }>;

export class OrderAcceptanceHoldError extends Error {
  constructor(readonly code: "ORDER_ACCEPTANCE_HOLD_UNAVAILABLE") {
    super(code);
    this.name = "OrderAcceptanceHoldError";
  }
}
const unavailable = (): never => {
  throw new OrderAcceptanceHoldError("ORDER_ACCEPTANCE_HOLD_UNAVAILABLE");
};

export function parseOrderAcceptanceHold(value: unknown): OrderAcceptanceHold {
  if (typeof value !== "object" || value === null) return unavailable();
  const raw = value as Record<string, unknown>;
  try {
    const sequence = raw.sequence;
    if (
      typeof sequence !== "number" ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > 1000
    )
      return unavailable();
    const lapsedDeadline = parseOrderingInstant(raw.lapsedDeadline);
    const storeLastSeenAt =
      raw.storeLastSeenAt === null ? null : parseOrderingInstant(raw.storeLastSeenAt);
    const heldAt = parseOrderingInstant(raw.heldAt);
    if (
      heldAt < lapsedDeadline ||
      (storeLastSeenAt !== null &&
        Date.parse(storeLastSeenAt) >= Date.parse(lapsedDeadline) - storeOfflineAfterMilliseconds)
    )
      return unavailable();
    if (!Array.isArray(raw.resolutions) || raw.resolutions.length > 2) return unavailable();
    const resolutions = raw.resolutions.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return unavailable();
      const r = entry as Record<string, unknown>;
      const recordedAt = parseOrderingInstant(r.recordedAt);
      const decideBy = parseOrderingInstant(r.decideBy);
      if (recordedAt < heldAt) return unavailable();
      if (r.resolution === "StoreBackOnline") {
        const back = parseOrderingInstant(r.storeBackOnlineAt);
        if (
          r.actorReference !== null ||
          back <= lapsedDeadline ||
          Date.parse(decideBy) !== Date.parse(back) + heldOrderDecisionMilliseconds
        )
          return unavailable();
        return Object.freeze({
          resolution: "StoreBackOnline" as const,
          storeBackOnlineAt: back as string,
          decideBy: decideBy as string,
          actorReference: null,
          recordedAt: recordedAt as string,
        });
      }
      if (r.resolution === "StaffRefund") {
        if (r.storeBackOnlineAt !== null || decideBy !== recordedAt) return unavailable();
        return Object.freeze({
          resolution: "StaffRefund" as const,
          storeBackOnlineAt: null,
          decideBy: decideBy as string,
          actorReference: parseOrderingReference(r.actorReference) as string,
          recordedAt: recordedAt as string,
        });
      }
      return unavailable();
    });
    if (new Set(resolutions.map((entry) => entry.resolution)).size !== resolutions.length)
      return unavailable();
    return Object.freeze({
      holdReference: parseOrderingReference(raw.holdReference) as string,
      brandReference: parseOrderingReference(raw.brandReference) as string,
      storeReference: parseOrderingReference(raw.storeReference) as string,
      orderReference: parseOrderingReference(raw.orderReference) as string,
      orderBatchReference: parseOrderingReference(raw.orderBatchReference) as string,
      paymentEventReference: parseOrderingReference(raw.paymentEventReference) as string,
      sequence,
      lapsedDeadline: lapsedDeadline as string,
      storeLastSeenAt: storeLastSeenAt as string | null,
      heldAt: heldAt as string,
      resolutions: Object.freeze(resolutions),
    });
  } catch (error) {
    if (error instanceof OrderAcceptanceHoldError) throw error;
    return unavailable();
  }
}

/**
 * The batch's current deadline: its capacity expiry, or the chain of holds recorded against it.
 * Every hold must continue exactly from the deadline before it; anything else is unavailable.
 */
export function resolveOrderAcceptanceDeadline(input: {
  capacityExpiresAt: string;
  holds: readonly unknown[];
}): OrderAcceptanceDeadline {
  let deadline: string = parseOrderingInstant(input.capacityExpiresAt);
  const holds = input.holds
    .map(parseOrderAcceptanceHold)
    .sort((left, right) => left.sequence - right.sequence);
  let current: OrderAcceptanceDeadline = Object.freeze({ kind: "Standard", deadline });
  for (const [index, hold] of holds.entries()) {
    if (
      hold.sequence !== index + 1 ||
      hold.lapsedDeadline !== deadline ||
      current.kind === "Held" ||
      (current.kind === "Extended" && current.refundChosen) ||
      (holds[0] !== undefined &&
        (hold.orderBatchReference !== holds[0].orderBatchReference ||
          hold.paymentEventReference !== holds[0].paymentEventReference))
    )
      return unavailable();
    if (hold.resolutions.length === 0) {
      current = Object.freeze({ kind: "Held", hold });
      continue;
    }
    deadline = hold.resolutions
      .map((entry) => entry.decideBy)
      .reduce((earliest, value) => (value < earliest ? value : earliest));
    current = Object.freeze({
      kind: "Extended",
      hold,
      deadline,
      refundChosen: hold.resolutions.some((entry) => entry.resolution === "StaffRefund"),
    });
  }
  return current;
}

/** The instant acceptance must happen before, or null while the order is held (no deadline). */
export function orderAcceptanceDeadlineInstant(value: OrderAcceptanceDeadline): string | null {
  return value.kind === "Held" ? null : value.deadline;
}

/**
 * What the System does for a paid, unaccepted pickup batch at `observedAt`, given the Store's
 * recorded staff activity. Pure: callers resolve presence facts from the Store's public read.
 */
export function decideOrderAcceptanceHold(input: {
  deadline: OrderAcceptanceDeadline;
  observedAt: string;
  /** Whether staff were online at the deadline instant (Store presence). */
  storeOnlineAtDeadline: boolean;
  /** Latest staff activity at or before the deadline (null: never). */
  storeLastSeenBeforeDeadline: string | null;
  /** First time staff came back online after the held deadline, if they have (Store presence). */
  storeBackOnlineAt: string | null;
}):
  | Readonly<{ action: "None" }>
  | Readonly<{
      action: "Hold";
      sequence: number;
      lapsedDeadline: string;
      storeLastSeenAt: string | null;
    }>
  | Readonly<{
      action: "Resume";
      hold: OrderAcceptanceHold;
      storeBackOnlineAt: string;
      decideBy: string;
    }> {
  const observedAt = parseOrderingInstant(input.observedAt);
  const deadline = input.deadline;
  if (deadline.kind === "Held") {
    const back = input.storeBackOnlineAt;
    if (back === null) return Object.freeze({ action: "None" });
    const backAt = parseOrderingInstant(back);
    if (backAt <= deadline.hold.lapsedDeadline || backAt > observedAt)
      return Object.freeze({ action: "None" });
    return Object.freeze({
      action: "Resume",
      hold: deadline.hold,
      storeBackOnlineAt: backAt as string,
      decideBy: new Date(Date.parse(backAt) + heldOrderDecisionMilliseconds).toISOString(),
    });
  }
  // Not yet due, already chosen for refund by a manager, or staff were online at the deadline:
  // the ordinary rule applies (the caller's disposition closes and refunds a lapsed order).
  if (
    observedAt < deadline.deadline ||
    (deadline.kind === "Extended" && deadline.refundChosen) ||
    input.storeOnlineAtDeadline
  )
    return Object.freeze({ action: "None" });
  const lastSeen =
    input.storeLastSeenBeforeDeadline === null
      ? null
      : parseOrderingInstant(input.storeLastSeenBeforeDeadline);
  if (
    lastSeen !== null &&
    Date.parse(lastSeen) >= Date.parse(deadline.deadline) - storeOfflineAfterMilliseconds
  )
    return unavailable();
  return Object.freeze({
    action: "Hold",
    sequence: deadline.kind === "Standard" ? 1 : deadline.hold.sequence + 1,
    lapsedDeadline: deadline.deadline,
    storeLastSeenAt: lastSeen as string | null,
  });
}
