import { canonicalizeRfc8785 } from "@bop/audit";
import { loadOutboxEnvelope, type ConsumerTransaction } from "@bop/eventing";
import { parsePricingReference, type PersistentPriceBookRepository } from "@rms/pricing";

/** Pricing operation and immutable Eventing Actor establish the current draft
 * author. This composition's event identity convention is operationReference.
 * Missing legacy/bootstrap provenance denies independent publication approval.
 */
export function createPriceBookDraftAuthorSource(options: {
  brandReference: string;
  repository(
    transaction: ConsumerTransaction,
  ): Pick<PersistentPriceBookRepository, "loadCurrentOperation">;
}) {
  const brand = parsePricingReference(options.brandReference);
  return Object.freeze({
    async load(transaction: ConsumerTransaction, priceBookReference: string) {
      const book = parsePricingReference(priceBookReference);
      const operation = await options.repository(transaction).loadCurrentOperation(book);
      if (
        !operation ||
        operation.aggregate.lifecycle !== "Draft" ||
        !["CreateDraft", "ReplaceDraft"].includes(operation.action)
      )
        return null;
      if (
        operation.aggregate.brandReference !== brand ||
        operation.aggregate.priceBookReference !== book
      )
        return null;
      const event = await loadOutboxEnvelope(transaction, operation.operationReference);
      if (
        !event ||
        event.tenantId !== brand ||
        event.storeId !== undefined ||
        event.producerModule !== "@rms/pricing" ||
        event.aggregateType !== "PriceBook" ||
        event.aggregateId !== book ||
        event.aggregateVersion !== BigInt(operation.aggregate.aggregateVersion) ||
        event.schemaVersion !== 1 ||
        event.eventId !== operation.operationReference ||
        event.eventType !== operation.event.eventType ||
        event.occurredAt !== operation.aggregate.createdAt ||
        event.actor.type !== "Actor" ||
        canonicalizeRfc8785(event.payload) !== canonicalizeRfc8785(operation.event)
      )
        return null;
      return Object.freeze({
        actorReference: parsePricingReference(event.actor.actorId),
        operationReference: operation.operationReference,
        versionReference: operation.aggregate.versionReference,
        aggregateVersion: operation.aggregate.aggregateVersion,
      });
    },
  });
}
