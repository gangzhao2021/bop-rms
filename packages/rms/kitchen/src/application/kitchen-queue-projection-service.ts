import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerOutcome,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";

import {
  buildKitchenQueueGeneration,
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
  parseKitchenQueueGeneration,
  parseKitchenQueueGetQuery,
  parseKitchenQueueListQuery,
  parseKitchenQueueRebuildRequest,
  parseKitchenQueueRow,
  parseKitchenQueueRows,
  parseKitchenQueueSourceEvent,
  parseKitchenQueueSourceFeed,
  reconcileKitchenQueueProjectionBundle,
  type KitchenQueueGeneration,
  type KitchenQueueGetResult,
  type KitchenQueueListResult,
  type KitchenQueueProjectionBundle,
  type KitchenQueueRebuildRequest,
  type KitchenQueueRow,
  type KitchenQueueSourceEvent,
  type KitchenQueueSourceFeed,
} from "../contracts/kitchen-queue-projection.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";
import type {
  KitchenQueueCheckpointComparison,
  KitchenQueueGetRead,
  KitchenQueueListRead,
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

function conflict(): never {
  return fail("KITCHEN_QUEUE_VERSION_CONFLICT");
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
): KitchenQueueProjectionBundle | null {
  const snapshot = portSnapshot(value);
  if (snapshot.status === "NotFound") {
    exactPortSnapshot(snapshot, ["status"]);
    return null;
  }
  const found = exactPortSnapshot(snapshot, ["status", "generation", "rows"]);
  if (found.status !== "Found") return dependency();
  try {
    const bundle = reconcileKitchenQueueProjectionBundle(
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
): KitchenQueueProjectionBundle | null {
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
    return reconcileKitchenQueueProjectionBundle(
      { generation: found.generation, rows: found.rows },
      sha256,
    );
  } catch {
    return dependency();
  }
}

function sameGeneration(left: KitchenQueueGeneration, right: KitchenQueueGeneration): boolean {
  return (
    left.projectionGenerationReference === right.projectionGenerationReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.projectionName === right.projectionName &&
    left.projectionVersion === right.projectionVersion &&
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
    left.workItemCreatedAt === right.workItemCreatedAt
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
    active.workItemCreatedAt === candidate.workItemCreatedAt
  );
}

function sameBundle(left: KitchenQueueProjectionBundle, right: KitchenQueueProjectionBundle) {
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
  expected: KitchenQueueProjectionBundle,
  sha256: (canonicalValue: string) => string,
): KitchenQueueProjectionBundle {
  const snapshot = portSnapshot(value);
  if (snapshot.status === "Conflict") {
    exactPortSnapshot(snapshot, ["status"]);
    return dependency();
  }
  const committed = exactPortSnapshot(snapshot, ["status", "generation", "rows"]);
  if (committed.status !== "Activated") return dependency();
  let bundle: KitchenQueueProjectionBundle;
  try {
    bundle = reconcileKitchenQueueProjectionBundle(
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
  });
}

function incrementalGeneration(input: {
  readonly current: KitchenQueueProjectionBundle;
  readonly feed: KitchenQueueSourceFeed;
  readonly generationReference: string;
  readonly projectedAt: string;
  readonly rows: readonly KitchenQueueRow[];
  readonly sha256: (canonicalValue: string) => string;
}): KitchenQueueProjectionBundle {
  const activationLagMs = Date.parse(input.projectedAt) - Date.parse(input.feed.asOfUtc);
  if (!Number.isSafeInteger(activationLagMs) || activationLagMs < 0) return dependency();
  const generation = parseKitchenQueueGeneration({
    projectionGenerationReference: input.generationReference,
    brandReference: input.feed.brandReference,
    storeReference: input.feed.storeReference,
    projectionName: kitchenQueueProjectionName,
    projectionVersion: kitchenQueueProjectionVersion,
    generationStatus: "Active",
    sourceCheckpointReference: input.feed.sourceCheckpointReference,
    sourceEventBindingDigest: computeKitchenQueueSourceEventBindingDigest(input.rows, input.sha256),
    queueSnapshotDigest: computeKitchenQueueSnapshotDigest(
      {
        brandReference: input.feed.brandReference,
        storeReference: input.feed.storeReference,
        rows: input.rows,
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
  return reconcileKitchenQueueProjectionBundle({ generation, rows: input.rows }, input.sha256);
}

export function createKitchenQueueProjectionService(ports: KitchenQueueProjectionPorts) {
  const sha256 = ports.digests.sha256.bind(ports.digests);

  async function authorizeProjection(event: KitchenQueueSourceEvent): Promise<string> {
    let authorized: boolean;
    let observedAt: string;
    try {
      observedAt = parseKitchenTicketInstant(ports.clock.now());
      authorized = await ports.authorization.authorize({
        action: "ProjectKitchenQueue",
        purpose: "MaintainKitchenQueueProjection",
        actorType: "System",
        actorReference: null,
        brandReference: event.tenantId,
        storeReference: event.storeId,
        sourceEventReference: event.eventId,
        observedAt,
      });
    } catch {
      return dependency();
    }
    if (authorized !== true) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
    return observedAt;
  }

  async function loadActive(
    brandReference: string,
    storeReference: string,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueProjectionBundle | null> {
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
    current: KitchenQueueGeneration | null,
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

  async function rebuildCheckpoint(
    current: KitchenQueueGeneration | null,
    feed: KitchenQueueSourceFeed,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueCheckpointComparison> {
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
          completeSourceFeed: feed,
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
    expected: KitchenQueueProjectionBundle,
    prior: KitchenQueueProjectionBundle | null,
    transaction: ConsumerTransaction,
  ): Promise<KitchenQueueProjectionBundle> {
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
    prepared: KitchenQueueProjectionBundle,
    projectedAt: string,
  ): KitchenQueueProjectionBundle {
    const source = prepared.generation;
    const activationLagMs = Date.parse(projectedAt) - Date.parse(source.asOfUtc);
    if (!Number.isSafeInteger(activationLagMs) || activationLagMs < 0) return dependency();
    const generation = parseKitchenQueueGeneration({
      projectionGenerationReference: source.projectionGenerationReference,
      brandReference: source.brandReference,
      storeReference: source.storeReference,
      projectionName: source.projectionName,
      projectionVersion: source.projectionVersion,
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
      const preparedGeneration = buildKitchenQueueGeneration({
        generationReference,
        generationStatus: "Active",
        feed,
        rows,
        projectedAt: preparedAt,
        lastRebuiltAt: null,
        rebuildRequest: null,
        sha256,
      });
      const prepared = reconcileKitchenQueueProjectionBundle(
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
    if (authorized !== true) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
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
      let retained: KitchenQueueProjectionBundle | null;
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
        return retained.generation;
      }
      const active = await loadActive(request.brandReference, request.storeReference, transaction);
      if (
        request.expectedActiveGenerationReference !==
        (active?.generation.projectionGenerationReference ?? null)
      )
        return conflict();
      let feed: KitchenQueueSourceFeed;
      try {
        feed = parseKitchenQueueSourceFeed(
          await ports.sources.loadRebuild({ request, transaction }),
        );
      } catch {
        return dependency();
      }
      if (
        feed.brandReference !== request.brandReference ||
        feed.storeReference !== request.storeReference
      )
        throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
      const comparison = await rebuildCheckpoint(active?.generation ?? null, feed, transaction);
      if (
        (active === null && comparison !== "Initial") ||
        (active !== null && comparison !== "Exact" && comparison !== "Successor")
      )
        return dependency();
      const generationReference = parseKitchenTicketReference(
        ports.references.nextGenerationReference(),
      );
      const rows = buildKitchenQueueRows({ generationReference, feed, sha256 });
      const preparedAt = preparationFloor({
        feed,
        current: active?.generation ?? null,
        authorizedAt: observedAt,
        rebuildRequest: request,
      });
      const preparedGeneration = buildKitchenQueueGeneration({
        generationReference,
        generationStatus: "Active",
        feed,
        rows,
        projectedAt: preparedAt,
        lastRebuiltAt: active?.generation.lastRebuiltAt ?? null,
        rebuildRequest: request,
        sha256,
      });
      const prepared = reconcileKitchenQueueProjectionBundle(
        { generation: preparedGeneration, rows },
        sha256,
      );
      const projectedAt = trustedProjectedAt(feed, active?.generation ?? null, observedAt);
      if (Date.parse(projectedAt) < Date.parse(request.requestedAt)) return dependency();
      return (await replace(finalizePreparedCandidate(prepared, projectedAt), active, transaction))
        .generation;
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
    if (authorized !== true) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
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
      let generation: KitchenQueueGeneration;
      let rows: readonly KitchenQueueRow[];
      try {
        generation = parseKitchenQueueGeneration(found.generation);
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
      return buildKitchenQueueListResult({ generation, rows, nextCursor });
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
    if (authorized !== true) return fail("KITCHEN_QUEUE_PERMISSION_DENIED");
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
      let generation: KitchenQueueGeneration;
      let row: KitchenQueueRow;
      try {
        generation = parseKitchenQueueGeneration(found.generation);
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
        row.workItemReference !== query.workItemReference
      )
        return dependency();
      return buildKitchenQueueGetResult({ generation, row });
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

  return Object.freeze({ registration, consume, rebuild, list, get });
}
