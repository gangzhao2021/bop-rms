import { createInternalDiningPaymentRoute } from "./pilot-dining-payment-route.mjs";
import { GuestSessionService } from "../../packages/bop/identity/src/index.ts";
export async function createInternalChannelPayment(
  resources,
  checkout,
  diningCheckout,
  orders,
  diningOrders,
  simulator,
  catalogOptions,
  { createAdditionalPayment, createPaymentIntent },
) {
  const pickup = await createPaymentIntent(resources, checkout, orders, simulator);
  const dining = await createPaymentIntent(
    resources,
    { ...checkout, preparation: diningCheckout.preparation },
    diningOrders,
    simulator,
    "DineIn",
  );
  const route = createInternalDiningPaymentRoute(resources, checkout);
  const additional = await createAdditionalPayment(
    resources,
    checkout,
    diningCheckout,
    diningOrders,
    catalogOptions,
    simulator,
    route,
  );
  const identity = new GuestSessionService({
    ...diningCheckout.preparation.session,
    now: resources.now,
    admission: { consume: async () => null },
  });
  async function select(input) {
    const guest = await identity.authorize({
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
    });
    if (
      guest.brandReference !== resources.scope.brandReference ||
      guest.storeReference !== resources.scope.storeReference
    )
      throw new Error("INTERNAL_PAYMENT_SCOPE_DENIED");
    if (guest.channel === "Pickup") return pickup;
    if (guest.channel === "DineIn" && guest.diningState === "DiningBound") {
      const selected = await route.resolve(input);
      if (selected.kind === "Initial") return dining;
      return additional;
    }
    throw new Error("INTERNAL_PAYMENT_CHANNEL_DENIED");
  }
  return {
    async create(input) {
      return (await select(input)).create(input);
    },
    async resolveRequest(input) {
      return (await select(input)).resolveRequest(input);
    },
  };
}
