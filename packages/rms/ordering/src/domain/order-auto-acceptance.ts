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
export function orderAutoAcceptedPickupRefundAt(acceptedAt: string): string {
  return new Date(Date.parse(acceptedAt) + orderAutoAcceptedPickupRefundAfterMs).toISOString();
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
