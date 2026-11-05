/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: a guest starts a free table by scanning its code at a Store
 * that turned the switch on. These are the rules; the stores and compositions gather the facts.
 */

/** How long a guest-started table stays open with no activity before the System frees it. */
export const guestTableQuietMinutes = Object.freeze({
  /** Nobody ordered: an empty table frees itself soon. */
  noOrder: 20,
  /** A party may sit and chat for an hour; this is cleanup, not turnover. */
  withOrder: 90,
});
/** The next party is asked "are you with them?" once the table has been quiet this long. */
export const guestTableNewPartyGapMinutes = 5;
/**
 * A dish left in the table's cart keeps a new phone from being asked only this long after the cart
 * last changed: past that, nobody is composing it (the cart itself lives for an hour).
 */
export const guestTableCartInUseMinutes = 20;
/** Staff get this long to clean a table before the next guest may start it anyway. */
export const guestTableCleaningGraceMinutes = 5;
/** At a guest-started table, "just joined" is flagged only for this many phones in 10 minutes. */
export const guestTableManyPhones = Object.freeze({ phones: 6, windowMinutes: 10 });
/** Also enforced by the database (2000_173). */
export const guestTableStartBudget = Object.freeze({
  perTable: 3,
  perStore: 40,
  windowMinutes: 10,
});

export const guestTableStartAuditReason = "GUEST_SCANNED_FREE_TABLE";
export const guestTableCleaningExpiredAuditReason = "GUEST_START_CLEANING_NOT_MARKED";
export const guestTableCloseReasons = Object.freeze([
  "GUEST_TABLE_QUIET",
  "GUEST_NEW_PARTY",
] as const);
export type GuestTableCloseReason = (typeof guestTableCloseReasons)[number];

const minutes = 60_000;
const at = (value: string) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError("DINING_GUEST_TABLE_FACT_INVALID");
  return parsed;
};

/** What the Store's switch, payment timing and the table say about starting it now. */
export interface GuestTableStartFacts {
  readonly switchOn: boolean;
  readonly storeTiming: "PayFirst" | "PayLater";
  readonly lifecycle: string;
  readonly qrStatus: string;
  readonly operationalState: string;
  readonly blockReasonCode: string | null;
  /** When the table last changed (for a blocked table, when it was blocked). */
  readonly tableObservedAt: string;
  readonly occupied: boolean;
}
export type GuestTableStartDecision =
  /** Free, or its cleaning was not marked within the grace time: a guest may start it. */
  | { readonly kind: "MayStart"; readonly clearsCleaning: boolean }
  | { readonly kind: "BeingCleaned" }
  | { readonly kind: "No" };

export function decideGuestTableStart(
  facts: GuestTableStartFacts,
  now: string,
): GuestTableStartDecision {
  if (
    !facts.switchOn ||
    facts.storeTiming !== "PayFirst" ||
    facts.lifecycle !== "Published" ||
    facts.qrStatus !== "Active" ||
    facts.occupied
  )
    return Object.freeze({ kind: "No" });
  if (facts.operationalState === "Available")
    return Object.freeze({ kind: "MayStart", clearsCleaning: false });
  if (facts.operationalState !== "TemporarilyBlocked" || facts.blockReasonCode !== "CLEANING")
    return Object.freeze({ kind: "No" });
  return at(now) - at(facts.tableObservedAt) >= guestTableCleaningGraceMinutes * minutes
    ? Object.freeze({ kind: "MayStart", clearsCleaning: true })
    : Object.freeze({ kind: "BeingCleaned" });
}

/** The closing facts of one guest-started table, read from their owners. */
export interface GuestTableCloseFacts {
  readonly startedAt: string;
  /** See `guestTableActivity`. */
  readonly activity: readonly (string | null)[];
  readonly cartHasItems: boolean;
  /** When a cart at this table last changed (also part of the activity). */
  readonly cartChangedAt: string | null;
  readonly openStaffCall: boolean;
  /** Merged into or from another table. */
  readonly merged: boolean;
  /** Staff paused joining by scan at this table: their brake, so nobody new is asked anything. */
  readonly scanPaused: boolean;
  /** Null: nobody ordered. */
  readonly order: null | {
    /** Items not ready yet: not paid, not accepted, being made or being remade. */
    readonly unfinishedItems: number;
    /** What the Order close itself would refuse for, other than items waiting to be served. */
    readonly blockers: readonly string[];
    /** Items the kitchen finished that nobody marked served. */
    readonly readyItems: number;
  };
}
export type GuestTableHold =
  "Recent" | "CartInUse" | "StaffCall" | "Merged" | "Unfinished" | "Owed" | "Paused";
