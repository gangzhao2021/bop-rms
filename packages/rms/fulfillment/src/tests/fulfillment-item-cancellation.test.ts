import { describe, expect, it } from "vitest";

import { foldPickupHandoffHistory } from "../application/pickup-handoff-history.js";
import { foldPickupProofHistory } from "../application/pickup-proof-history.js";
import {
  planCompletePickupHandoff,
  type CompletePickupHandoffCommand,
} from "../contracts/pickup-handoff.js";
import {
  FulfillmentReadinessError,
  foldFulfillmentReadiness,
  fulfillmentPhaseFor,
  parseFulfillmentItemCancellationRow,
  parseFulfillmentReadinessSource,
  type FulfillmentItemCancellationRecord,
  type FulfillmentReadinessFoldReady,
} from "../index.js";

const id = (n: number) => `0198c100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fulfillment = id(1);
const items: readonly [
  { fulfillmentItemReference: string; orderItemReference: string; orderedQuantity: number },
  { fulfillmentItemReference: string; orderItemReference: string; orderedQuantity: number },
] = [
  { fulfillmentItemReference: id(11), orderItemReference: id(21), orderedQuantity: 2 },
  { fulfillmentItemReference: id(12), orderItemReference: id(22), orderedQuantity: 1 },
];
const readyAt = "2026-08-11T12:01:00.000Z";
const cancelledAt = "2026-08-11T12:05:00.000Z";

function ready(
  index: 0 | 1,
  before: bigint,
  phaseAfter: "Pending" | "Ready",
  phaseBefore: "Pending" | "Ready" = "Pending",
): FulfillmentReadinessFoldReady {
  const item = items[index];
  return {
    fulfillmentItemReference: item.fulfillmentItemReference,
    orderItemReference: item.orderItemReference,
    readyQuantity: item.orderedQuantity,
    aggregateVersionBefore: before,
    aggregateVersionAfter: before + 1n,
    phaseBefore,
    phaseAfter,
    occurredAt: readyAt,
  };
}

function cancellation(
  index: 0 | 1,
  before: bigint,
  phaseAfter: "Pending" | "Ready",
): FulfillmentItemCancellationRecord {
  const item = items[index];
  return parseFulfillmentItemCancellationRow({
    fulfillment_item_cancellation_id: id(30 + Number(before)),
    operation_id: id(40),
    fulfillment_id: fulfillment,
    fulfillment_item_id: item.fulfillmentItemReference,
    order_id: id(2),
    order_batch_id: id(3),
    order_item_id: item.orderItemReference,
    order_cancellation_id: id(41),
    actor_id: id(42),
    aggregate_version_before: before.toString(10),
    aggregate_version_after: (before + 1n).toString(10),
    phase_before: "Pending",
    phase_after: phaseAfter,
    evidence_digest: `sha256:${"a".repeat(64)}`,
    audit_id: id(43),
    cancelled_at: new Date(cancelledAt),
  });
}

describe("WP-2423 Q6 cancelled pickup lines", () => {
  it("makes the pickup Ready when the last unfinished line is cancelled", () => {
    const fold = foldFulfillmentReadiness({
      items,
      ready: [ready(0, 1n, "Pending")],
      cancellations: [cancellation(1, 2n, "Ready")],
    });
    expect(fold.canonicalPhase).toBe("Ready");
    expect(fold.aggregateVersion).toBe(3n);
    expect([...fold.cancelled]).toEqual([id(12)]);
    // The order became ready to collect when the cancellation removed the last unfinished line.
    expect(fold.readyAt).toBe(cancelledAt);
  });

  it("makes the pickup Ready on the last ready line after an earlier cancellation", () => {
    const fold = foldFulfillmentReadiness({
      items,
      ready: [{ ...ready(0, 2n, "Ready"), occurredAt: "2026-08-11T12:09:00.000Z" }],
      cancellations: [cancellation(1, 1n, "Pending")],
    });
    expect(fold.canonicalPhase).toBe("Ready");
    expect(fold.readyAt).toBe("2026-08-11T12:09:00.000Z");
    expect(fulfillmentPhaseFor(items, new Set<string>(), new Set([id(11), id(12)]))).toBe(
      "Pending",
    );
  });

  it.each([
    [
      "a cancellation after Ready",
      [ready(0, 1n, "Pending"), ready(1, 2n, "Ready")],
      [cancellation(1, 3n, "Ready")],
    ],
    [
      "a ready fact for a cancelled line",
      [ready(1, 2n, "Pending")],
      [cancellation(1, 1n, "Pending")],
    ],
    [
      "a wrong phase after the cancellation",
      [ready(0, 1n, "Pending")],
      [cancellation(1, 2n, "Pending")],
    ],
    ["a version gap", [ready(0, 1n, "Pending")], [cancellation(1, 3n, "Ready")]],
    ["a duplicated version", [ready(0, 1n, "Pending")], [cancellation(1, 1n, "Pending")]],
  ])("refuses %s", (_name, readyFacts, cancellations) => {
    expect(() => foldFulfillmentReadiness({ items, ready: readyFacts, cancellations })).toThrow(
      FulfillmentReadinessError,
    );
  });

  it("refuses malformed cancellation rows", () => {
    for (const change of [
      { phase_before: "Ready" },
      { aggregate_version_after: "9" },
      { phase_after: "Completed" },
      { order_item_id: "not-a-reference" },
    ])
      expect(() =>
        parseFulfillmentItemCancellationRow({
          fulfillment_item_cancellation_id: id(50),
          operation_id: id(40),
          fulfillment_id: fulfillment,
          fulfillment_item_id: id(12),
          order_id: id(2),
          order_batch_id: id(3),
          order_item_id: id(22),
          order_cancellation_id: id(41),
          actor_id: id(42),
          aggregate_version_before: "1",
          aggregate_version_after: "2",
          phase_before: "Pending",
          phase_after: "Pending",
          evidence_digest: `sha256:${"a".repeat(64)}`,
          audit_id: id(43),
          cancelled_at: cancelledAt,
          ...change,
        }),
      ).toThrow(FulfillmentReadinessError);
  });

  it("issues the proof and completes the handoff over the remaining lines only", () => {
    const fold = foldFulfillmentReadiness({
      items,
      ready: [ready(0, 1n, "Pending")],
      cancellations: [cancellation(1, 2n, "Ready")],
    });
    const readiness = parseFulfillmentReadinessSource({
      fulfillmentReference: fulfillment,
      brandReference: id(4),
      storeReference: id(5),
      orderReference: id(2),
      orderBatchReference: id(3),
      canonicalPhase: fold.canonicalPhase,
      aggregateVersion: fold.aggregateVersion,
      lockedAt: "2026-08-11T12:06:00.000Z",
      items: items
        .filter((item) => !fold.cancelled.has(item.fulfillmentItemReference))
        .map((item) => ({
          ...item,
          readyQuantity: fold.ready.get(item.fulfillmentItemReference) ?? 0,
          handedOverQuantity: 0,
          state: fold.ready.has(item.fulfillmentItemReference) ? "Ready" : "Pending",
        })),
    });
    const proof = foldPickupProofHistory(readiness, fold.readyAt ?? "", {
      issues: [],
      verifications: [],
    });
    expect(proof.source.canonicalPhase).toBe("Ready");
    expect(proof.source.readyAt).toBe(cancelledAt);
    expect(proof.source.items.map((item) => item.fulfillmentItemReference)).toEqual([id(11)]);
    const handoff = foldPickupHandoffHistory(proof, [], [], []);
    const command = {
      fulfillmentReference: fulfillment,
      brandReference: id(4),
      storeReference: id(5),
      expectedAggregateVersion: handoff.source.aggregateVersion,
      purpose: "CompletePickupHandoff",
      actorReference: id(60),
      actorPermissions: ["fulfillment.pickup.complete"],
      verification: {
        verificationReference: id(61),
        correlationReference: id(62),
        fulfillmentReference: fulfillment,
        brandReference: id(4),
        storeReference: id(5),
        verificationMethod: "InPerson",
        identityCheck: "OrderNumberAndName",
        reason: "ProofNotIssued",
        verifiedByActorReference: id(60),
        verifiedAt: "2026-08-11T12:07:00.000Z",
      },
      recipientType: "Customer",
      recipientDisplayMask: "R*** Z***",
      pickupLocationReference: id(63),
      deviceReference: id(64),
      quantities: [{ fulfillmentItemReference: id(11), quantity: 2 }],
      handoffReference: id(65),
      operationReference: id(66),
      auditReference: id(67),
      idempotencyReference: id(68),
      correlationReference: id(69),
      handedOverAt: "2026-08-11T12:08:00.000Z",
    } as unknown as CompletePickupHandoffCommand;
    // Handing over the remaining line completes the pickup; the cancelled line is not owed.
    expect(planCompletePickupHandoff(handoff.source, command).nextPhase).toBe("Completed");
    expect(() =>
      planCompletePickupHandoff(handoff.source, {
        ...command,
        quantities: [
          { fulfillmentItemReference: id(11), quantity: 2 },
          { fulfillmentItemReference: id(12), quantity: 1 },
        ],
      } as unknown as CompletePickupHandoffCommand),
    ).toThrow();
  });
});
