import type {
  CustomerEntryClient,
  CustomerEntryIntent,
  CustomerEntryResumedContext,
  CustomerEntryScreenState,
} from "./types.js";
import { pickupLinkPattern, tableLauncherPattern } from "./entry-address.js";

/**
 * M02 (v15 07b7a1b7): how the start page finds where this phone is. A phone stays at the Store and
 * table it scanned; with no scan and no visit it asks the guest to scan, and it never opens a
 * default Store at an installation of several Stores (which opened DEMO Café for other merchants'
 * guests and emptied their carts):
 *
 * 1. A code in the address (`#qr=`, `#pickup=`, the InternalTest table launcher): that code, unless
 *    it is the code of the visit this phone already has (the same poster or table scanned again),
 *    which is resumed with its cart.
 * 2. No code: this browser's last scan that started no visit yet (a table not open, a closed Store)
 *    is asked about again at the same Store and table.
 * 3. Otherwise the restored visit, as it was.
 * 4. Otherwise the installation's only Store's pickup code (none at several Stores: "scan").
 */
export type CustomerEntryStartSource =
  | Readonly<{
      kind: "Code";
      load: () => Promise<string | undefined>;
      /** Where the code says it is, when the address shows it (unverified: only compared). */
      names?: CustomerEntryCodePlace | undefined;
    }>
  | Readonly<{ kind: "None" }>
  /** Something in the address that is no code: asked to scan, as before. */
  | Readonly<{ kind: "Unusable" }>;

export interface CustomerStartClientInput {
  readonly source: CustomerEntryStartSource;
  /** The visit restored with this browser's Session, if any. */
  readonly restored?: CustomerEntryResumedContext | undefined;
  /** An entry for one code. */
  readonly forCode: (token: string) => CustomerEntryClient;
  /** A replay of this browser's waiting scan. */
  readonly forReplay: () => CustomerEntryClient;
  /** A pickup code: of the named Store, or with none named, of the installation's only Store. */
  readonly pickupCode: (publicStoreReference?: string) => Promise<string | undefined>;
  /** Whether this installation hands out its Stores' pickup codes (absent: it does). */
  readonly pickupOffered?: boolean;
}

/** The Store a code names (null: not shown) and whether it is a table's. */
export type CustomerEntryCodePlace = Readonly<{
  publicStoreReference: string | null;
  table: boolean;
}>;

/** Where the code in the address says it is, before it is loaded (undefined: it can't say). */
export function addressCodePlace(
  hash: string,
  scannedCode: string | null,
): CustomerEntryCodePlace | undefined {
  if (scannedCode !== null) {
    const names = codeNames(scannedCode);
    return names === null
      ? undefined
      : Object.freeze({
          publicStoreReference: names.publicStoreReference,
          table: names.publicTableReference !== null,
        });
  }
  const pickup = pickupLinkPattern.exec(hash);
  if (pickup?.[1] !== undefined)
    return Object.freeze({ publicStoreReference: pickup[1], table: false });
  // The InternalTest table launcher always opens a table.
  if (tableLauncherPattern.test(hash))
    return Object.freeze({ publicStoreReference: null, table: true });
  return undefined;
}

/**
 * M105 (B.3): the code is another Store's, or a table's, while this phone's visit is a pickup one.
 * Its order is kept on the phone (the server keeps the visit), so the scanned place opens at once
 * instead of showing the other Store's order under this Store's code.
 */
export function leavesPickupVisit(
  place: CustomerEntryCodePlace | undefined,
  restored: CustomerEntryResumedContext | undefined,
): boolean {
  if (place === undefined || restored === undefined || restored.channel !== "Pickup") return false;
  return place.table || place.publicStoreReference !== restored.publicStoreReference;
}

const missing: CustomerEntryScreenState = Object.freeze({ kind: "Missing" });

