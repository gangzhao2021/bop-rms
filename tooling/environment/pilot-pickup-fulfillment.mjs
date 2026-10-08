import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import {
  parseOrderConfirmedEnvelope,
  createPostgresOrderBatchIdentitySource,
} from "../../packages/rms/ordering/src/index.ts";
import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import { createPostgresOrderFulfillmentSourceStore } from "../../packages/rms/ordering/src/index.ts";
import {
  createPickupFulfillmentService,
  createPostgresPickupFulfillmentStore,
} from "../../packages/rms/fulfillment/src/index.ts";
export function createInternalPickupFulfillment(resources) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_FULFILLMENT_ONLY");
  const scope = resources.scope,
    hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const references = {
    derive: (purpose, identity) => {
      const digest = hash(purpose + ":" + identity).slice(7);
      return (
        "0190fa32-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
  };
  function service(transaction) {
    const source = createPostgresOrderFulfillmentSourceStore({
      ...scope,
      quoteVersion: 2,
      sha256: hash,
      authorize: async (_tx, request) =>
        active() &&
        request.action === "ResolveConfirmedOrderFulfillmentSource" &&
        request.purpose === "CreatePickupFulfillment",
    });
    const repository = createPostgresPickupFulfillmentStore({
      ...scope,
      sha256: hash,
      authorize: async () => active(),
      validateCurrentSource: async (tx, effect) => {
        const current = await source.resolve({
          transaction: tx,
          query: {
            ...scope,
            observedAt: effect.aggregate.createdAt,
            orderReference: effect.aggregate.orderReference,
            orderBatchReference: effect.aggregate.orderBatchReference,
            confirmationReference: effect.aggregate.confirmationReference,
            sourceEventReference: effect.aggregate.sourceEventReference,
            sourceAggregateVersion: effect.aggregate.sourceAggregateVersion,
            sourceSnapshotDigest: effect.aggregate.sourceSnapshotDigest,
          },
        });
        return (
          current.orderType === "Pickup" &&
          current.evidenceDigest === effect.aggregate.sourceEvidenceDigest
        );
      },
    });
    return createPickupFulfillmentService({
      authorization: { authorize: async () => active() },
      orderingSource: { resolve: (input) => source.resolve({ transaction, query: input }) },
      references,
      digests: { sha256: hash },
      repository,
      audit: {
        append: ({ transaction: tx, record }) => appendAuditRecordInTransaction(tx, record),
      },
    });
  }
  function authorized(value) {
    const event = parseOrderConfirmedEnvelope(value);
    if (
      !active() ||
      event.tenantId !== scope.brandReference ||
      event.storeId !== scope.storeReference
    )
      throw new Error("INTERNAL_FULFILLMENT_SCOPE_DENIED");
    return event;
  }
  const registration = Object.freeze({
    ...service().registration,
    handler: async (context) => {
      const event = authorized(context.envelope);
      const identity = await createPostgresOrderBatchIdentitySource({
        ...scope,
        authorize: async () => active(),
      }).load(context.transaction, {
        orderReference: event.payload.orderReference,
        orderBatchReference: event.payload.orderBatchReference,
        observedAt: resources.now(),
      });
      if (!identity) throw new Error("INTERNAL_FULFILLMENT_IDENTITY_UNAVAILABLE");
      if (identity.orderType === "DineIn") return { status: "completed" };
      return service(context.transaction).registration.handler(context);
    },
  });
  return {
    consume: (transaction, value) => service(transaction).consume(transaction, authorized(value)),
    worker: {
      registration,
      consume: (transaction, value) =>
        consumeEventInTransaction(transaction, registration, authorized(value)),
    },
  };
}
