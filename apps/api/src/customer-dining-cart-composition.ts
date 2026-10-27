import { createHash } from "node:crypto";
import type { createPostgresCatalogSelectionService } from "@rms/catalog";
import {
  createCustomerCartSelectionInventory,
  withCartItemStockShortage,
  type CustomerCartSelectionInventoryOptions,
} from "./customer-cart-selection-inventory.js";
import { createCustomerDiningCartInventoryAuthorization } from "./customer-dining-cart-inventory-authorization.js";
import { DiningTableCheckingOutError } from "@rms/dining";
import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionService,
} from "@bop/identity";
import {
  CartCheckoutInProgressError,
  CartError,
  CartReplacementPendingError,
  createCustomerDiningCartViewQuery,
  createDiningCartReadService,
  createDiningCartSelectionService,
  createDiningCartItemService,
  createPostgresDiningCartCommandQueryStore,
  createPostgresBoundCartItemOperationStore,
  createPostgresCartItemCommandStore,
  createPostgresDiningCartReadStore,
  createPostgresDiningCartSelectionStore,
  createPostgresDiningCartSuccessionSource,
  parseDiningCartSelectionReceipt,
  parseOrderingInstant,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type CustomerDiningCartViewPorts,
  type DiningCartReadPorts,
  type DiningCartSelectionStoreOptions,
  type DiningCartItemOptions,
  type CartItemWriteTransactionRunner,
  type DiningCartCheckoutHoldPort,
} from "@rms/ordering";
import { createCustomerCartItemPort } from "./customer-cart-item-composition.js";
import { createCustomerCartRemovalPort } from "./customer-cart-removal-composition.js";
import {
  createCustomerCartReadPort,
  readCartView,
  type CustomerCartDisplayQuery,
} from "./customer-cart-read-composition.js";
import {
  cartDisplayArguments,
  orderProcessingRetrySeconds,
  type CustomerCartPort,
  type CustomerCartPortResult,
  type CustomerCartReplacementPort,
} from "./customer-cart.js";

/** WP-2423: cart warning on the one response that replaced a timed-out table Cart holding items. */
export const EARLIER_CART_ITEMS_CLEARED = "EARLIER_CART_ITEMS_CLEARED";
/** WP-2423: how long a guest waits before retrying while the expiry is still being recorded. */
export const TABLE_CART_EXPIRY_RETRY_SECONDS = 5;
/** WP-2423: the table Cart a selection found expired (observation only, grants nothing). */
export interface DiningCartContinuation {
  previous(input: {
    readonly sessionCredential: string;
    readonly csrfCredential: string;
  }): Promise<null | {
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly lifecycleStatus: "Active" | "Abandoned" | "Expired";
    readonly itemCount: number;
  }>;
  readonly replacement: CustomerCartReplacementPort;
}
/** Deterministic replacement operation for one selection operation and one previous Cart (UUIDv7 form). */
export function continuationOperationReference(
  selectionOperationReference: string,
  previousCartReference: string,
): string {
  const d = createHash("sha256")
    .update(
      JSON.stringify([
        "dining-cart-timeout-continuation-v1",
        selectionOperationReference,
        previousCartReference,
      ]),
    )
    .digest("hex");
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-7${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}
class RetryLater extends Error {}
class OrderProcessing extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super("table order processing");
  }
}

