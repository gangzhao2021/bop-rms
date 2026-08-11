import { isProxy } from "node:util/types";

import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerOutcome,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";

import {
  kitchenItemCompletedEventConsumer,
  kitchenItemProgressRecordedEventConsumer,
  kitchenWorkAcceptedEventConsumer,
  kitchenWorkStartedEventConsumer,
  type KitchenWorkLifecycleEnvelope,
} from "../contracts/kitchen-work-lifecycle-events.js";

import {
  buildKitchenQueueGetResult,
  buildKitchenQueueListResult,
  buildKitchenQueueRows,
  computeKitchenQueueFilterSortDigest,
  computeKitchenQueueRebuildRequestDigest,
  computeKitchenQueueSnapshotDigest,
  computeKitchenQueueSourceEventBindingDigest,
  computeKitchenQueueSourceEventSemanticDigest,
  kitchenQueueConsumerName,
  kitchenQueueConsumerVersion,
  kitchenQueuePermission,
  kitchenQueueProjectionName,
  kitchenQueueProjectionVersion,
  KitchenQueueProjectionError,
  parseKitchenQueueCursor,
  parseKitchenQueueGetQuery,
  parseKitchenQueueListQuery,
  parseKitchenQueueRebuildRequest,
  parseKitchenQueueRow,
  parseKitchenQueueRows,
  parseKitchenQueueSourceEvent,
  parseKitchenQueueSourceFeed,
  type KitchenQueueGeneration,
  type KitchenQueueGetResult,
  type KitchenQueueListResult,
  type KitchenQueueRebuildRequest,
  type KitchenQueueRow,
  type KitchenQueueSourceEvent,
  type KitchenQueueSourceFeed,
} from "../contracts/kitchen-queue-projection.js";
import {
  buildKitchenQueueStoredGeneration,
  kitchenQueueSnapshotBindingVersion,
  parseKitchenQueueLifecycleIncrementalSourceFeed,
  parseKitchenQueueLifecycleRebuildSourceFeed,
  parseKitchenQueueStoredGeneration,
  reconcileKitchenQueueStoredProjectionBundle,
  stripKitchenQueueStoredGeneration,
  type KitchenQueueLifecycleEventProof,
  type KitchenQueueLifecycleSourceFeed,
  type KitchenQueueStoredGeneration,
  type KitchenQueueStoredProjectionBundle,
} from "../domain/kitchen-queue-projection.js";
import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";
import { parseKitchenWorkLifecycleEnvelope } from "./kitchen-work-lifecycle-events.js";
import type {
  KitchenQueueCheckpointComparison,
  KitchenQueueGetRead,
  KitchenQueueListRead,
  KitchenQueueLifecycleCheckpointComparison,
  KitchenQueueProjectionCommit,
  KitchenQueueProjectionPorts,
  KitchenQueueStoredProjection,
  KitchenQueueStoredRebuild,
} from "./ports/kitchen-queue-projection-ports.js";

function fail(
  code:
    | "KITCHEN_QUEUE_PERMISSION_DENIED"
    | "KITCHEN_QUEUE_NOT_FOUND"
    | "KITCHEN_QUEUE_VERSION_CONFLICT"
    | "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
): never {
  throw new KitchenQueueProjectionError(code);
}

function dependency(): never {
  return fail("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
}

function rejectUnsafeLifecycleSourceGraph(
  value: unknown,
  seen = new WeakSet<object>(),
  active = new WeakSet<object>(),
): void {
  if (typeof value === "function") return dependency();
  if (typeof value !== "object" || value === null) return;
  if (isProxy(value) || active.has(value)) return dependency();
  if (seen.has(value)) return;
  seen.add(value);
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
        return dependency();
      rejectUnsafeLifecycleSourceGraph(descriptor.value, seen, active);
    }
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return dependency();
  } finally {
    active.delete(value);
  }
}

function conflict(): never {
  return fail("KITCHEN_QUEUE_VERSION_CONFLICT");
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lifecyclePayload(event: KitchenWorkLifecycleEnvelope): Readonly<Record<string, unknown>> {
  const common = {
    kitchenTicketReference: event.payload.kitchenTicketReference,
    kitchenWorkItemReference: event.payload.kitchenWorkItemReference,
    orderItemReference: event.payload.orderItemReference,
    ticketVersion: event.payload.ticketVersion,
    workItemVersion: event.payload.workItemVersion,
  };
  if (event.eventType === "KitchenWorkAccepted")
    return Object.freeze({
      ...common,
      workItemStatus: event.payload.workItemStatus,
      acceptedAt: event.payload.acceptedAt,
    });
  if (event.eventType === "KitchenWorkStarted")
    return Object.freeze({
      ...common,
      fromStatus: event.payload.fromStatus,
      toStatus: event.payload.toStatus,
      startedAt: event.payload.startedAt,
    });
  if (event.eventType === "KitchenItemProgressRecorded")
    return Object.freeze({
      ...common,
      quantityDelta: event.payload.quantityDelta,
      completedQuantity: event.payload.completedQuantity,
      requiredQuantity: event.payload.requiredQuantity,
      fromStatus: event.payload.fromStatus,
      toStatus: event.payload.toStatus,
      recordedAt: event.payload.recordedAt,
    });
  return Object.freeze({
    ...common,
    quantityDelta: event.payload.quantityDelta,
    completedQuantity: event.payload.completedQuantity,
    requiredQuantity: event.payload.requiredQuantity,
    fromStatus: event.payload.fromStatus,
    toStatus: event.payload.toStatus,
    completedAt: event.payload.completedAt,
  });
}

function lifecycleEventSemanticDigest(
  event: KitchenWorkLifecycleEnvelope,
  sha256: (canonicalValue: string) => string,
): string {
  try {
    return parseKitchenTicketDigest(
      sha256(
        JSON.stringify({
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          occurredAt: event.occurredAt,
          producerModule: event.producerModule,
          tenantId: event.tenantId,
          storeId: event.storeId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion.toString(10),
          correlationId: event.correlationId,
          causationId: event.causationId,
          actor: { type: event.actor.type, actorId: event.actor.actorId },
          payload: lifecyclePayload(event),
          redactionClassification: event.redactionClassification,
          replayMetadata: { replaySafe: event.replayMetadata.replaySafe },
        }),
      ),
    );
  } catch {
    return dependency();
  }
}

function portSnapshot(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      })
    )
      return dependency();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return dependency();
      result[key] = descriptors[key]?.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenQueueProjectionError) throw error;
    return dependency();
  }
}

function exactPortSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(snapshot);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return dependency();
  return snapshot;
}

function exactPortRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactPortSnapshot(portSnapshot(value), fields);
}

function storedProjection(
  value: KitchenQueueStoredProjection,
  brandReference: string,
  storeReference: string,
  sha256: (canonicalValue: string) => string,
): KitchenQueueStoredProjectionBundle | null {
  const snapshot = portSnapshot(value);
  if (snapshot.status === "NotFound") {
    exactPortSnapshot(snapshot, ["status"]);
    return null;
  }
  const found = exactPortSnapshot(snapshot, ["status", "generation", "rows"]);
  if (found.status !== "Found") return dependency();
  try {
    const bundle = reconcileKitchenQueueStoredProjectionBundle(
      { generation: found.generation, rows: found.rows },
      sha256,
    );
    if (
      bundle.generation.generationStatus !== "Active" ||
      bundle.generation.brandReference !== brandReference ||
      bundle.generation.storeReference !== storeReference ||
      bundle.generation.projectionName !== kitchenQueueProjectionName ||
      bundle.generation.projectionVersion !== kitchenQueueProjectionVersion
    )
      return dependency();
    return bundle;
  } catch {
    return dependency();
  }
}

