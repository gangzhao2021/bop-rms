import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation } from "../checkout/checkout-client.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface SessionPaymentView {
  readonly checkoutSessionReference: string;
  readonly paymentIntentReference: string;
  readonly orderReference: string;
  readonly creationStatus: "Created" | "AlreadyCreated" | "Processing";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }>;
}
export class SessionPaymentClientError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "denied"
      | "conflict"
      | "not_ready"
      | "store_closed"
      /** WP-2423 Q20: why another card cannot be tried for this payment. */
      | "retry_limit"
      | "retry_pending"
      | "already_paid"
      | "window_ended"
      /** WP-2423: items ran out after checkout; no order was placed and nothing was charged. */
      | "items_short"
      | "unknown",
  ) {
    super("Payment unavailable.");
    this.name = "SessionPaymentClientError";
  }
}
/** WP-2423 Q4: the server's error code, when it sent one. */
function errorCode(payload: unknown): string | null {
  const error =
    payload !== null && typeof payload === "object"
      ? (payload as { error?: { code?: unknown } }).error
      : undefined;
  return typeof error?.code === "string" ? error.code : null;
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
function amount(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new SessionPaymentClientError("invalid");
  return value;
}
export function createSessionPaymentClient() {
  const explicit = {
    payment_store_closed: "store_closed",
    payment_retry_limit: "retry_limit",
    payment_retry_pending: "retry_pending",
    payment_already_paid: "already_paid",
    payment_window_ended: "window_ended",
    payment_items_short: "items_short",
  } as const;
  async function post(session: string, suffix: string, body: object, key?: string) {
    if (!uuid.test(session)) throw new SessionPaymentClientError("invalid");
    const current = captureCustomerCsrfContext(),
      csrf = getCustomerCsrfCredential();
    if (csrf === null) throw new SessionPaymentClientError("denied");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new SessionPaymentClientError("invalid");
    try {
      const result = await requestCheckoutMutation(
        "/api/v1/checkout-sessions/" + session + "/" + suffix,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf,
            ...(suffix === "simulation-confirm"
              ? { "x-bop-simulation-confirmation": "SIMULATE_CAPTURE" }
              : suffix === "simulation-fail"
                ? { "x-bop-simulation-confirmation": "SIMULATE_FAILURE" }
                : {}),
            ...(key === undefined ? {} : { "idempotency-key": key }),
          },
          body: JSON.stringify(body),
        },
        current,
      );
      if (!current()) throw new SessionPaymentClientError("unknown");
      const named = errorCode(result.payload);
      if (![200, 201, 202].includes(result.response.status))
        throw new SessionPaymentClientError(
          result.response.status === 400
            ? "invalid"
            : result.response.status === 404
              ? "denied"
              : (result.response.status === 409 || result.response.status === 422) &&
                  named !== null &&
                  Object.hasOwn(explicit, named)
                ? explicit[named as keyof typeof explicit]
                : result.response.status === 409
                  ? "conflict"
                  : result.response.status === 422
                    ? "not_ready"
                    : "unknown",
        );
      return result;
    } catch (error) {
      if (error instanceof SessionPaymentClientError) throw error;
      throw new SessionPaymentClientError("unknown");
    }
  }
  async function create(
    session: string,
    selectionReference: string,
    tipAmountMinor: string,
    suffix = "payment-intents",
  ): Promise<SessionPaymentView> {
    if (!uuid.test(selectionReference)) throw new SessionPaymentClientError("invalid");
    const tip = amount(tipAmountMinor);
    return view(
      session,
      await post(
        session,
        suffix,
        { tip: { amountMinor: tip, currency: "CAD" } },
        selectionReference,
      ),
    );
  }
  function view(
    session: string,
    { response, payload }: Awaited<ReturnType<typeof post>>,
  ): SessionPaymentView {
    try {
      const root = exact(payload, ["schemaVersion", "payment"]);
      const raw = exact(root.payment, [
        "checkoutSessionReference",
        "paymentIntentReference",
        "orderReference",
        "creationStatus",
        "total",
      ]);
      const total = exact(raw.total, ["amountMinor", "currency"]);
      const expected =
        response.status === 201
          ? "Created"
          : response.status === 202
            ? "Processing"
            : "AlreadyCreated";
      if (
        root.schemaVersion !== 1 ||
        raw.checkoutSessionReference !== session ||
        raw.creationStatus !== expected ||
        typeof raw.paymentIntentReference !== "string" ||
        !uuid.test(raw.paymentIntentReference) ||
        typeof raw.orderReference !== "string" ||
        !uuid.test(raw.orderReference) ||
        total.currency !== "CAD"
      )
        throw new Error();
      return Object.freeze({
        checkoutSessionReference: session,
        paymentIntentReference: raw.paymentIntentReference,
        orderReference: raw.orderReference,
        creationStatus: expected,
        total: Object.freeze({
          amountMinor: amount(total.amountMinor),
          currency: "CAD" as const,
        }),
      });
    } catch {
      throw new SessionPaymentClientError("unknown");
    }
  }
  return Object.freeze({
    create: (session: string, selection: string, tip: string) => create(session, selection, tip),
    /** Explicit local simulation only; navigate to the authoritative result reader afterward. */
    simulate: (session: string, selection: string, tip: string) =>
      create(session, selection, tip, "simulation-confirm"),
    /** Internal testing only: the simulated card is declined. */
    simulateDecline: (session: string, selection: string, tip: string) =>
      create(session, selection, tip, "simulation-fail"),
    /**
     * WP-2423 Q20: another card for this checkout's existing payment after a decline. The server
     * keeps the amount, tip and payment window; repeating it returns the same open attempt.
     */
    async retry(session: string): Promise<SessionPaymentView> {
      return view(session, await post(session, "payment-intents", { retry: true }));
    },
    /**
     * WP-2423 abandoned payment: come back to this checkout's open payment (after a reload or
     * from the table page). The server returns the same attempt; nothing new is charged or opened.
     */
    async resume(session: string): Promise<SessionPaymentView> {
      return view(session, await post(session, "payment-intents", { resume: true }));
    },
    /** Internal testing only: finish the open simulated payment, approved or declined. */
    async simulateResume(session: string, outcome: "approve" | "decline") {
      return view(
        session,
        await post(session, outcome === "approve" ? "simulation-confirm" : "simulation-fail", {
          resume: true,
        }),
      );
    },
    /** Internal testing only: another simulated card, approved or declined. */
    async simulateRetry(session: string, outcome: "approve" | "decline") {
      return view(
        session,
        await post(session, outcome === "approve" ? "simulation-confirm" : "simulation-fail", {
          retry: true,
        }),
      );
    },
    /** The caller passes this ephemeral value directly to the secure Provider component. */
    async handoff(session: string): Promise<string> {
      const { response, payload } = await post(session, "payment-handoff", {});
      try {
        const raw = exact(payload, ["schemaVersion", "clientSecret"]);
        if (
          response.status !== 200 ||
          response.headers.get("cache-control") !== "no-store" ||
          raw.schemaVersion !== 1 ||
          typeof raw.clientSecret !== "string" ||
          raw.clientSecret.length > 512 ||
          !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u.test(raw.clientSecret)
        )
          throw new Error();
        return raw.clientSecret;
      } catch {
        throw new SessionPaymentClientError("unknown");
      }
    },
  });
}
