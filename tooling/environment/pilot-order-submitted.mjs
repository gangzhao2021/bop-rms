import {
  createPostgresOrderSubmittedConsumer,
  createPostgresOrderBatchIdentitySource,
  createPostgresAdditionalDiningExecutionReader,
} from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalOrderSubmitted(resources) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_ORDER_SUBMITTED_ONLY");
  const scope = resources.scope,
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const authorized = async (_tx, event) =>
    active() && event.tenantId === scope.brandReference && event.storeId === scope.storeReference;
  const same = (q) =>
    active() &&
    q.brandReference === scope.brandReference &&
    q.storeReference === scope.storeReference;
  return createPostgresOrderSubmittedConsumer({
    projection: {
      ...scope,
      authorize: async (_tx, q) => same(q),
      validateCurrentSource: async (_tx, p) => same(p.snapshot),
    },
    authorization: { authorize: authorized },
    history: { quoteVersion: 2, locale: "en-CA" },
    references: { generateGeneration: resources.credentials.reference, now: resources.now },
    freshness: async (tx, snapshot) => {
      if (!same(snapshot)) throw new Error("ORDER_SUBMITTED_SCOPE_DENIED");
      const batch = snapshot.batches.at(-1);
      if (!batch) throw new Error("ORDER_SUBMITTED_BATCH_UNAVAILABLE");
      const identity = await createPostgresOrderBatchIdentitySource({
        ...scope,
        authorize: async () => active(),
      }).load(tx, {
        orderReference: snapshot.orderReference,
        orderBatchReference: batch.orderBatchReference,
        observedAt: resources.now(),
      });
      if (!identity || identity.kind !== "Additional")
        throw new Error("ORDER_SUBMITTED_IDENTITY_UNAVAILABLE");
      const execution = await createPostgresAdditionalDiningExecutionReader({
        ...scope,
        authorize: async (_tx, q) =>
          same(q) && q.submissionReference === identity.submissionReference,
      }).loadBySubmission({
        transaction: tx,
        submissionReference: identity.submissionReference,
        observedAt: resources.now(),
      });
      if (!execution) throw new Error("ORDER_SUBMITTED_EXECUTION_UNAVAILABLE");
      return execution.orderVersion === snapshot.sourceVersion ? "Fresh" : "Stale";
    },
  });
}
