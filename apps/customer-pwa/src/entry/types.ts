import type { CustomerCurrentOrder } from "../session/session-bootstrap.js";

export type CustomerEntryOperatingState = "Open" | "Closed" | "TemporarilyClosed";
export type CustomerEntryServiceMode = "DineIn" | "Pickup" | "Delivery";

export interface CustomerEntryEstablishedContext {
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  readonly publicStoreReference: string;
  readonly publicTableReference: string | null;
  readonly channel: "DineIn" | "Pickup";
  readonly operatingState: CustomerEntryOperatingState;
  readonly availableServiceModes: readonly CustomerEntryServiceMode[];
  readonly locale: string;
  readonly contextExpiresAt: string;
  readonly csrfToken: string;
  /** Coordinator 2026-10-30: at a table, whether staff seated a party there (absent: unknown). */
  readonly tableOpen?: boolean;
  /** M104/M105: this phone's pickup visit at this Store goes on (its cart and orders are kept). */
  readonly resumed?: true;
  /** M104/M105: the visit this phone had here ended; whether its receipts are still on the phone. */
  readonly previousVisit?: "Ended" | "EndedReceiptsKept";
}

/** What the menu needs when no visit has started: the Store, never a table or a Session. */
export type CustomerEntryPublicContext = Readonly<{
  publicStoreReference: string;
  channel: "DineIn";
  locale: string;
  brandDisplayName: string;
  storeDisplayName: string;
}>;

/** M116: a Store closed now or paused: its menu to look at, with nothing to order. */
export type CustomerEntryBrowseContext = Readonly<{
  publicStoreReference: string;
  channel: "DineIn" | "Pickup";
  locale: string;
  brandDisplayName: string;
  storeDisplayName: string;
}>;

export type CustomerEntryIntent = "Start" | "Join" | "NewParty";

/**
 * M02 (v15 07b7a1b7): the visit this browser already has, restored with its Session: a reload, a
 * home-screen launch or a second scan of the same code stays here (same Store, table and cart).
 */
export type CustomerEntryResumedContext = Readonly<{
  publicStoreReference: string;
  channel: "DineIn" | "Pickup";
  locale: string;
  brandDisplayName: string;
  storeDisplayName: string;
  /** At a table: which one, and whether this phone joined the party there. */
  publicTableReference: string | null;
  joined: boolean;
  /** WP-2423 shared-table-checkout (b): the server said this phone is already at the table. */
  alreadyAtTable?: true;
}>;

export type CustomerEntryScreenState =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "RequestInvalid" }>
  | Readonly<{ kind: "EntryUnavailable" }>
  /** WP-2423 Q11: staff replaced or turned off this table's code; no session was started. */
  | Readonly<{ kind: "TableCodeRetired"; replaced: boolean }>
  /** WP-2423 Q4: the Store is closed or paused; no session was started. */
  | Readonly<{
      kind: "NotAccepting";
      storeDisplayName: string;
      paused: boolean;
      todayHours: readonly Readonly<{ start: string; end: string; endsNextDay: boolean }>[];
      /** WP-2423 item 8 ③ (decision 16): today's holiday or closure, and the next opening. */
      todayKind: "Holiday" | "TemporaryClosure" | "Override" | null;
      nextOpening: Readonly<{ localDate: string; startLocalTime: string }> | null;
      localDate: string | null;
      /** WP-2423 item 11: not a closing time; this Store isn't ready to take orders yet. */
      notReady?: true;
      /** WP-2423 item 13 ②: not taking new guests for now; no hours to wait for. */
      newGuestsPaused?: true;
      /** M116: the menu can be looked at (read-only: no visit, no cart). */
      browse?: CustomerEntryBrowseContext;
    }>
  /** WP-2423 item 8 ⑦ 1b: a pickup code at a Store that takes dine-in orders only. */
  | Readonly<{ kind: "PickupNotOffered"; storeDisplayName: string }>
  /**
   * Coordinator 2026-10-30: no party is seated at the scanned table; no visit was started (staff
   * seat the party, then the code is scanned again). The menu can be browsed.
   */
  | Readonly<{
      kind: "TableNotOpen";
      context: CustomerEntryPublicContext;
      /**
       * WP-2423 (guest-table-open-and-busy-reads): the scanned table's printed name, so a guest
       * holding another table's card sees which table it is for. Absent when it couldn't be read.
       */
      tableLabel?: string;
    }>
  /**
   * WP-2423 DEC-DINING-GUEST-TABLE-START: no visit was started; this free table can be started, it
   * is waiting for cleaning, or this phone is asked whether it is with the guests already there.
   */
  | Readonly<{ kind: "TableMayStart"; context: CustomerEntryPublicContext }>
  | Readonly<{ kind: "TableBeingCleaned"; context: CustomerEntryPublicContext }>
  | Readonly<{ kind: "TableAskNewParty"; context: CustomerEntryPublicContext }>
  | Readonly<{ kind: "ServiceUnavailable" }>
  | Readonly<{ kind: "RateLimited"; retryAfterSeconds: number }>
  | Readonly<{ kind: "Offline" }>
  | Readonly<{ kind: "CommandFailed" }>
  | Readonly<{
      kind: "Established";
      context: CustomerEntryEstablishedContext;
      /**
       * M105 (B.3): a pickup visit this phone kept went on, and it has an order: the start page
       * shows that order, as a scan of this Store's code always does.
       */
      currentOrder?: CustomerCurrentOrder;
    }>
  /** M02: this browser's own visit, restored; nothing new was started. */
  | Readonly<{ kind: "Resumed"; context: CustomerEntryResumedContext }>;

export interface CustomerEntryClient {
  readonly hasEntry: boolean;
  start(): Promise<CustomerEntryScreenState>;
  retry(): Promise<CustomerEntryScreenState>;
  /** The guest answered a table's choice: a second entry, which may start a visit. */
  enter?(intent: CustomerEntryIntent): Promise<CustomerEntryScreenState>;
  /**
   * M02: "Start a new order" after an order in progress: at the restored visit's own Store (a new
   * pickup visit there, or back to the same table), never a default Store.
   */
  startNew?(): Promise<CustomerEntryScreenState>;
  /** False: a new order here continues the restored table visit, so none is offered to start. */
  readonly startsNewVisit?: boolean;
  /**
   * M105 (B.3): the code in the address is another Store's, or a table's, not the pickup visit
   * this phone restored. Its order stays on the phone; the scanned place opens at once.
   */
  readonly leavesPickupVisit?: boolean;
}
