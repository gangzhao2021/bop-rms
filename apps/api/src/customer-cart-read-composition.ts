import { CartError, type CustomerCartDisplayView } from "@rms/ordering";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

export interface CustomerCartDisplayQuery {
  read(input: unknown): Promise<CustomerCartDisplayView | null>;
}

// Existing mutation routes stay explicitly unavailable until their owning composition is ready.
export function createCustomerCartReadPort(query: CustomerCartDisplayQuery): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const read = async (input: unknown): Promise<CustomerCartPortResult> => {
    try {
      const view = await query.read(input);
      return view === null ? { status: "NotFound" } : { status: "Found", view };
    } catch (error) {
      return error instanceof CartError && error.code === "CART_PERMISSION_DENIED"
        ? { status: "SessionExpired" }
        : unavailable;
    }
  };
  return Object.freeze({
    getCurrentCart: (input: Parameters<CustomerCartPort["getCurrentCart"]>[0]) =>
      read({ sessionCredential: input.guestCredential }),
    getCart: (input: Parameters<CustomerCartPort["getCart"]>[0]) =>
      read({ sessionCredential: input.guestCredential, cartReference: input.cartReference }),
    createCart: async () => unavailable,
    addItem: async () => unavailable,
    updateItem: async () => unavailable,
    removeItem: async () => unavailable,
  });
}
