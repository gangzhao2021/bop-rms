import { describe, expect, it } from "vitest";

import {
  createKitchenWorkCreatedEnvelope,
  parseKitchenTicket,
  parseKitchenWorkCreatedEnvelope,
} from "../index.js";

function id(value: number): string {
  return `018f3000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function hash(value: string): string {
  return `sha256:${value.padEnd(64, "0").slice(0, 64)}`;
}

function ticket() {
  const ticketReference = id(1);
  return parseKitchenTicket({
    ticketReference,
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    confirmationReference: id(6),
    sourceEventReference: id(7),
    sourceAggregateVersion: 3n,
    sourceSnapshotDigest: hash("1"),
    sourceEvidenceReference: id(8),
    sourceEvidenceVersion: 1,
    sourceEvidenceDigest: hash("2"),
    sourceEvidenceCapturedAt: "2026-08-08T15:59:59.000Z",
    planReference: id(9),
    planVersion: 1,
    planDigest: hash("3"),
    planGeneratedAt: "2026-08-08T16:00:01.000Z",
    consumerName: "kitchen.confirmed-order:v1",
    consumerVersion: 1,
    confirmedAt: "2026-08-08T16:00:00.000Z",
    correlationReference: id(10),
    semanticEventBindingDigest: hash("4"),
    aggregateVersion: 1n,
    status: "Open",
    createdAt: "2026-08-08T16:00:02.000Z",
    workItems: [
      {
        workItemReference: id(11),
        ticketReference,
        brandReference: id(2),
        storeReference: id(3),
        orderItemReference: id(12),
        orderBatchReference: id(5),
        sourceOrdinal: 1,
        splitOrdinal: 1,
        requiredQuantity: 2,
        completedQuantity: 0,
        status: "Queued",
        productReference: id(13),
        productVersionReference: id(14),
        skuReference: id(15),
        menuVersionReference: id(16),
        localizedDisplayNames: { "en-CA": "Synthetic item" },
        selectedOptions: [
          {
            optionReference: id(17),
            quantity: 1,
            localizedNames: { "en-CA": "Synthetic option" },
          },
        ],
        customerNote: "Synthetic private note",
        sourceLineDigest: hash("5"),
        stationRouting: {
          stationReference: id(18),
          routingRuleReference: id(19),
          routingRuleVersion: 1,
          routingRuleDigest: hash("6"),
        },
        preparation: {
          preparationReference: id(20),
          preparationVersion: 1,
          preparationDigest: hash("7"),
          instructions: ["Prepare synthetic item"],
        },
        executionSnapshotDigest: hash("8"),
        createdAt: "2026-08-08T16:00:02.000Z",
      },
    ],
  });
}

describe("KitchenWorkCreated.v1", () => {
  it("creates the exact minimal, causal, deeply frozen public envelope", () => {
    const sourceTicket = ticket();
    const envelope = createKitchenWorkCreatedEnvelope({
      eventReference: id(21),
      ticket: sourceTicket,
    });

    expect(envelope).toEqual({
      eventId: id(21),
      eventType: "KitchenWorkCreated",
      schemaVersion: 1,
      occurredAt: sourceTicket.createdAt,
      producerModule: "@rms/kitchen",
      tenantId: sourceTicket.brandReference,
      storeId: sourceTicket.storeReference,
      aggregateType: "KitchenTicket",
      aggregateId: sourceTicket.ticketReference,
      aggregateVersion: 1n,
      correlationId: sourceTicket.correlationReference,
      causationId: sourceTicket.sourceEventReference,
      actor: { type: "System" },
      payload: {
        kitchenTicketReference: sourceTicket.ticketReference,
        orderReference: sourceTicket.orderReference,
        orderBatchReference: sourceTicket.orderBatchReference,
        confirmationReference: sourceTicket.confirmationReference,
        workItemCount: 1,
        aggregateVersion: 1,
        createdAt: sourceTicket.createdAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    expect(envelope.aggregateId).toBe(envelope.payload.kitchenTicketReference);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.actor)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
    expect(Object.isFrozen(envelope.replayMetadata)).toBe(true);
    expect(
      JSON.stringify(envelope, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toMatch(/Synthetic|note|station|preparation|allerg|health|payment|provider/iu);
  });

  it("rejects extra or mismatched public fields and exact time/aggregate violations", () => {
    const envelope = createKitchenWorkCreatedEnvelope({ eventReference: id(21), ticket: ticket() });
    const invalid = [
      { ...envelope, extra: true },
      { ...envelope, eventType: "OtherEvent" },
      { ...envelope, occurredAt: "2026-08-08T16:00:03.000Z" },
      { ...envelope, aggregateId: id(30) },
      { ...envelope, aggregateVersion: 2n },
      { ...envelope, actor: { type: "User" } },
      { ...envelope, replayMetadata: { replaySafe: false } },
      { ...envelope, payload: { ...envelope.payload, customerNote: "forbidden" } },
      { ...envelope, payload: { ...envelope.payload, kitchenTicketReference: id(30) } },
      { ...envelope, payload: { ...envelope.payload, workItemCount: 0 } },
      { ...envelope, payload: { ...envelope.payload, aggregateVersion: 2 } },
    ];
    for (const candidate of invalid)
      expect(() => parseKitchenWorkCreatedEnvelope(candidate)).toThrow();
  });

  it("never executes accessors and rejects symbols/custom prototypes on parser and creator inputs", () => {
    const envelope = createKitchenWorkCreatedEnvelope({ eventReference: id(21), ticket: ticket() });
    let getterCalls = 0;
    const parserGetter = { ...envelope };
    Object.defineProperty(parserGetter, "eventId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return id(21);
      },
    });
    expect(() => parseKitchenWorkCreatedEnvelope(parserGetter)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() =>
      parseKitchenWorkCreatedEnvelope({ ...envelope, [Symbol("extra")]: true }),
    ).toThrow();
    expect(() =>
      parseKitchenWorkCreatedEnvelope(Object.assign(Object.create(null), envelope)),
    ).toThrow();

    const creatorGetter = { eventReference: id(21), ticket: ticket() };
    Object.defineProperty(creatorGetter, "ticket", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return ticket();
      },
    });
    expect(() => createKitchenWorkCreatedEnvelope(creatorGetter)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() =>
      createKitchenWorkCreatedEnvelope({
        eventReference: id(21),
        ticket: ticket(),
        [Symbol("extra")]: true,
      } as never),
    ).toThrow();
    expect(() =>
      createKitchenWorkCreatedEnvelope(
        Object.assign(Object.create(null), { eventReference: id(21), ticket: ticket() }),
      ),
    ).toThrow();
  });
});
