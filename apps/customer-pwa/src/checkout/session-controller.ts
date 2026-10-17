import { v7 as uuidv7 } from "uuid";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";
import {
  CheckoutSessionClientError,
  type CheckoutRefusedLine,
  type CheckoutSessionSelection,
  type CheckoutSessionView,
} from "./session-client.js";

export type CheckoutSessionState =
  | { readonly status: "idle" | "pending" }
  | { readonly status: "ready"; readonly session: CheckoutSessionView }
  | {
      readonly status: "unknown" | "denied" | "conflict" | "invalid" | "offline" | "store_closed";
      readonly canRetry: boolean;
    }
  | {
      /** WP-2423: another guest at the table is checking out this cart; nothing was created. */
      readonly status: "checkout_in_progress";
      readonly canRetry: boolean;
      readonly retryAfterSeconds: number | null;
    }
  | {
      /**
       * WP-2423: the store can't make the cart as it stands (too few left, or an item can't be
       * sold now); nothing was created or charged. The guest changes the cart, then checks out
       * again (a changed cart is a new checkout).
       */
      readonly status: "item_short" | "item_unavailable";
      readonly canRetry: false;
      readonly line: CheckoutRefusedLine | null;
    };
export function createCheckoutSessionController(
  client: {
    create(selection: CheckoutSessionSelection, operation: string): Promise<CheckoutSessionView>;
  },
  keyFactory = uuidv7,
) {
  let state: CheckoutSessionState = { status: "idle" };
  let plan: { selection: CheckoutSessionSelection; key: string; current: () => boolean } | null =
    null;
  let flight: Promise<void> | null = null;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  const listeners = new Set<() => void>();
  const publish = (value: CheckoutSessionState) => {
    state = Object.freeze(value);
    listeners.forEach((listener) => listener());
  };
  const execute = (): Promise<void> => {
    if (flight !== null) return flight;
    if (plan === null) return Promise.resolve();
    const attempt = plan;
    if (!attempt.current()) {
      publish({ status: "denied", canRetry: false });
      return Promise.resolve();
    }
    if (state.status === "ready") return Promise.resolve();
    if (!online) {
      publish({ status: "offline", canRetry: true });
      return Promise.resolve();
    }
    publish({ status: "pending" });
    flight = Promise.resolve().then(async () => {
      try {
        const session = await client.create(attempt.selection, attempt.key);
        if (!attempt.current()) publish({ status: "denied", canRetry: false });
        else publish(online ? { status: "ready", session } : { status: "offline", canRetry: true });
      } catch (error) {
        if (
          attempt.current() &&
          online &&
          error instanceof CheckoutSessionClientError &&
          error.code === "checkout_in_progress"
        ) {
          // Nothing was created under this operation; the retry after the wait is a new one.
          if (plan === attempt) plan = { ...attempt, key: keyFactory() };
          publish({
            status: "checkout_in_progress",
            canRetry: true,
            retryAfterSeconds: error.retryAfterSeconds,
          });
          return;
        }
        if (
          attempt.current() &&
          online &&
          error instanceof CheckoutSessionClientError &&
          (error.code === "item_short" || error.code === "item_unavailable")
        ) {
          publish({ status: error.code, canRetry: false, line: error.line });
          return;
        }
        const code = !attempt.current()
          ? "denied"
          : !online
            ? "offline"
            : error instanceof CheckoutSessionClientError &&
                error.code !== "checkout_in_progress" &&
                error.code !== "item_short" &&
                error.code !== "item_unavailable"
              ? error.code
              : "unknown";
        publish({
          status: code,
          // WP-2423 Q4: a closed Store may reopen; the same checkout can be retried then.
          canRetry:
            attempt.current() &&
            (code === "unknown" || code === "offline" || code === "store_closed"),
        });
      } finally {
        flight = null;
      }
    });
    return flight;
  };
  return Object.freeze({
    getState(): CheckoutSessionState {
      if (plan && !plan.current() && state.status !== "denied")
        state = Object.freeze({ status: "denied", canRetry: false });
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(selection: CheckoutSessionSelection) {
      if (plan !== null) return execute();
      if (!online) {
        publish({ status: "offline", canRetry: false });
        return Promise.resolve();
      }
      plan = {
        selection: Object.freeze({ ...selection }),
        key: keyFactory(),
        current: captureCustomerCsrfContext(),
      };
      return execute();
    },
    retry() {
      return "canRetry" in state && state.canRetry ? execute() : Promise.resolve();
    },
    setOnline(value: boolean) {
      online = value;
      if (value && plan === null && state.status === "offline") publish({ status: "idle" });
      if (!value && state.status !== "ready")
        publish({ status: "offline", canRetry: plan !== null && plan.current() });
    },
  });
}
