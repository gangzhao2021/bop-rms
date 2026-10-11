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
}

export type CustomerEntryScreenState =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "RequestInvalid" }>
  | Readonly<{ kind: "EntryUnavailable" }>
  /** WP-2423 Q4: the Store is closed or paused; no session was started. */
  | Readonly<{
      kind: "NotAccepting";
      storeDisplayName: string;
      paused: boolean;
      todayHours: readonly Readonly<{ start: string; end: string; endsNextDay: boolean }>[];
    }>
  | Readonly<{ kind: "ServiceUnavailable" }>
  | Readonly<{ kind: "RateLimited"; retryAfterSeconds: number }>
  | Readonly<{ kind: "Offline" }>
  | Readonly<{ kind: "CommandFailed" }>
  | Readonly<{ kind: "Established"; context: CustomerEntryEstablishedContext }>;

export interface CustomerEntryClient {
  readonly hasEntry: boolean;
  start(): Promise<CustomerEntryScreenState>;
  retry(): Promise<CustomerEntryScreenState>;
}
