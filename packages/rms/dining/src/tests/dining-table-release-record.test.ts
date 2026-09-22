import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { expect, it, vi } from "vitest";
import {
  createDiningTable,
  parseDiningSession,
  releaseClosedDiningSession,
  parseDiningInstant,
  parseDiningTableReleaseRecord,
} from "../index.js";
const id = (n: number) => "0190fad8-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = parseDiningInstant("2026-09-20T00:00:00.000Z"),
  hashes = {
    hashIntent: (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex"),
    equals: (a: string, b: string) => a === b,
  };
function fixture() {
  const beforeTable = createDiningTable({
    tableReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    stableLabel: "T1",
    areaReference: id(5),
    areaCode: "DINING",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: id(6),
    aggregateVersion: 2,
    createdAt: at,
    observedAt: at,
  });
  const session = parseDiningSession({
    diningSessionReference: id(6),
    brandReference: id(3),
    storeReference: id(4),
    tableReference: id(1),
    tableAssignmentVersion: 1,
    phase: "Closed",
    version: 3,
    startedByActorReference: id(7),
    startedAt: at,
    hostParticipantReference: null,
  });
  const command = {
    operationReference: id(8),
    diningSessionReference: id(6),
    tableReference: id(1),
    expectedSessionVersion: 3,
    expectedTableVersion: 2,
    observedAt: at,
  };
  const audit = {
    auditId: id(9),
    brandId: id(3),
    storeId: id(4),
    actor: { type: "User", reference: id(7) },
    actionCode: "DINING_TABLE_RELEASED",
    targetType: "DiningTable",
    targetId: id(1),
    reasonCode: "CUSTOMER_FINISHED",
    correlationId: id(8),
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
  return {
    command,
    intentDigest: hashes.hashIntent(
      canonicalizeRfc8785({
        tenantReference: beforeTable.tenantReference,
        brandReference: beforeTable.brandReference,
        storeReference: beforeTable.storeReference,
        ...command,
      }),
    ),
    session,
    beforeTable,
    afterTable: releaseClosedDiningSession(session, beforeTable, at),
    audit,
  };
}
it("captures immutable complete before/after release and unchanged session", () => {
  const value = fixture(),
    record = parseDiningTableReleaseRecord(value, hashes);
  expect(record).toEqual(value);
  expect(record.afterTable.activeDiningSessionReference).toBeNull();
  expect(Object.isFrozen(record.command)).toBe(true);
});
it.each(["capacity", "qrVersion", "operationalState", "aggregateVersion"] as const)(
  "rejects unrelated or invalid afterTable %s",
  (key) => {
    const f = fixture();
    expect(() =>
      parseDiningTableReleaseRecord(
        {
          ...f,
          afterTable: {
            ...f.afterTable,
            [key]: key === "operationalState" ? "TemporarilyBlocked" : 99,
          },
        },
        hashes,
      ),
    ).toThrow();
  },
);
it.each([
  "brandId",
  "storeId",
  "targetId",
  "correlationId",
  "actionCode",
  "sourceChannel",
  "dataClassification",
] as const)("rejects Audit %s mismatch", (key) => {
  const f = fixture();
  expect(() =>
    parseDiningTableReleaseRecord({ ...f, audit: { ...f.audit, [key]: id(99) } }, hashes),
  ).toThrow();
});
it("rejects changed command version even with original valid snapshots", () => {
  const f = fixture();
  expect(() =>
    parseDiningTableReleaseRecord(
      { ...f, command: { ...f.command, expectedTableVersion: 1 } },
      hashes,
    ),
  ).toThrow();
});
it("does not invoke untrusted getters", () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f, "audit", { get: getter, enumerable: true });
  expect(() => parseDiningTableReleaseRecord(f, hashes)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects hash substitution and System actor", () => {
  const f = fixture();
  expect(() =>
    parseDiningTableReleaseRecord({ ...f, intentDigest: "sha256:" + "0".repeat(64) }, hashes),
  ).toThrow();
  expect(() =>
    parseDiningTableReleaseRecord(
      { ...f, audit: { ...f.audit, actor: { type: "System" } } },
      hashes,
    ),
  ).toThrow();
});