function storedRebuild(
  value: KitchenQueueStoredRebuild,
  sha256: (canonicalValue: string) => string,
): KitchenQueueStoredProjectionBundle | null {
  const snapshot = portSnapshot(value);
  const status = snapshot.status;
  if (status === "NotFound") {
    exactPortSnapshot(snapshot, ["status"]);
    return null;
  }
  if (status === "Conflict") {
    exactPortSnapshot(snapshot, ["status"]);
    return conflict();
  }
  const found = exactPortSnapshot(snapshot, ["status", "generation", "rows"]);
  if (found.status !== "Found") return dependency();
  try {
    return reconcileKitchenQueueStoredProjectionBundle(
      { generation: found.generation, rows: found.rows },
      sha256,
    );
  } catch {
    return dependency();
  }
}

function sameGeneration(
  left: KitchenQueueStoredGeneration,
  right: KitchenQueueStoredGeneration,
): boolean {
  return (
    left.projectionGenerationReference === right.projectionGenerationReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.projectionName === right.projectionName &&
    left.projectionVersion === right.projectionVersion &&
    left.snapshotBindingVersion === right.snapshotBindingVersion &&
    left.generationStatus === right.generationStatus &&
    left.sourceCheckpointReference === right.sourceCheckpointReference &&
    left.sourceEventBindingDigest === right.sourceEventBindingDigest &&
    left.queueSnapshotDigest === right.queueSnapshotDigest &&
    left.ticketCount === right.ticketCount &&
    left.workItemCount === right.workItemCount &&
    left.initializedEmpty === right.initializedEmpty &&
    left.asOfUtc === right.asOfUtc &&
    left.projectedAt === right.projectedAt &&
    left.activationLagMs === right.activationLagMs &&
    left.lastRebuiltAt === right.lastRebuiltAt &&
    left.freshnessStatus === right.freshnessStatus &&
    left.rebuildReference === right.rebuildReference &&
    left.rebuildRequestDigest === right.rebuildRequestDigest &&
    left.rebuildRequestedAt === right.rebuildRequestedAt &&
    left.expectedPriorGenerationReference === right.expectedPriorGenerationReference
  );
}

function sameNames(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function sameRow(left: KitchenQueueRow, right: KitchenQueueRow): boolean {
  return (
    left.projectionGenerationReference === right.projectionGenerationReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.ticketReference === right.ticketReference &&
    left.workItemReference === right.workItemReference &&
    left.orderReference === right.orderReference &&
    left.orderBatchReference === right.orderBatchReference &&
    left.orderItemReference === right.orderItemReference &&
    left.sourceItemOrdinal === right.sourceItemOrdinal &&
    left.ticketAggregateVersion === right.ticketAggregateVersion &&
    left.workItemVersion === right.workItemVersion &&
    left.status === right.status &&
    left.requiredQuantity === right.requiredQuantity &&
    left.completedQuantity === right.completedQuantity &&
    sameNames(left.localizedDisplayNames, right.localizedDisplayNames) &&
    left.selectedOptions.length === right.selectedOptions.length &&
    left.selectedOptions.every((option, index) => {
      const expected = right.selectedOptions[index];
      return (
        expected !== undefined &&
        option.optionReference === expected.optionReference &&
        option.quantity === expected.quantity &&
        sameNames(option.localizedNames, expected.localizedNames)
      );
    }) &&
    left.stationReference === right.stationReference &&
    left.originalSourceEventReference === right.originalSourceEventReference &&
    left.sourceEventSemanticDigest === right.sourceEventSemanticDigest &&
    left.sourceEventOccurredAt === right.sourceEventOccurredAt &&
    left.workItemCreatedAt === right.workItemCreatedAt &&
    left.acceptedAt === right.acceptedAt &&
    left.orderItemReadyAt === right.orderItemReadyAt
  );
}

function sameCandidateTicketRow(active: KitchenQueueRow, candidate: KitchenQueueRow): boolean {
  return (
    active.brandReference === candidate.brandReference &&
    active.storeReference === candidate.storeReference &&
    active.ticketReference === candidate.ticketReference &&
    active.workItemReference === candidate.workItemReference &&
    active.orderReference === candidate.orderReference &&
    active.orderBatchReference === candidate.orderBatchReference &&
    active.orderItemReference === candidate.orderItemReference &&
    active.sourceItemOrdinal === candidate.sourceItemOrdinal &&
    active.ticketAggregateVersion === candidate.ticketAggregateVersion &&
    active.workItemVersion === candidate.workItemVersion &&
    active.status === candidate.status &&
    active.requiredQuantity === candidate.requiredQuantity &&
    active.completedQuantity === candidate.completedQuantity &&
    sameNames(active.localizedDisplayNames, candidate.localizedDisplayNames) &&
    active.selectedOptions.length === candidate.selectedOptions.length &&
    active.selectedOptions.every((option, index) => {
      const expected = candidate.selectedOptions[index];
      return (
        expected !== undefined &&
        option.optionReference === expected.optionReference &&
        option.quantity === expected.quantity &&
        sameNames(option.localizedNames, expected.localizedNames)
      );
    }) &&
    active.stationReference === candidate.stationReference &&
    active.sourceEventSemanticDigest === candidate.sourceEventSemanticDigest &&
    active.sourceEventOccurredAt === candidate.sourceEventOccurredAt &&
    active.workItemCreatedAt === candidate.workItemCreatedAt &&
    active.acceptedAt === candidate.acceptedAt &&
    active.orderItemReadyAt === candidate.orderItemReadyAt
  );
}

function sameLifecycleSourceIdentity(active: KitchenQueueRow, candidate: KitchenQueueRow): boolean {
  return (
    active.brandReference === candidate.brandReference &&
    active.storeReference === candidate.storeReference &&
    active.ticketReference === candidate.ticketReference &&
    active.workItemReference === candidate.workItemReference &&
    active.orderReference === candidate.orderReference &&
    active.orderBatchReference === candidate.orderBatchReference &&
    active.orderItemReference === candidate.orderItemReference &&
    active.sourceItemOrdinal === candidate.sourceItemOrdinal &&
    active.requiredQuantity === candidate.requiredQuantity &&
    sameNames(active.localizedDisplayNames, candidate.localizedDisplayNames) &&
    active.selectedOptions.length === candidate.selectedOptions.length &&
    active.selectedOptions.every((option, index) => {
      const expected = candidate.selectedOptions[index];
      return (
        expected !== undefined &&
        option.optionReference === expected.optionReference &&
        option.quantity === expected.quantity &&
        sameNames(option.localizedNames, expected.localizedNames)
      );
    }) &&
    active.stationReference === candidate.stationReference &&
    active.originalSourceEventReference === candidate.originalSourceEventReference &&
    active.sourceEventSemanticDigest === candidate.sourceEventSemanticDigest &&
    active.sourceEventOccurredAt === candidate.sourceEventOccurredAt &&
    active.workItemCreatedAt === candidate.workItemCreatedAt &&
    active.orderItemReadyAt === candidate.orderItemReadyAt
  );
}

function proofMatchesLifecycleEvent(
  proof: KitchenQueueLifecycleEventProof,
  event: KitchenWorkLifecycleEnvelope,
  semanticDigest: string,
): boolean {
  const common =
    proof.eventType === event.eventType &&
    proof.brandReference === event.tenantId &&
    proof.storeReference === event.storeId &&
    proof.ticketReference === event.payload.kitchenTicketReference &&
    proof.ticketReference === event.aggregateId &&
    proof.workItemReference === event.payload.kitchenWorkItemReference &&
    proof.orderItemReference === event.payload.orderItemReference &&
    proof.operationReference === event.causationId &&
    proof.actor.actorReference === event.actor.actorId &&
    proof.committedTicketVersion === BigInt(event.payload.ticketVersion) &&
    proof.committedTicketVersion === event.aggregateVersion &&
    proof.committedWorkItemVersion === BigInt(event.payload.workItemVersion) &&
    proof.occurredAt === event.occurredAt &&
    proof.eventSemanticDigest === semanticDigest;
  if (!common) return false;
  if (event.eventType === "KitchenWorkAccepted")
    return proof.afterStatus === event.payload.workItemStatus;
  if (event.eventType === "KitchenWorkStarted")
    return (
      proof.beforeStatus === event.payload.fromStatus &&
      proof.afterStatus === event.payload.toStatus
    );
  return (
    proof.beforeStatus === event.payload.fromStatus &&
    proof.afterStatus === event.payload.toStatus &&
    proof.quantityDelta === event.payload.quantityDelta &&
    proof.completedQuantity === event.payload.completedQuantity &&
    proof.requiredQuantity === event.payload.requiredQuantity
  );
}

function sameBundle(
  left: KitchenQueueStoredProjectionBundle,
  right: KitchenQueueStoredProjectionBundle,
) {
  return (
    sameGeneration(left.generation, right.generation) &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const expected = right.rows[index];
      return expected !== undefined && sameRow(row, expected);
    })
  );
}

