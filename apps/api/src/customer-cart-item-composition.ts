import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  readClosedRecord,
} from "@bop/identity";
import {
  CartError,
  createPickupCartItemService,
  createPostgresCartQueryStore,
  createPostgresCartItemCommandStore,
  createPostgresCartItemOperationStore,
  createPostgresPickupCartBindingReader,
  parseOrderingReference,
  type PickupCartItemOptions,
  type PickupCartItemResult,
} from "@rms/ordering";
import type { CustomerCartRemovalCompositionOptions } from "./customer-cart-removal-composition.js";
import {
  createCustomerCartReadPort,
  type CustomerCartDisplayQuery,
} from "./customer-cart-read-composition.js";
import type { CustomerCartPort, CustomerCartPortResult } from "./customer-cart.js";
export interface CustomerCartItemCompositionOptions extends Omit<
  CustomerCartRemovalCompositionOptions,
  "references" | "audit"
> {
  readonly references: PickupCartItemOptions["references"];
  readonly audit: PickupCartItemOptions["audit"];
  readonly catalog: PickupCartItemOptions["catalog"];
  readonly fallback?: CustomerCartPort;
}
type Add = Parameters<CustomerCartPort["addItem"]>[0];
type Update = Parameters<CustomerCartPort["updateItem"]>[0];
function snapshot(value: Add | Update, action: "Add" | "Update"): Add | Update {
  const raw = readClosedRecord(
    value,
    [
      "guestCredential",
      "requestedAt",
      "csrfCredential",
      "operationReference",
      "cartReference",
      "expectedCartVersion",
      action === "Add" ? "sellableReference" : "cartItemReference",
      "quantity",
      "optionSelections",
      "customerNote",
    ],
    "ACTOR_SHAPE_INVALID",
  );
  if (
    !Array.isArray(raw.optionSelections) ||
    raw.optionSelections.length > 100 ||
    Reflect.ownKeys(raw.optionSelections).length !== raw.optionSelections.length + 1
  )
    throw new Error();
  const options = [];
  for (let index = 0; index < raw.optionSelections.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw.optionSelections, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
    options.push(
      Object.freeze({
        ...readClosedRecord(
          descriptor.value,
          ["optionReference", "quantity"],
          "ACTOR_SHAPE_INVALID",
        ),
      }),
    );
  }
  return Object.freeze({ ...raw, optionSelections: Object.freeze(options) }) as unknown as
    Add | Update;
}
export function createCustomerCartItemPort(options: {
  readonly query: CustomerCartDisplayQuery;
  readonly items: Pick<ReturnType<typeof createPickupCartItemService>, "add" | "update">;
  readonly fallback?: CustomerCartPort;
}): CustomerCartPort {
  const unavailable = Object.freeze({ status: "Unavailable" } as const);
  const read = (input: Add | Update) =>
    options.query.read({
      sessionCredential: input.guestCredential,
      cartReference: input.cartReference,
    });
  async function failure(error: unknown, input: Add | Update): Promise<CustomerCartPortResult> {
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
      case "CART_ITEM_LIMIT_REACHED":
        return { status: "SelectionInvalid", issueCodes: ["CART_ITEM_LIMIT_REACHED"] };
      case "CART_SELECTION_INVALID":
        return { status: "SelectionInvalid", issueCodes: ["CATALOG_SELECTION_REJECTED"] };
      case "CART_INPUT_INVALID":
        return { status: "SelectionInvalid", issueCodes: ["CART_INPUT_INVALID"] };
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
  }
  async function execute(
    action: "Add" | "Update",
    value: Add | Update,
  ): Promise<CustomerCartPortResult> {
    let input: Add | Update;
    try {
      input = snapshot(value, action);
    } catch {
      return unavailable;
    }
    let receipt: PickupCartItemResult;
    try {
      const command = {
        sessionCredential: input.guestCredential,
        csrfCredential: input.csrfCredential,
        cartReference: input.cartReference,
        expectedAggregateVersion: input.expectedCartVersion,
        quantity: input.quantity,
        optionSelections: input.optionSelections,
        customerNote: input.customerNote,
        operationReference: input.operationReference,
      };
      receipt =
        action === "Add"
          ? await options.items.add({
              ...command,
              sellableReference: (input as Add).sellableReference,
            })
          : await options.items.update({
              ...command,
              cartItemReference: (input as Update).cartItemReference,
            });
    } catch (error) {
      return failure(error, input);
    }
    try {
      receipt = Object.freeze({
        ...readClosedRecord(
          receipt,
          ["status", "cartReference", "cartItemReference", "aggregateVersion"],
          "ACTOR_SHAPE_INVALID",
        ),
      }) as unknown as PickupCartItemResult;
      if (
        !["Applied", "AlreadyApplied"].includes(receipt.status) ||
        receipt.cartReference !== input.cartReference ||
        !Number.isSafeInteger(receipt.aggregateVersion) ||
        receipt.aggregateVersion !== input.expectedCartVersion + 1 ||
        (action === "Update" && receipt.cartItemReference !== (input as Update).cartItemReference)
      )
        return unavailable;
      parseOrderingReference(receipt.cartItemReference);
      const view = await read(input);
      if (
        view === null ||
        view.cart.cartReference !== receipt.cartReference ||
        !Number.isSafeInteger(view.cart.version) ||
        view.cart.version < receipt.aggregateVersion
      )
        return unavailable;
      if (view.cart.version === receipt.aggregateVersion) {
        const item = view.cart.items.find(
          (item) => item.cartItemReference === receipt.cartItemReference,
        );
        if (
          !item ||
          item.quantity !== input.quantity ||
          (action === "Add" && item.sellableReference !== (input as Add).sellableReference)
        )
          return unavailable;
      }
      return { status: "Applied", view };
    } catch {
      return unavailable;
    }
  }
  return Object.freeze({
    ...(options.fallback ?? createCustomerCartReadPort(options.query)),
    addItem: (input: Add) => execute("Add", input),
    updateItem: (input: Update) => execute("Update", input),
  });
}
export function createCustomerCartItemComposition(
  options: CustomerCartItemCompositionOptions,
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
  return createCustomerCartItemPort({
    query: options.query,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    items: createPickupCartItemService({
      scope,
      sessions,
      binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
      references: options.references,
      catalog: options.catalog,
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
