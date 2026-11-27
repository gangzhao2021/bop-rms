import { v7 as uuidv7 } from "uuid";
import { boundedFetch } from "../network/bounded-fetch.js";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";

/**
 * WP-2423 shared-table-checkout (a): at a table that pays per round, the payer chooses this
 * round's dishes ("only what I added", or dishes they pick for anyone), keeps them longer, or goes
 * back; any phone gives the dishes that waited back to the cart once nobody pays for them. Each
 * tap keeps its operation reference until it is answered, so a lost answer is resent and never
 * applied twice.
 */
export type CheckoutScopeCommand =
  | {
      readonly action: "Choose";
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly choice: "Mine" | "Chosen";
      readonly lines: readonly { readonly cartItemReference: string; readonly quantity: number }[];
    }
  | { readonly action: "Extend" | "Cancel" | "Return" };

export type CheckoutScopeOutcome =
  /** The other dishes wait; the cart is now this round. */
  | { readonly status: "Chosen"; readonly expiresAt: string }
  /** Every dish was chosen: pay the whole cart as usual. */
  | { readonly status: "WholeCart" }
  /** Nothing to pay in that choice (no dish of this phone). */
  | { readonly status: "NothingChosen" }
  | { readonly status: "Extended"; readonly expiresAt: string }
  /** The choice is no longer kept (the round was sent, or the dishes came back). */
  | { readonly status: "NotLive" }
  | { readonly status: "Returned" | "NothingToReturn" }
  /** Someone at the table is paying now: ask again after the seconds given. */
  | { readonly status: "OtherPaying"; readonly retryAfterSeconds: number }
  /** The cart changed: read it again. */
  | { readonly status: "Changed" }
  /** No answer could be read (offline or the store's service): the same tap may be repeated. */
  | { readonly status: "Unknown" };

const route = "/api/v1/dine-in/checkout-scope";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function createCheckoutScopeClient(
  request: typeof globalThis.fetch = globalThis.fetch,
  newOperationReference: () => string = uuidv7,
) {
  return Object.freeze({
    newOperationReference,
    async send(
      operationReference: string,
      command: CheckoutScopeCommand,
    ): Promise<CheckoutScopeOutcome> {
      const csrf = getCustomerCsrfCredential();
      if (csrf === null || !credential.test(csrf)) return { status: "Unknown" };
      let response: Response;
      try {
        response = await boundedFetch(request, route, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrf,
            "idempotency-key": operationReference,
          },
          body: JSON.stringify(command),
        });
      } catch {
        return { status: "Unknown" };
      }
      const body = (await response.json().catch(() => null)) as {
        status?: unknown;
        expiresAt?: unknown;
        error?: { code?: unknown };
      } | null;
      if (response.status === 409) {
        if (body?.error?.code === "cart_checkout_in_progress") {
          const seconds = Number(response.headers.get("retry-after"));
          return {
            status: "OtherPaying",
            retryAfterSeconds:
              Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 5,
          };
        }
        return { status: "Changed" };
      }
      if (response.status === 400 || response.status === 404) return { status: "Changed" };
      if (!response.ok || body === null) return { status: "Unknown" };
      const status = body.status;
      if ((status === "Chosen" || status === "Extended") && typeof body.expiresAt === "string")
        return instant.test(body.expiresAt)
          ? { status, expiresAt: body.expiresAt }
          : { status: "Unknown" };
      if (
        status === "WholeCart" ||
        status === "NothingChosen" ||
        status === "NotLive" ||
        status === "Returned" ||
        status === "NothingToReturn"
      )
        return { status };
      return { status: "Unknown" };
    },
  });
}
export type CheckoutScopeClient = ReturnType<typeof createCheckoutScopeClient>;
