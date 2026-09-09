import { describe, expect, it } from "vitest";
import {
  createDiningTable,
  assignStartedDiningSession,
  moveActiveDiningSession,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableCode,
  replaceDiningTableDraft,
  transitionDiningTable,
} from "../index.js";

const raw = (n: number) => `018fa000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseDiningReference(raw(n));
const at = parseDiningInstant("2026-08-14T04:00:00.000Z");
function table(reference = id(1), lifecycle: "Draft" | "Published" = "Draft") {
  return createDiningTable({
    tableReference: reference,
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    stableLabel: reference === id(1) ? "T-01" : "T-02",
    areaReference: id(5),
    areaCode: "DINING_ROOM",
    capacity: 4,
    accessibilityAttributes: ["STEP_FREE"],
    lifecycle,
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: at,
    observedAt: at,
  });
}

describe("Dining Table", () => {
  it("keeps draft configuration exact and transitions QR and block state", () => {
    const revised = replaceDiningTableDraft(table(), {
      stableLabel: "T-01A",
      areaReference: id(5),
      areaCode: parseDiningTableCode("DINING_ROOM"),
      capacity: 6,
      accessibilityAttributes: [parseDiningTableCode("STEP_FREE")],
      observedAt: at,
    });
    const published = transitionDiningTable(revised, "Publish", at);
    const issued = transitionDiningTable(published, "IssueQr", at);
    const blocked = transitionDiningTable(
      issued,
      "SetBlock",
      at,
      parseDiningTableCode("MAINTENANCE"),
    );
    expect(transitionDiningTable(blocked, "ClearBlock", at)).toMatchObject({
      lifecycle: "Published",
      qrStatus: "Active",
      qrVersion: 1,
      operationalState: "Available",
      blockReasonCode: null,
      capacity: 6,
      aggregateVersion: 6,
    });
  });

  it("moves only an Active Session to an eligible same-Store Table with capacity", () => {
    const sessionReference = id(9);
    const source = createDiningTable({
      ...table(id(1), "Published"),
      activeDiningSessionReference: sessionReference,
    });
    const target = table(id(6), "Published");
    const session = parseDiningSession({
      diningSessionReference: sessionReference,
      brandReference: id(3),
      storeReference: id(4),
      tableReference: id(1),
      tableAssignmentVersion: 1,
      phase: "Active",
      version: 1,
      startedByActorReference: id(8),
      startedAt: at,
      hostParticipantReference: null,
    });
    expect(moveActiveDiningSession(session, source, target, 4, at)).toMatchObject({
      session: { tableReference: id(6), version: 2 },
      sourceTable: { activeDiningSessionReference: null, aggregateVersion: 2 },
      targetTable: { activeDiningSessionReference: sessionReference, aggregateVersion: 2 },
    });
    expect(() =>
      moveActiveDiningSession(session, source, { ...target, capacity: 2 }, 4, at),
    ).toThrow(expect.objectContaining({ code: "DINING_TABLE_CAPACITY_CONFLICT" }));
  });

  it("rejects accessors, markup, illegal Draft state and transition shortcuts", () => {
    expect(() => createDiningTable({ ...table(), stableLabel: "<T>" })).toThrow();
    expect(() => createDiningTable({ ...table(), qrStatus: "Active", qrVersion: 1 })).toThrow();
    expect(() => transitionDiningTable(table(), "IssueQr", at)).toThrow();
    const accessor = { ...table() } as Record<string, unknown>;
    Object.defineProperty(accessor, "stableLabel", { enumerable: true, get: () => "T-01" });
    expect(() => createDiningTable(accessor)).toThrow();
  });
});

describe("WP-2275 atomic Table start assignment", () => {
  const session = () =>
    parseDiningSession({
      diningSessionReference: id(9),
      brandReference: id(3),
      storeReference: id(4),
      tableReference: id(1),
      tableAssignmentVersion: 1,
      phase: "Active",
      version: 1,
      startedByActorReference: id(8),
      startedAt: at,
      hostParticipantReference: null,
    });
  it("keeps the assignment version distinct from later Table configuration revisions", () => {
    const original = session();
    const occupied = assignStartedDiningSession(original, table(id(1), "Published"), 1);
    expect(occupied).toMatchObject({ activeDiningSessionReference: id(9), aggregateVersion: 2 });
    expect(original.tableAssignmentVersion).toBe(1);
    expect(transitionDiningTable(occupied, "IssueQr", at).aggregateVersion).toBe(3);
    expect(original.tableAssignmentVersion).toBe(1);
    expect(Object.isFrozen(occupied)).toBe(true);
  });
  it.each([
    ["brandReference", id(90)],
    ["storeReference", id(90)],
    ["tableReference", id(90)],
    ["tableAssignmentVersion", 2],
    ["version", 2],
    ["phase", "Closing"],
    ["hostParticipantReference", id(90)],
    ["startedAt", "2026-08-14T03:59:00.000Z"],
  ])("rejects mismatched start %s", (field, value) => {
    expect(() =>
      assignStartedDiningSession(
        { ...session(), [field]: value } as never,
        table(id(1), "Published"),
        1,
      ),
    ).toThrow();
  });
  it.each([0, 2, 1.5, Number.NaN])("rejects stale/invalid assignment %s", (version) => {
    expect(() =>
      assignStartedDiningSession(session(), table(id(1), "Published"), version),
    ).toThrow();
  });
  it("rejects a source Table observed before its own creation", () => {
    expect(() =>
      assignStartedDiningSession(
        session(),
        { ...table(id(1), "Published"), createdAt: parseDiningInstant("2026-08-14T04:01:00.000Z") },
        1,
      ),
    ).toThrow();
  });
  it("rejects draft, occupied and blocked Tables", () => {
    const published = table(id(1), "Published");
    for (const candidate of [
      table(),
      { ...published, activeDiningSessionReference: id(90) },
      { ...published, operationalState: "TemporarilyBlocked", blockReasonCode: "MAINTENANCE" },
    ])
      expect(() => assignStartedDiningSession(session(), candidate as never, 1)).toThrow();
  });
});
