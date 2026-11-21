import { exercisePaidKitchenLifecycle } from "./kitchen-paid-lifecycle.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresKitchenRoutingConfigurationStore,
  createPostgresKitchenTicketStore,
  createKitchenTicketIntakeAdapter,
  createConfirmedOrderConsumerService,
  createKitchenWorkPlanService,
} from "../../rms/kitchen/src/index.ts";
import {
  createPostgresRecipePreparationContentStore,
  createPostgresConfiguredRecipePreparationSource,
} from "../../rms/recipe/src/index.ts";
import { createKitchenRecipePreparationSource } from "../../../apps/api/src/kitchen-recipe-preparation-source.ts";

// Existing owner publications, no replacement route/recipe publication for an added Batch.
export async function exerciseDiningSecondKitchenTicket({
  client,
  runner,
  scope,
  source,
  query,
  event,
}) {
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = {
    derive(purpose, identity) {
      const digest = createHash("sha256")
        .update(purpose + ":" + identity)
        .digest("hex");
      return (
        "0190abcd-" +
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
  let dependency = "none";
  const traced = async (name, work) => {
    try {
      return await work();
    } catch (error) {
      dependency =
        name +
        ":" +
        (typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : "UNAVAILABLE");
      throw error;
    }
  };
  const noWrite = async () => {
    throw new Error("READ_ONLY_PUBLICATION");
  };
  const routing = createPostgresKitchenRoutingConfigurationStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    sha256: hash,
    authorizeRead: async () => true,
    authorizeWrite: async () => false,
    validateConfiguration: async () => false,
    audit: noWrite,
  });
  const content = createPostgresRecipePreparationContentStore({
    brandReference: scope.brandReference,
    sha256: hash,
    authorizeRead: async () => true,
    authorizeWrite: async () => false,
    validatePublication: async () => false,
    audit: noWrite,
  });
  const recipe = createPostgresConfiguredRecipePreparationSource({
    brandReference: scope.brandReference,
    sha256: hash,
    content,
    authorize: async () => true,
  });
  const preparation = createKitchenRecipePreparationSource({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    recipe,
    authorize: async () => true,
    sha256: hash,
    deriveReference: references.derive,
  });
  const repository = createPostgresKitchenTicketStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    references,
    digests: { sha256: hash },
    authorize: async () => true,
    validateCurrentSource: async (transaction, effect) => {
      const current = await source.resolve({ transaction, query });
      const valid =
        current.evidenceDigest === effect.ticket.sourceEvidenceDigest &&
        current.orderBatchReference === effect.ticket.orderBatchReference;
      if (!valid) dependency = "source_fence_mismatch";
      return valid;
    },
  });
  const consume = () =>
    runner().run((transaction) => {
      const plans = createKitchenWorkPlanService({
        references,
        digests: { sha256: hash },
        stationRouting: {
          resolve: (request) =>
            traced("routing", () => routing.resolve({ transaction, query: request })),
        },
        preparations: {
          resolve: (request) => traced("recipe", () => preparation.resolve(transaction, request)),
        },
      });
      return createConfirmedOrderConsumerService({
        authorization: { authorize: async () => true },
        intakes: createKitchenTicketIntakeAdapter({
          references,
          digests: { sha256: hash },
          clock: { now: async () => query.observedAt },
          repository: {
            ...repository,
            commit: (input) => traced("commit", () => repository.commit(input)),
          },
          orderingSource: {
            resolve: (request) =>
              traced("ordering", () => source.resolve({ transaction, query: request })),
          },
          plans: { resolve: (input) => traced("plan", () => plans.resolve(input)) },
        }),
        digests: { sha256: hash },
      }).consume(transaction, event);
    });
  let created;
  try {
    created = await consume();
  } catch (error) {
    throw new Error("SECOND_KITCHEN:" + dependency, { cause: error });
  }
  assert.equal(created.status, "Accepted");
  const replay = await consume();
  assert.equal(replay.status, "AlreadyAccepted");
  assert.deepEqual(replay.receipt, created.receipt);
  const saved = await runner().run((transaction) =>
    repository.resolveBySemanticKeys({
      transaction,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      sourceEventReference: event.eventId,
      confirmationReference: query.confirmationReference,
      orderBatchReference: query.orderBatchReference,
    }),
  );
  assert.equal(saved.status, "Resolved");
  assert.equal(saved.effect.ticket.orderBatchReference, query.orderBatchReference);
  const counts = await client.query(
    "SELECT count(*)::int AS tickets,count(DISTINCT order_batch_id)::int AS batches FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
    [scope.brandReference, scope.storeReference, query.orderReference],
  );
  assert.deepEqual(counts.rows[0], { tickets: 2, batches: 2 });
  const role = await runner().run(
    async (transaction) =>
      (await transaction.query("SELECT current_user AS role", [])).rows[0].role,
  );
  assert.match(role, /^[a-z][a-z0-9_]+$/);
  const lifecycle = await exercisePaidKitchenLifecycle({
    admin: client,
    role,
    runner,
    scope,
    ticket: saved.effect.ticket,
    source,
    sourceQuery: query,
    hash,
    references,
    id: (n) => "01909864-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  });
  assert.equal(lifecycle.readyItems, saved.effect.ticket.workItems.length);
  return saved.effect.ticket;
}
