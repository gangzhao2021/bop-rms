import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseFulfillmentCompletedEnvelope } from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export async function createInternalOrderCompletionConsumer(resources, { createCompletion }) {
  const service = await createCompletion(resources);
  const authorized = (value) => {
    const event = parseFulfillmentCompletedEnvelope(value);
    if (
      !isPilotRuntime() ||
      resources.now() >= resources.publicProfile.binding.validUntil ||
      event.tenantId !== resources.scope.brandReference ||
      event.storeId !== resources.scope.storeReference
    )
      throw new Error("INTERNAL_ORDER_COMPLETION_SCOPE_DENIED");
    return event;
  };
  const registration = Object.freeze({
    consumerName: "ordering.internal-fulfillment-completion:v1",
    consumerVersion: 1,
    eventType: "FulfillmentCompleted",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "commit_fulfilled_order_workflow",
    replaySafe: true,
    handler: async ({ transaction, envelope }) => {
      await service.consume(transaction, authorized(envelope));
      return { status: "completed" };
    },
  });
  return {
    registration,
    consume: (transaction, value) =>
      consumeEventInTransaction(transaction, registration, authorized(value)),
  };
}
