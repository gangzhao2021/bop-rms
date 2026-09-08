import {
  createPostgresGuestSessionEntryStore,
  type GuestSessionEntryTransactionRunner,
} from "@bop/identity";
import {
  createCustomerMenuQueryService,
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
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly entry: Omit<CustomerEntryCompositionOptions, "session"> & {
    readonly session: Omit<CustomerEntryCompositionOptions["session"], "store">;
  };
  readonly menuStores: CustomerMenuQueryPorts["stores"];
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  // Must own a separate, bounded, read-only transaction and release its connection.
  readonly menuTransactions: PublishedMenuQueryTransactionRunner;
  readonly allowedOrigin: string;
  readonly now: () => string;
  readonly uuidV7Factory: () => string;
  readonly runtime?: Pick<ApiServerRuntimeOptions, "port" | "logger">;
}

// The caller owns the injected database resources; close them after runtime.shutdown().
export function createLocalCustomerRuntime(options: LocalCustomerRuntimeOptions): ApiServerRuntime {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
    throw new Error("LOCAL_CUSTOMER_RUNTIME_UNAVAILABLE");
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
  const customerMenu = createCustomerMenuQueryService({
    stores: {
      async resolvePublic(reference) {
        const resolved = await menuStores.resolvePublic(reference);
        return resolved !== null && sameScope(resolved) ? resolved : null;
      },
    },
    projections: createPostgresPublishedMenuQueryStore(options.menuTransactions, scope),
  });
  return createApiServerRuntime({
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
