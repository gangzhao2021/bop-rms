import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseOrderConfirmedEnvelope } from "../../packages/rms/ordering/src/index.ts";
import { createHash } from "node:crypto";
import { createPostgresOrderKitchenSourceStore } from "../../packages/rms/ordering/src/index.ts";
import {
  createPostgresRecipePreparationContentStore,
  createPostgresConfiguredRecipePreparationSource,
} from "../../packages/rms/recipe/src/index.ts";
import { createKitchenRecipePreparationSource } from "../../apps/api/src/kitchen-recipe-preparation-source.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  createPostgresKitchenTicketStore,
  createKitchenTicketIntakeAdapter,
  createConfirmedOrderConsumerService,
  createKitchenWorkPlanService,
} from "../../packages/rms/kitchen/src/index.ts";
export function createInternalKitchen(resources) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_KITCHEN_ONLY");
  const scope = resources.scope,
    hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const references = {
    derive: (purpose, identity) => {
      const d = hash(purpose + ":" + identity).slice(7);
      return (
        "0190fa35-" +
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
  const readOnly = async () => {
    throw new Error("READ_ONLY");
  };
  const content = createPostgresRecipePreparationContentStore({
    brandReference: scope.brandReference,
    sha256: hash,
    authorizeRead: async () => active(),
    authorizeWrite: async () => false,
    validatePublication: async () => false,
    audit: readOnly,
  });
  const recipe = createPostgresConfiguredRecipePreparationSource({
    brandReference: scope.brandReference,
    sha256: hash,
    content,
    authorize: async () => active(),
  });
  const preparation = createKitchenRecipePreparationSource({
    ...scope,
    recipe,
    authorize: async () => active(),
    sha256: hash,
    deriveReference: references.derive,
  });
  const routing = createPostgresKitchenRoutingConfigurationStore({
    ...scope,
    sha256: hash,
    authorizeRead: async () => active(),
    authorizeWrite: async () => false,
    validateConfiguration: async () => false,
    audit: readOnly,
  });
  function service(transaction) {
    const observedAt = resources.now();
    const source = createPostgresOrderKitchenSourceStore({
      ...scope,
      quoteVersion: 2,
      sha256: hash,
      authorize: async () => active(),
    });
    const repository = createPostgresKitchenTicketStore({
      ...scope,
      references,
      digests: { sha256: hash },
      authorize: async (_tx, input) =>
        active() && input.actorType === "System" && input.purposeCode === "CREATE_KITCHEN_TICKET",
      validateCurrentSource: async (tx, effect) => {
        const current = await source.resolve({
          transaction: tx,
          query: {
            ...scope,
            observedAt,
            orderReference: effect.ticket.orderReference,
            orderBatchReference: effect.ticket.orderBatchReference,
            confirmationReference: effect.ticket.confirmationReference,
            sourceEventReference: effect.ticket.sourceEventReference,
            sourceAggregateVersion: effect.ticket.sourceAggregateVersion,
            sourceSnapshotDigest: effect.ticket.sourceSnapshotDigest,
          },
        });
        return current.evidenceDigest === effect.ticket.sourceEvidenceDigest;
      },
    });
    const ports = {
      references,
      digests: { sha256: hash },
      clock: { now: async () => observedAt },
      repository,
      orderingSource: { resolve: (query) => source.resolve({ transaction, query }) },
      plans: {
        resolve: (input) =>
          createKitchenWorkPlanService({
            references,
            digests: { sha256: hash },
            stationRouting: { resolve: (query) => routing.resolve({ transaction, query }) },
            preparations: { resolve: (query) => preparation.resolve(transaction, query) },
          }).resolve(input),
      },
    };
    return createConfirmedOrderConsumerService({
      authorization: { authorize: async () => active() },
      intakes: createKitchenTicketIntakeAdapter(ports),
      digests: { sha256: hash },
    });
  }
  function authorized(value) {
    const event = parseOrderConfirmedEnvelope(value);
    if (
      !active() ||
      event.tenantId !== scope.brandReference ||
      event.storeId !== scope.storeReference
    )
      throw new Error("INTERNAL_KITCHEN_SCOPE_DENIED");
    return event;
  }
  const registration = Object.freeze({
    ...service().registration,
    handler: (context) => {
      authorized(context.envelope);
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
