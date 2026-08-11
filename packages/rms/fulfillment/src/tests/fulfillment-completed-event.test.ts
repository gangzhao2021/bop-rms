import { describe, expect, it } from "vitest";
import {
  createFulfillmentCompletionPublication,
  fulfillmentCompletedSemanticBinding,
  FulfillmentCompletedEventError,
  parseFulfillmentCompletedEnvelope,
} from "../index.js";

const id = (n: number) => `018f6000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const refs = {
  publication: id(1),
  event: id(2),
  brand: id(3),
  store: id(4),
  fulfillment: id(5),
  order: id(6),
  handoff: id(7),
  correlation: id(8),
  causation: id(9),
};
const completedAt = "2026-08-11T20:00:00.000Z";
function input(overrides: Record<string, unknown> = {}) {
  return {
    publicationReference: refs.publication,
    eventReference: refs.event,
    brandReference: refs.brand,
    storeReference: refs.store,
    fulfillmentReference: refs.fulfillment,
    orderReference: refs.order,
    aggregateVersion: 6n,
    handoffRecordReference: refs.handoff,
    verificationMethod: "HumanCode",
    completedAt,
    correlationReference: refs.correlation,
    causationReference: refs.causation,
    completionPhase: "Completed",
    ...overrides,
  };
}
function invalid(action: () => unknown): void {
  expect(action).toThrow(FulfillmentCompletedEventError);
  try {
    action();
  } catch (error) {
    expect((error as FulfillmentCompletedEventError).code).toBe(
      "FULFILLMENT_COMPLETED_EVENT_INVALID",
    );
  }
}

describe("WP-1604 FulfillmentCompleted Event", () => {
  it("creates one exact minimal completion fact and stable publication", () => {
    const result = createFulfillmentCompletionPublication(input());
    expect(result.event).toEqual({
      eventId: refs.event,
      eventType: "FulfillmentCompleted",
      schemaVersion: 1,
      occurredAt: completedAt,
      producerModule: "@rms/fulfillment",
      tenantId: refs.brand,
      storeId: refs.store,
      aggregateType: "Fulfillment",
      aggregateId: refs.fulfillment,
      aggregateVersion: 6n,
      correlationId: refs.correlation,
      causationId: refs.causation,
      actor: { type: "System" },
      payload: {
        fulfillmentReference: refs.fulfillment,
        orderReference: refs.order,
        handoffRecordReference: refs.handoff,
        storeReference: refs.store,
        verificationMethod: "HumanCode",
        completedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    expect(parseFulfillmentCompletedEnvelope(result.event)).toEqual(result.event);
    expect(result.semanticBinding).toBe(fulfillmentCompletedSemanticBinding(result.event));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects partial phase, invalid version, cross-Store payload and time divergence", () => {
    invalid(() => createFulfillmentCompletionPublication(input({ completionPhase: "InProgress" })));
    invalid(() => createFulfillmentCompletionPublication(input({ aggregateVersion: 0n })));
    const valid = createFulfillmentCompletionPublication(input()).event;
    invalid(() =>
      parseFulfillmentCompletedEnvelope({
        ...valid,
        payload: { ...valid.payload, storeReference: refs.brand },
      }),
    );
    invalid(() =>
      parseFulfillmentCompletedEnvelope({ ...valid, occurredAt: "2026-08-11T20:00:01.000Z" }),
    );
  });

  it("rejects identity alias, extra/accessor/proxy input and unsafe payload expansion", () => {
    invalid(() =>
      createFulfillmentCompletionPublication(input({ eventReference: refs.fulfillment })),
    );
    invalid(() => createFulfillmentCompletionPublication({ ...input(), rawProof: "123456" }));
    const accessor = input();
    let accessed = false;
    Object.defineProperty(accessor, "rawProof", {
      enumerable: true,
      get() {
        accessed = true;
        return "123456";
      },
    });
    invalid(() => createFulfillmentCompletionPublication(accessor));
    expect(accessed).toBe(false);
    invalid(() => createFulfillmentCompletionPublication(new Proxy(input(), {})));
  });

  it("contains no raw proof, recipient, contact, free text, Money or Payment fields", () => {
    const serialized = JSON.stringify(
      createFulfillmentCompletionPublication(input()),
      (_, value) => (typeof value === "bigint" ? String(value) : value),
    );
    for (const forbidden of [
      "rawProof",
      "recipient",
      "contact",
      "customer",
      "note",
      "amount",
      "payment",
      "provider",
      "123456",
    ])
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});