export type GuestTableCloseDecision =
  | { readonly close: true; readonly closesAt: string }
  | { readonly close: false; readonly hold: GuestTableHold; readonly closesAt: string | null };

/** What counts as activity at a guest-started table, the same for the close and for Tables. */
export function guestTableActivity(facts: {
  readonly lastPhoneJoinedAt: string | null;
  readonly lastServedAt: string | null;
  readonly lastRoundAt: string | null;
  readonly lastCartChangeAt: string | null;
  readonly kitchenChangedAt: string | null;
}): readonly (string | null)[] {
  return Object.freeze([
    facts.lastPhoneJoinedAt,
    facts.lastServedAt,
    facts.lastRoundAt,
    facts.lastCartChangeAt,
    facts.kitchenChangedAt,
  ]);
}

export function guestTableLastActivity(
  facts: Pick<GuestTableCloseFacts, "startedAt" | "activity">,
) {
  let latest = at(facts.startedAt);
  for (const value of facts.activity) if (value !== null) latest = Math.max(latest, at(value));
  return latest;
}

/** Why this table can't be closed now, whatever the clock says; null: only time holds it. */
function standingHold(facts: GuestTableCloseFacts): GuestTableHold | null {
  if (facts.merged) return "Merged";
  if (facts.openStaffCall) return "StaffCall";
  if (facts.order !== null && facts.order.unfinishedItems > 0) return "Unfinished";
  if (facts.order !== null && facts.order.blockers.length > 0) return "Owed";
  return null;
}

/**
 * The quiet rule: nothing owed and nothing unfinished (a dish the kitchen finished counts as handed
 * over), no merge, no open call, no cart with something in it, and the table quiet for 20 minutes
 * with no Order or 90 minutes with one.
 */
export function decideGuestTableQuietClose(
  facts: GuestTableCloseFacts,
  now: string,
): GuestTableCloseDecision {
  const closesAt = new Date(
    guestTableLastActivity(facts) +
      (facts.order === null ? guestTableQuietMinutes.noOrder : guestTableQuietMinutes.withOrder) *
        minutes,
  ).toISOString();
  const standing = standingHold(facts);
  if (standing !== null) return Object.freeze({ close: false, hold: standing, closesAt: null });
  if (facts.cartHasItems) return Object.freeze({ close: false, hold: "CartInUse", closesAt: null });
  if (at(now) < Date.parse(closesAt))
    return Object.freeze({ close: false, hold: "Recent", closesAt });
  return Object.freeze({ close: true, closesAt });
}

/**
 * Turnover comes from the next scan: a new phone at a guest-started table is asked whether it is
 * with the people there only when staff haven't paused scanning here, nothing is owed, nothing is
 * unfinished, no cart changed in the last 20 minutes with something still in it, the table has been
 * quiet for 5 minutes, and another start here would still be within budget.
 */
export function decideGuestNewParty(
  facts: GuestTableCloseFacts,
  now: string,
  startsInWindow: { readonly table: number; readonly store: number },
): { readonly ask: true } | { readonly ask: false; readonly hold: GuestTableHold | "Budget" } {
  const standing = standingHold(facts);
  if (standing !== null) return Object.freeze({ ask: false, hold: standing });
  if (facts.scanPaused) return Object.freeze({ ask: false, hold: "Paused" });
  if (
    facts.cartHasItems &&
    (facts.cartChangedAt === null ||
      at(now) - at(facts.cartChangedAt) < guestTableCartInUseMinutes * minutes)
  )
    return Object.freeze({ ask: false, hold: "CartInUse" });
  if (at(now) - guestTableLastActivity(facts) < guestTableNewPartyGapMinutes * minutes)
    return Object.freeze({ ask: false, hold: "Recent" });
  // With no start left, "we just sat down" would close the table and then send them to staff.
  if (
    startsInWindow.table >= guestTableStartBudget.perTable ||
    startsInWindow.store >= guestTableStartBudget.perStore
  )
    return Object.freeze({ ask: false, hold: "Budget" });
  return Object.freeze({ ask: true });
}