const unavailable = Object.freeze({ status: "Unavailable" } as const);
function scope(value: unknown) {
  const raw = readClosedRecord(value, ["brandReference", "storeReference"]);
  return Object.freeze({
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
  });
}
function failure(error: unknown): CustomerCartPortResult {
  if (error instanceof OrderProcessing)
    return { status: "OrderProcessing", retryAfterSeconds: error.retryAfterSeconds };
  if (error instanceof RetryLater)
    return { status: "RetryLater", retryAfterSeconds: TABLE_CART_EXPIRY_RETRY_SECONDS };
  if (error instanceof CartCheckoutInProgressError)
    return { status: "CheckoutInProgress", heldUntil: error.heldUntil };
  if (!(error instanceof CartError)) return unavailable;
  if (error.code === "CART_TABLE_CHECKING_OUT") return { status: "TableCheckingOut" };
  switch (error.code) {
    case "CART_PERMISSION_DENIED":
      return { status: "SessionExpired" };
    case "CART_IDEMPOTENCY_CONFLICT":
      return { status: "IdempotencyConflict" };
    case "CART_EXPIRED":
      return { status: "LifecycleExpired" };
    case "CART_ABANDONED":
      return { status: "LifecycleAbandoned" };
    // WP-2423: no longer an active participant of this table (left or removed): enter again.
    case "CART_REPLACEMENT_FORBIDDEN":
      return { status: "SessionExpired" };
    default:
      return unavailable;
  }
}
export function createCustomerDiningCartPort(options: {
  readonly query: CustomerCartDisplayQuery;
  readonly items?: ReturnType<typeof createDiningCartItemService>;
  readonly selection: {
    select(input: {
      readonly sessionCredential: string;
      readonly csrfCredential: string;
      readonly operationReference: string;
    }): Promise<unknown>;
  };
  /** WP-2423: continue past a timed-out table Cart through the owner replacement command. */
  readonly continuation?: DiningCartContinuation;
  /** Clock for retry hints (defaults to the system clock). */
  readonly now?: () => string;
}): CustomerCartPort {
  /**
   * Select the table Cart; when it timed out (recorded Expired), replace it through the owner
   * command (same authorization/fences/audit, never copies items) and select the successor.
   * A concurrent guest's replacement wins cleanly: our version conflict just re-selects.
   */
  const selectOrContinue = async (command: {
    readonly sessionCredential: string;
    readonly csrfCredential: string;
    readonly operationReference: string;
  }) => {
    try {
      return { result: await options.selection.select(command), cleared: false };
    } catch (error) {
      const continuation = options.continuation;
      if (
        continuation === undefined ||
        !(error instanceof CartError) ||
        error.code !== "CART_EXPIRED"
      )
        throw error;
      let cleared = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const previous = await continuation.previous({
          sessionCredential: command.sessionCredential,
          csrfCredential: command.csrfCredential,
        });
        if (previous !== null) {
          // Due but not yet recorded by the expiry owner: retry shortly. Abandoned keeps refusing.
          if (previous.lifecycleStatus === "Active") throw new RetryLater();
          if (previous.lifecycleStatus === "Abandoned") throw new CartError("CART_ABANDONED");
          try {
            await continuation.replacement.replace({
              sessionCredential: command.sessionCredential,
              csrfCredential: command.csrfCredential,
              operationReference: continuationOperationReference(
                command.operationReference,
                previous.cartReference,
              ),
              previousCartReference: previous.cartReference,
              expectedCartVersion: previous.cartVersion,
            });
            cleared = previous.itemCount > 0;
          } catch (replaceError) {
            if (!(replaceError instanceof CartError)) throw replaceError;
            if (replaceError.code === "CART_LIFECYCLE_UNAVAILABLE") throw new RetryLater();
            // The table's last checkout may still create an order or charge: wait for it.
            if (replaceError.code === "CART_REPLACEMENT_CHECKOUT_PENDING")
              throw new OrderProcessing(
                orderProcessingRetrySeconds(
                  replaceError instanceof CartReplacementPendingError
                    ? replaceError.pendingUntil
                    : null,
                  (options.now ?? (() => new Date().toISOString()))(),
                ),
              );
            // Another guest replaced it first; the next selection finds the successor.
            if (replaceError.code !== "CART_VERSION_CONFLICT") throw replaceError;
          }
        }
        try {
          return { result: await options.selection.select(command), cleared };
        } catch (retryError) {
          if (!(retryError instanceof CartError) || retryError.code !== "CART_EXPIRED")
            throw retryError;
        }
      }
      throw new RetryLater();
    }
  };
  const base = Object.freeze<CustomerCartPort>({
    ...createCustomerCartReadPort(options.query),
    async createCart(
      input: Parameters<CustomerCartPort["createCart"]>[0],
      displayLocale?: string | null,
    ): Promise<CustomerCartPortResult> {
      let command: {
        readonly sessionCredential: string;
        readonly csrfCredential: string;
        readonly operationReference: string;
      };
      let receipt;
      let cleared: boolean;
      try {
        const raw = readClosedRecord(input, [
          "guestCredential",
          "csrfCredential",
          "operationReference",
          "requestedAt",
        ]);
        parseOrderingInstant(raw.requestedAt);
        command = Object.freeze({
          sessionCredential: parseGuestRawCredential(raw.guestCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          operationReference: parseOrderingReference(raw.operationReference),
        });
        const selected = await selectOrContinue(command);
        cleared = selected.cleared;
        receipt = parseDiningCartSelectionReceipt(selected.result);
        if (receipt.operationReference !== command.operationReference) return unavailable;
      } catch (error) {
        return failure(error);
      }
      // A failed current read cannot erase a possibly committed selection.
      try {
        const view = await readCartView(
          options.query,
          Object.freeze({
            sessionCredential: command.sessionCredential,
            cartReference: receipt.cartReference,
          }),
          displayLocale,
        );
        if (
          view === null ||
          view.schemaVersion !== 1 ||
          view.cart.orderType !== "DineIn" ||
          view.cart.cartReference !== receipt.cartReference ||
          !Number.isSafeInteger(view.cart.version) ||
          view.cart.version < receipt.cartVersion
        )
          return unavailable;
        return {
          status: receipt.action === "Create" ? "Applied" : "Current",
          view: cleared
            ? Object.freeze({
                ...view,
                cart: Object.freeze({
                  ...view.cart,
                  warnings: Object.freeze([...view.cart.warnings, EARLIER_CART_ITEMS_CLEARED]),
                }),
              })
            : view,
        };
      } catch {
        return unavailable;
      }
    },
  });
  if (options.items === undefined) return base;
  const query: CustomerCartDisplayQuery = {
    async read(input, displayLocale) {
      const view = await readCartView(options.query, input, displayLocale);
      if (view !== null && (view.schemaVersion !== 1 || view.cart.orderType !== "DineIn"))
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      return view;
    },
  };
  const removal = createCustomerCartRemovalPort({ query, removal: options.items });
  const items = createCustomerCartItemPort({ query, items: options.items, fallback: base });
  return Object.freeze({
    ...items,
    async removeItem(
      input: Parameters<CustomerCartPort["removeItem"]>[0],
      displayLocale?: string | null,
    ) {
      try {
        const captured = Object.freeze(
          readClosedRecord(input, [
            "guestCredential",
            "requestedAt",
            "csrfCredential",
            "operationReference",
            "cartReference",
            "cartItemReference",
            "expectedCartVersion",
          ]),
        );
        return await removal.removeItem(captured as unknown as typeof input, displayLocale);
      } catch {
        return unavailable;
      }
    },
  });
}
export interface CustomerDiningCartCompositionOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly sessions: Pick<GuestSessionService, "resolve" | "authorize">;
  readonly participation: DiningCartReadPorts["participation"];
  /** DEC-DINING-ANY-PARTICIPANT-SUBMIT: Dining's current hold of the table Cart version by
   * another participant's checkout; edits to a held version are refused. */
  readonly checkoutHold: DiningCartCheckoutHoldPort;
  readonly cartTransactions: CartQueryTransactionRunner;
  readonly selectionTransactions: CartQueryTransactionRunner;
  readonly selection: Omit<DiningCartSelectionStoreOptions, "scope" | "now">;
  readonly catalog: CustomerDiningCartViewPorts["catalog"];
  readonly stores: CustomerDiningCartViewPorts["stores"];
  readonly now: () => string;
  /** WP-2423: owner replacement used to continue past a timed-out table Cart (omitted: refused). */
  readonly replacement?: CustomerCartReplacementPort;
  readonly items?: {
    readonly writeTransactions: CartItemWriteTransactionRunner;
    readonly references: DiningCartItemOptions["references"];
    readonly catalog: DiningCartItemOptions["catalog"];
    readonly audit: DiningCartItemOptions["audit"];
  };
}
export function createCustomerDiningCartComposition(
  options: CustomerDiningCartCompositionOptions,
): CustomerCartPort {
  const itemOptions = options.items;
  const fixedScope = scope(options.scope);
  const now = options.now;
  const sessions = options.sessions;
  // DEC-DINE-IN-PAY-LATER: Dining's "this table is checking out" reaches the guest as such.
  const participation: DiningCartReadPorts["participation"] = Object.freeze({
    resolve: async (value: Parameters<DiningCartReadPorts["participation"]["resolve"]>[0]) => {
      try {
        return await options.participation.resolve(value);
      } catch (error) {
        if (error instanceof DiningTableCheckingOutError)
          throw new CartError("CART_TABLE_CHECKING_OUT");
        throw error;
      }
    },
  });
  const writer = createPostgresDiningCartSelectionStore(options.selectionTransactions, {
    ...options.selection,
    scope: fixedScope,
    now,
  });
  const query = createCustomerDiningCartViewQuery({
    reads: createDiningCartReadService({
      scope: fixedScope,
      sessions,
      participation,
      now,
      carts: createPostgresDiningCartReadStore(options.cartTransactions, fixedScope),
    }),
    catalog: options.catalog,
    stores: options.stores,
  });
  const replacement = options.replacement;
  const succession = createPostgresDiningCartSuccessionSource(options.cartTransactions, fixedScope);
  return createCustomerDiningCartPort({
    query,
    now,
    ...(replacement === undefined
      ? {}
      : {
          continuation: {
            replacement,
            async previous(input) {
              // Current Guest + CSRF first; the replacement re-authorizes and fences everything.
              const session = await sessions.authorize({
                sessionCredential: input.sessionCredential,
                csrfCredential: input.csrfCredential,
                observedAt: parseOrderingInstant(now()),
              });
              if (
                String(session.brandReference) !== fixedScope.brandReference ||
                String(session.storeReference) !== fixedScope.storeReference ||
                session.channel !== "DineIn" ||
                session.diningState !== "DiningBound" ||
                session.diningSessionReference === null
              )
                throw new CartError("CART_PERMISSION_DENIED");
              return succession.previous({
                diningSessionReference: String(session.diningSessionReference),
              });
            },
          },
        }),
    ...(itemOptions === undefined
      ? {}
      : {
          items: createDiningCartItemService({
            scope: fixedScope,
            sessions,
            participation,
            checkoutHold: options.checkoutHold,
            now,
            references: itemOptions.references,
            catalog: itemOptions.catalog,
            audit: itemOptions.audit,
            repository: (bound) => ({
              load: createPostgresDiningCartCommandQueryStore(options.cartTransactions, bound).load,
              resolveOperation: createPostgresBoundCartItemOperationStore(
                options.cartTransactions,
                bound,
              ).resolveOperation,
              commit: createPostgresCartItemCommandStore(
                itemOptions.writeTransactions,
                fixedScope,
                itemOptions.references,
              ).commit,
            }),
          }),
        }),
    selection: {
      select: (command) =>
        createDiningCartSelectionService({
          scope: fixedScope,
          participation,
          selection: writer,
          now,
          sessions: {
            resolve: (request) =>
              sessions.authorize({
                sessionCredential: request.sessionCredential,
                csrfCredential: command.csrfCredential,
                observedAt: request.observedAt,
              }),
          },
        }).select({
          sessionCredential: command.sessionCredential,
          operationReference: command.operationReference,
        }),
    },
  });
}

