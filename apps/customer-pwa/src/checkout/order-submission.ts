import { v7 as uuidv7 } from "uuid";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import { requestCheckoutMutation } from "./checkout-client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface SubmissionSelection {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly orderType: "DineIn" | "Pickup";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }>;
}
export interface SubmittedOrder extends SubmissionSelection {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly submissionReference: string;
  readonly phase: "Submitted";
  readonly paymentStatus: "NotReported";
}
export type SubmissionFailure = "unknown" | "denied" | "conflict" | "requote" | "invalid";
export class OrderSubmissionError extends Error {
  constructor(readonly code: SubmissionFailure) {
    super(code);
  }
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid");
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    throw new Error("invalid");
  return raw;
}
function selection(value: SubmissionSelection): SubmissionSelection {
  if (
    !uuid.test(value.cartReference) ||
    !uuid.test(value.quoteReference) ||
    !Number.isSafeInteger(value.cartVersion) ||
    value.cartVersion < 1 ||
    value.cartVersion > 2147483647 ||
    ![1, 2].includes(value.quoteVersion) ||
    !["DineIn", "Pickup"].includes(value.orderType) ||
    value.total.currency !== "CAD" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value.total.amountMinor) ||
    BigInt(value.total.amountMinor) > 9223372036854775807n
  )
    throw new OrderSubmissionError("invalid");
  return Object.freeze({
    cartReference: value.cartReference,
    cartVersion: value.cartVersion,
    quoteReference: value.quoteReference,
    quoteVersion: value.quoteVersion,
    orderType: value.orderType,
    total: Object.freeze({ amountMinor: value.total.amountMinor, currency: "CAD" as const }),
  });
}
export interface OrderSubmissionClient {
  submit(selected: SubmissionSelection, submissionReference: string): Promise<SubmittedOrder>;
}
export function createOrderSubmissionClient(): OrderSubmissionClient {
  return Object.freeze({
    async submit(input: SubmissionSelection, submissionReference: string): Promise<SubmittedOrder> {
      const current = captureCustomerCsrfContext();
      const csrf = getCustomerCsrfCredential();
      if (csrf === null) throw new OrderSubmissionError("denied");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf) || !uuid.test(submissionReference))
        throw new OrderSubmissionError("invalid");
      const selected = selection(input);
      try {
        const { response, payload } = await requestCheckoutMutation(
          "/api/v1/orders",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf,
              "idempotency-key": submissionReference,
            },
            body: JSON.stringify({
              cartReference: selected.cartReference,
              cartVersion: selected.cartVersion,
              quoteReference: selected.quoteReference,
            }),
          },
          current,
        );
        if (!current()) throw new OrderSubmissionError("unknown");
        if (response.status === 200 || response.status === 201) {
          const root = exact(payload, ["schemaVersion", "order"]);
          const raw = exact(root.order, [
            "orderReference",
            "orderNumber",
            "submissionReference",
            "cartReference",
            "cartVersion",
            "quoteReference",
            "quoteVersion",
            "orderType",
            "phase",
            "paymentStatus",
            "total",
          ]);
          const total = exact(raw.total, ["amountMinor", "currency"]);
          if (
            root.schemaVersion !== 1 ||
            typeof raw.orderReference !== "string" ||
            !uuid.test(raw.orderReference) ||
            typeof raw.orderNumber !== "string" ||
            !/^[A-Za-z0-9-]{1,64}$/u.test(raw.orderNumber) ||
            raw.submissionReference !== submissionReference ||
            raw.cartReference !== selected.cartReference ||
            raw.cartVersion !== selected.cartVersion ||
            raw.quoteReference !== selected.quoteReference ||
            raw.quoteVersion !== selected.quoteVersion ||
            raw.orderType !== selected.orderType ||
            raw.phase !== "Submitted" ||
            raw.paymentStatus !== "NotReported" ||
            total.amountMinor !== selected.total.amountMinor ||
            total.currency !== selected.total.currency
          )
            throw new Error("invalid");
          return Object.freeze({
            ...selected,
            orderReference: raw.orderReference,
            orderNumber: raw.orderNumber,
            submissionReference,
            phase: "Submitted",
            paymentStatus: "NotReported",
          });
        }
        const root = exact(payload, ["schemaVersion", "error"]);
        const error = exact(root.error, ["code", "messageKey"]);
        const known = {
          order_not_found: [404, "denied"],
          order_version_conflict: [409, "conflict"],
          order_idempotency_conflict: [409, "conflict"],
          order_requote_required: [422, "requote"],
          order_request_invalid: [400, "invalid"],
        } as const;
        const entry =
          typeof error.code === "string" && Object.hasOwn(known, error.code)
            ? known[error.code as keyof typeof known]
            : undefined;
        if (
          root.schemaVersion !== 1 ||
          entry === undefined ||
          response.status !== entry[0] ||
          error.messageKey !== "customer.order." + String(error.code).slice(6)
        )
          throw new Error("invalid");
        throw new OrderSubmissionError(entry[1]);
      } catch (error) {
        if (!current()) throw new OrderSubmissionError("unknown");
        if (error instanceof OrderSubmissionError) throw error;
        throw new OrderSubmissionError("unknown");
      }
    },
  });
}
export type OrderSubmissionState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "submitted"; order: SubmittedOrder }>
  | Readonly<{ status: SubmissionFailure | "offline"; canRetry: boolean }>;
