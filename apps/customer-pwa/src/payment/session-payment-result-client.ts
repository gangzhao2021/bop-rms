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
  /**
   * WP-2423: the round this checkout paid for, when the server names it (absent from an older
   * server), so the page can tell whether staff have sent it to the kitchen yet.
   */
  readonly orderBatchReference?: string;
  readonly status: "Pending" | "Unknown" | "Succeeded" | "Failed";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }> | null;
  /** WP-2423 abandoned payment: until when this payment can still be finished. */
  readonly payBy: string | null;
  /** Failed only: declined, or never finished and cancelled when its time ran out. */
  readonly failure: "Declined" | "NotCompleted" | null;
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
      // WP-2423: `orderBatchReference` (the paid round) is absent from an older server.
      const withRound =
        root.payment !== null &&
        typeof root.payment === "object" &&
        Object.hasOwn(root.payment, "orderBatchReference");
      const raw = exact(root.payment, [
        "checkoutSessionReference",
        "paymentIntentReference",
        "orderReference",
        ...(withRound ? ["orderBatchReference"] : []),
        "status",
        "total",
        "payBy",
        "failure",
      ]);
      const failure =
        raw.failure === "Declined" || raw.failure === "NotCompleted" ? raw.failure : null;
      if (
        (raw.failure !== null && failure === null) ||
        (raw.status === "Failed") !== (failure !== null) ||
        root.schemaVersion !== 1 ||
        raw.checkoutSessionReference !== session ||
        !["Pending", "Unknown", "Succeeded", "Failed"].includes(String(raw.status))
      )
        throw new Error();
      if (raw.paymentIntentReference === null) {
        if (
          raw.orderReference !== null ||
          (withRound && raw.orderBatchReference !== null) ||
          raw.total !== null ||
          raw.status !== "Pending" ||
          raw.payBy !== null
        )
          throw new Error();
        return Object.freeze({
          checkoutSessionReference: session,
          paymentIntentReference: null,
          orderReference: null,
          status: "Pending",
          total: null,
          payBy: null,
          failure: null,
        });
      }
      if (
        typeof raw.paymentIntentReference !== "string" ||
        !uuid.test(raw.paymentIntentReference) ||
        typeof raw.orderReference !== "string" ||
        !uuid.test(raw.orderReference) ||
        (withRound &&
          (typeof raw.orderBatchReference !== "string" || !uuid.test(raw.orderBatchReference))) ||
        typeof raw.payBy !== "string" ||
        !Number.isFinite(Date.parse(raw.payBy))
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
        ...(withRound ? { orderBatchReference: raw.orderBatchReference as string } : {}),
        status: raw.status as SessionPaymentResult["status"],
        total: Object.freeze({ amountMinor: total.amountMinor, currency: "CAD" as const }),
        payBy: raw.payBy,
        failure,
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
