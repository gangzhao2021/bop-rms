import { describe, expect, it } from "vitest";
import {
  createDiningTable,
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
