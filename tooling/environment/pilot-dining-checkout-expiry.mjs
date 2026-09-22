import process from "node:process";
import { createDiningCheckoutExpiryDispatcher } from "../../apps/api/dist/dining-checkout-expiry-dispatcher.js";
import { createOutboxWorkload } from "../../apps/worker/dist/outbox-workload.js";
export function createInternalDiningCheckoutExpiryWorkload(
  resources,
  onSnapshot,
  { providerAccountReference },
) {
  const allowed = () =>
    process.env.NODE_ENV === "development" &&
    resources.now() < resources.publicProfile.binding.validUntil;
  const dispatcher = createDiningCheckoutExpiryDispatcher({
    scope: {
      ...resources.scope,
      tenantReference: resources.publicProfile.binding.tenantReference,
      providerAccountReference: providerAccountReference,
      environment: "Test",
    },
    transactions: resources.transactions,
    authorize: async () => allowed(),
    authorizeDiscovery: async (_tx, at) => allowed() && at <= resources.now(),
    now: resources.now,
    newReference: resources.credentials.reference,
    pageSize: 10,
  });
  return createOutboxWorkload({
    dispatcher,
    pollIntervalMs: 5000,
    drainDeadlineMs: 25000,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
