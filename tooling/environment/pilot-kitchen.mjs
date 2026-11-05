import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { loadDiningTeaChargeSetting } from "../../packages/rms/dining/src/index.ts";
import { parseOrderConfirmedEnvelope } from "../../packages/rms/ordering/src/index.ts";
import { createHash } from "node:crypto";
import {
  createPostgresOrderBatchIdentitySource,
  createPostgresOrderKitchenSourceStore,
} from "../../packages/rms/ordering/src/index.ts";
import {
  createPostgresRecipePreparationContentStore,
  createPostgresConfiguredRecipePreparationSource,
  listDeclaredChargeSkus,
} from "../../packages/rms/recipe/src/index.ts";
import { createKitchenRecipePreparationSource } from "../../apps/api/src/kitchen-recipe-preparation-source.ts";
import { comboChoiceProducts } from "../../apps/api/dist/merchant-combo-parts.js";
import {
  createPostgresKitchenRoutingConfigurationStore,
  createPostgresKitchenTicketStore,
  createKitchenTicketIntakeAdapter,
  createConfirmedOrderConsumerService,
  createKitchenWorkPlanService,
  createKitchenNotPreparedIntakeAdapter,
  loadKitchenBatchPreparationDecision,
} from "../../packages/rms/kitchen/src/index.ts";

/**
 * WP-2423 item 8 ⑦ (decision 2): the lines of a round the kitchen does not prepare, as Kitchen
 * decided when the round reached it (none before then: the intake decides first).
 */
export function kitchenNotPreparedLines(scope) {
  return async (transaction, round) =>
    new Set(
      (await loadKitchenBatchPreparationDecision(transaction, scope, round.orderBatchReference))
        ?.notPreparedOrderItemReferences ?? [],
    );
}
/**
 * WP-2423 item 8a: of these sizes, the ones the kitchen does not prepare unless the Store marked the
 * dish: a size declared a charge, and the Store's current tea item (choosing another tea gives the
 * dish back to the kitchen, with nothing to undo).
 */
export function kitchenDefaultNotPrepared(scope) {
  return async (transaction, skuReferences) => {
    const tea = (await loadDiningTeaChargeSetting(transaction, scope)).teaSellableReference;
    const charges = await listDeclaredChargeSkus(transaction, scope, skuReferences);
    return new Set([...charges, ...(tea !== null && skuReferences.includes(tea) ? [tea] : [])]);
  };
}
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalKitchen(resources) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_KITCHEN_ONLY");
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
  // v15 2026-11-01: the step a confirmed order could not get past (kitchen's own failures are one
  // code), so the delivery failure names its cause instead of only a temporary failure.
  const step = (diagnosis, code, read) => async (query) => {
    let value;
    try {
      value = await read(query);
    } catch (error) {
      diagnosis.cause ??= Object.assign(new Error(code), { code, cause: error });
      throw error;
    }
    if (value === null) diagnosis.cause ??= Object.assign(new Error(code), { code });
    return value;
  };
  function service(transaction, diagnosis = { cause: null }) {
    const observedAt = resources.now();
    const source = createPostgresOrderKitchenSourceStore({
      ...scope,
      quoteVersion: 2,
      sha256: hash,
      authorize: async () => active(),
      notPrepared: kitchenNotPreparedLines(scope),
    });
    // Every line of the round, before the kitchen decides which it does not prepare.
    const allLines = createPostgresOrderKitchenSourceStore({
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
      orderingSource: {
        resolve: step(diagnosis, "KITCHEN_ORDER_SOURCE_UNAVAILABLE", (query) =>
          source.resolve({ transaction, query }),
        ),
      },
      plans: {
        resolve: (input) =>
          createKitchenWorkPlanService({
            references,
            digests: { sha256: hash },
            // None: the Store had no kitchen routing in effect when the order was confirmed.
            stationRouting: {
              resolve: step(diagnosis, "KITCHEN_ROUTING_NOT_IN_EFFECT_AT_CONFIRMATION", (query) =>
                routing.resolve({ transaction, query }),
              ),
            },
            preparations: {
              resolve: step(diagnosis, "KITCHEN_PREPARATION_UNAVAILABLE", (query) =>
                preparation.resolve(transaction, query),
              ),
            },
          }).resolve(input),
      },
    };
    return createConfirmedOrderConsumerService({
      authorization: { authorize: async () => active() },
      intakes: createKitchenNotPreparedIntakeAdapter({
        inner: createKitchenTicketIntakeAdapter(ports),
        scope,
        now: resources.now,
        derive: references.derive,
        notPreparedByDefault: kitchenDefaultNotPrepared(scope),
        orderType: async (tx, receipt) => {
          const identity = await createPostgresOrderBatchIdentitySource({
            ...scope,
            authorize: async () => active(),
          }).load(tx, {
            orderReference: receipt.orderReference,
            orderBatchReference: receipt.orderBatchReference,
            observedAt: resources.now(),
          });
          if (!identity) throw new Error("INTERNAL_KITCHEN_IDENTITY_UNAVAILABLE");
          return identity.orderType;
        },
        allLines: async (tx, receipt) =>
          (
            await allLines.resolve({
              transaction: tx,
              query: {
                ...scope,
                orderReference: receipt.orderReference,
                orderBatchReference: receipt.orderBatchReference,
                confirmationReference: receipt.confirmationReference,
                sourceEventReference: receipt.sourceEventReference,
                sourceAggregateVersion: receipt.sourceAggregateVersion,
                sourceSnapshotDigest: receipt.sourceSnapshotDigest,
                // Now, not when it was confirmed: a later round may exist by the time this one is
                // consumed, and the Order's history is read as of now (v15 2026-11-03).
                observedAt,
              },
            })
          ).items.map((item) => ({
            orderItemReference: String(item.orderItemReference),
            productReference: String(item.productReference),
            skuReference: String(item.skuReference),
            quantity: item.quantity,
            optionReferences: (item.selectedOptions ?? []).map((option) =>
              String(option.optionReference),
            ),
          })),
        comboChoices: (tx, optionReferences) => comboChoiceProducts(tx, scope, optionReferences),
      }),
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
    handler: async (context) => {
      authorized(context.envelope);
      const diagnosis = { cause: null };
      const outcome = await service(context.transaction, diagnosis).registration.handler(context);
      // Retried as before; the failure carries the step it stopped at (codes only).
      if (outcome.status === "retry_required" && diagnosis.cause !== null)
        throw Object.assign(new Error(outcome.errorCode, { cause: diagnosis.cause }), {
          code: outcome.errorCode,
        });
      return outcome;
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
