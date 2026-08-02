import { validateDomainEventEnvelope, type DomainEventEnvelope } from "@bop/eventing";

import type { MenuPublicationRecord } from "../contracts/menu-publication.js";
import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import type { MenuPublishedPayload } from "../contracts/published-menu-projection.js";

export function createMenuPublishedEnvelope(input: {
  readonly eventReference: string;
  readonly operationReference: string;
  readonly correlationReference: string;
  readonly actorReference: string;
  readonly menuReference: string;
  readonly brandReference: string;
  readonly record: MenuPublicationRecord;
}): DomainEventEnvelope<MenuPublishedPayload> {
  const { lifecycle, release, effectivePeriod } = input.record;
  if (lifecycle.state !== "Published" || release === null || effectivePeriod === null)
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return validateDomainEventEnvelope({
    eventId: parseCatalogReference(input.eventReference),
    eventType: "MenuPublished",
    schemaVersion: 1,
    occurredAt: lifecycle.changedAt,
    producerModule: "@rms/catalog",
    tenantId: parseCatalogReference(input.brandReference),
    aggregateType: "Menu",
    aggregateId: parseCatalogReference(input.menuReference),
    aggregateVersion: BigInt(lifecycle.version),
    correlationId: parseCatalogReference(input.correlationReference),
    causationId: parseCatalogReference(input.operationReference),
    actor: { type: "Actor", actorId: parseCatalogReference(input.actorReference) },
    payload: {
      menuReference: String(lifecycle.familyReference),
      menuVersionReference: String(lifecycle.snapshotReference),
      releaseReference: String(release.releaseId),
      snapshotDigest: String(lifecycle.snapshotDigest),
      effectiveFrom: effectivePeriod.effectiveFrom.instant,
      effectiveUntil: effectivePeriod.effectiveUntil?.instant ?? null,
      timeZone: effectivePeriod.timeZone,
    },
    redactionClassification: "none",
    replayMetadata: { replaySafe: true },
  }) as DomainEventEnvelope<MenuPublishedPayload>;
}
