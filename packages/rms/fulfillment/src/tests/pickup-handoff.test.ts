import { describe, expect, it } from "vitest";
import {
  PickupHandoffError,
  planCompletePickupHandoff,
  type CompletePickupHandoffCommand,
  type PickupHandoffReference,
  type PickupHandoffSource,
} from "../contracts/pickup-handoff.js";
import type { PickupProofVerificationRecord } from "../contracts/pickup-proof.js";

const id = (n: number) =>
  `018f3f7a-8b1c-7a11-8d01-${String(n).padStart(12, "0")}` as PickupHandoffReference;
const refs = {
  fulfillment: id(1),
  brand: id(2),
  store: id(3),
  item1: id(4),
  item2: id(5),
  verification: id(6),
  capability: id(7),
  proofOperation: id(8),
  proofIdempotency: id(9),
  proofCorrelation: id(10),
  actor: id(11),
  location: id(12),
  device: id(13),
  handoff: id(14),
  operation: id(15),
  audit: id(16),
  idempotency: id(17),
  correlation: id(18),
} as const;

function source(overrides: Partial<PickupHandoffSource> = {}): PickupHandoffSource {
  return {
    fulfillmentReference: refs.fulfillment,
    brandReference: refs.brand,
    storeReference: refs.store,
    fulfillmentType: "Pickup",
    canonicalPhase: "Ready",
    aggregateVersion: 5n,
    currentProofGeneration: 1,
    lockedAt: "2026-08-11T12:00:00.000Z",
    items: [
      {
        fulfillmentItemReference: refs.item1,
        orderedQuantity: 2,
        readyQuantity: 2,
        handedOverQuantity: 0,
        state: "Ready",
      },
      {
        fulfillmentItemReference: refs.item2,
        orderedQuantity: 1,
        readyQuantity: 1,
        handedOverQuantity: 0,
        state: "Ready",
      },
    ],
    ...overrides,
  } as PickupHandoffSource;
}

function verification(overrides: Record<string, unknown> = {}): PickupProofVerificationRecord {
  return {
    verificationReference: refs.verification,
    operationReference: refs.proofOperation,
    idempotencyReference: refs.proofIdempotency,
    correlationReference: refs.proofCorrelation,
    fulfillmentReference: refs.fulfillment,
    brandReference: refs.brand,
    storeReference: refs.store,
    capabilityReference: refs.capability,
    generation: 1,
    verificationMethod: "HumanCode",
    validationStatus: "Validated",
    verifiedAt: "2026-08-11T12:02:00.000Z",
    grantsCompletionAuthority: false,
    ...overrides,
  } as PickupProofVerificationRecord;
}

function command(
  overrides: Partial<CompletePickupHandoffCommand> = {},
): CompletePickupHandoffCommand {
  return {
    fulfillmentReference: refs.fulfillment,
    brandReference: refs.brand,
    storeReference: refs.store,
    expectedAggregateVersion: 5n,
    purpose: "CompletePickupHandoff",
    actorReference: refs.actor,
    actorPermissions: ["fulfillment.pickup.complete"],
    verification: verification(),
    recipientType: "Customer",
    recipientDisplayMask: "R*** Z***",
    pickupLocationReference: refs.location,
    deviceReference: refs.device,
    quantities: [
      { fulfillmentItemReference: refs.item1, quantity: 2 },
      { fulfillmentItemReference: refs.item2, quantity: 1 },
    ],
    handoffReference: refs.handoff,
    operationReference: refs.operation,
    auditReference: refs.audit,
    idempotencyReference: refs.idempotency,
    correlationReference: refs.correlation,
    handedOverAt: "2026-08-11T12:03:00.000Z",
    ...overrides,
  } as CompletePickupHandoffCommand;
}

function code(action: () => unknown, expected: PickupHandoffError["code"]): void {
  try {
    action();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PickupHandoffError);
    expect((error as PickupHandoffError).code).toBe(expected);
  }
}

