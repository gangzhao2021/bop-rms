import { CartError, type CustomerCartDisplayView } from "@rms/ordering";
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
      return error instanceof CartError && error.code === "CART_PERMISSION_DENIED"
        ? { status: "SessionExpired" }
        : unavailable;
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
