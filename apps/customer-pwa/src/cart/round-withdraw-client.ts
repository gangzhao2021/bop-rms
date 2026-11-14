import { v7 as uuidv7 } from "uuid";
import { boundedFetch } from "../network/bounded-fetch.js";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";

/**
 * WP-2423 shared-table-cart-staff-round M38: at a pay-first table the guest paying for a round
 * stops before paying and the round's dishes come back to the table's cart. Only the round's
 * number at the table is sent; the server finds this phone's own round and proves nothing was
 * charged first. The same operation reference is sent again after a lost answer.
 */
export type RoundWithdrawOutcome =
  /** Cancelled unpaid; the dishes are back in the cart. */
  | "Returned"
  /** The payment went through: the round is paid and stays. */
  | "Paid"
  /** The payment may still be going through: nothing changed yet. */
  | "PaymentPending"
  /** Not a round this phone can stop (already sent, another phone's, or waiting for staff). */
  | "NotWithdrawable"
  /** The table closed: there is no cart to put the dishes back into. */
  | "TableClosed"
  /** No answer could be read (offline or the store's service): the same tap may be repeated. */
  | "Unknown";

const route = "/api/v1/dine-in/rounds/withdraw";
const credential = /^[A-Za-z0-9_-]{43}$/u;

export function createRoundWithdrawClient(
  request: typeof globalThis.fetch = globalThis.fetch,
  newOperationReference: () => string = uuidv7,
) {
  return Object.freeze({
    newOperationReference,
    async withdraw(operationReference: string, roundNumber: number): Promise<RoundWithdrawOutcome> {
      const csrf = getCustomerCsrfCredential();
      if (csrf === null || !credential.test(csrf)) return "NotWithdrawable";
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
          body: JSON.stringify({ roundNumber }),
        });
      } catch {
        return "Unknown";
      }
      if (response.status === 404 || response.status === 400) return "NotWithdrawable";
      if (!response.ok) return "Unknown";
      const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
      const status = body?.status;
      if (status === "Returned" || status === "AlreadyReturned") return "Returned";
      if (
        status === "Paid" ||
        status === "PaymentPending" ||
        status === "NotWithdrawable" ||
        status === "TableClosed"
      )
        return status;
      return "Unknown";
    },
  });
}
