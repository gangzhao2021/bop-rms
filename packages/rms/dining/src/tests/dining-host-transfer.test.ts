import { expect, it } from "vitest";
import {
  createDiningHostTransfer,
  parseDiningHostTransferCommand,
  parseDiningHostTransferRecord,
} from "../index.js";
const id = (n: number) => "0190fa40-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-21T03:30:00.000Z",
  started = "2026-09-21T01:00:00.000Z";
function fixture() {
  return {
    command: {
      operationReference: id(1),
      tenantReference: id(2),
      brandReference: id(3),
      storeReference: id(4),
      diningSessionReference: id(5),
      actorType: "Staff",
      actorReference: id(6),
      targetParticipantReference: id(8),
      expectedSessionVersion: 4,
      expectedHostParticipantReference: id(7),
      purposeCode: "TransferDiningHost",
      permissionCode: "dining.host.transfer",
      reasonCode: "HOST_UNAVAILABLE",
      observedAt: at,
    },
    session: {
      diningSessionReference: id(5),
      brandReference: id(3),
      storeReference: id(4),
      tableReference: id(9),
      tableAssignmentVersion: 2,
      phase: "Active",
      version: 4,
      startedByActorReference: id(10),
      startedAt: started,
      hostParticipantReference: id(7),
    },
    targetParticipant: {
      participantReference: id(8),
      diningSessionReference: id(5),
      status: "Active",
      version: 1,
      joinedAt: "2026-09-21T02:00:00.000Z",
      leftAt: null,
    },
  };
}
it("transfers only future Host and session version, preserving immutable prior facts", () => {
  const f = fixture(),
    before = structuredClone(f),
    record = createDiningHostTransfer(f);
  expect(record.session).toEqual({ ...f.session, version: 5, hostParticipantReference: id(8) });
  expect(f).toEqual(before);
  expect(record.previousSession.hostParticipantReference).toBe(id(7));
  expect(parseDiningHostTransferRecord(record)).toEqual(record);
  expect(Object.isFrozen(record.session)).toBe(true);
});
it("accepts current Participant Host and preserves Closing phase", () => {
  const f = fixture();
  f.command.actorType = "Participant";
  f.command.actorReference = id(7);
  f.session.phase = "Closing";
  expect(createDiningHostTransfer(f).session.phase).toBe("Closing");
});
it.each(["Closed", "Cancelled"])("refuses terminal session %s", (phase) => {
  const f = fixture();
  f.session.phase = phase;
  expect(() => createDiningHostTransfer(f)).toThrow();
});
it.each([
  { expectedSessionVersion: 3 },
  { expectedSessionVersion: 2147483647 },
  { expectedHostParticipantReference: id(99) },
  { targetParticipantReference: id(7) },
  { brandReference: id(99) },
  { storeReference: id(99) },
  { diningSessionReference: id(99) },
  { actorType: "System" },
  { actorType: "Participant", actorReference: id(99) },
  { purposeCode: "Other" },
  { permissionCode: "order.accept" },
  { reasonCode: "private note" },
  { observedAt: "2026-09-21T00:00:00.000Z" },
])("rejects stale or rebound command %j", (change) => {
  const f = fixture();
  expect(() => createDiningHostTransfer({ ...f, command: { ...f.command, ...change } })).toThrow();
});
it.each([
  { participantReference: id(99) },
  { diningSessionReference: id(99) },
  { status: "Left", leftAt: at },
  { joinedAt: "2026-09-21T04:00:00.000Z" },
  { joinedAt: "2026-09-21T00:00:00.000Z" },
])("refuses ineligible target %j", (change) => {
  const f = fixture();
  expect(() =>
    createDiningHostTransfer({ ...f, targetParticipant: { ...f.targetParticipant, ...change } }),
  ).toThrow();
});
it.each([
  { phase: "Closed" },
  { tableReference: id(99) },
  { tableAssignmentVersion: 3 },
  { startedByActorReference: id(99) },
  { hostParticipantReference: id(7) },
  { version: 6 },
])("rejects altered persisted transition %j", (change) => {
  const record = createDiningHostTransfer(fixture());
  expect(() =>
    parseDiningHostTransferRecord({ ...record, session: { ...record.session, ...change } }),
  ).toThrow();
});
it("rejects extra fields and accessors without evaluating them", () => {
  const f = fixture();
  expect(() => parseDiningHostTransferCommand({ ...f.command, authority: true })).toThrow();
  let read = false;
  const value = { ...f.command };
  Object.defineProperty(value, "actorReference", {
    enumerable: true,
    get: () => {
      read = true;
      return id(6);
    },
  });
  expect(() => parseDiningHostTransferCommand(value)).toThrow();
  expect(read).toBe(false);
});
