import console from "node:console";
import { createPostgresDiningBatchCancellationCandidates } from "../../packages/rms/ordering/src/index.ts";
import { createDiningBatchCancellationDispatcher } from "../../apps/api/dist/dining-batch-cancellation-dispatcher.js";
import { createInternalBatchCancellation } from "./pilot-batch-cancellation.mjs";
import { createInternalOpenPaymentResolution } from "./pilot-open-payment-resolution.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";
export async function createInternalBatchCancellationDispatcher(resources, options) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const source = createPostgresDiningBatchCancellationCandidates({
    ...scope,
    authorize: async (_tx, at) =>
      isPilotRuntime() &&
      at <= resources.now() &&
      resources.now() < resources.publicProfile.binding.validUntil,
  });
  const service = await createInternalBatchCancellation(resources, options);
  const payment =
    options.createSimulatedProvider === undefined || options.providerAccountReference === undefined
      ? null
      : createInternalOpenPaymentResolution(resources, {
          createSimulatedProvider: options.createSimulatedProvider,
          providerAccountReference: options.providerAccountReference,
        });
  return createDiningBatchCancellationDispatcher({
    scope,
    transactions: resources.transactions,
    discover: (tx, query) => source.discover(tx, query),
    cancel: (input) => service.cancel(input),
    ...(payment === null
      ? {}
      : {
          resolveStartedPayment: async (expiry) => {
            const outcome = await payment.resolve(expiry.paymentOperationReference);
            // Never log identifiers; the status alone tells operations what is happening.
            if (outcome.status !== "Failed" && outcome.status !== "Paid")
              console.error(
                JSON.stringify({
                  event: "INTERNAL_OPEN_PAYMENT_UNRESOLVED",
                  status: outcome.status,
                }),
              );
            return outcome;
          },
        }),
    now: resources.now,
    pageSize: 10,
  });
}