function parseCommit(
  value: KitchenQueueProjectionCommit,
  expected: KitchenQueueStoredProjectionBundle,
  sha256: (canonicalValue: string) => string,
): KitchenQueueStoredProjectionBundle {
  const snapshot = portSnapshot(value);
  if (snapshot.status === "Conflict") {
    exactPortSnapshot(snapshot, ["status"]);
    return dependency();
  }
  const committed = exactPortSnapshot(snapshot, ["status", "generation", "rows"]);
  if (committed.status !== "Activated") return dependency();
  let bundle: KitchenQueueStoredProjectionBundle;
  try {
    bundle = reconcileKitchenQueueStoredProjectionBundle(
      { generation: committed.generation, rows: committed.rows },
      sha256,
    );
  } catch {
    return dependency();
  }
  if (bundle.generation.generationStatus !== "Active" || !sameBundle(bundle, expected))
    return dependency();
  return bundle;
}

function rebindRow(row: KitchenQueueRow, generationReference: string): KitchenQueueRow {
  return parseKitchenQueueRow({
    projectionGenerationReference: generationReference,
    brandReference: row.brandReference,
    storeReference: row.storeReference,
    ticketReference: row.ticketReference,
    workItemReference: row.workItemReference,
    orderReference: row.orderReference,
    orderBatchReference: row.orderBatchReference,
    orderItemReference: row.orderItemReference,
    sourceItemOrdinal: row.sourceItemOrdinal,
    ticketAggregateVersion: row.ticketAggregateVersion,
    workItemVersion: row.workItemVersion,
    status: row.status,
    requiredQuantity: row.requiredQuantity,
    completedQuantity: row.completedQuantity,
    localizedDisplayNames: row.localizedDisplayNames,
    selectedOptions: row.selectedOptions,
    stationReference: row.stationReference,
    originalSourceEventReference: row.originalSourceEventReference,
    sourceEventSemanticDigest: row.sourceEventSemanticDigest,
    sourceEventOccurredAt: row.sourceEventOccurredAt,
    workItemCreatedAt: row.workItemCreatedAt,
    acceptedAt: row.acceptedAt,
    orderItemReadyAt: row.orderItemReadyAt,
  });
}

function incrementalGeneration(input: {
  readonly current: KitchenQueueStoredProjectionBundle;
  readonly feed: KitchenQueueSourceFeed;
  readonly generationReference: string;
  readonly projectedAt: string;
  readonly rows: readonly KitchenQueueRow[];
  readonly sha256: (canonicalValue: string) => string;
}): KitchenQueueStoredProjectionBundle {
  const activationLagMs = Date.parse(input.projectedAt) - Date.parse(input.feed.asOfUtc);
  if (!Number.isSafeInteger(activationLagMs) || activationLagMs < 0) return dependency();
  const generation = parseKitchenQueueStoredGeneration({
    projectionGenerationReference: input.generationReference,
    brandReference: input.feed.brandReference,
    storeReference: input.feed.storeReference,
    projectionName: kitchenQueueProjectionName,
    projectionVersion: kitchenQueueProjectionVersion,
    snapshotBindingVersion: kitchenQueueSnapshotBindingVersion,
    generationStatus: "Active",
    sourceCheckpointReference: input.feed.sourceCheckpointReference,
    sourceEventBindingDigest: computeKitchenQueueSourceEventBindingDigest(input.rows, input.sha256),
    queueSnapshotDigest: computeKitchenQueueSnapshotDigest(
      {
        brandReference: input.feed.brandReference,
        storeReference: input.feed.storeReference,
        rows: input.rows,
        snapshotBindingVersion: kitchenQueueSnapshotBindingVersion,
      },
      input.sha256,
    ),
    ticketCount: new Set(input.rows.map((row) => row.ticketReference)).size,
    workItemCount: input.rows.length,
    initializedEmpty: input.rows.length === 0,
    asOfUtc: input.feed.asOfUtc,
    projectedAt: input.projectedAt,
    activationLagMs,
    lastRebuiltAt: input.current.generation.lastRebuiltAt,
    freshnessStatus: activationLagMs <= 2000 ? "Fresh" : "Stale",
    rebuildReference: null,
    rebuildRequestDigest: null,
    rebuildRequestedAt: null,
    expectedPriorGenerationReference: null,
  });
  return reconcileKitchenQueueStoredProjectionBundle(
    { generation, rows: input.rows },
    input.sha256,
  );
}

