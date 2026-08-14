import { describe, expect, it } from "vitest";
import {
  beginDeliverySearch,
  createDeliveryTask,
  deliveryInstant,
  deliveryReference,
  offerDeliveryAssignment,
  respondDeliveryAssignment,
} from "../index.js";
const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (h: number) => deliveryInstant(`2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z`);
const planned = () =>
  createDeliveryTask({
    taskReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    fulfillmentReference: id(5),
    orderReference: id(6),
    fulfillmentType: "Delivery",
    fulfillmentStatus: "Planned",
    addressSnapshotReference: id(7),
    confirmedWindowReference: id(8),
    capacityAllocationReference: id(9),
    requirementsReference: id(10),
    occurredAt: at(8),
  });
const offered = () => {
  const task = beginDeliverySearch(planned(), { expectedVersion: 1, occurredAt: at(9) });
  return offerDeliveryAssignment(task, {
    expectedVersion: 2,
    attemptReference: id(11),
    targetType: "InternalWorker",
    targetReference: id(12),
    dispatchMode: "Automatic",
    dispatchPolicyVersionReference: id(13),
    routePlanVersionReference: id(14),
    assignmentVersion: 1,
    offeredAt: at(10),
    expiresAt: at(11),
    dispatchDeadline: at(12),
    maxAutomaticAttempts: 3,
    idempotencyReference: id(15),
    candidateEvidence: { available: "Available", requirementsMatched: true, hardBlocked: false },
  });
};
describe("Delivery Task dispatch", () => {
  it("creates exactly a Planned Delivery Task from complete source snapshots", () => {
    expect(planned()).toMatchObject({
      executionStatus: "Planned",
      assignmentStatus: "Unassigned",
      aggregateVersion: 1,
    });
  });
  it("rejects Pickup, Pending or incomplete Planned sources", () => {
    expect(() =>
      createDeliveryTask({
        taskReference: id(1),
        tenantReference: id(2),
        brandReference: id(3),
        storeReference: id(4),
        fulfillmentReference: id(5),
        orderReference: id(6),
        fulfillmentType: "Pickup",
        fulfillmentStatus: "Planned",
        addressSnapshotReference: id(7),
        confirmedWindowReference: id(8),
        capacityAllocationReference: id(9),
        requirementsReference: id(10),
        occurredAt: at(8),
      }),
    ).toThrow();
  });
  it("pins one active Offer with policy, route, TTL and immutable sequence", () => {
    const task = offered();
    expect(task.attempts[0]).toMatchObject({
      sequence: 1,
      outcome: "Pending",
      dispatchPolicyVersionReference: id(13),
      routePlanVersionReference: id(14),
    });
    expect(() =>
      offerDeliveryAssignment(task, {
        expectedVersion: 3,
        attemptReference: id(20),
        targetType: "ExternalProvider",
        targetReference: id(21),
        dispatchMode: "Manual",
        dispatchPolicyVersionReference: id(13),
        routePlanVersionReference: id(14),
        assignmentVersion: 2,
        offeredAt: at(10),
        expiresAt: at(11),
        dispatchDeadline: at(12),
        maxAutomaticAttempts: 3,
        idempotencyReference: id(22),
        candidateEvidence: {
          available: "Available",
          requirementsMatched: true,
          hardBlocked: false,
        },
      }),
    ).toThrow();
  });
  it("rejects unavailable/indeterminate or hard-blocked candidates", () => {
    const task = beginDeliverySearch(planned(), { expectedVersion: 1, occurredAt: at(9) });
    expect(() =>
      offerDeliveryAssignment(task, {
        expectedVersion: 2,
        attemptReference: id(11),
        targetType: "InternalWorker",
        targetReference: id(12),
        dispatchMode: "Automatic",
        dispatchPolicyVersionReference: id(13),
        routePlanVersionReference: id(14),
        assignmentVersion: 1,
        offeredAt: at(10),
        expiresAt: at(11),
        dispatchDeadline: at(12),
        maxAutomaticAttempts: 3,
        idempotencyReference: id(15),
        candidateEvidence: {
          available: "Indeterminate",
          requirementsMatched: true,
          hardBlocked: false,
        },
      }),
    ).toThrow();
  });
  it("rejects late or stale Accept and preserves the original attempt", () => {
    const task = offered();
    expect(() =>
      respondDeliveryAssignment(task, {
        expectedVersion: 3,
        attemptReference: id(11),
        assignmentVersion: 1,
        outcome: "Accepted",
        reasonCode: "ACCEPTED",
        respondedAt: at(11),
      }),
    ).toThrow();
    expect(task.attempts[0]?.outcome).toBe("Pending");
  });
  it("moves a rejected attempt to Reassignment Required without failing execution", () => {
    const task = offered(),
      rejected = respondDeliveryAssignment(task, {
        expectedVersion: 3,
        attemptReference: id(11),
        assignmentVersion: 1,
        outcome: "Rejected",
        reasonCode: "WORKER_DECLINED",
        respondedAt: at(10),
      });
    expect(rejected).toMatchObject({
      assignmentStatus: "ReassignmentRequired",
      executionStatus: "Planned",
    });
    expect(rejected.attempts[0]?.outcome).toBe("Rejected");
  });
});
