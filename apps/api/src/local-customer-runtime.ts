import {
  createCustomerDiningCartComposition,
  createCustomerCartChannelPort,
  type CustomerDiningCartCompositionOptions,
} from "./customer-dining-cart-composition.js";
import { CustomerDiningJoinHandler } from "./customer-dining-join.js";
import { CustomerDiningBindingHandler } from "./customer-dining-binding.js";
import {
  createCustomerDiningJoinComposition,
  type CustomerDiningJoinCompositionOptions,
} from "./customer-dining-join-composition.js";
import {
  createCustomerDiningBindingComposition,
  type CustomerDiningBindingCompositionOptions,
} from "./customer-dining-binding-composition.js";
import {
  createCustomerCartItemComposition,
  type CustomerCartItemCompositionOptions,
} from "./customer-cart-item-composition.js";
import {
  createCustomerCartRemovalComposition,
  type CustomerCartRemovalCompositionOptions,
} from "./customer-cart-removal-composition.js";
import {
  createCustomerCartBindingComposition,
  type CustomerCartBindingCompositionOptions,
} from "./customer-cart-binding-composition.js";
import { CustomerCartBindingHandler } from "./customer-cart-binding.js";
import {
  createCustomerQuoteComposition,
  type CustomerQuoteCompositionOptions,
} from "./customer-quote-composition.js";
import { CustomerQuoteHandler } from "./customer-quote.js";
import { createPublicStoreProfileService } from "@rms/store";
import {
  createCustomerCartViewQuery,
  createPickupCartReadService,
  createPostgresPickupCartBindingReader,
  createPostgresCartQuoteReader,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import { createCustomerCartReadPort } from "./customer-cart-read-composition.js";
import { CustomerCartHandler } from "./customer-cart.js";
import {
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  type GuestSessionEntryTransactionRunner,
} from "@bop/identity";
import {
  createCustomerMenuQueryService,
  createCatalogSelectionDisplayQuery,
  createPostgresPublishedMenuQueryStore,
  parseCatalogReference,
  type CustomerMenuQueryPorts,
  type PublishedMenuQueryTransactionRunner,
} from "@rms/catalog";
import {
  createCustomerEntryComposition,
  type CustomerEntryCompositionOptions,
} from "./customer-entry-composition.js";
import { CustomerEntryHandler } from "./customer-entry.js";
import { CustomerMenuHandler } from "./customer-menu.js";
import {
  createApiServerRuntime,
  type ApiServerRuntime,
  type ApiServerRuntimeOptions,
} from "./server.js";

export interface LocalCustomerRuntimeOptions {
  readonly diningCart?: Omit<
    CustomerDiningCartCompositionOptions,
    "scope" | "sessions" | "cartTransactions" | "catalog" | "stores" | "now"
  >;
  readonly diningAdmission?: {
    readonly join: Omit<CustomerDiningJoinCompositionOptions, "scope" | "session" | "now">;
    readonly binding: Omit<CustomerDiningBindingCompositionOptions, "scope" | "session" | "now">;
    readonly resolveRequestContext: ConstructorParameters<
      typeof CustomerDiningJoinHandler
    >[0]["resolveRequestContext"];
  };
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly entry: Omit<CustomerEntryCompositionOptions, "session"> & {
    readonly session: Omit<CustomerEntryCompositionOptions["session"], "store">;
  };
  readonly menuStores: CustomerMenuQueryPorts["stores"];
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  // Must own a separate, bounded, read-only transaction and release its connection.
  readonly menuTransactions: PublishedMenuQueryTransactionRunner;
  // Optional scoped, bounded read-only transactions; the caller retains resource ownership.
  readonly cartTransactions?: CartQueryTransactionRunner;
  readonly cartBinding?: Omit<
    CustomerCartBindingCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "now"
  >;
  readonly cartItems?: Omit<
    CustomerCartItemCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "query" | "now" | "fallback"
  >;
  readonly cartRemoval?: Omit<
    CustomerCartRemovalCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "query" | "now"
  >;
  readonly allowedOrigin: string;
  readonly cartQuote?: Omit<
    CustomerQuoteCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "now"
  >;
  readonly now: () => string;
  readonly uuidV7Factory: () => string;
  readonly runtime?: Pick<ApiServerRuntimeOptions, "port" | "logger">;
}

// The caller owns the injected database resources; close them after runtime.shutdown().
export function createLocalCustomerRuntime(options: LocalCustomerRuntimeOptions): ApiServerRuntime {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
    throw new Error("LOCAL_CUSTOMER_RUNTIME_UNAVAILABLE");
  if (options.diningCart !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_DINING_CART_READS_REQUIRED");
  if (options.cartBinding !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_BINDING_READS_REQUIRED");
  if (options.cartItems !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_ITEM_READS_REQUIRED");
  if (options.cartRemoval !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_REMOVAL_READS_REQUIRED");
  if (options.cartQuote !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_QUOTE_READS_REQUIRED");
  const scope = Object.freeze({
    brandReference: parseCatalogReference(options.scope.brandReference),
    storeReference: parseCatalogReference(options.scope.storeReference),
  });
  const sameScope = (value: { brandReference: string; storeReference: string }) =>
    value.brandReference === scope.brandReference && value.storeReference === scope.storeReference;
  const { entry, menuStores, now } = options;
  const store = createPostgresGuestSessionEntryStore(options.sessionTransactions, scope);
  const customerEntry = createCustomerEntryComposition({
    ...entry,
    qr: {
      ...entry.qr,
      contexts: {
        async resolve(payload) {
          const evidence = await entry.qr.contexts.resolve(payload);
          return evidence !== null && sameScope(evidence) ? evidence : null;
        },
      },
    },
    session: { ...entry.session, store },
  });
  const projections = createPostgresPublishedMenuQueryStore(options.menuTransactions, scope);
  const customerMenu = createCustomerMenuQueryService({
    stores: {
      async resolvePublic(reference) {
        const resolved = await menuStores.resolvePublic(reference);
        return resolved !== null && sameScope(resolved) ? resolved : null;
      },
    },
    projections,
  });
  let customerCart: CustomerCartHandler | undefined;
  if (options.cartTransactions !== undefined) {
    const sessions = new GuestSessionService({
      ...entry.session,
      store,
      admission: { consume: async () => null },
      now,
    });
    const catalog = createCatalogSelectionDisplayQuery(projections);
    const stores = createPublicStoreProfileService({
      ...entry.profile,
      resolution: {
        async resolve(request) {
          const resolved = await entry.profile.resolution.resolve(request);
          return resolved !== null && sameScope(resolved) ? resolved : null;
        },
      },
    });
    const query = createCustomerCartViewQuery({
      reads: createPickupCartReadService({
        sessions,
        binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
        scope,
        now,
      }),
      catalog,
      stores,
      quotes: createPostgresCartQuoteReader(options.cartTransactions, scope),
    });
    const fallback =
      options.cartRemoval === undefined
        ? createCustomerCartReadPort(query)
        : createCustomerCartRemovalComposition({
            ...options.cartRemoval,
            scope,
            session: entry.session,
            sessionTransactions: options.sessionTransactions,
            cartTransactions: options.cartTransactions,
            query,
            now,
          });
    const port =
      options.cartItems === undefined
        ? fallback
        : createCustomerCartItemComposition({
            ...options.cartItems,
            scope,
            session: entry.session,
            sessionTransactions: options.sessionTransactions,
            cartTransactions: options.cartTransactions,
            query,
            now,
            fallback,
          });
    const composedPort =
      options.diningCart === undefined
        ? port
        : createCustomerCartChannelPort({
            scope,
            sessions,
            now,
            pickup: port,
            dining: createCustomerDiningCartComposition({
              ...options.diningCart,
              scope,
              sessions,
              cartTransactions: options.cartTransactions,
              catalog,
              stores,
              now,
            }),
          });
    customerCart = new CustomerCartHandler({
      allowedOrigin: options.allowedOrigin,
      now,
      port: composedPort,
    });
  }
  const customerCartBinding =
    options.cartBinding === undefined
      ? undefined
      : new CustomerCartBindingHandler({
          allowedOrigin: options.allowedOrigin,
          now,
          port: createCustomerCartBindingComposition({
            ...options.cartBinding,
            scope,
            session: entry.session,
            sessionTransactions: options.sessionTransactions,
            now,
          }),
        });
  const diningAdmission = options.diningAdmission;
  const diningSession = {
    store,
    credentials: entry.session.credentials,
    binding: entry.session.binding,
  };
  const customerDiningJoin =
    diningAdmission === undefined
      ? undefined
      : new CustomerDiningJoinHandler({
          allowedOrigin: options.allowedOrigin,
          resolveRequestContext: diningAdmission.resolveRequestContext,
          port: createCustomerDiningJoinComposition({
            ...diningAdmission.join,
            scope,
            session: diningSession,
            now,
          }),
        });
  const customerDiningBinding =
    diningAdmission === undefined
      ? undefined
      : new CustomerDiningBindingHandler({
          allowedOrigin: options.allowedOrigin,
          now,
          port: createCustomerDiningBindingComposition({
            ...diningAdmission.binding,
            scope,
            session: diningSession,
            now,
          }),
        });
  return createApiServerRuntime({
    ...(customerDiningJoin === undefined ? {} : { customerDiningJoin }),
    ...(customerDiningBinding === undefined ? {} : { customerDiningBinding }),
    ...(options.cartQuote === undefined || options.cartTransactions === undefined
      ? {}
      : {
          customerQuote: new CustomerQuoteHandler({
            allowedOrigin: options.allowedOrigin,
            now,
            port: createCustomerQuoteComposition({
              ...options.cartQuote,
              scope,
              session: entry.session,
              sessionTransactions: options.sessionTransactions,
              cartTransactions: options.cartTransactions,
              now,
            }),
          }),
        }),
    ...(customerCartBinding === undefined ? {} : { customerCartBinding }),
    ...(customerCart === undefined ? {} : { customerCart }),
    port: options.runtime?.port ?? 0,
    ...(options.runtime?.logger === undefined ? {} : { logger: options.runtime.logger }),
    host: "127.0.0.1",
    customerEntry: new CustomerEntryHandler({
      port: customerEntry,
      allowedOrigin: options.allowedOrigin,
      now,
      uuidV7Factory: options.uuidV7Factory,
    }),
    customerMenu: new CustomerMenuHandler({ port: customerMenu, now }),
  });
}
