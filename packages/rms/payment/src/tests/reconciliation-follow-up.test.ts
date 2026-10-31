import { expect, it } from "vitest";
import {
  parseReconciliationFollowUp,
  parseReconciliationFollowUpCommand,
  transitionReconciliationFollowUp,
} from "../application/reconciliation-follow-up.js";
const id = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  exceptionReference: id(4),
};
const current = {
  ...scope,
  version: 1,
  status: "Open",
  acknowledgedByReference: null,
  ownerReference: null,
  openedAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};
const command = {
  ...scope,
  expectedVersion: 1,
  operationReference: id(5),
  actorReference: id(6),
  action: "Acknowledge",
  assigneeReference: null,
  occurredAt: "2026-09-20T10:01:00.000Z",
};
it("acknowledges without rewriting opening facts or resolving the difference", () => {
  const next = transitionReconciliationFollowUp(current, command);
  expect(next).toMatchObject({
    status: "Acknowledged",
    version: 2,
    acknowledgedByReference: id(6),
    ownerReference: null,
    openedAt: current.openedAt,
  });
  expect(current.status).toBe("Open");
  expect(Object.isFrozen(next)).toBe(true);
});
it("assignment and later acknowledgment preserve owner and first acknowledgment", () => {
  const assigned = transitionReconciliationFollowUp(current, {
    ...command,
    action: "Assign",
    assigneeReference: id(7),
  });
  const acknowledged = transitionReconciliationFollowUp(assigned, {
    ...command,
    expectedVersion: 2,
  });
  expect(acknowledged).toMatchObject({
    status: "Assigned",
    ownerReference: id(7),
    acknowledgedByReference: id(6),
  });
  const again = transitionReconciliationFollowUp(acknowledged, {
    ...command,
    expectedVersion: 3,
    actorReference: id(8),
  });
  expect(again.acknowledgedByReference).toBe(id(6));
});
it.each(["tenantReference", "brandReference", "storeReference", "exceptionReference"])(
  "rejects changed %s",
  (field) => {
    expect(() =>
      transitionReconciliationFollowUp(current, { ...command, [field]: id(99) }),
    ).toThrow("RECONCILIATION_FOLLOW_UP_CONFLICT");
  },
);
it("rejects stale versions and backward clocks", () => {
  expect(() =>
    transitionReconciliationFollowUp(current, { ...command, expectedVersion: 2 }),
  ).toThrow("CONFLICT");
  expect(() =>
    transitionReconciliationFollowUp(current, {
      ...command,
      occurredAt: "2026-09-20T09:59:00.000Z",
    }),
  ).toThrow("CONFLICT");
});
it("rejects caller resolution, system actors and malformed assignment", () => {
  for (const patch of [
    { action: "Resolve" },
    { actorReference: "System" },
    { action: "Assign" },
    { assigneeReference: id(8) },
    { expectedVersion: 1.5 },
  ])
    expect(() => parseReconciliationFollowUpCommand({ ...command, ...patch })).toThrow("INVALID");
  expect(() => parseReconciliationFollowUp({ ...current, status: "Resolved" })).toThrow("INVALID");
  expect(() => parseReconciliationFollowUp({ ...current, status: "Assigned" })).toThrow("INVALID");
});
