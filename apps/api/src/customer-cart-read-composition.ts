import { logGuestFailure } from "./guest-failure-log.js";
import {
  readCartError,
  readCartParticipationEnded,
  type CustomerCartDisplayView,
} from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";
import {
  noteRequestRealFault,
  requestAnswerTimeLeftMs,
  requestClientLeft,
  requestWasShed,
} from "./request-acquire-budget.js";

export interface CustomerCartDisplayQuery {
  /**
   * `displayLocale`: the guest's chosen language for names (null: the session's own). Batch 65:
   * `atCheckout`: a table's Cart is also read while the table checks out (read-only).
   */
  read(
    input: unknown,
    displayLocale?: string | null,
    options?: { readonly atCheckout?: boolean },
  ): Promise<CustomerCartDisplayView | null>;
}

/** Reads a Cart view; the session's own locale (no second argument) unless another was chosen. */
export function readCartView(
  query: CustomerCartDisplayQuery,
  input: unknown,
  displayLocale: string | null | undefined,
  atCheckout = false,
): Promise<CustomerCartDisplayView | null> {
  if (atCheckout) return query.read(input, displayLocale ?? null, { atCheckout });
  return displayLocale == null ? query.read(input) : query.read(input, displayLocale);
}

/**
 * WP-2423 (guest-cart-503): the guest's own state as such (never a 503): permission ended or the
 * phone left the table → session expired; the table is checking out → say so. Matched by name as
 * well (the entry can load Ordering twice), and one level of `cause` under "unavailable".
 */
function guestState(error: unknown): CustomerCartPortResult | null {
  let found = readCartError(error);
  if (found?.code === "CART_DEPENDENCY_UNAVAILABLE")
    found = readCartError((error as { cause?: unknown }).cause) ?? found;
  switch (found?.code) {
    case "CART_PERMISSION_DENIED":
    case "CART_REPLACEMENT_FORBIDDEN":
      return { status: "SessionExpired" };
    case "CART_TABLE_CHECKING_OUT":
      return { status: "TableCheckingOut" };
    // M126 I.2: the phone's place at the table ended; why travels with it.
    case "CART_PARTICIPATION_ENDED": {
      const reason = readCartParticipationEnded(found);
      return reason === null
        ? { status: "SessionExpired" }
        : { status: "ParticipationEnded", reason };
    }
    default:
      return null;
  }
}

const own = (value: unknown, key: PropertyKey): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
/** The safe code an owner keeps behind its plain answer (the Guest Session store's, M68). */
const failureCauseKey = Symbol.for("bop.failure.cause");
/** No database connection could be had (the rush itself): reading again only adds to it. */
function noConnection(error: unknown): boolean {
  for (
    let at = error, depth = 0;
    depth < 8 && at !== null && typeof at === "object";
    depth += 1, at = own(at, "cause") ?? own(at, failureCauseKey)
  ) {
    const code = own(at, "code"),
      message = own(at, "message");
    if (code === "TENANT_DATABASE_ACQUIRE_FAILED" || message === "LOCAL_DATABASE_UNAVAILABLE")
      return true;
  }
  return false;
}
/**
 * Only a passing fault is worth a second read: the read's own "couldn't reach what it needs"
 * (CART_DEPENDENCY_UNAVAILABLE) or a database fault under it. A refusal such as CART_INPUT_INVALID
 * answers the same every time, so a second read would only make the phone wait.
 */
function passingFault(error: unknown): boolean {
  if (readCartError(error)?.code === "CART_DEPENDENCY_UNAVAILABLE") return true;
  if (readCartError(error) !== null) return false;
  const code = own(error, "code");
  return (
    own(error, "dependencyFailure") === true ||
    (typeof code === "string" && code.startsWith("TENANT_DATABASE_"))
  );
}
/**
 * WP-2423 (guest-table-open-and-busy-reads, v15 2026-11-12): a cart read that met staff moving or
 * merging the guest's own table (or the phone's own add committing at that moment) can find the
 * records mid-change and fail once, though nothing is wrong: the phone's next read worked, but each
 * time it showed "busy" and wrote a level-50 line. It is read once more, a moment later, before
 * the guest is told "busy, try again" — never when the database had no connection to give (that
 * would only add to a rush), and only while the read has time left to answer.
 */