export function createKitchenQueueProjectionService(ports: KitchenQueueProjectionPorts) {
  const sha256 = ports.digests.sha256.bind(ports.digests);

  async function authorizeProjection(
    event: KitchenQueueSourceEvent | KitchenWorkLifecycleEnvelope,
  ): Promise<string> {
    let authorized: boolean;
    let observedAt: string;
    try {
      observedAt = parseKitchenTicketInstant(ports.clock.now());
      const storeReference = parseKitchenTicketReference(event.storeId);
      authorized = await ports.authorization.authorize(
        Object.freeze({
          action: "ProjectKitchenQueue",
          purpose: "MaintainKitchenQueueProjection",
          actorType: "System",
          actorReference: null,
          brandReference: event.tenantId,
          storeReference,
          sourceEventReference: event.eventId,
          observedAt,
        }),
      );
    } catch {
      return dependency();
    }
    if (authorized === false) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    if (authorized !== true) return dependency();
    return observedAt;
  }

  async function loadActive(
    brandReference: string,
    storeReference: string,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueStoredProjectionBundle | null> {
    try {
      return storedProjection(
        await ports.projections.loadActive({ brandReference, storeReference, transaction }),
        brandReference,
        storeReference,
        sha256,
      );
    } catch (error) {
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  async function incrementalCheckpoint(
    current: KitchenQueueStoredGeneration | null,
    feed: KitchenQueueSourceFeed,
    event: KitchenQueueSourceEvent,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueCheckpointComparison> {
    let comparison: KitchenQueueCheckpointComparison;
    try {
      comparison = await ports.checkpoints.compareIncremental({
        brandReference: feed.brandReference,
        storeReference: feed.storeReference,
        current:
          current === null
            ? null
            : {
                sourceCheckpointReference: current.sourceCheckpointReference,
                asOfUtc: current.asOfUtc,
              },
        candidate: {
          sourceCheckpointReference: feed.sourceCheckpointReference,
          asOfUtc: feed.asOfUtc,
          sourceEventReference: event.eventId,
          sourceEventSemanticDigest: computeKitchenQueueSourceEventSemanticDigest(event, sha256),
          coverageStatus: feed.coverageStatus,
          sourceFeed: feed,
        },
        transaction,
      });
    } catch {
      return dependency();
    }
    if (
      !["Initial", "Exact", "Successor", "Gap", "Regression", "ChangedAsOf", "Unknown"].includes(
        comparison,
      )
    )
      return dependency();
    return comparison;
  }

  async function lifecycleCheckpoint(
    current: KitchenQueueStoredProjectionBundle,
    source: KitchenQueueLifecycleSourceFeed,
    event: KitchenWorkLifecycleEnvelope,
    sourceEventSemanticDigest: string,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueLifecycleCheckpointComparison> {
    let comparison: KitchenQueueLifecycleCheckpointComparison;
    try {
      comparison = await ports.checkpoints.compareLifecycleIncremental(
        Object.freeze({
          brandReference: source.queueFeed.brandReference,
          storeReference: source.queueFeed.storeReference,
          current: Object.freeze({
            sourceCheckpointReference: current.generation.sourceCheckpointReference,
            asOfUtc: current.generation.asOfUtc,
            generation: current.generation,
            rows: current.rows,
          }),
          candidate: Object.freeze({
            sourceCheckpointReference: source.queueFeed.sourceCheckpointReference,
            asOfUtc: source.queueFeed.asOfUtc,
            sourceEventReference: event.eventId,
            sourceEventSemanticDigest,
            coverageStatus: source.queueFeed.coverageStatus,
            lifecycleSource: source,
          }),
          transaction,
        }),
      );
    } catch {
      return dependency();
    }
    if (!["Current", "Successor", "RetryRequired"].includes(comparison)) return dependency();
    return comparison;
  }

  function lifecycleQueueFeed(
    source: KitchenQueueLifecycleSourceFeed,
    active: KitchenQueueStoredProjectionBundle | null,
    readySource: "Active" | "Source",
  ): KitchenQueueSourceFeed {
    const tickets = source.queueFeed.tickets.map((ticket) => {
      const existing =
        active?.rows.filter((row) => row.ticketReference === ticket.ticketReference) ?? [];
      if (readySource === "Active" && existing.length !== ticket.items.length) return dependency();
      const items = ticket.items.map((item) => {
        const current = existing.find((row) => row.workItemReference === item.workItemReference);
        if (
          readySource === "Active" &&
          (current === undefined || current.orderItemReference !== item.orderItemReference)
        )
          return dependency();
        return Object.freeze({
          ticketReference: item.ticketReference,
          workItemReference: item.workItemReference,
          orderReference: item.orderReference,
          orderBatchReference: item.orderBatchReference,
          orderItemReference: item.orderItemReference,
          sourceItemOrdinal: item.sourceItemOrdinal,
          ticketAggregateVersion: item.ticketAggregateVersion,
          workItemVersion: item.workItemVersion,
          status: item.status,
          requiredQuantity: item.requiredQuantity,
          completedQuantity: item.completedQuantity,
          localizedDisplayNames: item.localizedDisplayNames,
          selectedOptions: item.selectedOptions,
          stationReference: item.stationReference,
          workItemCreatedAt: item.workItemCreatedAt,
          acceptedAt: item.acceptedAt,
          orderItemReadyAt:
            readySource === "Active" ? (current?.orderItemReadyAt ?? null) : item.orderItemReadyAt,
          catalogSnapshotControlled: true as const,
        });
      });
      return Object.freeze({
        brandReference: ticket.brandReference,
        storeReference: ticket.storeReference,
        ticketReference: ticket.ticketReference,
        orderReference: ticket.orderReference,
        orderBatchReference: ticket.orderBatchReference,
        ticketAggregateVersion: ticket.ticketAggregateVersion,
        ticketStatus: ticket.ticketStatus,
        sourceEvent: ticket.sourceEvent,
        items: Object.freeze(items),
      });
    });
    return parseKitchenQueueSourceFeed({
      brandReference: source.queueFeed.brandReference,
      storeReference: source.queueFeed.storeReference,
      sourceCheckpointReference: source.queueFeed.sourceCheckpointReference,
      asOfUtc: source.queueFeed.asOfUtc,
      coverageStatus: source.queueFeed.coverageStatus,
      tickets: Object.freeze(tickets),
    });
  }

  async function rebuildCheckpoint(
    current: KitchenQueueStoredGeneration | null,
    source: KitchenQueueLifecycleSourceFeed,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueCheckpointComparison> {
    const feed = source.queueFeed;
    let comparison: KitchenQueueCheckpointComparison;
    try {
      comparison = await ports.checkpoints.compareRebuild({
        brandReference: feed.brandReference,
        storeReference: feed.storeReference,
        current:
          current === null
            ? null
            : {
                sourceCheckpointReference: current.sourceCheckpointReference,
                asOfUtc: current.asOfUtc,
              },
        candidate: {
          sourceCheckpointReference: feed.sourceCheckpointReference,
          asOfUtc: feed.asOfUtc,
          coverageStatus: feed.coverageStatus,
          completeSourceFeed: source,
        },
        transaction,
      });
    } catch {
      return dependency();
    }
    if (
      !["Initial", "Exact", "Successor", "Gap", "Regression", "ChangedAsOf", "Unknown"].includes(
        comparison,
      )
    )
      return dependency();
    return comparison;
  }

  async function replace(
    expected: KitchenQueueStoredProjectionBundle,
    prior: KitchenQueueStoredProjectionBundle | null,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueStoredProjectionBundle> {
    let result: KitchenQueueProjectionCommit;
    try {
      result = await ports.projections.replaceActive({
        expectedActiveGenerationReference: prior?.generation.projectionGenerationReference ?? null,
        generation: expected.generation,
        rows: expected.rows,
        transaction,
      });
    } catch {
      return dependency();
    }
    return parseCommit(result, expected, sha256);
  }

  function trustedProjectedAt(
    feed: KitchenQueueSourceFeed,
    current: KitchenQueueGeneration | null,
    authorizedAt: string,
  ): string {
    let value: string;
    try {
      value = parseKitchenTicketInstant(ports.clock.now());
    } catch {
      return dependency();
    }
    if (
      Date.parse(value) < Date.parse(feed.asOfUtc) ||
      Date.parse(value) < Date.parse(authorizedAt) ||
      (current !== null && Date.parse(value) < Date.parse(current.projectedAt)) ||
      (current?.lastRebuiltAt !== null &&
        current?.lastRebuiltAt !== undefined &&
        Date.parse(value) < Date.parse(current.lastRebuiltAt))
    )
      return dependency();
    return value;
  }

  function preparationFloor(input: {
    readonly feed: KitchenQueueSourceFeed;
    readonly current: KitchenQueueGeneration | null;
    readonly authorizedAt: string;
    readonly rebuildRequest: KitchenQueueRebuildRequest | null;
  }): string {
    const candidates = [
      input.feed.asOfUtc,
      input.authorizedAt,
      input.current?.projectedAt ?? null,
      input.current?.lastRebuiltAt ?? null,
      input.rebuildRequest?.requestedAt ?? null,
    ];
    let latest: string = input.feed.asOfUtc;
    for (const candidate of candidates) {
      if (candidate !== null && Date.parse(candidate) > Date.parse(latest)) latest = candidate;
    }
    return latest;
  }

  function finalizePreparedCandidate(
    prepared: KitchenQueueStoredProjectionBundle,
    projectedAt: string,
  ): KitchenQueueStoredProjectionBundle {
    const source = prepared.generation;
    const activationLagMs = Date.parse(projectedAt) - Date.parse(source.asOfUtc);
    if (!Number.isSafeInteger(activationLagMs) || activationLagMs < 0) return dependency();
    const generation = parseKitchenQueueStoredGeneration({
      projectionGenerationReference: source.projectionGenerationReference,
      brandReference: source.brandReference,
      storeReference: source.storeReference,
      projectionName: source.projectionName,
      projectionVersion: source.projectionVersion,
      snapshotBindingVersion: source.snapshotBindingVersion,
      generationStatus: source.generationStatus,
      sourceCheckpointReference: source.sourceCheckpointReference,
      sourceEventBindingDigest: source.sourceEventBindingDigest,
      queueSnapshotDigest: source.queueSnapshotDigest,
      ticketCount: source.ticketCount,
      workItemCount: source.workItemCount,
      initializedEmpty: source.initializedEmpty,
      asOfUtc: source.asOfUtc,
      projectedAt,
      activationLagMs,
      lastRebuiltAt: source.rebuildReference === null ? source.lastRebuiltAt : projectedAt,
      freshnessStatus: activationLagMs <= 2000 ? "Fresh" : "Stale",
      rebuildReference: source.rebuildReference,
      rebuildRequestDigest: source.rebuildRequestDigest,
      rebuildRequestedAt: source.rebuildRequestedAt,
      expectedPriorGenerationReference: source.expectedPriorGenerationReference,
    });
    return Object.freeze({ generation, rows: prepared.rows });
  }

  async function processIncremental(
    event: KitchenQueueSourceEvent,
    transaction: ConsumerTransaction,
  ): Promise<void> {
    const authorizedAt = await authorizeProjection(event);
    try {
      await ports.tenantContext.install({
        actorReference: null,
        brandReference: event.tenantId,
        storeReference: event.storeId,
        purpose: "MaintainKitchenQueueProjection",
        transaction,
      });
      await ports.locks.acquireStoreProjection({
        brandReference: event.tenantId,
        storeReference: event.storeId,
        projectionName: kitchenQueueProjectionName,
        transaction,
      });
    } catch {
      return dependency();
    }
    const active = await loadActive(event.tenantId, event.storeId, transaction);
    let feed: KitchenQueueSourceFeed;
    try {
      feed = parseKitchenQueueSourceFeed(
        await ports.sources.loadIncremental({ event, transaction }),
      );
    } catch {
      return dependency();
    }
    if (
      feed.brandReference !== event.tenantId ||
      feed.storeReference !== event.storeId ||
      feed.tickets.length !== 1 ||
      feed.tickets[0]?.sourceEvent.eventId !== event.eventId ||
      feed.tickets[0]?.ticketAggregateVersion !== 1n ||
      feed.tickets[0]?.items.some(
        (item) =>
          item.ticketAggregateVersion !== 1n ||
          item.workItemVersion !== 1n ||
          item.status !== "Queued" ||
          item.completedQuantity !== 0 ||
          item.acceptedAt !== null ||
          item.orderItemReadyAt !== null,
      ) ||
      computeKitchenQueueSourceEventSemanticDigest(feed.tickets[0]?.sourceEvent, sha256) !==
        computeKitchenQueueSourceEventSemanticDigest(event, sha256) ||
      Date.parse(feed.asOfUtc) < Date.parse(event.occurredAt)
    )
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
    const comparison = await incrementalCheckpoint(
      active?.generation ?? null,
      feed,
      event,
      transaction,
    );
    if (active === null) {
      if (comparison !== "Initial") return dependency();
      const generationReference = parseKitchenTicketReference(
        ports.references.nextGenerationReference(),
      );
      const rows = buildKitchenQueueRows({ generationReference, feed, sha256 });
      const preparedAt = preparationFloor({
        feed,
        current: null,
        authorizedAt,
        rebuildRequest: null,
      });
      const preparedGeneration = buildKitchenQueueStoredGeneration({
        generationReference,
        generationStatus: "Active",
        feed,
        rows,
        projectedAt: preparedAt,
        lastRebuiltAt: null,
        rebuildRequest: null,
        sha256,
      });
      const prepared = reconcileKitchenQueueStoredProjectionBundle(
        { generation: preparedGeneration, rows },
        sha256,
      );
      const projectedAt = trustedProjectedAt(feed, null, authorizedAt);
      await replace(finalizePreparedCandidate(prepared, projectedAt), null, transaction);
      return;
    }
    if (comparison !== "Exact" && comparison !== "Successor") return dependency();
    const incoming = feed.tickets[0];
    if (incoming === undefined) return dependency();
    const existing = active.rows.filter((row) => row.ticketReference === incoming.ticketReference);
    const incomingSemantic = computeKitchenQueueSourceEventSemanticDigest(
      incoming.sourceEvent,
      sha256,
    );
    const candidateRows = buildKitchenQueueRows({
      generationReference: active.generation.projectionGenerationReference,
      feed,
      sha256,
    });
    const normalizedExisting = [...existing].sort((left, right) =>
      ascii(left.workItemReference, right.workItemReference),
    );
    if (
      existing.length > 0 &&
      (existing.some((row) => row.sourceEventSemanticDigest !== incomingSemantic) ||
        normalizedExisting.length !== candidateRows.length ||
        normalizedExisting.some((row, index) => {
          const candidate = candidateRows[index];
          return candidate === undefined || !sameCandidateTicketRow(row, candidate);
        }))
    )
      return conflict();
    if (comparison === "Exact") {
      if (existing.length === 0) return dependency();
      return;
    }
    const generationReference = parseKitchenTicketReference(
      ports.references.nextGenerationReference(),
    );
    const retained = active.rows.map((row) => rebindRow(row, generationReference));
    const added =
      existing.length === 0
        ? candidateRows.map((row) => rebindRow(row, generationReference))
        : Object.freeze([] as KitchenQueueRow[]);
    const rows = Object.freeze(
      [...retained, ...added].sort((left, right) =>
        ascii(left.workItemReference, right.workItemReference),
      ),
    );
    const preparedAt = preparationFloor({
      feed,
      current: active.generation,
      authorizedAt,
      rebuildRequest: null,
    });
    const prepared = incrementalGeneration({
      current: active,
      feed,
      generationReference,
      projectedAt: preparedAt,
      rows,
      sha256,
    });
    const projectedAt = trustedProjectedAt(feed, active.generation, authorizedAt);
    await replace(finalizePreparedCandidate(prepared, projectedAt), active, transaction);
  }

  async function processLifecycleIncremental(
    event: KitchenWorkLifecycleEnvelope,
    transaction: ConsumerTransaction,
  ): Promise<void> {
    const storeReference = parseKitchenTicketReference(event.storeId);
    const authorizedAt = await authorizeProjection(event);
    try {
      await ports.tenantContext.install({
        actorReference: null,
        brandReference: event.tenantId,
        storeReference,
        purpose: "MaintainKitchenQueueProjection",
        transaction,
      });
      await ports.locks.acquireStoreProjection({
        brandReference: event.tenantId,
        storeReference,
        projectionName: kitchenQueueProjectionName,
        transaction,
      });
    } catch {
      return dependency();
    }
    const active = await loadActive(event.tenantId, storeReference, transaction);
    if (active === null) return dependency();
    let source: KitchenQueueLifecycleSourceFeed;
    try {
      const rawSource = await ports.sources.loadLifecycleIncremental({ event, transaction });
      rejectUnsafeLifecycleSourceGraph(rawSource);
      source = parseKitchenQueueLifecycleIncrementalSourceFeed(rawSource, sha256);
    } catch {
      return dependency();
    }
    const ticket = source.queueFeed.tickets[0];
    const proofBundle = source.proofBundles[0];
    if (
      ticket === undefined ||
      proofBundle === undefined ||
      source.queueFeed.brandReference !== event.tenantId ||
      source.queueFeed.storeReference !== storeReference ||
      ticket.ticketReference !== event.aggregateId ||
      ticket.ticketReference !== event.payload.kitchenTicketReference ||
      ticket.ticketAggregateVersion < event.aggregateVersion ||
      Date.parse(source.queueFeed.asOfUtc) < Date.parse(event.occurredAt)
    )
      return dependency();
    const semanticDigest = lifecycleEventSemanticDigest(event, sha256);
    const matchingProofs = proofBundle.proofs.filter(
      (proof): proof is KitchenQueueLifecycleEventProof =>
        proof.kind === "Event" &&
        proof.operationReference === event.causationId &&
        proof.eventType === event.eventType,
    );
    const matchingProof = matchingProofs[0];
    if (matchingProofs.length !== 1 || matchingProof === undefined) return dependency();
    if (!proofMatchesLifecycleEvent(matchingProof, event, semanticDigest))
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
    const target = ticket.items.find(
      (item) => item.workItemReference === event.payload.kitchenWorkItemReference,
    );
    if (
      target === undefined ||
      target.orderItemReference !== event.payload.orderItemReference ||
      target.workItemVersion < BigInt(event.payload.workItemVersion)
    )
      return dependency();
    const candidateFeed = lifecycleQueueFeed(source, active, "Active");
    const candidateTicketRows = buildKitchenQueueRows({
      generationReference: active.generation.projectionGenerationReference,
      feed: candidateFeed,
      sha256,
    });
    const existingTicketRows = active.rows
      .filter((row) => row.ticketReference === ticket.ticketReference)
      .sort((left, right) => ascii(left.workItemReference, right.workItemReference));
    if (
      existingTicketRows.length !== candidateTicketRows.length ||
      existingTicketRows.some((row, index) => {
        const candidate = candidateTicketRows[index];
        return candidate === undefined || !sameLifecycleSourceIdentity(row, candidate);
      })
    )
      return dependency();
    const currentRows = Object.freeze(
      [
        ...active.rows.filter((row) => row.ticketReference !== ticket.ticketReference),
        ...candidateTicketRows,
      ].sort((left, right) => ascii(left.workItemReference, right.workItemReference)),
    );
    const comparison = await lifecycleCheckpoint(
      active,
      source,
      event,
      semanticDigest,
      transaction,
    );
    if (comparison === "RetryRequired") return dependency();
    if (comparison === "Current") {
      if (
        source.queueFeed.sourceCheckpointReference !==
          active.generation.sourceCheckpointReference ||
        source.queueFeed.asOfUtc !== active.generation.asOfUtc ||
        currentRows.length !== active.rows.length ||
        currentRows.some((row, index) => {
          const expected = active.rows[index];
          return expected === undefined || !sameRow(row, expected);
        })
      )
        return dependency();
      return;
    }
    if (comparison !== "Successor") return dependency();
    const generationReference = parseKitchenTicketReference(
      ports.references.nextGenerationReference(),
    );
    const successorTicketRows = buildKitchenQueueRows({
      generationReference,
      feed: candidateFeed,
      sha256,
    });
    const rows = Object.freeze(
      [
        ...active.rows
          .filter((row) => row.ticketReference !== ticket.ticketReference)
          .map((row) => rebindRow(row, generationReference)),
        ...successorTicketRows,
      ].sort((left, right) => ascii(left.workItemReference, right.workItemReference)),
    );
    const preparedAt = preparationFloor({
      feed: candidateFeed,
      current: active.generation,
      authorizedAt,
      rebuildRequest: null,
    });
    const prepared = incrementalGeneration({
      current: active,
      feed: candidateFeed,
      generationReference,
      projectedAt: preparedAt,
      rows,
      sha256,
    });
    const projectedAt = trustedProjectedAt(candidateFeed, active.generation, authorizedAt);
    await replace(finalizePreparedCandidate(prepared, projectedAt), active, transaction);
  }

  function handlerOutcome(error: unknown) {
    if (
      error instanceof KitchenQueueProjectionError &&
      error.code !== "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE"
    )
      return { status: "rejected" as const, errorCode: "CONSUMER_REJECTED" as const };
    return { status: "retry_required" as const, errorCode: "CONSUMER_TEMPORARY_FAILURE" as const };
  }

  const registration: ConsumerRegistration = Object.freeze({
    consumerName: kitchenQueueConsumerName,
    consumerVersion: kitchenQueueConsumerVersion,
    eventType: "KitchenWorkCreated",
    schemaVersions: Object.freeze([1]),
    ownerModule: "@rms/kitchen",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "replace_kitchen_queue_projection",
    replaySafe: true,
    handler: async ({ envelope, transaction }: Parameters<ConsumerRegistration["handler"]>[0]) => {
      try {
        await processIncremental(parseKitchenQueueSourceEvent(envelope), transaction);
        return { status: "completed" as const };
      } catch (error) {
        return handlerOutcome(error);
      }
    },
  });

  function createLifecycleRegistration(
    consumerName: string,
    eventType: KitchenWorkLifecycleEnvelope["eventType"],
  ): ConsumerRegistration {
    return Object.freeze({
      consumerName,
      consumerVersion: 1,
      eventType,
      schemaVersions: Object.freeze([1]),
      ownerModule: "@rms/kitchen",
      tenantScope: "store",
      ordering: "none",
      sideEffect: "replace_kitchen_queue_projection",
      replaySafe: true,
      handler: async ({
        envelope,
        transaction,
      }: Parameters<ConsumerRegistration["handler"]>[0]) => {
        let parsed: KitchenWorkLifecycleEnvelope;
        try {
          parsed = parseKitchenWorkLifecycleEnvelope(envelope);
        } catch {
          return { status: "rejected" as const, errorCode: "CONSUMER_REJECTED" as const };
        }
        if (parsed.eventType !== eventType)
          return { status: "rejected" as const, errorCode: "CONSUMER_REJECTED" as const };
        try {
          await processLifecycleIncremental(parsed, transaction);
          return { status: "completed" as const };
        } catch (error) {
          return handlerOutcome(error);
        }
      },
    });
  }

  const lifecycleRegistrations = Object.freeze([
    createLifecycleRegistration(kitchenWorkAcceptedEventConsumer, "KitchenWorkAccepted"),
    createLifecycleRegistration(kitchenWorkStartedEventConsumer, "KitchenWorkStarted"),
    createLifecycleRegistration(
      kitchenItemProgressRecordedEventConsumer,
      "KitchenItemProgressRecorded",
    ),
    createLifecycleRegistration(kitchenItemCompletedEventConsumer, "KitchenItemCompleted"),
  ]);

  async function consume(
    transaction: ConsumerTransaction,
    envelope: DomainEventEnvelope,
  ): Promise<ConsumerOutcome> {
    try {
      return await consumeEventInTransaction(transaction, registration, envelope);
    } catch (error) {
      if (error instanceof ConsumerTransactionRollback) throw error;
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  async function consumeLifecycle(
    transaction: ConsumerTransaction,
    consumerName: string,
    envelope: DomainEventEnvelope,
  ): Promise<ConsumerOutcome> {
    const selected = lifecycleRegistrations.find(
      (candidate) => candidate.consumerName === consumerName,
    );
    if (selected === undefined) return dependency();
    try {
      return await consumeEventInTransaction(transaction, selected, envelope);
    } catch (error) {
      if (error instanceof ConsumerTransactionRollback) throw error;
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  async function executeRebuild(value: unknown): Promise<KitchenQueueGeneration> {
    const request = parseKitchenQueueRebuildRequest(value);
    const observedAt = parseKitchenTicketInstant(ports.clock.now());
    if (Date.parse(request.requestedAt) > Date.parse(observedAt))
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
    let authorized: boolean;
    try {
      authorized = await ports.authorization.authorize({
        action: "RebuildKitchenQueueProjection",
        purpose: "ProjectionRecovery",
        actorType: "System",
        actorReference: null,
        brandReference: request.brandReference,
        storeReference: request.storeReference,
        rebuildReference: request.rebuildReference,
        observedAt,
      });
    } catch {
      return dependency();
    }
    if (authorized === false) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    if (authorized !== true) return dependency();
    return ports.transactions.withTransaction(async (transaction) => {
      try {
        await ports.tenantContext.install({
          actorReference: null,
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          purpose: "ProjectionRecovery",
          transaction,
        });
        await ports.locks.acquireStoreProjection({
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          projectionName: kitchenQueueProjectionName,
          transaction,
        });
      } catch {
        return dependency();
      }
      const requestDigest = computeKitchenQueueRebuildRequestDigest(request, sha256);
      let retained: KitchenQueueStoredProjectionBundle | null;
      try {
        retained = storedRebuild(
          await ports.projections.loadByRebuildReference({
            brandReference: request.brandReference,
            storeReference: request.storeReference,
            rebuildReference: request.rebuildReference,
            rebuildRequestDigest: requestDigest,
            transaction,
          }),
          sha256,
        );
      } catch (error) {
        if (error instanceof KitchenQueueProjectionError) throw error;
        return dependency();
      }
      if (retained !== null) {
        if (
          (retained.generation.generationStatus !== "Active" &&
            retained.generation.generationStatus !== "Retired") ||
          retained.generation.brandReference !== request.brandReference ||
          retained.generation.storeReference !== request.storeReference ||
          retained.generation.projectionName !== kitchenQueueProjectionName ||
          retained.generation.projectionVersion !== kitchenQueueProjectionVersion
        )
          return dependency();
        if (
          retained.generation.rebuildReference !== request.rebuildReference ||
          retained.generation.rebuildRequestDigest !== requestDigest ||
          retained.generation.rebuildRequestedAt !== request.requestedAt ||
          retained.generation.expectedPriorGenerationReference !==
            request.expectedActiveGenerationReference
        )
          return dependency();
        return stripKitchenQueueStoredGeneration(retained.generation);
      }
      const active = await loadActive(request.brandReference, request.storeReference, transaction);
      if (
        request.expectedActiveGenerationReference !==
        (active?.generation.projectionGenerationReference ?? null)
      )
        return conflict();
      let source: KitchenQueueLifecycleSourceFeed;
      try {
        const rawSource = await ports.sources.loadRebuild({ request, transaction });
        rejectUnsafeLifecycleSourceGraph(rawSource);
        source = parseKitchenQueueLifecycleRebuildSourceFeed(rawSource, sha256);
      } catch {
        return dependency();
      }
      const feed = source.queueFeed;
      const queueFeed = lifecycleQueueFeed(source, null, "Source");
      if (
        feed.brandReference !== request.brandReference ||
        feed.storeReference !== request.storeReference
      )
        throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
      const comparison = await rebuildCheckpoint(active?.generation ?? null, source, transaction);
      if (
        (active === null && comparison !== "Initial") ||
        (active !== null && comparison !== "Exact" && comparison !== "Successor")
      )
        return dependency();
      const generationReference = parseKitchenTicketReference(
        ports.references.nextGenerationReference(),
      );
      const rows = buildKitchenQueueRows({ generationReference, feed: queueFeed, sha256 });
      const preparedAt = preparationFloor({
        feed: queueFeed,
        current: active?.generation ?? null,
        authorizedAt: observedAt,
        rebuildRequest: request,
      });
      const preparedGeneration = buildKitchenQueueStoredGeneration({
        generationReference,
        generationStatus: "Active",
        feed: queueFeed,
        rows,
        projectedAt: preparedAt,
        lastRebuiltAt: active?.generation.lastRebuiltAt ?? null,
        rebuildRequest: request,
        sha256,
      });
      const prepared = reconcileKitchenQueueStoredProjectionBundle(
        { generation: preparedGeneration, rows },
        sha256,
      );
      const projectedAt = trustedProjectedAt(queueFeed, active?.generation ?? null, observedAt);
      if (Date.parse(projectedAt) < Date.parse(request.requestedAt)) return dependency();
      return stripKitchenQueueStoredGeneration(
        (await replace(finalizePreparedCandidate(prepared, projectedAt), active, transaction))
          .generation,
      );
    });
  }

  async function trustedQueryScope(input: {
    readonly actorReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly observedAt: string;
  }) {
    let raw: Readonly<Record<string, unknown>>;
    try {
      raw = exactPortRecord(await ports.trustedContext.resolveQueryAuthority(), [
        "actorReference",
        "brandReference",
        "storeReference",
        "observedAt",
      ]);
    } catch {
      return dependency();
    }
    let actorReference: string;
    let brandReference: string;
    let storeReference: string;
    let observedAt: string;
    try {
      actorReference = parseKitchenTicketReference(raw.actorReference);
      brandReference = parseKitchenTicketReference(raw.brandReference);
      storeReference = parseKitchenTicketReference(raw.storeReference);
      observedAt = parseKitchenTicketInstant(raw.observedAt);
    } catch {
      return dependency();
    }
    if (
      actorReference !== input.actorReference ||
      brandReference !== input.brandReference ||
      storeReference !== input.storeReference ||
      observedAt !== input.observedAt
    )
      return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    return Object.freeze({ actorReference, brandReference, storeReference, observedAt });
  }

  async function executeList(value: unknown): Promise<KitchenQueueListResult> {
    const query = parseKitchenQueueListQuery(value);
    const scope = await trustedQueryScope(query);
    let authorized: boolean;
    try {
      authorized = await ports.authorization.authorize({
        action: "ListKitchenQueue",
        purpose: "KitchenQueueRead",
        permission: kitchenQueuePermission,
        actorReference: scope.actorReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        observedAt: scope.observedAt,
      });
    } catch {
      return dependency();
    }
    if (authorized === false) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    if (authorized !== true) return dependency();
    return ports.transactions.withTransaction(async (transaction) => {
      try {
        await ports.tenantContext.install({
          actorReference: scope.actorReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          purpose: "KitchenQueueRead",
          transaction,
        });
      } catch {
        return dependency();
      }
      const filterSortDigest = computeKitchenQueueFilterSortDigest(
        {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          filters: query.filters,
        },
        sha256,
      );
      if (query.cursor !== null && query.cursor.filterSortDigest !== filterSortDigest)
        return conflict();
      let read: KitchenQueueListRead;
      try {
        read = await ports.queries.list({ query, transaction });
      } catch {
        return dependency();
      }
      const snapshot = portSnapshot(read);
      if (snapshot.status === "NoActive") {
        exactPortSnapshot(snapshot, ["status"]);
        return dependency();
      }
      const found = exactPortSnapshot(snapshot, [
        "status",
        "generation",
        "rows",
        "returnedCount",
        "hasMore",
      ]);
      if (
        found.status !== "Found" ||
        !Number.isSafeInteger(found.returnedCount) ||
        (found.returnedCount as number) < 0 ||
        typeof found.hasMore !== "boolean"
      )
        return dependency();
      let generation: KitchenQueueStoredGeneration;
      let rows: readonly KitchenQueueRow[];
      try {
        generation = parseKitchenQueueStoredGeneration(found.generation);
        rows = parseKitchenQueueRows(found.rows);
      } catch {
        return dependency();
      }
      if (
        generation.generationStatus !== "Active" ||
        generation.brandReference !== scope.brandReference ||
        generation.storeReference !== scope.storeReference
      )
        return dependency();
      if (
        query.cursor !== null &&
        query.cursor.projectionGenerationReference !== generation.projectionGenerationReference
      )
        return conflict();
      const unfilteredFirstPage =
        query.cursor === null &&
        query.filters.orderReference === null &&
        query.filters.ticketReference === null &&
        query.filters.workItemReference === null &&
        query.filters.stationReference === null &&
        query.filters.status === null;
      const expectedUnfilteredCount = Math.min(query.limit, generation.workItemCount);
      const expectedUnfilteredHasMore = generation.workItemCount > query.limit;
      if (
        rows.length > query.limit ||
        found.returnedCount !== rows.length ||
        rows.length > generation.workItemCount ||
        (unfilteredFirstPage &&
          (rows.length !== expectedUnfilteredCount ||
            found.hasMore !== expectedUnfilteredHasMore)) ||
        (found.hasMore && rows.length !== query.limit) ||
        (query.filters.workItemReference !== null && (rows.length > 1 || found.hasMore)) ||
        (generation.initializedEmpty && (rows.length !== 0 || found.hasMore)) ||
        new Set(rows.map((row) => row.workItemReference)).size !== rows.length ||
        rows.some(
          (row, index) =>
            row.projectionGenerationReference !== generation.projectionGenerationReference ||
            row.brandReference !== scope.brandReference ||
            row.storeReference !== scope.storeReference ||
            Date.parse(row.sourceEventOccurredAt) > Date.parse(generation.asOfUtc) ||
            Date.parse(row.workItemCreatedAt) > Date.parse(generation.asOfUtc) ||
            (row.acceptedAt !== null &&
              Date.parse(row.acceptedAt) > Date.parse(generation.asOfUtc)) ||
            (row.orderItemReadyAt !== null &&
              Date.parse(row.orderItemReadyAt) > Date.parse(generation.asOfUtc)) ||
            (generation.snapshotBindingVersion === 1 &&
              (row.acceptedAt !== null || row.orderItemReadyAt !== null)) ||
            (query.filters.orderReference !== null &&
              row.orderReference !== query.filters.orderReference) ||
            (query.filters.ticketReference !== null &&
              row.ticketReference !== query.filters.ticketReference) ||
            (query.filters.workItemReference !== null &&
              row.workItemReference !== query.filters.workItemReference) ||
            (query.filters.stationReference !== null &&
              row.stationReference !== query.filters.stationReference) ||
            (query.filters.status !== null && row.status !== query.filters.status) ||
            (query.cursor !== null &&
              (ascii(row.workItemCreatedAt, query.cursor.afterCreatedAt) < 0 ||
                (row.workItemCreatedAt === query.cursor.afterCreatedAt &&
                  ascii(row.workItemReference, query.cursor.afterWorkItemReference) <= 0))) ||
            (index > 0 &&
              (() => {
                const previous = rows[index - 1];
                return (
                  previous === undefined ||
                  ascii(previous.workItemCreatedAt, row.workItemCreatedAt) > 0 ||
                  (previous.workItemCreatedAt === row.workItemCreatedAt &&
                    ascii(previous.workItemReference, row.workItemReference) >= 0)
                );
              })()),
        )
      )
        return dependency();
      const last = rows.at(-1);
      const nextCursor =
        !found.hasMore || last === undefined
          ? null
          : parseKitchenQueueCursor({
              projectionGenerationReference: generation.projectionGenerationReference,
              afterCreatedAt: last.workItemCreatedAt,
              afterWorkItemReference: last.workItemReference,
              filterSortDigest,
            });
      return buildKitchenQueueListResult({
        generation: stripKitchenQueueStoredGeneration(generation),
        rows,
        nextCursor,
      });
    });
  }

  async function executeGet(value: unknown): Promise<KitchenQueueGetResult> {
    const query = parseKitchenQueueGetQuery(value);
    const scope = await trustedQueryScope(query);
    let authorized: boolean;
    try {
      authorized = await ports.authorization.authorize({
        action: "GetKitchenQueueWorkItem",
        purpose: "KitchenQueueRead",
        permission: kitchenQueuePermission,
        actorReference: scope.actorReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        workItemReference: query.workItemReference,
        observedAt: scope.observedAt,
      });
    } catch {
      return dependency();
    }
    if (authorized === false) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    if (authorized !== true) return dependency();
    return ports.transactions.withTransaction(async (transaction) => {
      try {
        await ports.tenantContext.install({
          actorReference: scope.actorReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          purpose: "KitchenQueueRead",
          transaction,
        });
      } catch {
        return dependency();
      }
      let read: KitchenQueueGetRead;
      try {
        read = await ports.queries.get({ query, transaction });
      } catch {
        return dependency();
      }
      const snapshot = portSnapshot(read);
      const status = snapshot.status;
      if (status === "NoActive") {
        exactPortSnapshot(snapshot, ["status"]);
        return dependency();
      }
      if (status === "NotFound") {
        exactPortSnapshot(snapshot, ["status"]);
        return fail("KITCHEN_QUEUE_NOT_FOUND");
      }
      const found = exactPortSnapshot(snapshot, ["status", "generation", "row"]);
      if (found.status !== "Found") return dependency();
      let generation: KitchenQueueStoredGeneration;
      let row: KitchenQueueRow;
      try {
        generation = parseKitchenQueueStoredGeneration(found.generation);
        row = parseKitchenQueueRow(found.row);
      } catch {
        return dependency();
      }
      if (
        generation.generationStatus !== "Active" ||
        generation.brandReference !== scope.brandReference ||
        generation.storeReference !== scope.storeReference ||
        generation.initializedEmpty ||
        generation.ticketCount === 0 ||
        generation.workItemCount === 0 ||
        row.projectionGenerationReference !== generation.projectionGenerationReference ||
        row.brandReference !== scope.brandReference ||
        row.storeReference !== scope.storeReference ||
        Date.parse(row.sourceEventOccurredAt) > Date.parse(generation.asOfUtc) ||
        Date.parse(row.workItemCreatedAt) > Date.parse(generation.asOfUtc) ||
        (row.acceptedAt !== null && Date.parse(row.acceptedAt) > Date.parse(generation.asOfUtc)) ||
        (row.orderItemReadyAt !== null &&
          Date.parse(row.orderItemReadyAt) > Date.parse(generation.asOfUtc)) ||
        (generation.snapshotBindingVersion === 1 &&
          (row.acceptedAt !== null || row.orderItemReadyAt !== null)) ||
        row.workItemReference !== query.workItemReference
      )
        return dependency();
      return buildKitchenQueueGetResult({
        generation: stripKitchenQueueStoredGeneration(generation),
        row,
      });
    });
  }

  async function rebuild(value: unknown): Promise<KitchenQueueGeneration> {
    try {
      return await executeRebuild(value);
    } catch (error) {
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  async function list(value: unknown): Promise<KitchenQueueListResult> {
    try {
      return await executeList(value);
    } catch (error) {
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  async function get(value: unknown): Promise<KitchenQueueGetResult> {
    try {
      return await executeGet(value);
    } catch (error) {
      if (error instanceof KitchenQueueProjectionError) throw error;
      return dependency();
    }
  }

  return Object.freeze({
    registration,
    lifecycleRegistrations,
    consume,
    consumeLifecycle,
    rebuild,
    list,
    get,
  });
}
