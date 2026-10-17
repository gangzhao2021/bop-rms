import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@bop/eventing";
import {
  OrderCanonicalPhaseError,
  resolveOrderCanonicalPhase,
  type OrderCanonicalPhaseOwnerFacts,
  type OrderKitchenProgressFact,
} from "../domain/order-canonical-phase.js";
import {
  OrderKitchenProgressEventError,
  parseOrderKitchenProgressEnvelope,
} from "../application/kitchen-progress-event.js";
import {
  createOrderKitchenProgressConsumerService,
  orderKitchenProgressConsumerName,
} from "../application/kitchen-progress-event-consumer-service.js";
import { createOrderStatusQueryService } from "../application/order-status-projection-service.js";

vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createGuestSession: (value: unknown) => value,
  assertGuestSessionUsable: (value: unknown) => value,
}));

const id = (n: number) => "0190fa36-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 12, minute)).toISOString();
const ORDER = id(1),
  B1 = id(10),
  B2 = id(20),
  I1 = id(11),
  I2 = id(12),
  I3 = id(21);

const owner = (overrides: Partial<OrderCanonicalPhaseOwnerFacts> = {}) => ({
  items: [
    { orderItemReference: I1, orderBatchReference: B1 },
    { orderItemReference: I2, orderBatchReference: B1 },
  ],
  acceptedBatches: [],
  cancelledBatches: [],
  cancelledItems: [],
  termination: null,
  fulfilled: false,
  ...overrides,
});
const started = (item: string, batch = B1, minute = 1): OrderKitchenProgressFact => ({
  orderBatchReference: batch,
  orderItemReference: item,
  kind: "Started",
  occurredAt: at(minute),
});
const ready = (item: string, batch = B1, minute = 2): OrderKitchenProgressFact => ({
  orderBatchReference: batch,
  orderItemReference: item,
  kind: "Ready",
  occurredAt: at(minute),
});
const batchReady = (batch = B1, minute = 3): OrderKitchenProgressFact => ({
  orderBatchReference: batch,
  orderItemReference: null,
  kind: "BatchReady",
  occurredAt: at(minute),
});
const phase = (o: OrderCanonicalPhaseOwnerFacts, k: OrderKitchenProgressFact[] = []) =>
  resolveOrderCanonicalPhase(o, k).canonicalPhase;

describe("DEC-PILOT-BATCH-PHASE-01 pickup sequence", () => {
  it("advances Submitted → Accepted → In Progress → Ready → Fulfilled", () => {
    expect(phase(owner())).toBe("Submitted");
    const accepted = owner({ acceptedBatches: [B1] });
    expect(phase(accepted)).toBe("Accepted");
    expect(phase(accepted, [started(I1)])).toBe("In Progress");
    expect(phase(accepted, [started(I1), ready(I1)])).toBe("In Progress");
    expect(phase(accepted, [started(I1), ready(I1), ready(I2)])).toBe("Ready");
    expect(phase(accepted, [batchReady()])).toBe("Ready");
    expect(phase({ ...accepted, fulfilled: true }, [batchReady()])).toBe("Fulfilled");
  });
  it("terminations: never accepted and rejected → Rejected; expired or cancelled → Cancelled", () => {
    expect(phase(owner({ termination: { phase: "Rejected" } }))).toBe("Rejected");
    expect(phase(owner({ termination: { phase: "Cancelled" } }))).toBe("Cancelled");
    expect(
      phase(owner({ acceptedBatches: [B1], termination: { phase: "Cancelled" } }), [started(I1)]),
    ).toBe("Cancelled");
  });
});

