import { logGuestFailure } from "./guest-failure-log.js";
import {
  readCartError,
  readCartParticipationEnded,
  type CustomerCartDisplayView,
} from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

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

// Existing mutation routes stay explicitly unavailable until their owning composition is ready.
export function createCustomerCartReadPort(query: CustomerCartDisplayQuery): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const read = async (
    input: unknown,
    displayLocale: string | null | undefined,
  ): Promise<CustomerCartPortResult> => {
    try {
      const view = await readCartView(query, input, displayLocale);
      return view === null ? { status: "NotFound" } : { status: "Found", view };
    } catch (error) {
      const known = guestState(error);
      if (known !== null) return known;
      logGuestFailure("CUSTOMER_CART_READ_UNAVAILABLE", error);
      return unavailable;
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
