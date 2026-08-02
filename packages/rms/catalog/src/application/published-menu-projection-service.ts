import {
  consumeEventInTransaction,
  validateDomainEventEnvelope,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";

import type { MenuPublishedEnvelope } from "../contracts/published-menu-projection.js";
import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import { buildPublishedMenuProjection } from "../domain/published-menu-projection.js";
import type { PublishedMenuProjectionPorts } from "./ports/published-menu-projection-ports.js";

function dependency(error?: unknown): never {
  if (error instanceof CatalogError) throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}

function menuEnvelope(value: MenuPublishedEnvelope): MenuPublishedEnvelope {
  const envelope = validateDomainEventEnvelope(value) as MenuPublishedEnvelope;
  const payload = envelope.payload;
  if (
    envelope.eventType !== "MenuPublished" ||
    envelope.schemaVersion !== 1 ||
    envelope.producerModule !== "@rms/catalog" ||
    envelope.storeId !== undefined ||
    Object.keys(payload).length !== 7
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  parseCatalogReference(payload.menuReference);
  parseCatalogReference(payload.menuVersionReference);
  parseCatalogReference(payload.releaseReference);
  return envelope;
}

export function createPublishedMenuProjectionService(ports: PublishedMenuProjectionPorts) {
  const registration: ConsumerRegistration = {
    consumerName: "catalog.published-menu-projection",
    consumerVersion: 1,
    eventType: "MenuPublished",
    schemaVersions: [1],
    ownerModule: "@rms/catalog",
    tenantScope: "brand",
    ordering: "aggregate",
    sideEffect: "replace Catalog Published Menu projection generation",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = menuEnvelope(envelope as MenuPublishedEnvelope);
      const current = await ports.projections
        .load(parseCatalogReference(event.aggregateId))
        .catch(dependency);
      if (current !== null && current.sourceAggregateVersion >= Number(event.aggregateVersion))
        return {
          status: "completed",
          resultHash: String(current.snapshot.snapshotDigest).slice(7),
        };
      const snapshot = await ports.snapshots
        .loadExact({
          brandReference: parseCatalogReference(event.tenantId),
          menuReference: parseCatalogReference(event.payload.menuReference),
          menuVersionReference: parseCatalogReference(event.payload.menuVersionReference),
          releaseReference: parseCatalogReference(event.payload.releaseReference),
          snapshotDigest: event.payload.snapshotDigest,
        })
        .catch(dependency);
      if (snapshot === null)
        return { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" };
      const projection = buildPublishedMenuProjection({
        envelope: event,
        snapshot,
        generationReference: ports.references.generateGeneration(),
        projectedAt: ports.references.now(),
      });
      const saved = await ports.projections
        .replace({ projection, envelope: event, transaction })
        .catch(dependency);
      if (
        saved.sourceEventReference !== projection.sourceEventReference ||
        saved.sourceAggregateVersion !== projection.sourceAggregateVersion
      )
        dependency();
      return {
        status: "completed",
        resultHash: String(projection.snapshot.snapshotDigest).slice(7),
      };
    },
  };
  return Object.freeze({
    registration: Object.freeze(registration),
    async consume(transaction: ConsumerTransaction, envelope: MenuPublishedEnvelope) {
      return await consumeEventInTransaction(transaction, registration, menuEnvelope(envelope));
    },
  });
}
