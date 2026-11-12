import { logGuestFailure } from "./guest-failure-log.js";
import {
  readCartError,
  readCartParticipationEnded,
  type CustomerCartDisplayView,
} from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";
import { requestAnswerTimeLeftMs } from "./request-acquire-budget.js";

export interface CustomerCartDisplayQuery {
  /** `displayLocale`: the guest's chosen language for names (null: the session's own). */
  read(input: unknown, displayLocale?: string | null): Promise<CustomerCartDisplayView | null>;
}

/** Reads a Cart view; the session's own locale (no second argument) unless another was chosen. */
export function readCartView(
  query: CustomerCartDisplayQuery,
  input: unknown,
  displayLocale: string | null | undefined,
): Promise<CustomerCartDisplayView | null> {
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

const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
/** No database connection could be had (the rush itself): reading again only adds to it. */
function noConnection(error: unknown): boolean {
  for (
    let at = error, depth = 0;
    depth < 8 && at !== null && typeof at === "object";
    depth += 1, at = own(at, "cause")
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
  } = {},
): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeLeftMs = options.timeLeftMs ?? requestAnswerTimeLeftMs;
  const read = async (
    input: unknown,
    displayLocale: string | null | undefined,
  ): Promise<CustomerCartPortResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const view = await readCartView(query, input, displayLocale);
        return view === null ? { status: "NotFound" } : { status: "Found", view };
      } catch (error) {
        const known = guestState(error);
        if (known !== null) return known;
        const left = timeLeftMs();
        if (
          attempt === 0 &&
          passingFault(error) &&
          !noConnection(error) &&
          (left === undefined || left >= cartReadAgainNeedsMs)
        ) {
          // b10 review: what the first read met is still unknown; its cause codes are kept at a
          // lower level, so live runs can pin it down though the second read may hide it.
          logGuestFailure("CUSTOMER_CART_READ_RETRIED", error, undefined, 40);
          await pause(cartReadAgainAfterMs);
          continue;
        }
        logGuestFailure("CUSTOMER_CART_READ_UNAVAILABLE", error);
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
