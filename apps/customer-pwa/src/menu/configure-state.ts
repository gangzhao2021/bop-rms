import type { CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartItemDraft, type CartView } from "../cart/types.js";

export type ConfigureState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "pending"; stage: "locate" | "create" | "add" }>
  | Readonly<{ status: "added"; cart: CartView }>
  | Readonly<{ status: "offline"; canRetry: boolean }>
  | Readonly<{
      status:
        | "session-expired"
        | "conflict"
        | "validation"
        | "rate-limited"
        | "expired"
        | "abandoned"
        | "unavailable"
        | "outcome-unknown";
      issueCodes: readonly string[];
      retryAfterSeconds: number | null;
      canRetry: boolean;
    }>;

interface AddPlan {
  readonly sellableReference: string;
  readonly draft: CartItemDraft;
  readonly createOperationReference: string;
  readonly addOperationReference: string;
  stage: "locate" | "create" | "add";
  cart: CartView | null;
  outcomeUnknown: boolean;
}

export interface ConfigureController {
  getState(): ConfigureState;
  retry(): Promise<void>;
  setOnline(online: boolean): void;
  submit(sellableReference: string, draft: CartItemDraft): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function uuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createConfigureController({
  client,
  keyFactory = uuidV7,
}: {
  readonly client: CustomerCartClient;
  readonly keyFactory?: () => string;
}): ConfigureController {
  let state: ConfigureState = { status: "idle" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let pending: AddPlan | null = null;
  let commandFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ConfigureState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown, canRetry: boolean) => {
    const parsed =
      error instanceof CartClientError ? error : new CartClientError("cart_service_unavailable");
    const status =
      parsed.code === "cart_session_expired"
        ? "session-expired"
        : parsed.code === "cart_version_conflict" || parsed.code === "cart_idempotency_conflict"
          ? "conflict"
          : parsed.code === "cart_selection_invalid" || parsed.code === "cart_request_invalid"
            ? "validation"
            : parsed.code === "cart_rate_limited"
              ? "rate-limited"
              : parsed.code === "cart_expired"
                ? "expired"
                : parsed.code === "cart_abandoned"
                  ? "abandoned"
                  : parsed.code === "network_unknown"
                    ? "outcome-unknown"
                    : "unavailable";
    publish({
      status,
      issueCodes: parsed.issueCodes,
      retryAfterSeconds: parsed.retryAfterSeconds,
      canRetry: canRetry && parsed.code === "network_unknown",
    });
  };
  const execute = async (plan: AddPlan): Promise<void> => {
    if (!online) {
      publish({ status: "offline", canRetry: pending !== null });
      return;
    }
    pending = plan;
    try {
      if (plan.stage === "locate") {
        publish({ status: "pending", stage: "locate" });
        plan.cart = await client.loadCurrent();
        if (plan.cart !== null)
          plan.cart = Object.freeze({ ...plan.cart, cart: Object.freeze({ ...plan.cart.cart }) });
        plan.stage = plan.cart === null ? "create" : "add";
        plan.outcomeUnknown = false;
      }
      if (!online) {
        publish({ status: "offline", canRetry: true });
        return;
      }
      if (plan.stage === "create") {
        publish({ status: "pending", stage: "create" });
        plan.cart = await client.createCart({
          operationReference: plan.createOperationReference,
        });
        plan.cart = Object.freeze({ ...plan.cart, cart: Object.freeze({ ...plan.cart.cart }) });
        plan.stage = "add";
        plan.outcomeUnknown = false;
      }
      if (!online) {
        publish({ status: "offline", canRetry: true });
        return;
      }
      if (plan.cart === null) throw new CartClientError("cart_service_unavailable");
      const priorVersion = plan.cart.cart.version;
      publish({ status: "pending", stage: "add" });
      const result = await client.addItem({
        cart: plan.cart,
        sellableReference: plan.sellableReference,
        draft: plan.draft,
        operationReference: plan.addOperationReference,
      });
      if (
        result.cart.version <= priorVersion ||
        !result.cart.items.some((item) => item.sellableReference === plan.sellableReference)
      )
        throw new CartClientError("network_unknown");
      pending = null;
      publish({ status: "added", cart: result });
    } catch (error) {
      let parsed =
        error instanceof CartClientError ? error : new CartClientError("network_unknown");
      plan.outcomeUnknown ||= parsed.code === "network_unknown";
      if (plan.outcomeUnknown) parsed = new CartClientError("network_unknown");
      else pending = null;
      if (parsed.code === "cart_version_conflict") {
        try {
          await client.loadCurrent();
        } catch {
          // A failed canonical refresh must not replace the original conflict semantics.
        }
      }
      fail(parsed, true);
    }
  };
  const begin = (createPlan: () => AddPlan, retry = false): Promise<void> => {
    if (commandFlight !== null) return commandFlight;
    if (pending !== null && !retry) return Promise.resolve();
    if (!online) {
      publish({ status: "offline", canRetry: pending !== null });
      return Promise.resolve();
    }
    const current = execute(createPlan());
    commandFlight = current;
    void current.then(
      () => {
        if (commandFlight === current) commandFlight = null;
      },
      () => {
        if (commandFlight === current) commandFlight = null;
      },
    );
    return current;
  };
  return Object.freeze({
    getState: () => state,
    retry: () => {
      if (pending !== null && (state.status === "outcome-unknown" || state.status === "offline"))
        return begin(() => pending as AddPlan, true);
      return Promise.resolve();
    },
    setOnline: (value: boolean) => {
      online = value;
      if (!value) publish({ status: "offline", canRetry: pending !== null });
      else if (state.status === "offline" && commandFlight === null) {
        if (pending !== null) fail(new CartClientError("network_unknown"), true);
        else publish({ status: "idle" });
      }
    },
    submit: (sellableReference: string, draft: CartItemDraft) =>
      begin(() => ({
        sellableReference,
        draft: Object.freeze({
          quantity: draft.quantity,
          customerNote: draft.customerNote,
          optionSelections: Object.freeze(
            draft.optionSelections.map((option) => Object.freeze({ ...option })),
          ),
        }),
        createOperationReference: keyFactory(),
        addOperationReference: keyFactory(),
        stage: "locate",
        cart: null,
        outcomeUnknown: false,
      })),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
