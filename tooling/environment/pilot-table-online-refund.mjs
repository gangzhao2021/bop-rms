import { createDiningTableOnlineRefundSender } from "../../apps/api/dist/dining-table-online-refund.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";

/**
 * WP-2423 DEC-TABLE-ONLINE-REFUND: a refund staff approved stays on its way when the Provider did
 * not answer; this keeps sending the same refund (same key) until it does. Pilot provider only.
 */
export function createInternalTableOnlineRefundWorkload(
  resources,
  onSnapshot,
  { createSimulatedProvider },
) {
  const allowed = () =>
    isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil;
  const sender = createDiningTableOnlineRefundSender({
    scope: {
      ...resources.scope,
      tenantReference: resources.publicProfile.binding.tenantReference,
    },
    provider: {
      refundPayment: async (request) => {
        const simulator = await createSimulatedProvider();
        try {
          return await simulator.adapter.refundPayment(request);
        } finally {
          simulator.close();
        }
      },
    },
    transactions: resources.transactions,
    authorize: async () => allowed(),
    now: resources.now,
    nextReference: resources.credentials.reference,
  });
  return createOutboxWorkload({
    dispatcher: {
      runOnce: () => sender.sendOpen({ limit: 5 }),
      stop: async () => "drained",
    },
    pollIntervalMs: 30000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
