import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createCustomerQuoteComposition,
  createCustomerDiningQuoteComposition,
} from "../../apps/api/dist/customer-quote-composition.js";
export async function createInternalChannelQuote(
  resources,
  configuredEntry,
  diningCart,
  { createQuote },
) {
  const common = {
    scope: resources.scope,
    cartTransactions: resources.transactions,
    now: resources.now,
  };
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
  const pickup = createCustomerQuoteComposition({
    ...common,
    ...(await createQuote(resources)).cartQuote,
    session,
    sessionTransactions: resources.transactions,
  });
  const dining = createCustomerDiningQuoteComposition({
    ...common,
    ...(await createQuote(resources, "DineIn")).cartQuote,
    sessions,
    participation: diningCart.catalogDiningCart.participation,
  });
  return { configuredCartQuote: { pickup, dining } };
}
