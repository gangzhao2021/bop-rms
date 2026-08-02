import type { CustomerCartClient } from "./cart-client.js";
import { CartClientError, type CartItemDraft, type CartView } from "./types.js";

export type CartState =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly cart: CartView }
  | { readonly status: "offline-readonly"; readonly cart: CartView | null }
  | {
      readonly status:
        | "session-expired"
        | "not-found"
        | "conflict"
        | "validation"
        | "rate-limited"
        | "expired"
        | "abandoned"
        | "command-failed"
        | "unavailable";
      readonly cart: CartView | null;
      readonly issueCodes: readonly string[];
      readonly retryAfterSeconds: number | null;
      readonly canRetrySameOperation: boolean;
    }
  | { readonly status: "command-pending"; readonly cart: CartView };

type PendingOperation =
  | {
      readonly kind: "update";
      readonly cartItemReference: string;
      readonly draft: CartItemDraft;
      readonly operationReference: string;
    }
  | {
      readonly kind: "remove";
      readonly cartItemReference: string;
      readonly operationReference: string;
    };

export interface CartStateController {
  getState(): CartState;
  load(): Promise<void>;
  removeItem(cartItemReference: string): Promise<void>;
  retry(): Promise<void>;
  setOnline(online: boolean): void;
  subscribe(listener: () => void): () => void;
  updateItem(cartItemReference: string, draft: CartItemDraft): Promise<void>;
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

export function createCartStateController({
  client,
  keyFactory = uuidV7,
}: {
  readonly client: CustomerCartClient;
  readonly keyFactory?: () => string;
}): CartStateController {
  let state: CartState = { status: "loading" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let pending: PendingOperation | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: CartState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const currentCart = () => ("cart" in state ? state.cart : null);

  const load = async () => {
    if (!online) {
      publish({ status: "offline-readonly", cart: currentCart() });
      return;
    }
    const priorCart = currentCart();
    publish({ status: "loading" });
    try {
      const cart = await client.loadCurrent();
      pending = null;
      publish(cart === null ? { status: "empty" } : { status: "ready", cart });
    } catch (error) {
      mapError(error, priorCart, false);
    }
  };

  const mapError = (error: unknown, cart: CartView | null, operationCanRetry: boolean) => {
    const parsed =
      error instanceof CartClientError ? error : new CartClientError("cart_service_unavailable");
    const status =
      parsed.code === "cart_session_expired"
        ? "session-expired"
        : parsed.code === "cart_not_found"
          ? "not-found"
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
                      ? "command-failed"
                      : "unavailable";
    publish({
      status,
      cart,
      issueCodes: parsed.issueCodes,
      retryAfterSeconds: parsed.retryAfterSeconds,
      canRetrySameOperation: operationCanRetry && parsed.code === "network_unknown",
    });
  };

  const execute = async (operation: PendingOperation) => {
    const cart = currentCart();
    if (!online) {
      pending = operation;
      publish({ status: "offline-readonly", cart });
      return;
    }
    if (cart === null) {
      mapError(new CartClientError("cart_not_found"), null, false);
      return;
    }
    pending = operation;
    publish({ status: "command-pending", cart });
    try {
      const result =
        operation.kind === "update"
          ? await client.updateItem({ cart, ...operation })
          : await client.removeItem({ cart, ...operation });
      pending = null;
      publish({ status: "ready", cart: result });
    } catch (error) {
      if (error instanceof CartClientError && error.code === "cart_version_conflict") {
        try {
          const refreshed = await client.loadCurrent();
          mapError(error, refreshed, false);
          return;
        } catch (refreshError) {
          mapError(refreshError, cart, false);
          return;
        }
      }
      mapError(error, cart, true);
    }
  };

  return Object.freeze({
    getState: () => state,
    load,
    removeItem: (cartItemReference: string) =>
      execute({ kind: "remove", cartItemReference, operationReference: keyFactory() }),
    retry: async () => {
      if (pending === null || state.status !== "command-failed" || !state.canRetrySameOperation)
        return;
      await execute(pending);
    },
    setOnline: (value: boolean) => {
      online = value;
      if (!value) publish({ status: "offline-readonly", cart: currentCart() });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateItem: (cartItemReference: string, draft: CartItemDraft) =>
      execute({ kind: "update", cartItemReference, draft, operationReference: keyFactory() }),
  });
}
