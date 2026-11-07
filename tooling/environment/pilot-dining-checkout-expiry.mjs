import { createDiningCheckoutExpiryDispatcher } from "../../apps/api/dist/dining-checkout-expiry-dispatcher.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
export function createInternalDiningCheckoutExpiryWorkload(
  resources,
  onSnapshot,
  { providerAccountReference },
) {
  const allowed = () =>
    isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil;
  const dispatcher = createDiningCheckoutExpiryDispatcher({
    scope: {
      ...resources.scope,
      tenantReference: resources.publicProfile.binding.tenantReference,
      providerAccountReference: providerAccountReference,
      environment: pilotProviderEnvironment(),
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
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
