/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: when a paid order goes straight to the kitchen without anyone
 * pressing Accept. Every condition that fails leaves the order to a person, on the path it has
 * today (Accept or refuse, its deadline, the outage hold). The first condition that fails is the
 * one staff are told.
 */

/** A batch paid this long ago is left to a person: table rounds have no deadline of their own. */
export const orderAutoAcceptancePaidWindowMs = 30 * 60_000;
/** More items than this in one batch: someone sees it first (Owner decision, one constant). */
export const orderAutoAcceptanceMaximumItems = 15;
/** The kitchen board was read this recently: someone will see the ticket. */
export const orderAutoAcceptanceKitchenScreenMs = 3 * 60_000;

export type OrderAutoAcceptanceSkipReason =
  | "PaidBeforeSwitch"
  | "PaidTooLongAgo"
  | "KitchenScreenOff"
  | "StoreNotOpen"
  | "HasAlcohol"
  | "LargeOrder"
  | "StockChanged"
  | "NotEligible";

/** Why nothing is recorded at all: the switch is off, or another path owns this batch. */
export type OrderAutoAcceptanceSilentReason = "SwitchOff" | "CardMachine" | "OutageHold";

export interface OrderAutoAcceptanceSwitch {
  readonly on: boolean;
  /** When this order type's switch last changed; an order paid before it is left to a person. */
  readonly since: string | null;
}

export interface OrderAutoAcceptanceFacts {
  readonly switchState: OrderAutoAcceptanceSwitch;
  readonly paidAt: string;
  readonly observedAt: string;
  /** Staff recorded this payment on the card machine: their acceptance follows it. */
  readonly paidOnCardMachine: boolean;
  /** A first round's deadline kind; later rounds have no acceptance deadline. */
  readonly deadlineKind: "Standard" | "Held" | null;
  readonly kitchenScreenSeenAt: string | null;
  /** Open and offering this service now; unreadable counts as not open. */
  readonly storeOpen: boolean;
  /** Marked dishes only: alcohol in options or combos is not marked (DEC-ALCOHOL). */
  readonly hasAlcohol: boolean;
  /** Portions in the batch, not lines. */
  readonly itemCount: number;
  /** Stock is still reserved for it. */
  readonly stockIntact: boolean;
}

export type OrderAutoAcceptanceDecision =
  | { readonly action: "Accept" }
  | { readonly action: "Silent"; readonly reason: OrderAutoAcceptanceSilentReason }
  | { readonly action: "Skip"; readonly reason: OrderAutoAcceptanceSkipReason };

export function decideOrderAutoAcceptance(
  facts: OrderAutoAcceptanceFacts,
): OrderAutoAcceptanceDecision {
  const silent = (reason: OrderAutoAcceptanceSilentReason) =>
    Object.freeze({ action: "Silent" as const, reason });
  const skip = (reason: OrderAutoAcceptanceSkipReason) =>
    Object.freeze({ action: "Skip" as const, reason });
  const paidAt = Date.parse(facts.paidAt);
  const observedAt = Date.parse(facts.observedAt);
  if (!facts.switchState.on) return silent("SwitchOff");
  if (facts.paidOnCardMachine) return silent("CardMachine");
  if (facts.deadlineKind === "Held") return silent("OutageHold");
  // Turning it on never sends what was already waiting.
  if (facts.switchState.since === null || paidAt < Date.parse(facts.switchState.since))
    return skip("PaidBeforeSwitch");
  if (observedAt - paidAt >= orderAutoAcceptancePaidWindowMs) return skip("PaidTooLongAgo");
  if (!facts.storeOpen) return skip("StoreNotOpen");
  if (
    facts.kitchenScreenSeenAt === null ||
    observedAt - Date.parse(facts.kitchenScreenSeenAt) > orderAutoAcceptanceKitchenScreenMs
  )
    return skip("KitchenScreenOff");
  if (facts.hasAlcohol) return skip("HasAlcohol");
  if (facts.itemCount > orderAutoAcceptanceMaximumItems) return skip("LargeOrder");
  if (!facts.stockIntact) return skip("StockChanged");
  return Object.freeze({ action: "Accept" as const });
}

/**
 * An automatically accepted pickup the kitchen has not touched closes and refunds this long after
 * it was sent: today's promise for a pickup nobody acts on (Owner decision). Table rounds are never
 * refunded automatically (DEC-DINE-IN-PAID-ROUND-WAIT): the guest is in the room.
 */
export const orderAutoAcceptedPickupRefundAfterMs = 30 * 60_000;
/**
 * Recording Start is optional, so a pickup in the queue of a working kitchen may be in the pan with
 * nothing recorded. It is refunded only once the Store's kitchen has recorded no step for this long.
 */
export const orderAutoAcceptedPickupKitchenQuietMs = 10 * 60_000;
/** Staff back after an outage have this long, as for a pickup held for a manager's decision. */
export const orderAutoAcceptedPickupBackOnlineMs = 15 * 60_000;

export interface OrderAutoAcceptedPickupRefundFacts {
  /** When the System sent it to the kitchen. */
  readonly sentAt: string;
  readonly observedAt: string;
  /** False: no ticket and no preparation decision, so the kitchen can't be working on it. */
  readonly reachedKitchen: boolean;
  readonly lastKitchenStepAt: string | null;
  /** Staff presence at an instant that has passed, and when they came back after it if they had gone. */
  storeAt(at: string): Promise<{ readonly online: boolean; readonly backOnlineAt: string | null }>;
}

export interface OrderAutoAcceptedPickupRefund {
  /** When it refunds; null while the Store is offline past its time (no refund, no countdown). */
  readonly refundAt: string | null;
  readonly due: boolean;
}

/**
 * When an untouched automatically accepted pickup refunds. The same outage rule as a pickup nobody
 * accepted (DEC-OUTAGE-ACCEPTANCE-HOLD): the Store offline at the refund time means no refund, since
 * staff may be making it on paper and cannot say so; once they are back it gets a new time, 15
 * minutes after, with the same warnings. A host that comes back after an hour therefore refunds
 * nothing until the Store's screens are back too. Repeats for an outage inside the new window.
 */
export async function resolveOrderAutoAcceptedPickupRefund(
  facts: OrderAutoAcceptedPickupRefundFacts,
): Promise<OrderAutoAcceptedPickupRefund> {
  const observed = Date.parse(facts.observedAt);
  const quietUntil =
    facts.reachedKitchen && facts.lastKitchenStepAt !== null
      ? Date.parse(facts.lastKitchenStepAt) + orderAutoAcceptedPickupKitchenQuietMs
      : 0;
  let earliest = Date.parse(facts.sentAt) + orderAutoAcceptedPickupRefundAfterMs;
  for (let turn = 0; turn < 8; turn += 1) {
    const at = Math.max(earliest, quietUntil);
    const refundAt = new Date(at).toISOString();
    if (at > observed) return Object.freeze({ refundAt, due: false });
    const store = await facts.storeAt(refundAt);
    if (store.online) return Object.freeze({ refundAt, due: true });
    if (store.backOnlineAt === null) return Object.freeze({ refundAt: null, due: false });
    earliest = Date.parse(store.backOnlineAt) + orderAutoAcceptedPickupBackOnlineMs;
  }
  return Object.freeze({ refundAt: null, due: false });
}

/** How log noise is kept out: an expected refusal is a quiet skip, the rest is reported once. */
export function orderAutoAcceptanceFailureIsQuiet(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  return (
    name === "OrderAcceptanceRecordError" ||
    (typeof code === "string" && ["55P03", "40001", "40P01"].includes(code))
  );
}
