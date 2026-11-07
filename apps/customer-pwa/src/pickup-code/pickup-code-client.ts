import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  subscribeCustomerCsrfContext,
} from "../session/customer-transaction-context.js";
import { PickupCodeClientError, type CustomerPickupCodeClient } from "./pickup-code-controller.js";
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function createHttpPickupCodeClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): CustomerPickupCodeClient {
  return {
    subscribeContextChange: subscribeCustomerCsrfContext,
    async load(orderReference) {
      const csrf = getCustomerCsrfCredential(),
        current = captureCustomerCsrfContext();
      if (!reference.test(orderReference)) throw new PickupCodeClientError("service_unavailable");
      if (csrf === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))
        throw new PickupCodeClientError("permission_denied");
      try {
        const response = await boundedFetch(
          request,
          `/api/v1/orders/${orderReference}/pickup-code`,
          {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            headers: { accept: "application/json", "x-csrf-token": csrf },
          },
        );
        if (!current()) throw new PickupCodeClientError("permission_denied");
        if (response.status === 401 || response.status === 403)
          throw new PickupCodeClientError("permission_denied");
        if (response.status === 404) throw new PickupCodeClientError("not_found");
        if (response.status === 409) throw new PickupCodeClientError("conflict");
        if (response.status !== 200) throw new PickupCodeClientError("service_unavailable");
        const value: unknown = await response.json();
        if (!current()) throw new PickupCodeClientError("permission_denied");
        return value;
      } catch (error) {
        if (!current()) throw new PickupCodeClientError("permission_denied");
        if (error instanceof PickupCodeClientError) throw error;
        throw new PickupCodeClientError("service_unavailable");
      }
    },
  };
}
