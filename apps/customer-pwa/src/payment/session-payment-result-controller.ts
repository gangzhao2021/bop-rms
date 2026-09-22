import {
  captureCustomerCsrfContext,
  getCheckoutSessionReference,
} from "../session/customer-transaction-context.js";
import { SessionPaymentClientError } from "./session-payment-client.js";
import type { SessionPaymentResult } from "./session-payment-result-client.js";
export type SessionPaymentResultState =
  | { readonly status: "loading" | "missing" | "denied" | "offline" | "unknown" }
  | { readonly status: "ready"; readonly result: SessionPaymentResult };
export function createSessionPaymentResultController(client: {
  read(session: string): Promise<SessionPaymentResult>;
  reconcile?(session: string): Promise<SessionPaymentResult>;
}) {
  const session = getCheckoutSessionReference(),
    current = captureCustomerCsrfContext();
  let state: SessionPaymentResultState = { status: "loading" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let revision = 0,
    flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const valid = () => session !== null && current() && getCheckoutSessionReference() === session;
  const publish = (next: SessionPaymentResultState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  const check = (recover = false): Promise<void> => {
    if (session === null) {
      publish({ status: "missing" });
      return Promise.resolve();
    }
    if (!valid()) {
      publish({ status: "denied" });
      return Promise.resolve();
    }
    if (!online) {
      publish({ status: "offline" });
      return Promise.resolve();
    }
    if (flight !== null) return flight;
    const attempt = revision;
    publish({ status: "loading" });
    flight = Promise.resolve().then(async () => {
      try {
        const result = await (recover && client.reconcile
          ? client.reconcile(session)
          : client.read(session));
        if (!valid()) {
          publish({ status: "denied" });
          return;
        }
        if (attempt !== revision || !online) return;
        if (result.checkoutSessionReference !== session) {
          publish({ status: "denied" });
          return;
        }
        publish({ status: "ready", result });
      } catch (error) {
        if (!valid()) {
          publish({ status: "denied" });
          return;
        }
        if (attempt !== revision || !online) return;
        publish({
          status:
            error instanceof SessionPaymentClientError && error.code === "denied"
              ? "denied"
              : "unknown",
        });
      } finally {
        flight = null;
      }
    });
    return flight;
  };
  return Object.freeze({
    getState() {
      if (session !== null && !valid() && state.status !== "denied")
        state = Object.freeze({ status: "denied" });
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: () => check(),
    refresh: () => check(true),
    setOnline(value: boolean) {
      if (online === value) return;
      online = value;
      revision++;
      publish({
        status: !valid()
          ? session === null
            ? "missing"
            : "denied"
          : value
            ? "unknown"
            : "offline",
      });
    },
  });
}
