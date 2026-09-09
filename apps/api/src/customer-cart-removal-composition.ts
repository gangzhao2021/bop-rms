import {
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  type GuestSessionEntryTransactionRunner,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  CartError,
  createPickupCartRemovalService,
  createPostgresPickupCartBindingReader,
  createPostgresCartQueryStore,
  createPostgresCartItemOperationStore,
  createPostgresCartItemCommandStore,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type CartItemWriteTransactionRunner,
  type PickupCartRemovalOptions,
  type PickupCartRemovalResult,
} from "@rms/ordering";
import {
  createCustomerCartReadPort,
  type CustomerCartDisplayQuery,
} from "./customer-cart-read-composition.js";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

type RemovalInput = Parameters<CustomerCartPort["removeItem"]>[0];
export interface CustomerCartRemovalCompositionOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "credentials">;
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  readonly cartTransactions: CartQueryTransactionRunner;
  readonly writeTransactions: CartItemWriteTransactionRunner;
  readonly references: PickupCartRemovalOptions["references"];
  readonly audit: PickupCartRemovalOptions["audit"];
  readonly query: CustomerCartDisplayQuery;
  readonly now: () => string;
}

export function createCustomerCartRemovalPort(options: {
  readonly query: CustomerCartDisplayQuery;
  readonly removal: { remove(input: unknown): Promise<PickupCartRemovalResult> };
}): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const read = (input: RemovalInput) =>
    options.query.read({
      sessionCredential: input.guestCredential,
      cartReference: input.cartReference,
    });
  const failure = async (error: unknown, input: RemovalInput): Promise<CustomerCartPortResult> => {
    if (!(error instanceof CartError)) return unavailable;
    switch (error.code) {
      case "CART_PERMISSION_DENIED":
        return { status: "SessionExpired" };
      case "CART_UNAVAILABLE":
      case "CART_ITEM_NOT_FOUND":
        return { status: "NotFound" };
      case "CART_IDEMPOTENCY_CONFLICT":
        return { status: "IdempotencyConflict" };
      case "CART_EXPIRED":
        return { status: "LifecycleExpired" };
      case "CART_ABANDONED":
        return { status: "LifecycleAbandoned" };
      case "CART_VERSION_CONFLICT":
        try {
          const view = await read(input);
          return view !== null &&
            view.cart.cartReference === input.cartReference &&
            Number.isSafeInteger(view.cart.version) &&
            view.cart.version > 0
            ? { status: "VersionConflict", currentVersion: view.cart.version }
            : unavailable;
        } catch {
          return unavailable;
        }
      default:
        return unavailable;
    }
  };
  return Object.freeze({
    ...createCustomerCartReadPort(options.query),
    async removeItem(input: RemovalInput): Promise<CustomerCartPortResult> {
      let receipt: PickupCartRemovalResult;
      try {
        receipt = await options.removal.remove({
          sessionCredential: input.guestCredential,
          csrfCredential: input.csrfCredential,
          cartReference: input.cartReference,
          cartItemReference: input.cartItemReference,
          expectedAggregateVersion: input.expectedCartVersion,
          operationReference: input.operationReference,
        });
      } catch (error) {
        return failure(error, input);
      }
      // A failed post-command read cannot be presented as a rejected mutation.
      try {
        if (
          !["Applied", "AlreadyApplied"].includes(receipt.status) ||
          receipt.cartReference !== input.cartReference ||
          receipt.cartItemReference !== input.cartItemReference ||
          !Number.isSafeInteger(receipt.aggregateVersion) ||
          receipt.aggregateVersion < 1
        )
          return unavailable;
        const view = await read(input);
        if (
          view === null ||
          view.cart.cartReference !== receipt.cartReference ||
          !Number.isSafeInteger(view.cart.version) ||
          view.cart.version < receipt.aggregateVersion ||
          view.cart.items.some((item) => item.cartItemReference === receipt.cartItemReference)
        )
          return unavailable;
        return { status: "Applied", view };
      } catch {
        return unavailable;
      }
    },
  });
}

/** Explicit public owner composition only; constructors acquire no database connection. */
export function createCustomerCartRemovalComposition(
  options: CustomerCartRemovalCompositionOptions,
): CustomerCartPort {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const sessions = new GuestSessionService({
    ...options.session,
    store: createPostgresGuestSessionEntryStore(options.sessionTransactions, scope),
    admission: { consume: async () => null },
    now: options.now,
  });
  const carts = createPostgresCartQueryStore(options.cartTransactions, scope);
  const operations = createPostgresCartItemOperationStore(options.cartTransactions, scope);
  const writes = createPostgresCartItemCommandStore(
    options.writeTransactions,
    scope,
    options.references,
  );
  return createCustomerCartRemovalPort({
    query: options.query,
    removal: createPickupCartRemovalService({
      scope,
      sessions,
      binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
      references: options.references,
      audit: options.audit,
      now: options.now,
      repository: {
        load: carts.load,
        resolveOperation: operations.resolveOperation,
        commit: writes.commit,
      },
    }),
  });
}
