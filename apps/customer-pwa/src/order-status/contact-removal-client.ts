import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): "Remove my contact details" on the customer's own
 * order page. The server removes it once (a repeat changes nothing) and only for this visit's order.
 */
export type ContactRemovalResult = "Removed" | "AlreadyRemoved" | "NotGiven";
export class ContactRemovalError extends Error {
  constructor(readonly code: "VisitEnded" | "Unavailable") {
    super("contact removal " + code);
    this.name = "ContactRemovalError";
  }
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ContactRemovalClient {
  remove(orderReference: string): Promise<ContactRemovalResult>;
}

export function createHttpContactRemovalClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): ContactRemovalClient {
  return Object.freeze({
    async remove(orderReference: string): Promise<ContactRemovalResult> {
      const csrf = getCustomerCsrfCredential();
      const current = captureCustomerCsrfContext();
      if (!reference.test(orderReference) || csrf === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))
        throw new ContactRemovalError("VisitEnded");
      let response: Response;
      try {
        response = await boundedFetch(request, `/api/v1/orders/${orderReference}/contact-removal`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: "{}",
        });
      } catch {
        throw new ContactRemovalError("Unavailable");
      }
      if (!current()) throw new ContactRemovalError("VisitEnded");
      if (response.status === 404 || response.status === 401 || response.status === 403)
        throw new ContactRemovalError("VisitEnded");
      if (response.status !== 200) throw new ContactRemovalError("Unavailable");
      const payload = (await response.json().catch(() => null)) as {
        schemaVersion?: unknown;
        removal?: { status?: unknown };
      } | null;
      const status = payload?.removal?.status;
      if (
        payload?.schemaVersion !== 1 ||
        (status !== "Removed" && status !== "AlreadyRemoved" && status !== "NotGiven")
      )
        throw new ContactRemovalError("Unavailable");
      return status;
    },
  });
}
