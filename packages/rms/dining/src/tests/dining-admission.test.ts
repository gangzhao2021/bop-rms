import { describe, expect, it, vi } from "vitest";
import { consumeDiningIdentityAdmission } from "../index.js";

const id = (n: number) => `018f2000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const start = "2026-07-29T12:00:00.000Z";
const joined = "2026-07-29T12:01:00.000Z";
const now = "2026-07-29T12:02:00.000Z";
function input() {
  return {
    admission: {
      admissionReference: id(1),
      diningSessionReference: id(2),
      participantReference: id(3),
      storeReference: id(4),
      tableReference: id(5),
      tableAssignmentVersion: 7,
      operationReference: id(6),
      operationIntentHash: "a".repeat(64),
      status: "Active",
      version: 1,
      issuedAt: joined,
      consumedAt: null,
    },
    session: {
      diningSessionReference: id(2),
      brandReference: id(7),
      storeReference: id(4),
      tableReference: id(5),
      tableAssignmentVersion: 7,
      phase: "Active",
      version: 2,
      startedByActorReference: id(8),
      startedAt: start,
      hostParticipantReference: id(3),
    },
    participant: {
      participantReference: id(3),
      diningSessionReference: id(2),
      status: "Active",
      version: 1,
      joinedAt: joined,
      leftAt: null,
    },
    table: {
      brandReference: id(7),
      storeReference: id(4),
      tableReference: id(5),
      assignmentVersion: 7,
      tableState: "Eligible",
      activeDiningSessionReference: id(2),
      observedAt: now,
    },
    expectedAdmissionVersion: 1,
    expectedSessionVersion: 2,
    observedAt: now,
  };
}
const unavailable = { code: "DINING_SESSION_UNAVAILABLE" };
const invalid = { code: "DINING_SESSION_INPUT_INVALID" };
function errorOf(value: unknown) {
  try {
    consumeDiningIdentityAdmission(value);
  } catch (error) {
    return error;
  }
  throw new Error("expected denial");
}

describe("Dining admission one-time owner transition", () => {
  it("consumes once while retaining all original Join facts and caller data", () => {
    const request = input();
    const before = structuredClone(request);
    const result = consumeDiningIdentityAdmission(request);
    expect(result).toEqual({
      ...before.admission,
      status: "Consumed",
      version: 2,
      consumedAt: now,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toBe(request.admission);
    expect(request).toEqual(before);
    request.admission.operationIntentHash = "b".repeat(64);
    expect(result.operationIntentHash).toBe(before.admission.operationIntentHash);
    expect(errorOf({ ...before, admission: result, expectedAdmissionVersion: 2 })).toMatchObject(
      unavailable,
    );
  });
  it("allows a later participant without changing the original Host", () => {
    const request = input();
    request.session.hostParticipantReference = id(9);
    request.session.version = request.expectedSessionVersion = 3;
    expect(consumeDiningIdentityAdmission(request).participantReference).toBe(id(3));
    expect(request.session.hostParticipantReference).toBe(id(9));
  });
  it("allows consumption exactly at issuance", () => {
    const request = input();
    request.observedAt = request.table.observedAt = joined;
    expect(consumeDiningIdentityAdmission(request).consumedAt).toBe(joined);
  });
  it.each(["expectedAdmissionVersion", "expectedSessionVersion"] as const)(
    "fences stale %s",
    (field) => {
      const request = input();
      request[field] += 1;
      expect(errorOf(request)).toMatchObject({ code: "DINING_SESSION_VERSION_CONFLICT" });
    },
  );
  it.each([undefined, null, 0, -1, 1.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed expected version %s",
    (v) => {
      expect(errorOf({ ...input(), expectedAdmissionVersion: v })).toMatchObject(invalid);
      expect(errorOf({ ...input(), expectedSessionVersion: v })).toMatchObject(invalid);
    },
  );
  it.each([
    ["admission", "diningSessionReference", id(99)],
    ["admission", "participantReference", id(99)],
    ["admission", "storeReference", id(99)],
    ["admission", "tableReference", id(99)],
    ["admission", "tableAssignmentVersion", 8],
    ["admission", "issuedAt", start],
    ["participant", "diningSessionReference", id(99)],
    ["participant", "version", 2],
    ["session", "brandReference", id(99)],
    ["session", "hostParticipantReference", null],
    ["session", "phase", "Closing"],
    ["session", "phase", "Closed"],
    ["session", "phase", "Cancelled"],
    ["session", "startedAt", now],
    ["table", "brandReference", id(99)],
    ["table", "storeReference", id(99)],
    ["table", "tableReference", id(99)],
    ["table", "assignmentVersion", 8],
    ["table", "activeDiningSessionReference", id(99)],
    ["table", "activeDiningSessionReference", null],
    ["table", "tableState", "Unavailable"],
    ["table", "observedAt", joined],
    ["table", "observedAt", "2026-07-29T12:03:00.000Z"],
  ] as const)("denies ineligible %s.%s", (record, field, value) => {
    const request = input();
    Object.assign(request[record], { [field]: value });
    expect(errorOf(request)).toMatchObject(unavailable);
  });
  it("denies a participant who has left", () => {
    const request = input();
    const participant = { ...request.participant, status: "Left", version: 2, leftAt: now };
    expect(errorOf({ ...request, participant })).toMatchObject(unavailable);
  });
  it("denies future admission issuance", () => {
    const request = input();
    request.observedAt = request.table.observedAt = start;
    expect(errorOf(request)).toMatchObject(unavailable);
  });
  it.each([null, [], "private", Object.create(null), { ...input(), extra: true }])(
    "rejects closed root shape %#",
    (value) => {
      expect(errorOf(value)).toMatchObject(invalid);
    },
  );
  it.each([
    "admission",
    "session",
    "participant",
    "table",
    "expectedAdmissionVersion",
    "expectedSessionVersion",
    "observedAt",
  ])("rejects missing %s", (key) => {
    const request: Record<string, unknown> = input();
    Reflect.deleteProperty(request, key);
    expect(errorOf(request)).toMatchObject(invalid);
  });
  it.each(["admission", "session", "participant", "table"] as const)(
    "rejects accessor and hidden fields in %s without invoking them",
    (key) => {
      const request = input();
      const field = Object.keys(request[key])[0];
      if (field === undefined) throw new Error("missing fixture field");
      const get = vi.fn(() => {
        throw new Error("private dependency detail");
      });
      Object.defineProperty(request[key], field, { get, enumerable: true });
      expect(errorOf(request)).toMatchObject(invalid);
      expect(get).not.toHaveBeenCalled();
      const hidden = input();
      Object.defineProperty(hidden[key], "hidden", { value: "private", enumerable: false });
      expect(errorOf(hidden)).toMatchObject(invalid);
    },
  );
  it("rejects root accessors and symbols", () => {
    const request = input();
    const get = vi.fn();
    Object.defineProperty(request, "admission", { get, enumerable: true });
    expect(errorOf(request)).toMatchObject(invalid);
    expect(get).not.toHaveBeenCalled();
    expect(errorOf({ ...input(), [Symbol("extra")]: true })).toMatchObject(invalid);
  });
});