/** Current Identity chooses a channel; downstream services still authorize every operation. */
export function createCustomerCartChannelPort(options: {
  readonly scope: CustomerDiningCartCompositionOptions["scope"];
  readonly sessions: Pick<GuestSessionService, "resolve">;
  readonly now: () => string;
  readonly pickup: CustomerCartPort;
  readonly dining: CustomerCartPort;
}): CustomerCartPort {
  const fixedScope = scope(options.scope);
  const { sessions, now, pickup, dining } = options;
  const common = ["guestCredential", "requestedAt"];
  const mutation = [...common, "csrfCredential", "operationReference"];
  async function dispatch<T extends Parameters<CustomerCartPort["getCurrentCart"]>[0]>(
    value: T,
    fields: readonly string[],
    call: (port: CustomerCartPort, input: T) => Promise<CustomerCartPortResult>,
  ): Promise<CustomerCartPortResult> {
    try {
      const raw = { ...readClosedRecord(value, fields) };
      const credential = parseGuestRawCredential(raw.guestCredential);
      if (Object.hasOwn(raw, "optionSelections")) {
        if (!Array.isArray(raw.optionSelections)) return unavailable;
        raw.optionSelections = Object.freeze(
          raw.optionSelections.map((item) =>
            Object.freeze(readClosedRecord(item, ["optionReference", "quantity"])),
          ),
        );
      }
      const input = Object.freeze(raw) as unknown as T;
      const at = parseOrderingInstant(now());
      let session;
      try {
        session = createGuestSession(
          await sessions.resolve({
            sessionCredential: credential,
            activity: "Background",
            observedAt: at,
          }),
        );
      } catch {
        return { status: "SessionExpired" };
      }
      const checkedAt = parseOrderingInstant(now());
      if (checkedAt < at) return unavailable;
      try {
        assertGuestSessionUsable(session, checkedAt);
      } catch {
        return { status: "SessionExpired" };
      }
      if (
        String(session.brandReference) !== fixedScope.brandReference ||
        String(session.storeReference) !== fixedScope.storeReference
      )
        return { status: "SessionExpired" };
      return await call(session.channel === "Pickup" ? pickup : dining, input);
    } catch {
      return unavailable;
    }
  }
  return Object.freeze<CustomerCartPort>({
    getCurrentCart: (input, locale) =>
      dispatch(input, common, (port, raw) =>
        port.getCurrentCart(raw, ...cartDisplayArguments(locale)),
      ),
    getCart: (input, locale) =>
      dispatch(input, [...common, "cartReference"], (port, raw) =>
        port.getCart(raw, ...cartDisplayArguments(locale)),
      ),
    createCart: (input, locale) =>
      dispatch(input, mutation, (port, raw) =>
        port.createCart(raw, ...cartDisplayArguments(locale)),
      ),
    addItem: (input, locale) =>
      dispatch(
        input,
        [
          ...mutation,
          "cartReference",
          "expectedCartVersion",
          "sellableReference",
          "quantity",
          "optionSelections",
          "customerNote",
        ],
        (port, raw) => port.addItem(raw, ...cartDisplayArguments(locale)),
      ),
    updateItem: (input, locale) =>
      dispatch(
        input,
        [
          ...mutation,
          "cartReference",
          "cartItemReference",
          "expectedCartVersion",
          "quantity",
          "optionSelections",
          "customerNote",
        ],
        (port, raw) => port.updateItem(raw, ...cartDisplayArguments(locale)),
      ),
    removeItem: (input, locale) =>
      dispatch(
        input,
        [...mutation, "cartReference", "cartItemReference", "expectedCartVersion"],
        (port, raw) => port.removeItem(raw, ...cartDisplayArguments(locale)),
      ),
  });
}

