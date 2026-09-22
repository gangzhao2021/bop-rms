import process from "node:process";
import { createPostgresDiningBatchCancellationCandidates } from "../../packages/rms/ordering/src/index.ts";
import { createDiningBatchCancellationDispatcher } from "../../apps/api/dist/dining-batch-cancellation-dispatcher.js";
import { createInternalBatchCancellation } from "./pilot-batch-cancellation.mjs";
export async function createInternalBatchCancellationDispatcher(resources, options) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const source = createPostgresDiningBatchCancellationCandidates({
    ...scope,
    authorize: async (_tx, at) =>
      process.env.NODE_ENV === "development" &&
      at <= resources.now() &&
      resources.now() < resources.publicProfile.binding.validUntil,
  });
  const service = await createInternalBatchCancellation(resources, options);
  return createDiningBatchCancellationDispatcher({
    scope,
    transactions: resources.transactions,
    discover: (tx, query) => source.discover(tx, query),
    cancel: (input) => service.cancel(input),
    now: resources.now,
    pageSize: 10,
  });
}
