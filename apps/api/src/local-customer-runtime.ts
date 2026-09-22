import {
  CustomerPaymentIntentHandler,
  type CustomerPaymentIntentPort,
} from "./customer-payment-intent.js";
import { createCustomerOrderSubmissionChannel } from "./customer-order-submission-channel.js";
import {
  createCustomerCheckoutDetailsChannel,
  type CompleteCheckoutDetailsPort,
} from "./customer-checkout-details-channel.js";
import { createCustomerQuoteChannelPort } from "./customer-quote-channel.js";
import type { CustomerQuotePort } from "./customer-quote.js";
import {
  createPersistentCustomerEntryComposition,
  type PersistentCustomerEntryOptions,
} from "./persistent-customer-entry.js";
import { createPersistentPublicStoreProfileReader } from "./persistent-public-store-profile.js";
import {
  CustomerOrderSubmissionHandler,
  type CustomerOrderSubmissionPort,
} from "./customer-order-submission.js";
import {
  CustomerCheckoutDetailsHandler,
  type CustomerCheckoutDetailsPort,
} from "./customer-checkout-details.js";
import {
  createCustomerDiningCartComposition,
  createCustomerDiningCartWithCatalogInventoryComposition,
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
  createCustomerDiningSessionBinding,
  type CustomerDiningBindingCompositionOptions,
} from "./customer-dining-binding-composition.js";
import {
  createCustomerCartItemComposition,
  createCustomerCartItemWithCatalogComposition,
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
import { CustomerCartHandler, type CustomerCartReplacementPort } from "./customer-cart.js";
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

type LocalPaymentIntent = NonNullable<ApiServerRuntimeOptions["customerPaymentIntent"]>;
type LocalPaymentHandoff = NonNullable<ApiServerRuntimeOptions["customerPaymentHandoff"]>;
type LocalPaymentResult = NonNullable<ApiServerRuntimeOptions["customerPaymentResult"]>;

export interface LocalCustomerRuntimeOptions {
  readonly entryRequestAdmission?: ConstructorParameters<
    typeof CustomerEntryHandler
  >[0]["requestAdmission"];
  readonly merchantRuntime?: ApiServerRuntimeOptions["merchantRuntime"];
  readonly orderSubmission?: CustomerOrderSubmissionPort;
  readonly channelOrderSubmission?: Readonly<{
    pickup: CustomerOrderSubmissionPort;
    dining: CustomerOrderSubmissionPort;
  }>;
  readonly checkoutDetails?: CustomerCheckoutDetailsPort;
  readonly channelCheckoutDetails?: Readonly<{
    pickup: CompleteCheckoutDetailsPort;
    dining: CompleteCheckoutDetailsPort;
  }>;
  readonly paymentIntent?: CustomerPaymentIntentPort;
  readonly paymentResult?: Omit<LocalPaymentResult, "access" | "allowedOrigin"> & {
    readonly access: Omit<LocalPaymentResult["access"], "scope" | "credentials" | "now">;
  };
  readonly payment?: {
    readonly access: Omit<LocalPaymentIntent["access"], "scope" | "credentials" | "now">;
    readonly history: LocalPaymentIntent["history"];
    readonly intent: Omit<LocalPaymentIntent, "access" | "history" | "allowedOrigin">;
    readonly handoff: Omit<LocalPaymentHandoff, "access" | "history" | "allowedOrigin">;
    readonly result: Omit<LocalPaymentResult, "access" | "history" | "allowedOrigin">;
  };
  readonly pickupCode?: Omit<
    NonNullable<ApiServerRuntimeOptions["customerPickupCode"]>,
    "status" | "allowedOrigin"
  >;
  readonly orderStatus?: Omit<
    NonNullable<ApiServerRuntimeOptions["customerOrderStatus"]>,
    "scope" | "credentials" | "now" | "allowedOrigin"
  >;
  readonly receipt?: Omit<
    NonNullable<ApiServerRuntimeOptions["customerReceipt"]>,
    "scope" | "credentials" | "now" | "allowedOrigin"
  >;
  readonly checkoutSessions?: Omit<
    NonNullable<ApiServerRuntimeOptions["customerCheckoutSessions"]>,
    "scope" | "credentials" | "now" | "allowedOrigin"
  >;
  readonly diningCart?: Omit<
    CustomerDiningCartCompositionOptions,
    "scope" | "sessions" | "cartTransactions" | "catalog" | "stores" | "now"
  >;
  readonly catalogDiningCart?: Omit<
    Parameters<typeof createCustomerDiningCartWithCatalogInventoryComposition>[0],
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
  readonly entry: {
    readonly session: Omit<CustomerEntryCompositionOptions["session"], "store">;
  } & (
    | Omit<CustomerEntryCompositionOptions, "session">
    | {
        readonly persistent: Omit<PersistentCustomerEntryOptions, "session">;
      }
  );
  readonly menuStores: CustomerMenuQueryPorts["stores"];
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  // Must own a separate, bounded, read-only transaction and release its connection.
  readonly menuTransactions: PublishedMenuQueryTransactionRunner;
  // Optional scoped, bounded read-only transactions; the caller retains resource ownership.
  readonly cartTransactions?: CartQueryTransactionRunner;
  readonly cartReplacement?: CustomerCartReplacementPort;
  readonly cartBinding?: Omit<
    CustomerCartBindingCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "now"
  >;
  readonly cartItems?: Omit<
    CustomerCartItemCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "query" | "now" | "fallback"
  >;
  readonly catalogCartItems?: Omit<
    Parameters<typeof createCustomerCartItemWithCatalogComposition>[0],
    | "scope"
    | "session"
    | "sessionTransactions"
    | "cartTransactions"
    | "query"
    | "now"
    | "fallback"
    | "selectedInventory"
  > & {
    readonly selectedInventory: NonNullable<
      Parameters<typeof createCustomerCartItemWithCatalogComposition>[0]["selectedInventory"]
    >;
  };
  readonly cartRemoval?: Omit<
    CustomerCartRemovalCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "query" | "now"
  >;
  readonly allowedOrigin: string;
  readonly configuredCartQuote?: Readonly<{ pickup: CustomerQuotePort; dining: CustomerQuotePort }>;
  readonly cartQuote?: Omit<
    CustomerQuoteCompositionOptions,
    "scope" | "session" | "sessionTransactions" | "cartTransactions" | "now"
  >;
  readonly now: () => string;
  readonly uuidV7Factory: () => string;
  readonly runtime?: Pick<ApiServerRuntimeOptions, "port" | "logger" | "healthReadiness">;
}

// The caller owns the injected database resources; close them after runtime.shutdown().
export function createLocalCustomerRuntime(options: LocalCustomerRuntimeOptions): ApiServerRuntime {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
    throw new Error("LOCAL_CUSTOMER_RUNTIME_UNAVAILABLE");
  if (options.cartItems !== undefined && options.catalogCartItems !== undefined)
    throw new Error("LOCAL_CART_ITEM_CONFIGURATION_CONFLICT");
  if (options.diningCart !== undefined && options.catalogDiningCart !== undefined)
    throw new Error("LOCAL_DINING_CART_CONFIGURATION_CONFLICT");
  if (options.cartQuote !== undefined && options.configuredCartQuote !== undefined)
    throw new Error("LOCAL_CART_QUOTE_CONFIGURATION_CONFLICT");
  if (options.checkoutDetails !== undefined && options.channelCheckoutDetails !== undefined)
    throw new Error("LOCAL_CHECKOUT_DETAILS_CONFIGURATION_CONFLICT");
  if (options.channelCheckoutDetails !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CHECKOUT_DETAILS_READS_REQUIRED");
  if (options.orderSubmission !== undefined && options.channelOrderSubmission !== undefined)
    throw new Error("LOCAL_ORDER_SUBMISSION_CONFIGURATION_CONFLICT");
  if (options.channelOrderSubmission !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_ORDER_SUBMISSION_READS_REQUIRED");
  if (options.payment !== undefined && options.paymentResult !== undefined)
    throw new Error("LOCAL_PAYMENT_RESULT_CONFIGURATION_CONFLICT");
  if (options.payment !== undefined && options.paymentIntent !== undefined)
    throw new Error("LOCAL_PAYMENT_INTENT_CONFIGURATION_CONFLICT");
  const cartItems = options.catalogCartItems ?? options.cartItems;
  const diningCart = options.catalogDiningCart ?? options.diningCart;
  if (diningCart !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_DINING_CART_READS_REQUIRED");
  if (options.cartBinding !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_BINDING_READS_REQUIRED");
  if (cartItems !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_ITEM_READS_REQUIRED");
  if (options.cartRemoval !== undefined && options.cartTransactions === undefined)
    throw new Error("LOCAL_CART_REMOVAL_READS_REQUIRED");
  if (
    (options.cartQuote !== undefined || options.configuredCartQuote !== undefined) &&
    options.cartTransactions === undefined
  )
    throw new Error("LOCAL_CART_QUOTE_READS_REQUIRED");
  const scope = Object.freeze({
    brandReference: parseCatalogReference(options.scope.brandReference),
    storeReference: parseCatalogReference(options.scope.storeReference),
  });
  const sameScope = (value: { brandReference: string; storeReference: string }) =>
    value.brandReference === scope.brandReference && value.storeReference === scope.storeReference;
  const { entry, menuStores, now } = options;
  const store = createPostgresGuestSessionEntryStore(options.sessionTransactions, scope);
  if ("persistent" in entry && !sameScope(entry.persistent.profile.binding))
    throw new Error("LOCAL_PUBLIC_STORE_SCOPE_MISMATCH");
  const customerEntry =
    "persistent" in entry
      ? createPersistentCustomerEntryComposition({ ...entry.persistent, session: entry.session })
      : createCustomerEntryComposition({
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
  let orderSubmission = options.orderSubmission;
  let checkoutDetails = options.checkoutDetails;
  let configuredQuote: CustomerQuotePort | undefined;
  if (options.cartTransactions !== undefined) {
    const sessions = new GuestSessionService({
      ...entry.session,
      store,
      admission: { consume: async () => null },
      now,
      binding:
        options.diningAdmission === undefined
          ? entry.session.binding
          : createCustomerDiningSessionBinding({
              scope,
              binding: entry.session.binding,
              repository: options.diningAdmission.binding.dining.binding,
              contexts: options.diningAdmission.binding.contexts,
              now,
            }),
    });
    if (options.channelOrderSubmission !== undefined)
      orderSubmission = createCustomerOrderSubmissionChannel({
        ...options.channelOrderSubmission,
        scope,
        sessions,
        now,
      });
    if (options.channelCheckoutDetails !== undefined)
      checkoutDetails = createCustomerCheckoutDetailsChannel({
        ...options.channelCheckoutDetails,
        scope,
        sessions,
        now,
      });
    if (options.configuredCartQuote !== undefined)
      configuredQuote = createCustomerQuoteChannelPort({
        ...options.configuredCartQuote,
        scope,
        sessions,
        now,
      });
    const catalog = createCatalogSelectionDisplayQuery(projections);
    const stores =
      "persistent" in entry
        ? createPersistentPublicStoreProfileReader({
            ...entry.persistent.profile,
            transactions: entry.persistent.transactions,
          })
        : createPublicStoreProfileService({
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
    const itemCommon = {
      scope,
      session: entry.session,
      sessionTransactions: options.sessionTransactions,
      cartTransactions: options.cartTransactions,
      query,
      now,
      fallback,
    };
    const port =
      options.catalogCartItems !== undefined
        ? createCustomerCartItemWithCatalogComposition({
            ...options.catalogCartItems,
            ...itemCommon,
          })
        : options.cartItems !== undefined
          ? createCustomerCartItemComposition({ ...options.cartItems, ...itemCommon })
          : fallback;
    const diningCommon = {
      scope,
      sessions,
      cartTransactions: options.cartTransactions,
      catalog,
      stores,
      now,
    };
    const diningPort =
      options.catalogDiningCart !== undefined
        ? createCustomerDiningCartWithCatalogInventoryComposition({
            ...options.catalogDiningCart,
            ...diningCommon,
          })
        : options.diningCart !== undefined
          ? createCustomerDiningCartComposition({ ...options.diningCart, ...diningCommon })
          : undefined;
    const composedPort =
      diningPort === undefined
        ? port
        : createCustomerCartChannelPort({
            scope,
            sessions,
            now,
            pickup: port,
            dining: diningPort,
          });
    customerCart = new CustomerCartHandler({
      allowedOrigin: options.allowedOrigin,
      now,
      port: composedPort,
      ...(options.cartReplacement === undefined ? {} : { replacement: options.cartReplacement }),
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
  const payment = options.payment;
  const paymentAccess =
    payment === undefined
      ? undefined
      : {
          ...payment.access,
          scope,
          credentials: entry.session.credentials,
          now,
        };
  if (options.pickupCode !== undefined && options.orderStatus === undefined)
    throw new Error("CUSTOMER_PICKUP_STATUS_REQUIRED");
  return createApiServerRuntime({
    ...(options.merchantRuntime === undefined ? {} : { merchantRuntime: options.merchantRuntime }),
    ...(orderSubmission === undefined
      ? {}
      : {
          customerOrderSubmission: new CustomerOrderSubmissionHandler({
            port: orderSubmission,
            allowedOrigin: options.allowedOrigin,
          }),
        }),
    ...(checkoutDetails === undefined
      ? {}
      : {
          customerCheckoutDetails: new CustomerCheckoutDetailsHandler({
            port: checkoutDetails,
            allowedOrigin: options.allowedOrigin,
          }),
        }),
    ...(options.paymentResult === undefined
      ? {}
      : {
          customerPaymentResult: {
            ...options.paymentResult,
            access: {
              ...options.paymentResult.access,
              scope,
              credentials: entry.session.credentials,
              now,
            },
            allowedOrigin: options.allowedOrigin,
          },
        }),
    ...(options.paymentIntent === undefined
      ? {}
      : {
          customerPaymentIntentHandler: new CustomerPaymentIntentHandler({
            port: options.paymentIntent,
            allowedOrigin: options.allowedOrigin,
          }),
        }),
    ...(payment === undefined || paymentAccess === undefined
      ? {}
      : {
          customerPaymentIntent: {
            ...payment.intent,
            access: paymentAccess,
            history: payment.history,
            allowedOrigin: options.allowedOrigin,
          },
          customerPaymentHandoff: {
            ...payment.handoff,
            access: paymentAccess,
            history: payment.history,
            allowedOrigin: options.allowedOrigin,
          },
          customerPaymentResult: {
            ...payment.result,
            access: paymentAccess,
            history: payment.history,
            allowedOrigin: options.allowedOrigin,
          },
        }),
    ...(options.pickupCode === undefined || options.orderStatus === undefined
      ? {}
      : {
          customerPickupCode: {
            ...options.pickupCode,
            allowedOrigin: options.allowedOrigin,
            status: { ...options.orderStatus, scope, credentials: entry.session.credentials, now },
          },
        }),
    ...(options.orderStatus === undefined
      ? {}
      : {
          customerSessionBootstrap: {
            ...options.orderStatus,
            ...("persistent" in entry ? { publicProfile: entry.persistent.profile } : {}),
            scope,
            credentials: entry.session.credentials,
            now,
            allowedOrigin: options.allowedOrigin,
          },
          customerOrderStatus: {
            ...options.orderStatus,
            scope,
            credentials: entry.session.credentials,
            now,
            allowedOrigin: options.allowedOrigin,
          },
        }),
    ...(options.receipt === undefined
      ? {}
      : {
          customerReceipt: {
            ...options.receipt,
            scope,
            credentials: entry.session.credentials,
            now,
            allowedOrigin: options.allowedOrigin,
          },
        }),
    ...(options.checkoutSessions === undefined
      ? {}
      : {
          customerCheckoutSessions: {
            ...options.checkoutSessions,
            scope,
            credentials: entry.session.credentials,
            now,
            allowedOrigin: options.allowedOrigin,
          },
        }),
    ...(customerDiningJoin === undefined ? {} : { customerDiningJoin }),
    ...(customerDiningBinding === undefined ? {} : { customerDiningBinding }),
    ...(configuredQuote !== undefined
      ? {
          customerQuote: new CustomerQuoteHandler({
            allowedOrigin: options.allowedOrigin,
            now,
            port: configuredQuote,
          }),
        }
      : options.cartQuote === undefined || options.cartTransactions === undefined
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
    ...(options.runtime?.healthReadiness === undefined
      ? {}
      : { healthReadiness: options.runtime.healthReadiness }),
    port: options.runtime?.port ?? 0,
    ...(options.runtime?.logger === undefined ? {} : { logger: options.runtime.logger }),
    host: "127.0.0.1",
    customerEntry: new CustomerEntryHandler({
      ...(options.entryRequestAdmission === undefined
        ? {}
        : { requestAdmission: options.entryRequestAdmission }),
      port: customerEntry,
      allowedOrigin: options.allowedOrigin,
      now,
      uuidV7Factory: options.uuidV7Factory,
    }),
    customerMenu: new CustomerMenuHandler({ port: customerMenu, now }),
  });
}