/** Explicit production-owner selection/Inventory composition for shared Dining Carts. */
export function createCustomerDiningCartWithCatalogInventoryComposition(
  options: Omit<CustomerDiningCartCompositionOptions, "items"> & {
    readonly items: Omit<NonNullable<CustomerDiningCartCompositionOptions["items"]>, "catalog">;
    readonly catalogTransactions: Parameters<typeof createPostgresCatalogSelectionService>[0];
    readonly catalogScope: Pick<
      Parameters<typeof createPostgresCatalogSelectionService>[1],
      "menuReference" | "sourceChannel" | "channelCode" | "orderTypeCode"
    >;
    readonly catalogSafety: Pick<
      Parameters<typeof createPostgresCatalogSelectionService>[2],
      "killSwitch" | "inventory"
    >;
    readonly selectedInventory: Omit<CustomerCartSelectionInventoryOptions, "authorize">;
  },
): CustomerCartPort {
  const { catalogTransactions, catalogScope, catalogSafety, selectedInventory, items, ...cart } =
    options;
  // WP-2423: a quantity the stock can't make tells the guest how many it can.
  return withCartItemStockShortage(
    createCustomerDiningCartComposition({
      ...cart,
      items: {
        ...items,
        catalog: createCustomerCartSelectionInventory(
          catalogTransactions,
          {
            ...catalogScope,
            ...cart.scope,
            orderType: "DineIn",
          },
          { ...catalogSafety, clock: { now: cart.now } },
          {
            ...selectedInventory,
            authorize: createCustomerDiningCartInventoryAuthorization(cart.scope, cart.now),
          },
        ),
      },
    }),
  );
}
