import {
  createPostgresDiningCheckoutCommitmentStore,
  sealDiningCheckoutCommitment,
  type DiningCheckoutCommitment,
} from "@rms/dining";
import {
  AdditionalDiningBatchStoreError,
  type createPostgresAdditionalDiningBatchStore,
} from "@rms/ordering";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";

type Finalize = Parameters<typeof createPostgresAdditionalDiningBatchStore>[0]["finalize"];
/** Invoke only from the Ordering post-write finalization capability, after
 * successful same-transaction Batch/link persistence. Acknowledgment is an
 * observed owner write, never a claimed database commit timestamp.
 */
export function createCustomerAdditionalDiningCommitmentSeal(
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  audit: (record: DiningCheckoutCommitment) => Promise<unknown>,
): Finalize {
  if (typeof audit !== "function") throw new AdditionalDiningBatchStoreError();
  return async (transaction, snapshot, link, context) => {
    const store = createPostgresDiningCheckoutCommitmentStore(
      { run: (work) => work(transaction) },
      scope,
      { now: () => context.observedAt },
    );
    const result = await store.withCurrentFacts(link.commitmentReference, async (_, facts) => {
      if (
        JSON.stringify(diningOrderCapacityLinkFromHistory(facts.commitment)) !==
          JSON.stringify(link) ||
        String(facts.commitment.submissionReference) !==
          String(snapshot.batch.submissionReference) ||
        facts.session.hostParticipantReference !== facts.participant.participantReference
      )
        throw new AdditionalDiningBatchStoreError();
      const c = facts.commitment;
      const record = sealDiningCheckoutCommitment(
        c,
        { session: facts.session, participant: facts.participant },
        {
          commitmentReference: c.commitmentReference,
          brandReference: c.brandReference,
          storeReference: c.storeReference,
          submissionReference: c.submissionReference,
          orderReference: c.orderReference,
          orderBatchReference: c.orderBatchReference,
          cartReference: c.cartReference,
          cartVersion: c.cartVersion,
          quoteReference: c.quoteReference,
          paymentOperationReference: c.paymentOperationReference,
          guestSessionReference: c.guestSessionReference,
          intentHash: c.intentHash,
          acknowledgedAt: context.observedAt,
        },
        context.observedAt,
        context.observedAt,
      );
      await store.append({ record, expectedVersion: 1, audit: await audit(record) });
      return true;
    });
    if (result !== true) throw new AdditionalDiningBatchStoreError();
  };
}