export const cartReadAgainAfterMs = 200;
const cartReadAgainNeedsMs = 3_000;
// Existing mutation routes stay explicitly unavailable until their owning composition is ready.
export function createCustomerCartReadPort(
  query: CustomerCartDisplayQuery,
  options: {
    readonly pause?: (ms: number) => Promise<void>;
    readonly timeLeftMs?: () => number | undefined;
    /** Whether the rush turned this request away (no connection in time, its time spent). */
    readonly shed?: () => boolean;
    /** Whether the guest's phone went away before the read answered. */
    readonly left?: () => boolean;
    readonly log?: typeof logGuestFailure;
  } = {},
): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeLeftMs = options.timeLeftMs ?? requestAnswerTimeLeftMs;
  const shed = options.shed ?? requestWasShed;
  const clientLeft = options.left ?? requestClientLeft;
  const log = options.log ?? logGuestFailure;
  const read = async (
    input: unknown,
    displayLocale: string | null | undefined,
  ): Promise<CustomerCartPortResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const view = await readCartView(query, input, displayLocale, true);
        if (view === null) return { status: "NotFound" };
        // Batch 65 (v15 b64 live): the table is checking out. Still "checking out" (409), now with
        // the Cart as it is, so a Cart opened or reloaded then names the dishes that were never
        // sent to the kitchen, in the guest's language; nothing in it can be changed.
        if (view.tableCheckingOut === true)
          return {
            status: "TableCheckingOut",
            view: { schemaVersion: view.schemaVersion, cart: view.cart },
          };
        return { status: "Found", view };
      } catch (error) {
        const known = guestState(error);
        if (known !== null) return known;
        const left = timeLeftMs();
        const rushed = shed();
        if (
          attempt === 0 &&
          passingFault(error) &&
          !rushed &&
          !clientLeft() &&
          !noConnection(error) &&
          (left === undefined || left >= cartReadAgainNeedsMs)
        ) {
          // b10 review: what the first read met is still unknown; its cause codes are kept at a
          // lower level, so live runs can pin it down though the second read may hide it.
          log("CUSTOMER_CART_READ_RETRIED", error, undefined, 40);
          await pause(cartReadAgainAfterMs);
          continue;
        }
        // WP-2423 (reads-under-burst, v15 2026-11-13): a read the rush turned away (no connection
        // within its wait, its answer time spent) is the expected "busy, try again" (503 +
        // Retry-After) the phone sits out: a level-40 line. A real fault stays level 50.
        // Review: a request turned away once that then met a real fault logs the fault.
        const faulted = noteRequestRealFault(error);
        // WP-2423 (logs-and-transaction-time, v15 2026-11-14): on quiet tables, right after a guest
        // added a dish, the phone stopped the cart read it had started (a newer one replaced it).
        // The read was cut and its next connection refused at once: a level-40 line with
        // TENANT_DATABASE_ACQUIRE_FAILED beside a "200" that was never sent. Nobody waits for
        // that answer: it is information (level 30). A real fault it met stays level 50.
        log(
          "CUSTOMER_CART_READ_UNAVAILABLE",
          error,
          undefined,
          faulted ? 50 : clientLeft() ? 30 : rushed ? 40 : 50,
        );
        return unavailable;
      }
    }
  };
  return Object.freeze({
    getCurrentCart: (
      input: Parameters<CustomerCartPort["getCurrentCart"]>[0],
      displayLocale?: string | null,
    ) => read({ sessionCredential: input.guestCredential }, displayLocale),
    getCart: (input: Parameters<CustomerCartPort["getCart"]>[0], displayLocale?: string | null) =>
      read(
        { sessionCredential: input.guestCredential, cartReference: input.cartReference },
        displayLocale,
      ),
    createCart: async () => unavailable,
    addItem: async () => unavailable,
    updateItem: async () => unavailable,
    removeItem: async () => unavailable,
  });
}
