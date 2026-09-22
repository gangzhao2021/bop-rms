import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  subscribeCustomerCsrfContext,
} from "../session/customer-transaction-context.js";
import { ReceiptClientError, type CustomerReceiptClient } from "./receipt-controller.js";
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credential = /^[A-Za-z0-9_-]{43}$/u;

export function createHttpReceiptClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): CustomerReceiptClient {
  return Object.freeze({
    subscribeContextChange: subscribeCustomerCsrfContext,
    async load(orderReference: string): Promise<unknown> {
      if (!reference.test(orderReference)) throw new ReceiptClientError("service_unavailable");
      const csrf = getCustomerCsrfCredential(),
        current = captureCustomerCsrfContext();
      if (csrf === null || !credential.test(csrf))
        throw new ReceiptClientError("permission_denied");
      try {
        const response = await boundedFetch(
          request,
          "/api/v1/orders/" + orderReference + "/receipt",
          {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            headers: { accept: "application/json", "x-csrf-token": csrf },
          },
        );
        if (!current()) throw new ReceiptClientError("permission_denied");
        if (response.status === 401 || response.status === 403)
          throw new ReceiptClientError("permission_denied");
        if (response.status === 404) throw new ReceiptClientError("not_found");
        if (response.status !== 200) throw new ReceiptClientError("service_unavailable");
        const body: unknown = await response.json();
        if (!current()) throw new ReceiptClientError("permission_denied");
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.getPrototypeOf(body) !== Object.prototype ||
          Reflect.ownKeys(body).length !== 2
        )
          throw new ReceiptClientError("service_unavailable");
        const fields = Object.getOwnPropertyDescriptors(body);
        if (
          !fields.schemaVersion ||
          !("value" in fields.schemaVersion) ||
          fields.schemaVersion.value !== 1 ||
          !fields.receipt ||
          !("value" in fields.receipt) ||
          !fields.receipt.enumerable ||
          !fields.schemaVersion.enumerable
        )
          throw new ReceiptClientError("service_unavailable");
        // The existing receipt controller validates the closed view and exact Order once.
        return fields.receipt.value;
      } catch (error) {
        if (!current()) throw new ReceiptClientError("permission_denied");
        if (error instanceof ReceiptClientError) throw error;
        throw new ReceiptClientError("service_unavailable");
      }
    },
  });
}
