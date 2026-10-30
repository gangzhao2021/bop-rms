import type { CustomerCartPort } from "./customer-cart.js";

/**
 * WP-2423 item 8 ⑦ 4b-3 (coordinator 2026-10-29): the per-head tea is staff's — it follows the
 * party size — so a guest's phone can't add it, whatever it sends. Only the guest route is
 * guarded; staff rounds use the cart port itself. `teaSellable` reads the Store's tea item (null:
 * none; it throws when unreadable, and then nothing is added).
 */
export function guestCartWithoutTea<P extends Pick<CustomerCartPort, "addItem">>(
  port: P,
  teaSellable: () => Promise<string | null>,
): P {
  return {
    ...port,
    addItem: async (...args: Parameters<CustomerCartPort["addItem"]>) => {
      let tea: string | null;
      try {
        tea = await teaSellable();
      } catch {
        return { status: "Unavailable" as const };
      }
      if (tea !== null && tea === args[0].sellableReference)
        return {
          status: "SelectionInvalid" as const,
          issueCodes: Object.freeze(["TEA_CHARGED_BY_STAFF"]),
        };
      return port.addItem(...args);
    },
  };
}
