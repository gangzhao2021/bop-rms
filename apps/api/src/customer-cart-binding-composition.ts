import {
  createGuestBindingService,
  createPostgresGuestBindingStore,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  type GuestBindingAuditPort,
  type GuestBindingServiceOptions,
  type GuestSessionEntryTransactionRunner,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  createPostgresPickupCartBindingStore,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type PickupCartBindingOptions,
} from "@rms/ordering";
import type { CustomerCartBindingPort } from "./customer-cart-binding.js";

export interface CustomerCartBindingCompositionOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "credentials">;
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  readonly orderingTransactions: CartQueryTransactionRunner;
  readonly identityAudit: GuestBindingAuditPort;
  readonly ordering: Omit<PickupCartBindingOptions, "brandReference" | "storeReference" | "now">;
  readonly recovery: GuestBindingServiceOptions["recovery"];
  readonly preparationLifetimeSeconds: number;
  readonly now: () => string;
}

/** Explicit providers only. Identity and Ordering retain all validation and write ownership. */
export function createCustomerCartBindingComposition(
  options: CustomerCartBindingCompositionOptions,
): CustomerCartBindingPort {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const sessions = createPostgresGuestSessionEntryStore(options.sessionTransactions, scope);
  const authorization = new GuestSessionService({
    ...options.session,
    store: sessions,
    admission: { consume: async () => null },
    now: options.now,
  });
  return createGuestBindingService({
    authorization,
    sessions,
    bindings: createPostgresGuestBindingStore(
      options.sessionTransactions,
      scope,
      options.identityAudit,
      options.session.credentials.equals,
    ),
    owner: createPostgresPickupCartBindingStore(options.orderingTransactions, {
      ...options.ordering,
      ...scope,
      now: options.now,
    }),
    credentials: options.session.credentials,
    recovery: options.recovery,
    preparationLifetimeSeconds: options.preparationLifetimeSeconds,
    now: options.now,
  });
}