describe("DEC-PILOT-BATCH-PHASE-01 dine-in rounds", () => {
  const two = (overrides: Partial<OrderCanonicalPhaseOwnerFacts> = {}) =>
    owner({
      items: [
        { orderItemReference: I1, orderBatchReference: B1 },
        { orderItemReference: I3, orderBatchReference: B2 },
      ],
      ...overrides,
    });
  it.each<[string, Partial<OrderCanonicalPhaseOwnerFacts>, OrderKitchenProgressFact[], string]>([
    ["both rounds submitted", {}, [], "Submitted"],
    ["round 1 accepted, round 2 unpaid", { acceptedBatches: [B1] }, [], "Accepted"],
    ["round 1 preparing, round 2 unpaid", { acceptedBatches: [B1] }, [started(I1)], "In Progress"],
    ["round 1 ready, round 2 unpaid", { acceptedBatches: [B1] }, [batchReady(B1)], "In Progress"],
    [
      "round 1 ready, round 2 unpaid round cancelled",
      { acceptedBatches: [B1], cancelledBatches: [B2] },
      [batchReady(B1)],
      "Ready",
    ],
    ["both rounds ready", { acceptedBatches: [B1, B2] }, [batchReady(B1), ready(I3, B2)], "Ready"],
    [
      "accepted item cancelled by staff, the other rejected",
      { acceptedBatches: [B1], cancelledItems: [I1], cancelledBatches: [B2] },
      [],
      "Cancelled",
    ],
  ])("%s", (_name, overrides, kitchen, expected) => {
    expect(phase(two(overrides), kitchen)).toBe(expected);
  });
  it("a stale ticket closed not made cancels the open dish; closed as made counts as ready", () => {
    const o = owner({ acceptedBatches: [B1] });
    const closed = (item: string, kind: "Made" | "NotMade"): OrderKitchenProgressFact => ({
      orderBatchReference: B1,
      orderItemReference: item,
      kind,
      occurredAt: at(9),
    });
    expect(phase(o, [ready(I1), closed(I2, "Made")])).toBe("Ready");
    expect(phase(o, [ready(I1), closed(I2, "NotMade")])).toBe("Ready");
    expect(phase(o, [closed(I1, "NotMade"), closed(I2, "NotMade")])).toBe("Cancelled");
  });
});

describe("replay and out-of-order Kitchen facts", () => {
  it("gives the same phase for any order and for duplicates", () => {
    const o = owner({ acceptedBatches: [B1] });
    const facts = [started(I1), ready(I1), started(I2, B1, 4), ready(I2, B1, 5), batchReady()];
    const expected = phase(o, facts);
    expect(expected).toBe("Ready");
    expect(phase(o, [...facts].reverse())).toBe(expected);
    expect(phase(o, [...facts, ...facts])).toBe(expected);
    // Ready without its Started (Started delivered later) is still progress, never regresses.
    expect(phase(o, [ready(I1)])).toBe("In Progress");
  });
  it("refuses facts for an item or Batch outside the Order", () => {
    expect(() => phase(owner(), [started(id(99))])).toThrow(OrderCanonicalPhaseError);
    expect(() => phase(owner(), [batchReady(id(98))])).toThrow(OrderCanonicalPhaseError);
    expect(() => phase(owner(), [started(I1, B2)])).toThrow(OrderCanonicalPhaseError);
  });
});

const envelope = (eventType: string, payload: JsonObject, extra = {}) => ({
  eventId: id(500),
  eventType,
  schemaVersion: 1,
  occurredAt: at(5),
  producerModule: "@rms/kitchen" as const,
  tenantId: id(2),
  storeId: id(3),
  aggregateType: eventType === "KitchenItemReady" ? "KitchenOrderItemReadyResult" : "KitchenTicket",
  aggregateId: id(600),
  aggregateVersion: 3n,
  correlationId: id(601),
  actor: { type: "System" as const },
  payload,
  redactionClassification: "indirect_identifier" as const,
  replayMetadata: { replaySafe: true },
  ...extra,
});
const startedPayload = {
  kitchenTicketReference: id(600),
  kitchenWorkItemReference: id(602),
  orderItemReference: I1,
  ticketVersion: "3",
  workItemVersion: "3",
  fromStatus: "Queued",
  toStatus: "In Progress",
  startedAt: at(5),
};

describe("Kitchen progress event reading", () => {
  it("keeps only the order references, fact and time", () => {
    expect(
      parseOrderKitchenProgressEnvelope(envelope("KitchenWorkStarted", startedPayload)),
    ).toEqual({
      eventId: id(500),
      eventType: "KitchenWorkStarted",
      brandReference: id(2),
      storeReference: id(3),
      orderReference: null,
      facts: [
        { orderBatchReference: null, orderItemReference: I1, kind: "Started", occurredAt: at(5) },
      ],
    });
    const closed = parseOrderKitchenProgressEnvelope(
      envelope("KitchenTicketClosed", {
        kitchenTicketReference: id(600),
        orderReference: ORDER,
        orderBatchReference: B1,
        reasonCode: "NOT_MADE_ABANDONED",
        foodMade: false,
        orderBusinessDate: "2026-10-16",
        ticketVersion: "2",
        openWorkItems: [
          {
            kitchenWorkItemReference: id(603),
            orderItemReference: I1,
            status: "Queued",
            requiredQuantity: 1,
            completedQuantity: 0,
          },
          {
            kitchenWorkItemReference: id(604),
            orderItemReference: I2,
            status: "Completed",
            requiredQuantity: 1,
            completedQuantity: 1,
          },
        ],
        closedAt: at(9),
      }),
    );
    expect(closed.facts.map((fact) => fact.kind)).toEqual(["NotMade", "Made"]);
  });
  it("refuses other producers, event types and changed payloads", () => {
    expect(() =>
      parseOrderKitchenProgressEnvelope(
        envelope("KitchenWorkStarted", startedPayload, { producerModule: "@rms/ordering" }),
      ),
    ).toThrow(OrderKitchenProgressEventError);
    expect(() =>
      parseOrderKitchenProgressEnvelope(envelope("KitchenWorkAccepted", startedPayload)),
    ).toThrow(OrderKitchenProgressEventError);
    expect(() =>
      parseOrderKitchenProgressEnvelope(
        envelope("KitchenWorkStarted", { ...startedPayload, extra: 1 }),
      ),
    ).toThrow(OrderKitchenProgressEventError);
  });
});

