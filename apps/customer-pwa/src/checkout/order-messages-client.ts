import { boundedFetch } from "../network/bounded-fetch.js";

/**
 * DEC-PILOT-NOTIFICATIONS: which order-message channels the store can actually send now. Any
 * failure means "none": the checkout never offers a use of the customer's contact that won't happen.
 * The answer is per Store, so the request carries the guest's cookie: on an installation of several
 * merchants that cookie is what routes it to the guest's own Store (the answer holds no private data).
 */
export interface OrderMessageOptions {
  readonly sms: boolean;
  readonly email: boolean;
}
export const noOrderMessages: OrderMessageOptions = Object.freeze({ sms: false, email: false });

export function createOrderMessageOptionsClient(
  request: typeof globalThis.fetch = globalThis.fetch,
) {
  return Object.freeze({
    async read(): Promise<OrderMessageOptions> {
      try {
        const response = await boundedFetch(request, "/api/v1/customer/order-messages", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { accept: "application/json" },
        });
        if (response.status !== 200) return noOrderMessages;
        const payload = (await response.json().catch(() => null)) as {
          schemaVersion?: unknown;
          orderMessages?: { sms?: unknown; email?: unknown };
        } | null;
        if (payload?.schemaVersion !== 1) return noOrderMessages;
        return Object.freeze({
          sms: payload.orderMessages?.sms === true,
          email: payload.orderMessages?.email === true,
        });
      } catch {
        return noOrderMessages;
      }
    },
  });
}