describe("WP-1603 Complete Pickup Handoff", () => {
  it("atomically plans a validated full handoff and completes only all quantities", () => {
    const effect = planCompletePickupHandoff(source(), command());
    expect(effect.nextPhase).toBe("Completed");
    expect(effect.nextAggregateVersion).toBe(6n);
    expect(effect.items).toHaveLength(2);
    expect(effect.audit.permission).toBe("fulfillment.pickup.complete");
    expect(effect).not.toHaveProperty("event");
    expect(
      JSON.stringify(effect, (_, value) => (typeof value === "bigint" ? String(value) : value)),
    ).not.toContain("123456");
  });

  it("records partial quantity and leaves the aggregate InProgress", () => {
    const effect = planCompletePickupHandoff(
      source(),
      command({ quantities: [{ fulfillmentItemReference: refs.item1, quantity: 1 }] }),
    );
    expect(effect.nextPhase).toBe("InProgress");
    expect(effect.items[0]?.cumulativeHandedOverQuantity).toBe(1);
  });

  it("completes a later handoff only when the remaining vector reaches Ready quantities", () => {
    const later = source({
      canonicalPhase: "InProgress",
      aggregateVersion: 6n,
      items: [
        {
          fulfillmentItemReference: refs.item1,
          orderedQuantity: 2,
          readyQuantity: 2,
          handedOverQuantity: 1,
          state: "Ready",
        },
        {
          fulfillmentItemReference: refs.item2,
          orderedQuantity: 1,
          readyQuantity: 1,
          handedOverQuantity: 1,
          state: "HandedOver",
        },
      ],
    });
    const effect = planCompletePickupHandoff(
      later,
      command({
        expectedAggregateVersion: 6n,
        quantities: [{ fulfillmentItemReference: refs.item1, quantity: 1 }],
      }),
    );
    expect(effect.nextPhase).toBe("Completed");
  });

  it("rejects missing permission, stale version and completed replay with a new idempotency key", () => {
    code(
      () => planCompletePickupHandoff(source(), command({ actorPermissions: [] })),
      "PICKUP_HANDOFF_PERMISSION_DENIED",
    );
    code(
      () => planCompletePickupHandoff(source(), command({ expectedAggregateVersion: 4n })),
      "PICKUP_HANDOFF_VERSION_CONFLICT",
    );
    code(
      () => planCompletePickupHandoff(source({ canonicalPhase: "Completed" }), command()),
      "PICKUP_HANDOFF_ALREADY_COMPLETED",
    );
  });

  it("rejects cross-scope or stale proof, future verification and unsafe recipient data", () => {
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({ verification: verification({ storeReference: refs.brand }) }),
        ),
      "PICKUP_HANDOFF_VERIFICATION_FAILED",
    );
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({ verification: verification({ generation: 2 }) }),
        ),
      "PICKUP_HANDOFF_VERIFICATION_FAILED",
    );
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({ verification: verification({ verifiedAt: "2026-08-11T12:04:00.000Z" }) }),
        ),
      "PICKUP_HANDOFF_VERIFICATION_FAILED",
    );
    code(
      () =>
        planCompletePickupHandoff(source(), command({ recipientDisplayMask: "name@example.com" })),
      "PICKUP_HANDOFF_INPUT_INVALID",
    );
  });

  it("rejects duplicate, unknown and excessive actual quantities", () => {
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({
            quantities: [
              { fulfillmentItemReference: refs.item1, quantity: 1 },
              { fulfillmentItemReference: refs.item1, quantity: 1 },
            ],
          }),
        ),
      "PICKUP_HANDOFF_INPUT_INVALID",
    );
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({ quantities: [{ fulfillmentItemReference: refs.actor, quantity: 1 }] }),
        ),
      "PICKUP_HANDOFF_NOT_READY",
    );
    code(
      () =>
        planCompletePickupHandoff(
          source(),
          command({ quantities: [{ fulfillmentItemReference: refs.item1, quantity: 3 }] }),
        ),
      "PICKUP_HANDOFF_NOT_READY",
    );
  });
});