describe("Ordering Kitchen progress consumer", () => {
  it("registers one consumer name per Kitchen event and retries until the Order item is visible", async () => {
    const record = vi.fn(async () => false);
    const service = createOrderKitchenProgressConsumerService({
      authorization: { authorize: async () => true },
      facts: { record },
    });
    expect(service.registrations.map((r) => [r.consumerName, r.eventType])).toEqual([
      [orderKitchenProgressConsumerName, "KitchenWorkStarted"],
      [orderKitchenProgressConsumerName, "KitchenItemReady"],
      [orderKitchenProgressConsumerName, "KitchenOrderReady"],
      [orderKitchenProgressConsumerName, "KitchenTicketClosed"],
    ]);
    const handler = service.registrations[0]?.handler;
    const transaction = { query: vi.fn() };
    await expect(
      handler?.({ envelope: envelope("KitchenWorkStarted", startedPayload), transaction }),
    ).resolves.toEqual({ status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" });
    record.mockResolvedValueOnce(true);
    await expect(
      handler?.({ envelope: envelope("KitchenWorkStarted", startedPayload), transaction }),
    ).resolves.toEqual({ status: "completed" });
  });
});

describe("guest status phase", () => {
  const snapshot = {
    sourceVersion: 2,
    sourceCheckpoint: id(700),
    sourceDigest: "sha256:" + "a".repeat(64),
    orderReference: ORDER,
    brandReference: id(2),
    storeReference: id(3),
    guestSessionReference: id(4),
    submissionReference: id(5),
    businessDate: "2026-10-17",
    orderNumber: "17",
    orderType: "Pickup",
    sourceChannel: "Web",
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    fulfillmentReference: null,
    fulfillmentCompletionEventReference: null,
    fulfillmentCompletedAt: null,
    eta: null,
    submittedAt: at(0),
    batches: [
      {
        orderBatchReference: B1,
        submittedAt: at(0),
        items: [
          {
            orderItemReference: I1,
            displayName: "Tea",
            quantity: 1,
            lineTotal: { amountMinor: 500n, currencyCode: "CAD" },
          },
        ],
      },
    ],
  };
  const service = (canonicalPhase: string | null) =>
    createOrderStatusQueryService({
      authorization: {
        authorizeCustomer: async () => ({
          guestSession: {
            sessionReference: id(4),
            brandReference: id(2),
            storeReference: id(3),
          } as never,
        }),
        authorizeMerchant: async () => null,
      },
      projections: {
        load: async () =>
          ({
            projectionName: "ordering_order_status_v1",
            projectionVersion: 1,
            generationReference: id(800),
            projectedAt: at(1),
            freshnessStatus: "Fresh",
            snapshot,
          }) as never,
        list: async () => [],
      },
      phases: {
        load: async () =>
          canonicalPhase === null ? null : { canonicalPhase: canonicalPhase as never },
      },
    });
  it("reports Ordering's merged phase instead of the revision-bound snapshot phase", async () => {
    const read = async (phaseValue: string | null) =>
      (await service(phaseValue).getCustomer({ orderReference: ORDER, observedAt: at(2) })).order
        .canonicalPhase;
    expect(await read("Ready")).toBe("Ready");
    expect(await read("In Progress")).toBe("In Progress");
    expect(await read(null)).toBe("Submitted");
    // Collected only with the recorded completion (Fulfilled iff fulfillmentStatus Completed).
    expect(await read("Fulfilled")).toBe("Ready");
  });
});
