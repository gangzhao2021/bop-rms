import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createPostgresMerchantOrderIndex,
  createPostgresOrderFulfillmentSourceStore,
  createPostgresOrderExecutionReader,
} from "../../packages/rms/ordering/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPostgresFulfillmentReadinessStore,
} from "../../packages/rms/fulfillment/src/index.ts";
export function createInternalPickupReadiness(
  resources,
  confirmation = null,
  { createConfirmation },
) {
  if (
    process.env.NODE_ENV !== "development" ||
    (confirmation !== null &&
      (confirmation.tenantId !== resources.scope.brandReference ||
        confirmation.storeId !== resources.scope.storeReference ||
        confirmation.eventType !== "OrderConfirmed"))
  )
    throw new Error("INTERNAL_READINESS_SCOPE_DENIED");
  const scope = resources.scope,
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = {
    derive: (purpose, identity) => {
      const d = hash(purpose + ":" + identity).slice(7);
      return (
        "0190fa32-" +
        d.slice(0, 4) +
        "-7" +
        d.slice(4, 7) +
        "-8" +
        d.slice(7, 10) +
        "-" +
        d.slice(10, 22)
      );
    },
  };
  const resolveConfirmation = createConfirmation(resources);
  const source = createPostgresOrderFulfillmentSourceStore({
    ...scope,
    quoteVersion: 2,
    sha256: hash,
    authorize: async () => active(),
  });
  const storeOptions = {
    ...scope,
    sha256: hash,
    now: resources.now,
    authorize: async () => active(),
    validateCurrentSource: async (transaction, orderReference) => {
      const selected = confirmation ?? (await resolveConfirmation(transaction, orderReference));
      if (orderReference !== selected.payload.orderReference) return false;
      const execution = await createPostgresOrderExecutionReader({
        ...scope,
        sha256: hash,
        authorize: async () => active(),
      }).loadByBatch({
        transaction,
        orderReference,
        orderBatchReference: selected.payload.orderBatchReference,
      });
      if (execution.phase === "Fulfilled")
        return (
          execution.completion !== null &&
          execution.completion.orderReference === orderReference &&
          execution.completion.orderBatchReference === selected.payload.orderBatchReference &&
          execution.completion.sourceEvent.payload.orderReference === orderReference
        );
      const current = await source.resolve({
        transaction,
        query: {
          ...scope,
          orderReference,
          orderBatchReference: selected.payload.orderBatchReference,
          confirmationReference: selected.payload.confirmationReference,
          sourceEventReference: selected.eventId,
          sourceAggregateVersion: selected.aggregateVersion,
          sourceSnapshotDigest: selected.payload.sourceSnapshotDigest,
          observedAt: resources.now(),
        },
      });
      return current.orderType === "Pickup";
    },
  };
  const repository = createPostgresFulfillmentReadinessStore(storeOptions);
  const service = createFulfillmentReadinessService({
    authorization: { authorize: async () => active() },
    references,
    digests: { sha256: hash },
    repository,
    audit: {
      append: ({ transaction, record }) => appendAuditRecordInTransaction(transaction, record),
    },
  });
  async function authorized(transaction, value) {
    const event = parseKitchenItemReadyEnvelope(value);
    if (
      !active() ||
      event.tenantId !== scope.brandReference ||
      event.storeId !== scope.storeReference
    )
      throw new Error("INTERNAL_READINESS_SCOPE_DENIED");
    const selected =
      confirmation ?? (await resolveConfirmation(transaction, event.payload.orderReference));
    if (
      event.payload.orderReference !== selected.payload.orderReference ||
      event.payload.orderBatchReference !== selected.payload.orderBatchReference
    )
      throw new Error("INTERNAL_READINESS_SCOPE_DENIED");
    return event;
  }
  return {
    repository,
    storeOptions,
    consume: async (transaction, value) =>
      service.consume(transaction, await authorized(transaction, value)),
    worker: {
      registration: service.registration,
      consume: async (transaction, value) => {
        const event = parseKitchenItemReadyEnvelope(value);
        // WP-2423: pickup readiness applies to pickup Orders. A dine-in item is served at the
        // table (the dining serving flow owns its readiness), so the event completes here with
        // no readiness effect instead of failing until it is dead-lettered.
        const order = active()
          ? await createPostgresMerchantOrderIndex({
              ...scope,
              authorize: async () => active(),
            }).find({ transaction, orderReference: event.payload.orderReference })
          : null;
        if (order?.orderType === "DineIn")
          return consumeEventInTransaction(
            transaction,
            {
              ...service.registration,
              handler: async () => ({
                status: "completed",
                resultHash: hash("NotApplicable:DineIn:" + event.eventId).slice(7),
              }),
            },
            event,
          );
        return consumeEventInTransaction(
          transaction,
          service.registration,
          await authorized(transaction, event),
        );
      },
    },
  };
}
