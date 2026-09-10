import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionService,
} from "@bop/identity";
import {
  CartError,
  createCustomerDiningCartViewQuery,
  createDiningCartReadService,
  createDiningCartSelectionService,
  createDiningCartItemService,
  createPostgresDiningCartCommandQueryStore,
  createPostgresBoundCartItemOperationStore,
  createPostgresCartItemCommandStore,
  createPostgresDiningCartReadStore,
  createPostgresDiningCartSelectionStore,
  parseDiningCartSelectionReceipt,
  parseOrderingInstant,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type CustomerDiningCartViewPorts,
  type DiningCartReadPorts,
  type DiningCartSelectionStoreOptions,
  type DiningCartItemOptions,
  type CartItemWriteTransactionRunner,
} from "@rms/ordering";
import { createCustomerCartItemPort } from "./customer-cart-item-composition.js";
import { createCustomerCartRemovalPort } from "./customer-cart-removal-composition.js";
import {
  createCustomerCartReadPort,
  type CustomerCartDisplayQuery,
} from "./customer-cart-read-composition.js";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";

const unavailable = Object.freeze({ status: "Unavailable" } as const);
function scope(value: unknown) {
  const raw = readClosedRecord(value, ["brandReference", "storeReference"]);
  return Object.freeze({
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
  });
}
function failure(error: unknown): CustomerCartPortResult {
  if (!(error instanceof CartError)) return unavailable;
  switch (error.code) {
    case "CART_PERMISSION_DENIED":
      return { status: "SessionExpired" };
    case "CART_IDEMPOTENCY_CONFLICT":
      return { status: "IdempotencyConflict" };
    case "CART_EXPIRED":
      return { status: "LifecycleExpired" };
    case "CART_ABANDONED":
      return { status: "LifecycleAbandoned" };
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
}): CustomerCartPort {
  const base = Object.freeze<CustomerCartPort>({
    ...createCustomerCartReadPort(options.query),
    async createCart(
      input: Parameters<CustomerCartPort["createCart"]>[0],
    ): Promise<CustomerCartPortResult> {
      let command: {
        readonly sessionCredential: string;
        readonly csrfCredential: string;
        readonly operationReference: string;
      };
      let receipt;
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
        receipt = parseDiningCartSelectionReceipt(await options.selection.select(command));
        if (receipt.operationReference !== command.operationReference) return unavailable;
      } catch (error) {
        return failure(error);
      }
      // A failed current read cannot erase a possibly committed selection.
      try {
        const view = await options.query.read(
          Object.freeze({
            sessionCredential: command.sessionCredential,
            cartReference: receipt.cartReference,
          }),
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
        return { status: receipt.action === "Create" ? "Applied" : "Current", view };
      } catch {
        return unavailable;
      }
    },
  });
  if (options.items === undefined) return base;
  const query: CustomerCartDisplayQuery = {
    async read(input) {
      const view = await options.query.read(input);
      if (view !== null && (view.schemaVersion !== 1 || view.cart.orderType !== "DineIn"))
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      return view;
    },
  };
  const removal = createCustomerCartRemovalPort({ query, removal: options.items });
  const items = createCustomerCartItemPort({ query, items: options.items, fallback: base });
  return Object.freeze({
    ...items,
    async removeItem(input: Parameters<CustomerCartPort["removeItem"]>[0]) {
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
        return await removal.removeItem(captured as unknown as typeof input);
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
  readonly cartTransactions: CartQueryTransactionRunner;
  readonly selectionTransactions: CartQueryTransactionRunner;
  readonly selection: Omit<DiningCartSelectionStoreOptions, "scope" | "now">;
  readonly catalog: CustomerDiningCartViewPorts["catalog"];
  readonly stores: CustomerDiningCartViewPorts["stores"];
  readonly now: () => string;
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
  const participation = options.participation;
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
  return createCustomerDiningCartPort({
    query,
    ...(itemOptions === undefined
      ? {}
      : {
          items: createDiningCartItemService({
            scope: fixedScope,
            sessions,
            participation,
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
    getCurrentCart: (input) => dispatch(input, common, (port, raw) => port.getCurrentCart(raw)),
    getCart: (input) =>
      dispatch(input, [...common, "cartReference"], (port, raw) => port.getCart(raw)),
    createCart: (input) => dispatch(input, mutation, (port, raw) => port.createCart(raw)),
    addItem: (input) =>
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
        (port, raw) => port.addItem(raw),
      ),
    updateItem: (input) =>
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
        (port, raw) => port.updateItem(raw),
      ),
    removeItem: (input) =>
      dispatch(
        input,
        [...mutation, "cartReference", "cartItemReference", "expectedCartVersion"],
        (port, raw) => port.removeItem(raw),
      ),
  });
}
