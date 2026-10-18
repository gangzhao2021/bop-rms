import { createHash } from "node:crypto";
import {
  createPaymentStatusEventConsumerService,
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentStatusStore,
} from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalPaymentStatus(resources, { providerAccountReference }) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_PAYMENT_STATUS_ONLY");
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const scope = {
    ...resources.scope,
    providerAccountReference: providerAccountReference,
    environment: "Test",
  };
  const projections = createPostgresPaymentStatusStore({
    scope,
    authorize: async (_tx, value) =>
      active() &&
      value.brandReference === scope.brandReference &&
      value.storeReference === scope.storeReference,
    authorizeOrder: async (_tx, value) =>
      active() &&
      value.brandReference === scope.brandReference &&
      value.storeReference === scope.storeReference,
  });
  const service = createPaymentStatusEventConsumerService({
    scope: resources.scope,
    authorization: {
      authorize: async (_tx, event) =>
        active() &&
        event.tenantId === scope.brandReference &&
        event.storeId === scope.storeReference,
    },
    projections,
    references: { generateGeneration: resources.credentials.reference, now: resources.now },
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
    // WP-2423 Q7: a card-machine payment has no Provider status; its own record is the status.
    cardMachine: {
      isCardMachinePayment: async (tx, event) =>
        (await createPostgresCardMachinePaymentStore({
          scope: resources.scope,
          authorize: async () => active(),
        }).loadByIntent(tx, event.aggregateId)) !== null,
    },
  });
  return { ...service, projections };
}
