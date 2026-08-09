import { createHash } from "node:crypto";

import {
  ConsumerTransactionRollback,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { describe, expect, it, vi } from "vitest";

import {
  buildKitchenQueueGeneration,
  buildKitchenQueueRows,
  computeKitchenQueueFilterSortDigest,
  computeKitchenQueueRebuildRequestDigest,
  computeKitchenQueueSnapshotDigest,
  computeKitchenQueueSourceEventBindingDigest,
  computeKitchenQueueSourceEventSemanticDigest,
  kitchenQueueConsumerName,
  kitchenQueueProjectionName,
  KitchenQueueProjectionError,
  parseKitchenQueueGeneration,
  parseKitchenQueueGetQuery,
  parseKitchenQueueListQuery,
  parseKitchenQueueRebuildRequest,
  parseKitchenQueueRow,
  parseKitchenQueueSourceEvent,
  parseKitchenQueueSourceFeed,
  reconcileKitchenQueueProjectionBundle,
  type KitchenQueueGeneration,
  type KitchenQueueProjectionBundle,
  type KitchenQueueRow,
  type KitchenQueueSourceEvent,
  type KitchenQueueSourceFeed,
} from "../contracts/kitchen-queue-projection.js";
import { createKitchenQueueProjectionService } from "../application/kitchen-queue-projection-service.js";
import type {
  KitchenQueueCheckpointComparison,
  KitchenQueueGetRead,
  KitchenQueueListRead,
  KitchenQueueProjectionPorts,
  KitchenQueueStoredProjection,
  KitchenQueueStoredRebuild,
} from "../application/ports/kitchen-queue-projection-ports.js";

function id(value: number): string {
  return `018f3000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const createdAt = "2026-08-08T16:00:00.000Z";
const projectedAt = "2026-08-08T16:00:01.000Z";

function sourceEvent(overrides: Readonly<Record<string, unknown>> = {}): KitchenQueueSourceEvent {
  const eventId = (overrides.eventId as string | undefined) ?? id(1);
  const ticketReference = (overrides.ticketReference as string | undefined) ?? id(10);
  const orderReference = (overrides.orderReference as string | undefined) ?? id(11);
  const orderBatchReference = (overrides.orderBatchReference as string | undefined) ?? id(12);
  const occurredAt = (overrides.occurredAt as string | undefined) ?? createdAt;
  return parseKitchenQueueSourceEvent({
    eventId,
    eventType: "KitchenWorkCreated",
    schemaVersion: 1,
    occurredAt,
    producerModule: "@rms/kitchen",
    tenantId: (overrides.brandReference as string | undefined) ?? id(2),
    storeId: (overrides.storeReference as string | undefined) ?? id(3),
    aggregateType: "KitchenTicket",
    aggregateId: ticketReference,
    aggregateVersion: 1n,
    correlationId: (overrides.correlationId as string | undefined) ?? id(4),
    causationId: (overrides.causationId as string | undefined) ?? id(5),
    actor: { type: "System" },
    payload: {
      kitchenTicketReference: ticketReference,
      orderReference,
      orderBatchReference,
      confirmationReference: (overrides.confirmationReference as string | undefined) ?? id(13),
      workItemCount: 1,
      aggregateVersion: 1,
      createdAt: occurredAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}

function sourceTicket(
  event: KitchenQueueSourceEvent = sourceEvent(),
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const displayName = (overrides.displayName as string | undefined) ?? "Burger";
  return {
    brandReference: event.tenantId,
    storeReference: event.storeId,
    ticketReference: event.aggregateId,
    orderReference: event.payload.orderReference,
    orderBatchReference: event.payload.orderBatchReference,
    ticketAggregateVersion: 1n,
    ticketStatus: "Open",
    sourceEvent: event,
    items: [
      {
        ticketReference: event.aggregateId,
        workItemReference: (overrides.workItemReference as string | undefined) ?? id(20),
        orderReference: event.payload.orderReference,
        orderBatchReference: event.payload.orderBatchReference,
        orderItemReference: (overrides.orderItemReference as string | undefined) ?? id(21),
        sourceItemOrdinal: 1,
        ticketAggregateVersion: 1n,
        workItemVersion: 1n,
        status: "Queued",
        requiredQuantity: (overrides.requiredQuantity as number | undefined) ?? 2,
        completedQuantity: 0,
        localizedDisplayNames: { "en-CA": displayName },
        selectedOptions: [
          {
            optionReference: id(22),
            quantity: 1,
            localizedNames: { "en-CA": "Cheese" },
          },
        ],
        stationReference: (overrides.stationReference as string | undefined) ?? id(23),
        workItemCreatedAt:
          (overrides.workItemCreatedAt as string | undefined) ?? event.payload.createdAt,
        catalogSnapshotControlled: true,
      },
    ],
  };
}

function sourceFeed(
  input: {
    readonly event?: KitchenQueueSourceEvent;
    readonly checkpoint?: string;
    readonly asOfUtc?: string;
    readonly ticketOverrides?: Readonly<Record<string, unknown>>;
    readonly tickets?: readonly unknown[];
  } = {},
): KitchenQueueSourceFeed {
  const event = input.event ?? sourceEvent();
  return parseKitchenQueueSourceFeed({
    brandReference: event.tenantId,
    storeReference: event.storeId,
    sourceCheckpointReference: input.checkpoint ?? id(30),
    asOfUtc: input.asOfUtc ?? event.occurredAt,
    coverageStatus: "CompleteThroughCheckpoint",
    tickets: input.tickets ?? [sourceTicket(event, input.ticketOverrides)],
  });
}

function bundle(
  feed: KitchenQueueSourceFeed = sourceFeed(),
  generationReference = id(40),
): KitchenQueueProjectionBundle {
  const rows = buildKitchenQueueRows({ generationReference, feed, sha256 });
  const generation = buildKitchenQueueGeneration({
    generationReference,
    generationStatus: "Active",
    feed,
    rows,
    projectedAt,
    lastRebuiltAt: null,
    rebuildRequest: null,
    sha256,
  });
  return Object.freeze({ generation, rows });
}

function rowValue(row: KitchenQueueRow, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    projectionGenerationReference: row.projectionGenerationReference,
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
    ...overrides,
  };
}

function firstRow(rows: readonly KitchenQueueRow[]): KitchenQueueRow {
  const row = rows[0];
  if (row === undefined) throw new Error("test fixture row is missing");
  return row;
}

function generationValue(
  generation: KitchenQueueGeneration,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    projectionGenerationReference: generation.projectionGenerationReference,
    brandReference: generation.brandReference,
    storeReference: generation.storeReference,
    projectionName: generation.projectionName,
    projectionVersion: generation.projectionVersion,
    generationStatus: generation.generationStatus,
    sourceCheckpointReference: generation.sourceCheckpointReference,
    sourceEventBindingDigest: generation.sourceEventBindingDigest,
    queueSnapshotDigest: generation.queueSnapshotDigest,
    ticketCount: generation.ticketCount,
    workItemCount: generation.workItemCount,
    initializedEmpty: generation.initializedEmpty,
    asOfUtc: generation.asOfUtc,
    projectedAt: generation.projectedAt,
    activationLagMs: generation.activationLagMs,
    lastRebuiltAt: generation.lastRebuiltAt,
    freshnessStatus: generation.freshnessStatus,
    rebuildReference: generation.rebuildReference,
    rebuildRequestDigest: generation.rebuildRequestDigest,
    rebuildRequestedAt: generation.rebuildRequestedAt,
    expectedPriorGenerationReference: generation.expectedPriorGenerationReference,
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string) {
  expect(operation).toThrowError(
    expect.objectContaining({ code, message: "kitchen queue is unavailable" }),
  );
}

describe("Kitchen queue projection domain", () => {
  it("binds complete Event semantics independently of Event ID", () => {
    const first = sourceEvent({ eventId: id(1) });
    const replay = sourceEvent({ eventId: id(6) });
    expect(computeKitchenQueueSourceEventSemanticDigest(first, sha256)).toBe(
      computeKitchenQueueSourceEventSemanticDigest(replay, sha256),
    );
    expect(
      computeKitchenQueueSourceEventSemanticDigest(
        sourceEvent({ eventId: id(6), correlationId: id(7) }),
        sha256,
      ),
    ).not.toBe(computeKitchenQueueSourceEventSemanticDigest(first, sha256));
  });

  it("rejects noncanonical controlled Catalog text without normalizing it", () => {
    expectCode(
      () => sourceFeed({ ticketOverrides: { displayName: " Burger" } }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
    expectCode(
      () => sourceFeed({ ticketOverrides: { displayName: "Cafe\u0301" } }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("rejects source and stored Work Item timestamp drift", () => {
    expectCode(
      () => sourceFeed({ ticketOverrides: { workItemCreatedAt: projectedAt } }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
    const built = bundle();
    expectCode(
      () =>
        parseKitchenQueueRow(rowValue(firstRow(built.rows), { workItemCreatedAt: projectedAt })),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("rejects huge sparse arrays before iterating their declared length", () => {
    const tickets: unknown[] = [];
    tickets.length = 0xffff_ffff;
    expectCode(
      () =>
        parseKitchenQueueSourceFeed({
          brandReference: id(2),
          storeReference: id(3),
          sourceCheckpointReference: id(30),
          asOfUtc: createdAt,
          coverageStatus: "CompleteThroughCheckpoint",
          tickets,
        }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("rejects source events later than the complete feed as-of instant", () => {
    expectCode(
      () => sourceFeed({ event: sourceEvent({ occurredAt: projectedAt }), asOfUtc: createdAt }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("requires coherent generation counts and rebuild timing", () => {
    const built = bundle();
    expectCode(
      () => parseKitchenQueueGeneration(generationValue(built.generation, { ticketCount: 2 })),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
    expectCode(
      () =>
        parseKitchenQueueGeneration(
          generationValue(built.generation, {
            rebuildReference: id(60),
            rebuildRequestDigest: sha256("request"),
            rebuildRequestedAt: createdAt,
            lastRebuiltAt: createdAt,
          }),
        ),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("rejects a source Event reference reused by another Ticket", () => {
    const first = bundle();
    const secondEvent = sourceEvent({
      eventId: id(1),
      ticketReference: id(70),
      orderReference: id(71),
      orderBatchReference: id(72),
    });
    const secondRows = buildKitchenQueueRows({
      generationReference: first.generation.projectionGenerationReference,
      feed: sourceFeed({
        event: secondEvent,
        ticketOverrides: { workItemReference: id(73), orderItemReference: id(74) },
      }),
      sha256,
    });
    expectCode(
      () => computeKitchenQueueSourceEventBindingDigest([...first.rows, ...secondRows], sha256),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("rejects caller-substituted rows when building a complete generation", () => {
    const feed = sourceFeed();
    const rows = buildKitchenQueueRows({ generationReference: id(40), feed, sha256 });
    const substituted = [
      parseKitchenQueueRow(rowValue(firstRow(rows), { stationReference: id(99) })),
    ];
    expectCode(
      () =>
        buildKitchenQueueGeneration({
          generationReference: id(40),
          generationStatus: "Active",
          feed,
          rows: substituted,
          projectedAt,
          lastRebuiltAt: null,
          rebuildRequest: null,
          sha256,
        }),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("classifies digest-port faults as dependency failures", () => {
    expectCode(
      () =>
        computeKitchenQueueSourceEventSemanticDigest(sourceEvent(), () => {
          throw new Error("secret adapter detail");
        }),
      "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    );
    expectCode(
      () => computeKitchenQueueSourceEventSemanticDigest(sourceEvent(), () => "bad"),
      "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("rejects rehashed durable duplicate Order Item identities", () => {
    const original = bundle();
    const first = firstRow(original.rows);
    const duplicate = parseKitchenQueueRow(
      rowValue(first, {
        workItemReference: id(90),
        sourceItemOrdinal: 2,
      }),
    );
    const rows = [first, duplicate];
    const generation = parseKitchenQueueGeneration(
      generationValue(original.generation, {
        workItemCount: 2,
        sourceEventBindingDigest: computeKitchenQueueSourceEventBindingDigest(rows, sha256),
        queueSnapshotDigest: computeKitchenQueueSnapshotDigest(
          {
            brandReference: original.generation.brandReference,
            storeReference: original.generation.storeReference,
            rows,
          },
          sha256,
        ),
      }),
    );
    expectCode(
      () => reconcileKitchenQueueProjectionBundle({ generation, rows }, sha256),
      "KITCHEN_QUEUE_INPUT_INVALID",
    );
  });

  it("strictly rejects extra, symbol, custom-prototype and accessor parser inputs", () => {
    const active = bundle();
    const request = rebuildRequest();
    const cases: readonly [
      (value: unknown) => unknown,
      Readonly<Record<string | symbol, unknown>>,
    ][] = [
      [parseKitchenQueueSourceFeed, { ...sourceFeed(), extra: true }],
      [parseKitchenQueueRow, { ...rowValue(firstRow(active.rows)), extra: true }],
      [parseKitchenQueueGeneration, { ...generationValue(active.generation), extra: true }],
      [parseKitchenQueueRebuildRequest, { ...request, extra: true }],
      [parseKitchenQueueListQuery, { ...queryInput(), extra: true }],
      [parseKitchenQueueGetQuery, { ...getInput(), extra: true }],
    ];
    for (const [parser, value] of cases) {
      expectCode(() => parser(value), "KITCHEN_QUEUE_INPUT_INVALID");
    }

    const symbolInput = { ...queryInput() } as Record<string | symbol, unknown>;
    symbolInput[Symbol("scope")] = id(3);
    expectCode(() => parseKitchenQueueListQuery(symbolInput), "KITCHEN_QUEUE_INPUT_INVALID");

    const customPrototype = Object.assign(Object.create(null) as object, queryInput());
    expectCode(() => parseKitchenQueueListQuery(customPrototype), "KITCHEN_QUEUE_INPUT_INVALID");

    let getterCalls = 0;
    const accessorInput = { ...queryInput() };
    Object.defineProperty(accessorInput, "actorReference", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return id(80);
      },
    });
    expectCode(() => parseKitchenQueueListQuery(accessorInput), "KITCHEN_QUEUE_INPUT_INVALID");
    expect(getterCalls).toBe(0);
  });

  it("deep-freezes strict source, rebuild and query snapshots", () => {
    const feed = sourceFeed();
    const ticket = feed.tickets[0];
    const item = ticket?.items[0];
    const request = rebuildRequest();
    const query = parseKitchenQueueListQuery(queryInput());
    for (const value of [
      feed,
      feed.tickets,
      ticket,
      ticket?.items,
      item,
      item?.localizedDisplayNames,
      item?.selectedOptions,
      item?.selectedOptions[0],
      request,
      query,
      query.filters,
    ]) {
      expect(value).not.toBeUndefined();
      expect(value === undefined ? false : Object.isFrozen(value)).toBe(true);
    }
  });
});

const transaction: ConsumerTransaction = {
  query: async () => {
    throw new Error("unexpected generic Inbox query");
  },
};

interface HarnessOptions {
  readonly active?: KitchenQueueStoredProjection;
  readonly rebuild?: KitchenQueueStoredRebuild;
  readonly incrementalFeed?: unknown;
  readonly rebuildFeed?: unknown;
  readonly comparison?: KitchenQueueCheckpointComparison;
  readonly rebuildComparison?: KitchenQueueCheckpointComparison;
  readonly authorized?: boolean;
  readonly trustedAuthority?: unknown;
  readonly listRead?: KitchenQueueListRead;
  readonly getRead?: KitchenQueueGetRead;
  readonly digest?: (value: string) => string;
  readonly clockNow?: string;
  readonly clockValues?: readonly string[];
  readonly transactionFailure?: Error;
}

function harness(options: HarnessOptions = {}) {
  const defaultFeed = sourceFeed();
  const authorize: KitchenQueueProjectionPorts["authorization"]["authorize"] = vi.fn(
    async () => options.authorized ?? true,
  );
  const resolveQueryAuthority: KitchenQueueProjectionPorts["trustedContext"]["resolveQueryAuthority"] =
    vi.fn(async () =>
      options.trustedAuthority === undefined
        ? {
            actorReference: id(80),
            brandReference: id(2),
            storeReference: id(3),
            observedAt: projectedAt,
          }
        : options.trustedAuthority,
    );
  const install: KitchenQueueProjectionPorts["tenantContext"]["install"] = vi.fn(
    async () => undefined,
  );
  const acquireStoreProjection: KitchenQueueProjectionPorts["locks"]["acquireStoreProjection"] =
    vi.fn(async () => undefined);
  const compareIncremental: KitchenQueueProjectionPorts["checkpoints"]["compareIncremental"] =
    vi.fn(async () => options.comparison ?? "Initial");
  const compareRebuild: KitchenQueueProjectionPorts["checkpoints"]["compareRebuild"] = vi.fn(
    async () => options.rebuildComparison ?? options.comparison ?? "Initial",
  );
  const loadIncremental: KitchenQueueProjectionPorts["sources"]["loadIncremental"] = vi.fn(
    async () => (options.incrementalFeed === undefined ? defaultFeed : options.incrementalFeed),
  );
  const loadRebuild: KitchenQueueProjectionPorts["sources"]["loadRebuild"] = vi.fn(async () =>
    options.rebuildFeed === undefined ? defaultFeed : options.rebuildFeed,
  );
  const loadActive: KitchenQueueProjectionPorts["projections"]["loadActive"] = vi.fn(async () =>
    options.active === undefined ? ({ status: "NotFound" } as const) : options.active,
  );
  const loadByRebuildReference: KitchenQueueProjectionPorts["projections"]["loadByRebuildReference"] =
    vi.fn(async () =>
      options.rebuild === undefined ? ({ status: "NotFound" } as const) : options.rebuild,
    );
  const replaceActive: KitchenQueueProjectionPorts["projections"]["replaceActive"] = vi.fn(
    async (input) => ({
      status: "Activated" as const,
      generation: input.generation,
      rows: input.rows,
    }),
  );
  const list: KitchenQueueProjectionPorts["queries"]["list"] = vi.fn(async () =>
    options.listRead === undefined ? ({ status: "NoActive" } as const) : options.listRead,
  );
  const get: KitchenQueueProjectionPorts["queries"]["get"] = vi.fn(async () =>
    options.getRead === undefined ? ({ status: "NoActive" } as const) : options.getRead,
  );
  const nextGenerationReference: KitchenQueueProjectionPorts["references"]["nextGenerationReference"] =
    vi.fn(() => id(50));
  let clockIndex = 0;
  const now: KitchenQueueProjectionPorts["clock"]["now"] = vi.fn(() => {
    const configured = options.clockValues?.[clockIndex];
    clockIndex += 1;
    return configured ?? options.clockNow ?? projectedAt;
  });
  const digestSha256: KitchenQueueProjectionPorts["digests"]["sha256"] = vi.fn((value) =>
    (options.digest ?? sha256)(value),
  );
  const withTransaction: KitchenQueueProjectionPorts["transactions"]["withTransaction"] = async (
    operation,
  ) => {
    if (options.transactionFailure !== undefined) throw options.transactionFailure;
    return operation(transaction);
  };
  const ports: KitchenQueueProjectionPorts = {
    authorization: { authorize },
    trustedContext: { resolveQueryAuthority },
    transactions: { withTransaction },
    tenantContext: { install },
    locks: { acquireStoreProjection },
    checkpoints: { compareIncremental, compareRebuild },
    sources: { loadIncremental, loadRebuild },
    projections: { loadActive, loadByRebuildReference, replaceActive },
    queries: { list, get },
    references: { nextGenerationReference },
    clock: { now },
    digests: { sha256: digestSha256 },
  };
  return {
    ports,
    spies: {
      authorize,
      resolveQueryAuthority,
      install,
      acquireStoreProjection,
      compareIncremental,
      compareRebuild,
      loadIncremental,
      loadRebuild,
      loadActive,
      loadByRebuildReference,
      replaceActive,
      list,
      get,
      nextGenerationReference,
      now,
      digestSha256,
    },
  };
}

function asEnvelope(event: KitchenQueueSourceEvent): DomainEventEnvelope {
  return event as unknown as DomainEventEnvelope;
}

function queryInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actorReference: id(80),
    brandReference: id(2),
    storeReference: id(3),
    observedAt: projectedAt,
    filters: {
      orderReference: null,
      ticketReference: null,
      workItemReference: null,
      stationReference: null,
      status: null,
    },
    cursor: null,
    limit: 50,
    ...overrides,
  };
}

function getInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actorReference: id(80),
    brandReference: id(2),
    storeReference: id(3),
    observedAt: projectedAt,
    workItemReference: id(20),
    ...overrides,
  };
}

describe("Kitchen queue projection service", () => {
  it("exposes the exact frozen registration contract", () => {
    const service = createKitchenQueueProjectionService(harness().ports);
    expect(service.registration).toEqual(
      expect.objectContaining({
        consumerName: kitchenQueueConsumerName,
        consumerVersion: 1,
        eventType: "KitchenWorkCreated",
        schemaVersions: [1],
        ownerModule: "@rms/kitchen",
        tenantScope: "store",
        ordering: "none",
        sideEffect: "replace_kitchen_queue_projection",
        replaySafe: true,
      }),
    );
    expect(Object.isFrozen(service.registration)).toBe(true);
  });

  it("strict-parses, System-authorizes, locks and activates the first Event", async () => {
    const event = sourceEvent();
    const feed = sourceFeed({ event });
    const { ports, spies } = harness({ incrementalFeed: feed, comparison: "Initial" });
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      service.registration.handler({ envelope: asEnvelope(event), transaction }),
    ).resolves.toEqual({ status: "completed" });
    expect(spies.authorize).toHaveBeenCalledWith({
      action: "ProjectKitchenQueue",
      purpose: "MaintainKitchenQueueProjection",
      actorType: "System",
      actorReference: null,
      brandReference: id(2),
      storeReference: id(3),
      sourceEventReference: id(1),
      observedAt: projectedAt,
    });
    expect(spies.acquireStoreProjection).toHaveBeenCalledBefore(
      spies.loadIncremental as unknown as ReturnType<typeof vi.fn>,
    );
    expect(spies.replaceActive).toHaveBeenCalledOnce();
    const commit = vi.mocked(spies.replaceActive).mock.calls[0]?.[0];
    expect(commit?.expectedActiveGenerationReference).toBeNull();
    expect(commit?.generation.generationStatus).toBe("Active");
    expect(commit?.rows).toHaveLength(1);
  });

  it("binds the trusted checkpoint comparator to the exact Event and one-Ticket feed", async () => {
    const event = sourceEvent();
    const feed = sourceFeed({ event });
    const { ports, spies } = harness({ incrementalFeed: feed });
    const service = createKitchenQueueProjectionService(ports);
    await service.registration.handler({ envelope: asEnvelope(event), transaction });
    expect(spies.compareIncremental).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: {
          sourceCheckpointReference: feed.sourceCheckpointReference,
          asOfUtc: feed.asOfUtc,
          sourceEventReference: event.eventId,
          sourceEventSemanticDigest: computeKitchenQueueSourceEventSemanticDigest(event, sha256),
          coverageStatus: "CompleteThroughCheckpoint",
          sourceFeed: feed,
        },
      }),
    );
  });

  it("completes exact-checkpoint same-semantic replay with no second generation", async () => {
    const active = bundle();
    const replay = sourceEvent({ eventId: id(6) });
    const { ports, spies } = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: sourceFeed({ event: replay }),
      comparison: "Exact",
    });
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      service.registration.handler({ envelope: asEnvelope(replay), transaction }),
    ).resolves.toEqual({ status: "completed" });
    expect(spies.replaceActive).not.toHaveBeenCalled();
    expect(spies.nextGenerationReference).not.toHaveBeenCalled();
  });

  it("parks same-Event semantics whose exact queue source rows drift", async () => {
    const active = bundle();
    const replay = sourceEvent({ eventId: id(6) });
    const { ports, spies } = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: sourceFeed({ event: replay, ticketOverrides: { stationReference: id(99) } }),
      comparison: "Exact",
    });
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      service.registration.handler({ envelope: asEnvelope(replay), transaction }),
    ).resolves.toEqual({ status: "rejected", errorCode: "CONSUMER_REJECTED" });
    expect(spies.replaceActive).not.toHaveBeenCalled();
  });

  it("advances only technical metadata for a same-semantic successor", async () => {
    const active = bundle();
    const replay = sourceEvent({ eventId: id(6) });
    const successor = sourceFeed({ event: replay, checkpoint: id(31) });
    const { ports, spies } = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: successor,
      comparison: "Successor",
    });
    const service = createKitchenQueueProjectionService(ports);
    await service.registration.handler({ envelope: asEnvelope(replay), transaction });
    const commit = vi.mocked(spies.replaceActive).mock.calls[0]?.[0];
    expect(commit?.generation.sourceCheckpointReference).toBe(id(31));
    expect(commit?.generation.sourceEventBindingDigest).toBe(
      active.generation.sourceEventBindingDigest,
    );
    expect(commit?.generation.queueSnapshotDigest).toBe(active.generation.queueSnapshotDigest);
    expect(commit?.rows[0]?.originalSourceEventReference).toBe(id(1));
    expect(commit?.rows[0]?.stationReference).toBe(active.rows[0]?.stationReference);
  });

  it("merges a distinct successor Ticket without losing the active Ticket", async () => {
    const active = bundle();
    const nextEvent = sourceEvent({
      eventId: id(6),
      ticketReference: id(70),
      orderReference: id(71),
      orderBatchReference: id(72),
    });
    const nextFeed = sourceFeed({
      event: nextEvent,
      checkpoint: id(31),
      ticketOverrides: { workItemReference: id(73), orderItemReference: id(74) },
    });
    const { ports, spies } = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: nextFeed,
      comparison: "Successor",
    });
    await createKitchenQueueProjectionService(ports).registration.handler({
      envelope: asEnvelope(nextEvent),
      transaction,
    });
    const committedRows = vi.mocked(spies.replaceActive).mock.calls[0]?.[0].rows ?? [];
    expect(committedRows.map((row) => row.ticketReference).sort()).toEqual([id(10), id(70)]);
    expect(
      committedRows.find((row) => row.ticketReference === id(10))?.originalSourceEventReference,
    ).toBe(id(1));
  });

  it("treats checkpoint gaps and replace races as retryable", async () => {
    for (const comparison of ["Gap", "Regression", "ChangedAsOf"] as const) {
      const checkpointFailure = harness({ comparison });
      const checkpointService = createKitchenQueueProjectionService(checkpointFailure.ports);
      await expect(
        checkpointService.registration.handler({
          envelope: asEnvelope(sourceEvent()),
          transaction,
        }),
      ).resolves.toEqual({
        status: "retry_required",
        errorCode: "CONSUMER_TEMPORARY_FAILURE",
      });
    }

    const race = harness();
    vi.mocked(race.spies.replaceActive).mockResolvedValueOnce({ status: "Conflict" });
    const raceService = createKitchenQueueProjectionService(race.ports);
    await expect(
      raceService.registration.handler({ envelope: asEnvelope(sourceEvent()), transaction }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });
  });

  it("uses trusted Actor, scope and observed time before a bounded List read", async () => {
    const active = bundle();
    const { ports, spies } = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: active.rows,
        returnedCount: 1,
        hasMore: false,
      },
    });
    const service = createKitchenQueueProjectionService(ports);
    const result = await service.list(queryInput());
    expect(spies.authorize).toHaveBeenCalledWith({
      action: "ListKitchenQueue",
      purpose: "KitchenQueueRead",
      permission: "kitchen.operate",
      actorReference: id(80),
      brandReference: id(2),
      storeReference: id(3),
      observedAt: projectedAt,
    });
    expect(spies.list).toHaveBeenCalledOnce();
    expect(result.items).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(result.items[0]).not.toHaveProperty("originalSourceEventReference");
    expect(result.items[0]).not.toHaveProperty("sourceEventSemanticDigest");
    expect(result).not.toHaveProperty("sourceEventBindingDigest");
    expect(result).not.toHaveProperty("queueSnapshotDigest");
  });

  it("rejects claimed observed time drift before authorization or query access", async () => {
    const { ports, spies } = harness();
    const service = createKitchenQueueProjectionService(ports);
    await expect(service.list(queryInput({ observedAt: createdAt }))).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_PERMISSION_DENIED",
      message: "kitchen queue is unavailable",
    });
    expect(spies.authorize).not.toHaveBeenCalled();
    expect(spies.list).not.toHaveBeenCalled();
  });

  it("rejects malformed bounded List rows and future facts", async () => {
    const active = bundle();
    const futureRow = parseKitchenQueueRow(
      rowValue(firstRow(active.rows), {
        sourceEventOccurredAt: projectedAt,
        workItemCreatedAt: projectedAt,
      }),
    );
    const { ports } = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: [futureRow],
        returnedCount: 1,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(ports).list(queryInput()),
    ).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("returns authorized Get not-found without exposing repository detail", async () => {
    const { ports } = harness({ getRead: { status: "NotFound" } });
    await expect(createKitchenQueueProjectionService(ports).get(getInput())).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_NOT_FOUND",
      message: "kitchen queue is unavailable",
    });
  });

  it("maps transaction failures to the single safe dependency error", async () => {
    const { ports } = harness({ transactionFailure: new Error("password=do-not-leak") });
    await expect(
      createKitchenQueueProjectionService(ports).list(queryInput()),
    ).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
      message: "kitchen queue is unavailable",
    });
  });
});

interface InboxRow {
  readonly event_type: string;
  readonly schema_version: number;
  readonly brand_id: string;
  readonly store_id: string | null;
  status: "processing" | "completed";
  result_hash: string | null;
}

class SyntheticInbox {
  #rows = new Map<string, InboxRow>();
  commitThenThrow = false;

  get rows(): ReadonlyMap<string, InboxRow> {
    return this.#rows;
  }

  async run<T>(operation: (value: ConsumerTransaction) => Promise<T>): Promise<T> {
    const staged = new Map([...this.#rows].map(([key, row]) => [key, { ...row }]));
    const value: ConsumerTransaction = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[],
      ): Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }> => {
        const key = `${String(values[0])}:${String(values[1])}`;
        if (sql.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
          if (staged.has(key)) return { rowCount: 0, rows: [] };
          staged.set(key, {
            event_type: String(values[2]),
            schema_version: Number(values[3]),
            brand_id: String(values[4]),
            store_id: values[5] === null ? null : String(values[5]),
            status: "processing",
            result_hash: null,
          });
          return { rowCount: 1, rows: [{ consumer_name: String(values[0]) } as Row] };
        }
        if (sql.startsWith("SELECT event_type")) {
          const row = staged.get(key);
          return {
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : ([{ ...row } as Row] as readonly Row[]),
          };
        }
        if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
          const row = staged.get(key);
          if (row === undefined || row.status !== "processing") return { rowCount: 0, rows: [] };
          row.status = "completed";
          row.result_hash = values[2] === null ? null : String(values[2]);
          return { rowCount: 1, rows: [] };
        }
        throw new Error("unexpected Inbox statement");
      },
    };
    const result = await operation(value);
    this.#rows = staged;
    if (this.commitThenThrow) throw new Error("commit outcome unknown");
    return result;
  }
}

function rebuildRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return parseKitchenQueueRebuildRequest({
    action: "RebuildKitchenQueueProjection",
    purpose: "ProjectionRecovery",
    projectionName: kitchenQueueProjectionName,
    projectionVersion: 1,
    brandReference: id(2),
    storeReference: id(3),
    rebuildReference: id(100),
    expectedActiveGenerationReference: null,
    requestedAt: createdAt,
    ...overrides,
  });
}

function rebuiltBundle(
  input: {
    readonly request?: ReturnType<typeof rebuildRequest>;
    readonly feed?: KitchenQueueSourceFeed;
    readonly status?: "Building" | "Active" | "Retired";
  } = {},
): KitchenQueueProjectionBundle {
  const request = input.request ?? rebuildRequest();
  const feed =
    input.feed ??
    sourceFeed({
      event: sourceEvent({
        brandReference: request.brandReference,
        storeReference: request.storeReference,
      }),
    });
  const rows = buildKitchenQueueRows({ generationReference: id(101), feed, sha256 });
  const generation = buildKitchenQueueGeneration({
    generationReference: id(101),
    generationStatus: input.status === "Building" ? "Building" : "Active",
    feed,
    rows,
    projectedAt,
    lastRebuiltAt: null,
    rebuildRequest: request,
    sha256,
  });
  return Object.freeze({
    generation:
      input.status === "Retired"
        ? parseKitchenQueueGeneration(generationValue(generation, { generationStatus: "Retired" }))
        : generation,
    rows,
  });
}

describe("Kitchen queue Inbox, rebuild and negative boundaries", () => {
  it("propagates the rollback sentinel so a rejected Inbox attempt cannot commit", async () => {
    const database = new SyntheticInbox();
    const { ports } = harness({ authorized: false });
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      database.run((value) => service.consume(value, asEnvelope(sourceEvent()))),
    ).rejects.toBeInstanceOf(ConsumerTransactionRollback);
    expect(database.rows.size).toBe(0);
  });

  it("completes once with null result hash and short-circuits the same Event duplicate", async () => {
    const database = new SyntheticInbox();
    const { ports, spies } = harness();
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      database.run((value) => service.consume(value, asEnvelope(sourceEvent()))),
    ).resolves.toEqual({ status: "processed" });
    await expect(
      database.run((value) => service.consume(value, asEnvelope(sourceEvent()))),
    ).resolves.toEqual({ status: "duplicate_completed" });
    expect(spies.authorize).toHaveBeenCalledTimes(1);
    expect(spies.loadIncremental).toHaveBeenCalledTimes(1);
    expect([...database.rows.values()][0]).toMatchObject({
      status: "completed",
      result_hash: null,
    });
  });

  it("recovers commit-unknown through the completed Inbox without a second effect", async () => {
    const database = new SyntheticInbox();
    const { ports, spies } = harness();
    const service = createKitchenQueueProjectionService(ports);
    database.commitThenThrow = true;
    await expect(
      database.run((value) => service.consume(value, asEnvelope(sourceEvent()))),
    ).rejects.toThrow("commit outcome unknown");
    expect([...database.rows.values()][0]?.status).toBe("completed");
    database.commitThenThrow = false;
    await expect(
      database.run((value) => service.consume(value, asEnvelope(sourceEvent()))),
    ).resolves.toEqual({ status: "duplicate_completed" });
    expect(spies.loadIncremental).toHaveBeenCalledTimes(1);
    expect(spies.replaceActive).toHaveBeenCalledTimes(1);
  });

  it("honestly short-circuits same-ID altered content under the immutable Event promise", async () => {
    const database = new SyntheticInbox();
    const { ports, spies } = harness();
    const service = createKitchenQueueProjectionService(ports);
    await database.run((value) => service.consume(value, asEnvelope(sourceEvent())));
    await expect(
      database.run((value) =>
        service.consume(value, asEnvelope(sourceEvent({ eventId: id(1), correlationId: id(199) }))),
      ),
    ).resolves.toEqual({ status: "duplicate_completed" });
    expect(spies.authorize).toHaveBeenCalledTimes(1);
    expect(spies.loadIncremental).toHaveBeenCalledTimes(1);
  });

  it("rolls a retry-required malformed source attempt out of the Inbox", async () => {
    const database = new SyntheticInbox();
    const { ports } = harness({ incrementalFeed: null });
    await expect(
      database.run((value) =>
        createKitchenQueueProjectionService(ports).consume(value, asEnvelope(sourceEvent())),
      ),
    ).rejects.toBeInstanceOf(ConsumerTransactionRollback);
    expect(database.rows.size).toBe(0);
  });

  it("retries malformed, incomplete or extra-field source DTOs without poisoning Inbox", async () => {
    for (const incrementalFeed of [
      null,
      { coverageStatus: "Incomplete" },
      { ...sourceFeed(), customerNote: null },
      { ...sourceFeed(), health: null },
    ]) {
      const { ports, spies } = harness({ incrementalFeed });
      const outcome = await createKitchenQueueProjectionService(ports).registration.handler({
        envelope: asEnvelope(sourceEvent()),
        transaction,
      });
      expect(outcome).toEqual({
        status: "retry_required",
        errorCode: "CONSUMER_TEMPORARY_FAILURE",
      });
      expect(spies.replaceActive).not.toHaveBeenCalled();
    }
  });

  it("retries stored Active corruption and digest outages", async () => {
    const active = bundle();
    const corrupt = parseKitchenQueueGeneration(
      generationValue(active.generation, { queueSnapshotDigest: sha256("wrong") }),
    );
    const stored = harness({
      active: { status: "Found", generation: corrupt, rows: active.rows },
      comparison: "Successor",
    });
    await expect(
      createKitchenQueueProjectionService(stored.ports).registration.handler({
        envelope: asEnvelope(sourceEvent({ eventId: id(6) })),
        transaction,
      }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });

    const outage = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      digest: () => {
        throw new Error("HSM unavailable");
      },
    });
    await expect(
      createKitchenQueueProjectionService(outage.ports).registration.handler({
        envelope: asEnvelope(sourceEvent({ eventId: id(6) })),
        transaction,
      }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });
  });

  it("builds an initialized-empty rebuild with required checkpoint and frozen capabilities", async () => {
    const request = rebuildRequest();
    const emptyFeed = sourceFeed({ tickets: [] });
    const { ports, spies } = harness({ rebuildFeed: emptyFeed });
    const generation = await createKitchenQueueProjectionService(ports).rebuild(request);
    expect(generation).toMatchObject({
      initializedEmpty: true,
      ticketCount: 0,
      workItemCount: 0,
      sourceCheckpointReference: emptyFeed.sourceCheckpointReference,
      rebuildReference: request.rebuildReference,
      lastRebuiltAt: projectedAt,
    });
    expect(spies.replaceActive).toHaveBeenCalledOnce();
  });

  it("System-authorizes rebuild before source and rejects stale expected Active", async () => {
    const request = rebuildRequest();
    const first = harness();
    await createKitchenQueueProjectionService(first.ports).rebuild(request);
    expect(first.spies.authorize).toHaveBeenCalledWith({
      action: "RebuildKitchenQueueProjection",
      purpose: "ProjectionRecovery",
      actorType: "System",
      actorReference: null,
      brandReference: id(2),
      storeReference: id(3),
      rebuildReference: id(100),
      observedAt: projectedAt,
    });
    expect(vi.mocked(first.spies.authorize).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(first.spies.loadRebuild).mock.invocationCallOrder[0] ?? 0,
    );

    const active = bundle();
    const stale = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
    });
    await expect(
      createKitchenQueueProjectionService(stale.ports).rebuild(request),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_VERSION_CONFLICT" });
    expect(stale.spies.loadRebuild).not.toHaveBeenCalled();
    expect(stale.spies.replaceActive).not.toHaveBeenCalled();
  });

  it("returns only exact completed retained rebuilds and conflicts only on explicit key conflict", async () => {
    const request = rebuildRequest();
    const retained = rebuiltBundle({ request, status: "Retired" });
    const repeat = harness({
      rebuild: { status: "Found", generation: retained.generation, rows: retained.rows },
    });
    await expect(
      createKitchenQueueProjectionService(repeat.ports).rebuild(request),
    ).resolves.toEqual(retained.generation);
    expect(repeat.spies.loadRebuild).not.toHaveBeenCalled();
    expect(repeat.spies.replaceActive).not.toHaveBeenCalled();

    const changed = harness({ rebuild: { status: "Conflict" } });
    await expect(
      createKitchenQueueProjectionService(changed.ports).rebuild(request),
    ).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_VERSION_CONFLICT",
    });
  });

  it("treats malformed or Building retained rebuild facts as dependency failure", async () => {
    const request = rebuildRequest();
    const building = rebuiltBundle({ request, status: "Building" });
    const { ports } = harness({
      rebuild: { status: "Found", generation: building.generation, rows: building.rows },
    });
    await expect(createKitchenQueueProjectionService(ports).rebuild(request)).rejects.toMatchObject(
      {
        code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
        message: "kitchen queue is unavailable",
      },
    );
  });

  it("rejects cross-scope retained Found metadata as a repository dependency", async () => {
    const request = rebuildRequest();
    const otherRequest = rebuildRequest({ brandReference: id(200), storeReference: id(201) });
    const other = rebuiltBundle({ request: otherRequest });
    const { ports } = harness({
      rebuild: { status: "Found", generation: other.generation, rows: other.rows },
    });
    await expect(createKitchenQueueProjectionService(ports).rebuild(request)).rejects.toMatchObject(
      {
        code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
      },
    );
  });

  it("retries a malformed rebuild source and never commits it", async () => {
    const { ports, spies } = harness({ rebuildFeed: null });
    await expect(
      createKitchenQueueProjectionService(ports).rebuild(rebuildRequest()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
    expect(spies.replaceActive).not.toHaveBeenCalled();
  });

  it("rejects cursor shape and generation drift with refresh conflicts", async () => {
    const active = bundle();
    const filters = queryInput().filters;
    const filterSortDigest = computeKitchenQueueFilterSortDigest(
      { brandReference: id(2), storeReference: id(3), filters },
      sha256,
    );
    const { ports } = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: [],
        returnedCount: 0,
        hasMore: false,
      },
    });
    const service = createKitchenQueueProjectionService(ports);
    await expect(
      service.list(
        queryInput({
          cursor: {
            projectionGenerationReference: id(99),
            afterCreatedAt: createdAt,
            afterWorkItemReference: id(20),
            filterSortDigest,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_VERSION_CONFLICT" });
    await expect(
      service.list(
        queryInput({
          cursor: {
            projectionGenerationReference: active.generation.projectionGenerationReference,
            afterCreatedAt: createdAt,
            afterWorkItemReference: id(20),
            filterSortDigest: sha256("wrong-filter"),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_VERSION_CONFLICT" });
  });

  it("rejects Get rows paired with empty, future or cross-scope Active metadata", async () => {
    const active = bundle();
    const request = rebuildRequest();
    const empty = rebuiltBundle({ request, feed: sourceFeed({ tickets: [] }) });
    const futureRow = parseKitchenQueueRow(
      rowValue(firstRow(active.rows), {
        sourceEventOccurredAt: projectedAt,
        workItemCreatedAt: projectedAt,
      }),
    );
    const otherFeed = sourceFeed({
      event: sourceEvent({ brandReference: id(200), storeReference: id(201) }),
    });
    const other = bundle(otherFeed, id(202));
    for (const getRead of [
      { status: "Found" as const, generation: empty.generation, row: active.rows[0] },
      { status: "Found" as const, generation: active.generation, row: futureRow },
      { status: "Found" as const, generation: other.generation, row: other.rows[0] },
    ]) {
      const { ports } = harness({ getRead });
      await expect(
        createKitchenQueueProjectionService(ports).get(getInput()),
      ).rejects.toMatchObject({
        code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
      });
    }
  });

  it("keeps all future facts explicitly unavailable and deeply frozen", async () => {
    const active = bundle();
    const { ports } = harness({
      getRead: { status: "Found", generation: active.generation, row: active.rows[0] },
    });
    const result = await createKitchenQueueProjectionService(ports).get(getInput());
    expect(result.projectionHealth).toBe("NotAvailable");
    expect(result.futureCapabilities).toEqual({
      course: "NotAvailable",
      priority: "NotAvailable",
      slaOverdue: "NotAvailable",
      holdReason: "NotAvailable",
      exception: "NotAvailable",
      claim: "NotAvailable",
      eta: "NotAvailable",
      structuredAllergenAssistance: "NotAvailable",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.futureCapabilities)).toBe(true);
  });

  it("denies List authorization before RLS or repository access", async () => {
    const denied = harness({ authorized: false });
    await expect(
      createKitchenQueueProjectionService(denied.ports).list(queryInput()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
    expect(denied.spies.install).not.toHaveBeenCalled();
    expect(denied.spies.list).not.toHaveBeenCalled();

    const failed = harness();
    vi.mocked(failed.spies.authorize).mockRejectedValueOnce(new Error("auth backend detail"));
    await expect(
      createKitchenQueueProjectionService(failed.ports).list(queryInput()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
    expect(failed.spies.list).not.toHaveBeenCalled();
  });

  it("uses exact Get authorization and installs the same trusted RLS scope before read", async () => {
    const active = bundle();
    const { ports, spies } = harness({
      getRead: { status: "Found", generation: active.generation, row: firstRow(active.rows) },
    });
    await createKitchenQueueProjectionService(ports).get(getInput());
    expect(spies.authorize).toHaveBeenCalledWith({
      action: "GetKitchenQueueWorkItem",
      purpose: "KitchenQueueRead",
      permission: "kitchen.operate",
      actorReference: id(80),
      brandReference: id(2),
      storeReference: id(3),
      workItemReference: id(20),
      observedAt: projectedAt,
    });
    expect(spies.install).toHaveBeenCalledWith({
      actorReference: id(80),
      brandReference: id(2),
      storeReference: id(3),
      purpose: "KitchenQueueRead",
      transaction,
    });
    expect(vi.mocked(spies.install).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spies.get).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("validates bounded filters, count, sort and creates a generation-bound next cursor", async () => {
    const active = bundle();
    const nextPage = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: active.rows,
        returnedCount: 1,
        hasMore: true,
      },
    });
    const result = await createKitchenQueueProjectionService(nextPage.ports).list(
      queryInput({
        filters: {
          orderReference: null,
          ticketReference: null,
          workItemReference: null,
          stationReference: id(23),
          status: "Queued",
        },
        limit: 1,
      }),
    );
    expect(result.nextCursor).toMatchObject({
      projectionGenerationReference: active.generation.projectionGenerationReference,
      afterCreatedAt: createdAt,
      afterWorkItemReference: id(20),
    });

    const wrongCount = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: active.rows,
        returnedCount: 0,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(wrongCount.ports).list(queryInput()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });

    const firstEvent = sourceEvent();
    const secondEvent = sourceEvent({
      eventId: id(6),
      ticketReference: id(70),
      orderReference: id(71),
      orderBatchReference: id(72),
    });
    const two = bundle(
      sourceFeed({
        event: firstEvent,
        tickets: [
          sourceTicket(firstEvent),
          sourceTicket(secondEvent, { workItemReference: id(73), orderItemReference: id(74) }),
        ],
      }),
      id(75),
    );
    const reversed = harness({
      listRead: {
        status: "Found",
        generation: two.generation,
        rows: [...two.rows].reverse(),
        returnedCount: 2,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(reversed.ports).list(queryInput()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
  });

  it("requires complete cardinality and exact hasMore on the first unfiltered page", async () => {
    const active = bundle();
    const missingRow = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: [],
        returnedCount: 0,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(missingRow.ports).list(queryInput()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });

    const firstEvent = sourceEvent();
    const secondEvent = sourceEvent({
      eventId: id(6),
      ticketReference: id(70),
      orderReference: id(71),
      orderBatchReference: id(72),
    });
    const two = bundle(
      sourceFeed({
        event: firstEvent,
        tickets: [
          sourceTicket(firstEvent),
          sourceTicket(secondEvent, { workItemReference: id(73), orderItemReference: id(74) }),
        ],
      }),
      id(75),
    );
    const falseHasMore = harness({
      listRead: {
        status: "Found",
        generation: two.generation,
        rows: [firstRow(two.rows)],
        returnedCount: 1,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(falseHasMore.ports).list(queryInput({ limit: 1 })),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });

    const forgedHasMore = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: active.rows,
        returnedCount: 1,
        hasMore: true,
      },
    });
    await expect(
      createKitchenQueueProjectionService(forgedHasMore.ports).list(queryInput({ limit: 1 })),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
  });

  it("returns initialized-empty List honestly and rejects impossible exact-item pagination", async () => {
    const empty = rebuiltBundle({ feed: sourceFeed({ tickets: [] }) });
    const emptyRead = harness({
      listRead: {
        status: "Found",
        generation: empty.generation,
        rows: [],
        returnedCount: 0,
        hasMore: false,
      },
    });
    await expect(
      createKitchenQueueProjectionService(emptyRead.ports).list(queryInput()),
    ).resolves.toMatchObject({ initializedEmpty: true, items: [], nextCursor: null });

    const active = bundle();
    const impossible = harness({
      listRead: {
        status: "Found",
        generation: active.generation,
        rows: active.rows,
        returnedCount: 1,
        hasMore: true,
      },
    });
    await expect(
      createKitchenQueueProjectionService(impossible.ports).list(
        queryInput({
          filters: {
            orderReference: null,
            ticketReference: null,
            workItemReference: id(20),
            stationReference: null,
            status: null,
          },
          limit: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
  });

  it("takes only one accessor-free snapshot of a union port response", async () => {
    const active = bundle();
    let ownKeysCalls = 0;
    const reply = new Proxy(
      {
        status: "Found" as const,
        generation: active.generation,
        rows: active.rows,
        returnedCount: 1,
        hasMore: false,
      },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const { ports } = harness({ listRead: reply });
    await expect(
      createKitchenQueueProjectionService(ports).list(queryInput()),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ workItemReference: id(20) })],
    });
    expect(ownKeysCalls).toBe(1);
  });

  it("never leaks raw adapter errors across public boundaries", async () => {
    const { ports } = harness();
    vi.mocked(ports.queries.get).mockRejectedValueOnce(new Error("sql password and customer note"));
    const service = createKitchenQueueProjectionService(ports);
    let failure: unknown;
    try {
      await service.get(getInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(KitchenQueueProjectionError);
    expect(failure).toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
      message: "kitchen queue is unavailable",
    });
    expect(String(failure)).not.toContain("password");
    expect(String(failure)).not.toContain("customer note");
  });

  it("persists the exact rebuild request digest independently of returned feed", async () => {
    const request = rebuildRequest();
    const { ports, spies } = harness();
    await createKitchenQueueProjectionService(ports).rebuild(request);
    const generation = vi.mocked(spies.replaceActive).mock.calls[0]?.[0].generation;
    expect(generation?.rebuildRequestDigest).toBe(
      computeKitchenQueueRebuildRequestDigest(request, sha256),
    );
  });

  it("treats a trusted clock behind source as-of as retryable dependency failure", async () => {
    const laterAsOf = "2026-08-08T16:00:02.000Z";
    const feed = sourceFeed({ asOfUtc: laterAsOf });
    const incremental = harness({ incrementalFeed: feed });
    await expect(
      createKitchenQueueProjectionService(incremental.ports).registration.handler({
        envelope: asEnvelope(sourceEvent()),
        transaction,
      }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });
    expect(incremental.spies.replaceActive).not.toHaveBeenCalled();

    const rebuild = harness({ rebuildFeed: feed });
    await expect(
      createKitchenQueueProjectionService(rebuild.ports).rebuild(rebuildRequest()),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
    expect(rebuild.spies.replaceActive).not.toHaveBeenCalled();
  });

  it("requires projected time not to regress behind final authorization or active rebuild", async () => {
    const project = harness({ clockValues: [projectedAt, createdAt] });
    await expect(
      createKitchenQueueProjectionService(project.ports).registration.handler({
        envelope: asEnvelope(sourceEvent()),
        transaction,
      }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });
    expect(project.spies.replaceActive).not.toHaveBeenCalled();

    const request = rebuildRequest();
    const active = rebuiltBundle({ request });
    const replay = sourceEvent({ eventId: id(6) });
    const successor = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: sourceFeed({ event: replay, checkpoint: id(31) }),
      comparison: "Successor",
      clockValues: [projectedAt, createdAt],
    });
    await expect(
      createKitchenQueueProjectionService(successor.ports).registration.handler({
        envelope: asEnvelope(replay),
        transaction,
      }),
    ).resolves.toEqual({
      status: "retry_required",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
    });
    expect(successor.spies.replaceActive).not.toHaveBeenCalled();
  });

  it("samples final projectedAt only after candidate digest reconciliation", async () => {
    async function prove(
      value: ReturnType<typeof harness>,
      operation: (
        service: ReturnType<typeof createKitchenQueueProjectionService>,
      ) => Promise<unknown>,
    ) {
      let digestsAtFinalClock = -1;
      let digestsAtReplace = -1;
      vi.mocked(value.spies.now)
        .mockImplementationOnce(() => projectedAt)
        .mockImplementationOnce(() => {
          digestsAtFinalClock = vi.mocked(value.spies.digestSha256).mock.calls.length;
          return projectedAt;
        });
      vi.mocked(value.spies.replaceActive).mockImplementationOnce(async (input) => {
        digestsAtReplace = vi.mocked(value.spies.digestSha256).mock.calls.length;
        return { status: "Activated", generation: input.generation, rows: input.rows };
      });
      await operation(createKitchenQueueProjectionService(value.ports));
      expect(digestsAtFinalClock).toBeGreaterThanOrEqual(4);
      expect(digestsAtReplace).toBe(digestsAtFinalClock);
      expect(vi.mocked(value.spies.now).mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(value.spies.replaceActive).mock.invocationCallOrder[0] ?? 0,
      );
    }

    const first = harness();
    await prove(first, (service) =>
      service.registration.handler({ envelope: asEnvelope(sourceEvent()), transaction }),
    );

    const active = bundle();
    const replay = sourceEvent({ eventId: id(6) });
    const successor = harness({
      active: { status: "Found", generation: active.generation, rows: active.rows },
      incrementalFeed: sourceFeed({ event: replay, checkpoint: id(31) }),
      comparison: "Successor",
    });
    await prove(successor, (service) =>
      service.registration.handler({ envelope: asEnvelope(replay), transaction }),
    );

    const rebuild = harness();
    await prove(rebuild, (service) => service.rebuild(rebuildRequest()));
  });

  it("rejects a rebuild requested after trusted authorization observation", async () => {
    const request = rebuildRequest({ requestedAt: projectedAt });
    const future = harness({ clockNow: createdAt });
    await expect(
      createKitchenQueueProjectionService(future.ports).rebuild(request),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_INPUT_INVALID" });
    expect(future.spies.authorize).not.toHaveBeenCalled();
    expect(future.spies.loadByRebuildReference).not.toHaveBeenCalled();
    expect(future.spies.loadRebuild).not.toHaveBeenCalled();
    expect(future.spies.replaceActive).not.toHaveBeenCalled();
  });
});
