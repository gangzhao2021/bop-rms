import {
  createPostgresDiningCheckoutCommitmentStore,
  assertDiningCheckoutPreparedForOrdering,
} from "@rms/dining";
import {
  AdditionalDiningBatchStoreError,
  parseOrderingReference,
  type createPostgresAdditionalDiningBatchStore,
} from "@rms/ordering";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";

type Gate = Parameters<typeof createPostgresAdditionalDiningBatchStore>[0]["finalize"];
/** Read and fence only through Dining's owner contract. Identity/CSRF and current
 * Store/Checkout authority remain independently required by the composition.
 */
export function createCustomerAdditionalDiningCurrentGate(scope: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}): Gate {
  const fixed = Object.freeze({
    tenantReference: parseOrderingReference(scope.tenantReference),
    brandReference: parseOrderingReference(scope.brandReference),
    storeReference: parseOrderingReference(scope.storeReference),
  });
  return async (transaction, snapshot, capacityLink, context) => {
    if (
      snapshot.brandReference !== fixed.brandReference ||
      snapshot.storeReference !== fixed.storeReference
    )
      throw new AdditionalDiningBatchStoreError();
    const owner = createPostgresDiningCheckoutCommitmentStore(
      { run: (work) => work(transaction) },
      fixed,
      { now: () => context.observedAt },
    );
    const valid = await owner.withCurrentFacts(
      capacityLink.commitmentReference,
      async (_, facts) => {
        const commitment = assertDiningCheckoutPreparedForOrdering(
          facts.commitment,
          { session: facts.session, participant: facts.participant },
          context.observedAt,
        );
        if (
          facts.session.hostParticipantReference !== facts.participant.participantReference ||
          String(commitment.guestSessionReference) !== String(snapshot.guestSessionReference) ||
          String(commitment.diningSessionReference) !== String(snapshot.diningSessionReference) ||
          JSON.stringify(diningOrderCapacityLinkFromHistory(commitment)) !==
            JSON.stringify(capacityLink)
        )
          throw new AdditionalDiningBatchStoreError();
        return true;
      },
    );
    if (valid !== true) throw new AdditionalDiningBatchStoreError();
  };
}