export function createOrderSubmissionController(
  client: OrderSubmissionClient,
  keyFactory: () => string = uuidv7,
) {
  let state: OrderSubmissionState = { status: "idle" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let plan: { selected: SubmissionSelection; key: string; current: () => boolean } | null = null;
  let flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OrderSubmissionState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  const execute = () => {
    if (flight !== null) return flight;
    if (plan === null || state.status === "submitted") return Promise.resolve();
    if (!plan.current()) {
      publish({ status: "denied", canRetry: false });
      return Promise.resolve();
    }
    if (!online) {
      publish({ status: "offline", canRetry: true });
      return Promise.resolve();
    }
    const attempt = plan;
    publish({ status: "pending" });
    // Defer the port call until flight is installed, including synchronous failures.
    flight = Promise.resolve().then(async () => {
      try {
        const order = await client.submit(attempt.selected, attempt.key);
        if (!attempt.current()) {
          publish({ status: "denied", canRetry: false });
          return;
        }
        publish(online ? { status: "submitted", order } : { status: "offline", canRetry: true });
      } catch (error) {
        const status = !attempt.current()
          ? "denied"
          : !online
            ? "offline"
            : error instanceof OrderSubmissionError
              ? error.code
              : "unknown";
        publish({
          status,
          canRetry: attempt.current() && (status === "unknown" || status === "offline"),
        });
      } finally {
        flight = null;
      }
    });
    return flight;
  };
  return Object.freeze({
    getState: (): OrderSubmissionState => {
      if (plan !== null && !plan.current() && state.status !== "denied")
        state = Object.freeze({ status: "denied", canRetry: false });
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit(input: SubmissionSelection): Promise<void> {
      if (plan !== null) return execute();
      if (!online) {
        publish({ status: "offline", canRetry: false });
        return Promise.resolve();
      }
      try {
        const selected = selection(input),
          key = keyFactory();
        if (!uuid.test(key)) throw new OrderSubmissionError("invalid");
        plan = { selected, key, current: captureCustomerCsrfContext() };
      } catch {
        publish({ status: "invalid", canRetry: false });
        return Promise.resolve();
      }
      return execute();
    },
    retry(): Promise<void> {
      return "canRetry" in state && state.canRetry ? execute() : Promise.resolve();
    },
    setOnline(value: boolean) {
      online = value;
      if (!value && state.status !== "submitted")
        publish({ status: "offline", canRetry: plan !== null && plan.current() });
      // Reconnection never sends a mutation.
    },
  });
}
