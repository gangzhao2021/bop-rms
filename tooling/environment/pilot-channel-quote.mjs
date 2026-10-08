import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import { createCustomerConfiguredQuoteHttpComposition } from "../../apps/api/dist/customer-configured-quote-composition.js";

/** WP-2423 slice 4: every new cart is priced with the configured Quote (v2), with or without options. */
export async function createInternalChannelQuote(
  resources,
  configuredEntry,
  diningCart,
  items,
  { createConfiguredQuote },
) {
  const session = {
    ...configuredEntry.entry.session,
    binding: configuredEntry.binding(resources.transactions),
  };
  const sessions = new GuestSessionService({
    ...session,
    store: createPostgresGuestSessionEntryStore(resources.transactions, resources.scope),
    admission: { consume: async () => null },
    now: resources.now,
  });
  const common = (catalog) => ({
    scope: resources.scope,
    sessions,
    now: resources.now,
    cartTransactions: resources.transactions,
    attachmentTransactions: resources.transactions,
    pricingTransactions: resources.transactions,
    catalogTransactions: catalog.catalogTransactions,
    catalogScope: catalog.catalogScope,
    catalogSafety: catalog.catalogSafety,
  });
  const pickup = createCustomerConfiguredQuoteHttpComposition({
    ...common(items.catalogCartItems),
    ...(await createConfiguredQuote(resources, "Pickup")),
    orderType: "Pickup",
  });
  const dining = createCustomerConfiguredQuoteHttpComposition({
    ...common(diningCart.catalogDiningCart),
    ...(await createConfiguredQuote(resources, "DineIn")),
    orderType: "DineIn",
    participation: diningCart.catalogDiningCart.participation,
  });
  return { configuredCartQuote: { pickup, dining } };
}
