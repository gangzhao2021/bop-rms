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
}

/** What the menu needs when no visit has started: the Store, never a table or a Session. */
export type CustomerEntryPublicContext = Readonly<{
  publicStoreReference: string;
  channel: "DineIn";
  locale: string;
  brandDisplayName: string;
  storeDisplayName: string;
}>;

export type CustomerEntryIntent = "Start" | "Join" | "NewParty";

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
  | Readonly<{ kind: "Established"; context: CustomerEntryEstablishedContext }>;

export interface CustomerEntryClient {
  readonly hasEntry: boolean;
  start(): Promise<CustomerEntryScreenState>;
  retry(): Promise<CustomerEntryScreenState>;
  /** The guest answered a table's choice: a second entry, which may start a visit. */
  enter?(intent: CustomerEntryIntent): Promise<CustomerEntryScreenState>;
}