/** The Store and table a code names (its payload, unverified: only compared, never trusted). */
export function codeNames(
  token: string,
): { publicStoreReference: string; publicTableReference: string | null } | null {
  try {
    const part = token.split(".")[1] ?? "";
    const text = atob(
      part
        .replace(/-/gu, "+")
        .replace(/_/gu, "/")
        .padEnd(4 * Math.ceil(part.length / 4), "="),
    );
    const payload: unknown = JSON.parse(text);
    if (payload === null || typeof payload !== "object") return null;
    const { publicStoreReference, publicTableReference } = payload as Record<string, unknown>;
    if (typeof publicStoreReference !== "string") return null;
    return {
      publicStoreReference,
      publicTableReference: typeof publicTableReference === "string" ? publicTableReference : null,
    };
  } catch {
    return null;
  }
}

/** Whether a code is the one of the visit this phone already has. */
export function isRestoredVisitCode(token: string, restored: CustomerEntryResumedContext): boolean {
  const names = codeNames(token);
  if (names === null || names.publicStoreReference !== restored.publicStoreReference) return false;
  return restored.channel === "Pickup"
    ? names.publicTableReference === null
    : restored.publicTableReference !== null &&
        names.publicTableReference === restored.publicTableReference;
}

export function createCustomerStartClient(input: CustomerStartClientInput): CustomerEntryClient {
  const { source, restored, forCode, forReplay, pickupCode } = input;
  const resumed: CustomerEntryScreenState | null = restored
    ? Object.freeze({ kind: "Resumed", context: restored })
    : null;
  let active: CustomerEntryClient | null = null;
  let settled: Promise<CustomerEntryScreenState> | null = null;
  const enterCode = (token: string | undefined): Promise<CustomerEntryScreenState> => {
    if (token === undefined) return Promise.resolve(missing);
    active = forCode(token);
    return active.start();
  };
  async function begin(): Promise<CustomerEntryScreenState> {
    active = null;
    if (source.kind === "Unusable") return missing;
    if (source.kind === "Code") {
      const token = await source.load();
      if (
        token !== undefined &&
        resumed !== null &&
        restored &&
        isRestoredVisitCode(token, restored)
      )
        return resumed;
      return enterCode(token);
    }
    const replay = forReplay();
    const answer = await replay.start();
    // A waiting scan answered: shown as any scan is (the guest scanned it last).
    if (
      answer.kind !== "Missing" &&
      !(
        resumed !== null &&
        (answer.kind === "CommandFailed" ||
          answer.kind === "Offline" ||
          answer.kind === "ServiceUnavailable")
      )
    ) {
      active = replay;
      return answer;
    }
    if (resumed !== null) return resumed;
    return enterCode(await pickupCode());
  }
  const run = (): Promise<CustomerEntryScreenState> => {
    const pending = begin();
    settled = pending;
    return pending;
  };
  return Object.freeze({
    hasEntry: true,
    // At a table with no new code, the guest goes on ordering at the same table.
    startsNewVisit:
      source.kind === "Code" ||
      (restored?.channel === "Pickup" && input.pickupOffered !== false) ||
      restored === undefined,
    leavesPickupVisit: source.kind === "Code" ? leavesPickupVisit(source.names, restored) : false,
    start() {
      if (settled === null) return run();
      // M116: back from looking at a closed Store's menu, the start page asks that Store again.
      const next = settled.then((answer) =>
        answer.kind === "NotAccepting" && active !== null ? active.start() : answer,
      );
      settled = next;
      return next;
    },
    retry() {
      return active === null ? run() : active.retry();
    },
    enter(intent: CustomerEntryIntent) {
      return active?.enter?.(intent) ?? Promise.resolve(missing);
    },
    async startNew() {
      if (source.kind === "Code") {
        const token = await source.load();
        // The same table or pickup poster again keeps its visit; anything else, the new code.
        if (
          token !== undefined &&
          resumed !== null &&
          restored &&
          isRestoredVisitCode(token, restored)
        )
          return resumed;
        return enterCode(token);
      }
      // M104: "Order more" at a pickup visit goes on with that visit (one per Store on a phone),
      // so the orders, receipts and pickup codes it has stay reachable; a table stays the same.
      return resumed ?? run();
    },
  });
}
