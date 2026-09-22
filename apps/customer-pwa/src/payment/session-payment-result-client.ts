import { requestCheckoutMutation } from "../checkout/checkout-client.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { SessionPaymentClientError } from "./session-payment-client.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface SessionPaymentResult {
  readonly checkoutSessionReference: string;
  readonly paymentIntentReference: string | null;
  readonly orderReference: string | null;
  readonly status: "Pending" | "Unknown" | "Succeeded" | "Failed";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }> | null;
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    throw new Error();
  return raw;
}
export function createSessionPaymentResultClient() {
  async function request(session: string, method: "GET" | "POST"): Promise<SessionPaymentResult> {
    if (!uuid.test(session)) throw new SessionPaymentClientError("invalid");
    const current = captureCustomerCsrfContext(),
      csrf = getCustomerCsrfCredential();
    if (csrf === null) throw new SessionPaymentClientError("denied");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new SessionPaymentClientError("invalid");
    try {
      const { response, payload } = await requestCheckoutMutation(
        "/api/v1/checkout-sessions/" +
          session +
          (method === "GET" ? "/payment-result" : "/payment-reconciliation"),
        {
          method,
          headers: {
            "x-csrf-token": csrf,
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        },
        current,
      );
      if (!current()) throw new SessionPaymentClientError("denied");
      if (response.status === 404) throw new SessionPaymentClientError("denied");
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
        throw new Error();
      const root = exact(payload, ["schemaVersion", "payment"]);
      const raw = exact(root.payment, [
        "checkoutSessionReference",
        "paymentIntentReference",
        "orderReference",
        "status",
        "total",
      ]);
      if (
        root.schemaVersion !== 1 ||
        raw.checkoutSessionReference !== session ||
        !["Pending", "Unknown", "Succeeded", "Failed"].includes(String(raw.status))
      )
        throw new Error();
      if (raw.paymentIntentReference === null) {
        if (raw.orderReference !== null || raw.total !== null || raw.status !== "Pending")
          throw new Error();
        return Object.freeze({
          checkoutSessionReference: session,
          paymentIntentReference: null,
          orderReference: null,
          status: "Pending",
          total: null,
        });
      }
      if (
        typeof raw.paymentIntentReference !== "string" ||
        !uuid.test(raw.paymentIntentReference) ||
        typeof raw.orderReference !== "string" ||
        !uuid.test(raw.orderReference)
      )
        throw new Error();
      const total = exact(raw.total, ["amountMinor", "currency"]);
      if (
        total.currency !== "CAD" ||
        typeof total.amountMinor !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/u.test(total.amountMinor) ||
        BigInt(total.amountMinor) > 9223372036854775807n
      )
        throw new Error();
      return Object.freeze({
        checkoutSessionReference: session,
        paymentIntentReference: raw.paymentIntentReference,
        orderReference: raw.orderReference,
        status: raw.status as SessionPaymentResult["status"],
        total: Object.freeze({ amountMinor: total.amountMinor, currency: "CAD" as const }),
      });
    } catch (error) {
      if (error instanceof SessionPaymentClientError) throw error;
      throw new SessionPaymentClientError("unknown");
    }
  }
  return Object.freeze({
    read: (session: string) => request(session, "GET"),
    reconcile: (session: string) => request(session, "POST"),
  });
}
