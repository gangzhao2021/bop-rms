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
      pending = plan;
      publish({ status: "offline", canRetry: true });
      return;
    }
    pending = plan;
    try {
      if (plan.stage === "locate") {
        publish({ status: "pending", stage: "locate" });
        plan.cart = await client.loadCurrent();
        plan.stage = plan.cart === null ? "create" : "add";
      }
      if (plan.stage === "create") {
        publish({ status: "pending", stage: "create" });
        plan.cart = await client.createCart({
          operationReference: plan.createOperationReference,
        });
        plan.stage = "add";
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
        throw new CartClientError("cart_service_unavailable");
      pending = null;
      publish({ status: "added", cart: result });
    } catch (error) {
      if (error instanceof CartClientError && error.code === "cart_version_conflict") {
        try {
          await client.loadCurrent();
        } catch {
          // A failed canonical refresh must not replace the original conflict semantics.
        }
      }
      fail(error, true);
    }
  };
  return Object.freeze({
    getState: () => state,
    retry: async () => {
      if (pending !== null && (state.status === "outcome-unknown" || state.status === "offline"))
        await execute(pending);
    },
    setOnline: (value: boolean) => {
      online = value;
      if (!value) publish({ status: "offline", canRetry: pending !== null });
    },
    submit: async (sellableReference: string, draft: CartItemDraft) => {
      const plan: AddPlan = {
        sellableReference,
        draft,
        createOperationReference: keyFactory(),
        addOperationReference: keyFactory(),
        stage: "locate",
        cart: null,
      };
      await execute(plan);
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
