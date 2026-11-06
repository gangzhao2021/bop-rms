import { describe, expect, it, vi } from "vitest";
import {
  createDiningGuestBindingQuery,
  createDiningHostSubmissionQuery,
  createDiningParticipantSubmissionQuery,
  type DiningGuestBindingReadSnapshot,
} from "../application/dining-guest-binding-query.js";
const id = (n: number) => `018f2000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T12:02:00.000Z",
  start = "2026-08-02T12:00:00.000Z",
  join = "2026-08-02T12:01:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const input = {
  purpose: "GuestSessionBinding",
  tableReference: id(5),
  diningSessionReference: id(3),
  participantReference: id(4),
};
function source(): DiningGuestBindingReadSnapshot {
  return {
    admission: {
      admissionReference: id(20),
      diningSessionReference: id(3),
      participantReference: id(4),
      storeReference: id(2),
      tableReference: id(5),
      tableAssignmentVersion: 2,
      operationReference: id(21),
      operationIntentHash: "a".repeat(64),
      status: "Consumed",
      version: 2,
      issuedAt: join,
      consumedAt: at,
    },
    session: {
      ...scope,
      diningSessionReference: id(3),
      tableReference: id(5),
      tableAssignmentVersion: 2,
      phase: "Active",
      version: 3,
      startedByActorReference: id(6),
      startedAt: start,
      hostParticipantReference: id(9),
    },
    participant: {
      participantReference: id(4),
      diningSessionReference: id(3),
      status: "Active",
      version: 1,
      joinedAt: join,
      leftAt: null,
    },
    table: {
      ...scope,
      tableReference: id(5),
      assignmentVersion: 2,
      tableState: "Eligible",
      activeDiningSessionReference: id(3),
      observedAt: at,
    },
  } as DiningGuestBindingReadSnapshot;
}
function fixture() {
  const readCurrent = vi.fn<(input: unknown) => Promise<DiningGuestBindingReadSnapshot | null>>(
    async () => source(),
  );
  const now = vi.fn(() => at);
  return {
    readCurrent,
    now,
    query: createDiningGuestBindingQuery({ scope, repository: { readCurrent }, now }),
  };
}
describe("WP-2299 current Dining Guest binding facts", () => {
  it("returns minimal immutable current facts with one scoped coherent read", async () => {
    const f = fixture();
    const result = await f.query.resolve(input);
    expect(result).toEqual({
      schemaVersion: 1,
      phase: "Active",
      ...scope,
      diningSessionReference: id(3),
      participantReference: id(4),
      tableReference: id(5),
      tableAssignmentVersion: 2,
      diningSessionVersion: 3,
      participantVersion: 1,
      observedAt: at,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.readCurrent).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      diningSessionReference: id(3),
      participantReference: id(4),
      observedAt: at,
    });
    expect(Object.isFrozen(f.readCurrent.mock.calls[0]?.[0])).toBe(true);
  });
  it("does not cache or renew participation", async () => {
    const f = fixture();
    expect(await f.query.resolve(input)).not.toBeNull();
    f.readCurrent.mockResolvedValue(null);
    expect(await f.query.resolve(input)).toBeNull();
    expect(f.readCurrent).toHaveBeenCalledTimes(2);
  });
  it.each([
    {},
    null,
    [],
    { ...input, purpose: "Override" },
    { ...input, extra: true },
    { ...input, participantReference: "invalid" },
  ])("rejects invalid closed input before I/O", async (value) => {
    const f = fixture();
    await expect(f.query.resolve(value)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    expect(f.readCurrent).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
  });
  it("rejects input accessors without evaluation", async () => {
    const f = fixture();
    const getter = vi.fn(() => id(4));
    const value = { ...input };
    Object.defineProperty(value, "participantReference", { enumerable: true, get: getter });
    await expect(f.query.resolve(value)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.readCurrent).not.toHaveBeenCalled();
  });
  it.each([
    ["session", "brandReference", id(90)],
    ["session", "storeReference", id(90)],
    ["session", "diningSessionReference", id(90)],
    ["participant", "participantReference", id(90)],
    ["participant", "diningSessionReference", id(90)],
    ["table", "brandReference", id(90)],
    ["table", "storeReference", id(90)],
    ["table", "tableReference", id(90)],
    ["table", "assignmentVersion", 3],
    ["table", "activeDiningSessionReference", id(90)],
    ["table", "activeDiningSessionReference", null],
    ["session", "phase", "Closed"],
    ["session", "phase", "Cancelled"],
    ["table", "tableState", "Unavailable"],
    ["session", "startedAt", "2026-08-02T12:03:00.000Z"],
    ["participant", "joinedAt", "2026-08-02T11:59:00.000Z"],
    ["participant", "joinedAt", "2026-08-02T12:03:00.000Z"],
  ] as const)("denies inconsistent or inactive %s.%s", async (group, field, value) => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      [group]: { ...current[group], [field]: value },
    } as never);
    expect(await f.query.resolve(input)).toBeNull();
  });
  it("denies a participant who has left even if they were the host", async () => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      session: {
        ...current.session,
        hostParticipantReference: current.participant.participantReference,
      },
      participant: { ...current.participant, status: "Left", leftAt: at },
    } as never);
    expect(await f.query.resolve(input)).toBeNull();
  });
  it.each([{}, { extra: true }, { participant: {} }])(
    "redacts malformed dependency shapes",
    async (change) => {
      const f = fixture();
      f.readCurrent.mockResolvedValue(
        (Object.keys(change).length ? { ...source(), ...change } : {}) as never,
      );
      await expect(f.query.resolve(input)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("does not evaluate dependency accessors", async () => {
    const f = fixture();
    const value = source();
    const getter = vi.fn(() => value.participant);
    Object.defineProperty(value, "participant", { enumerable: true, get: getter });
    f.readCurrent.mockResolvedValue(value);
    await expect(f.query.resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([join, "2026-08-02T12:03:00.000Z"])(
    "rejects observations outside the server read window",
    async (observedAt) => {
      const f = fixture();
      const current = source();
      f.readCurrent.mockResolvedValue({
        ...current,
        table: { ...current.table, observedAt },
      } as never);
      await expect(f.query.resolve(input)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("rejects backwards server time even for a missing record", async () => {
    const f = fixture();
    f.now.mockReturnValueOnce(at).mockReturnValueOnce(join);
    f.readCurrent.mockResolvedValue(null);
    await expect(f.query.resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("redacts private dependency failures", async () => {
    const f = fixture();
    f.readCurrent.mockRejectedValue(new Error("synthetic private source failure"));
    await expect(f.query.resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      message: "dining session is unavailable",
    });
  });
  it("copies input before awaits and snapshots before the next clock callback", async () => {
    const f = fixture();
    const value = { ...input };
    const current = source();
    f.readCurrent.mockResolvedValue(current);
    let clocks = 0;
    f.now.mockImplementation(() => {
      if (++clocks === 2) Object.assign(current.session, { version: 99 });
      return at;
    });
    const pending = f.query.resolve(value);
    value.participantReference = id(90);
    expect(await pending).toMatchObject({ participantReference: id(4), diningSessionVersion: 3 });
  });
  it("copies configured scope before callers can mutate it", async () => {
    const configured = { ...scope };
    const readCurrent = vi.fn(async () => source());
    const query = createDiningGuestBindingQuery({
      scope: configured,
      repository: { readCurrent },
      now: () => at,
    });
    configured.storeReference = id(90);
    expect(await query.resolve(input)).toMatchObject(scope);
  });
  it("isolates simultaneous participant queries", async () => {
    const f = fixture();
    f.readCurrent.mockImplementation(async (value) => {
      const participantReference = (value as { participantReference: string }).participantReference;
      const current = source();
      return {
        ...current,
        participant: { ...current.participant, participantReference },
        admission: { ...current.admission, participantReference },
      } as never;
    });
    const results = await Promise.all([
      f.query.resolve(input),
      f.query.resolve({ ...input, participantReference: id(8) }),
    ]);
    expect(results.map((x) => x?.participantReference)).toEqual([id(4), id(8)]);
    expect(f.readCurrent).toHaveBeenCalledTimes(2);
  });
  it("preserves Closing identity facts without claiming Active-only Cart authority", async () => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      session: { ...current.session, phase: "Closing" },
    } as never);
    expect(await f.query.resolve(input)).toMatchObject({
      phase: "Closing",
      participantReference: id(4),
    });
    await expect(f.query.resolve({ ...input, purpose: "Cart" })).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
  });
  it("denies original binding after a move away and back despite matching current Table IDs", async () => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      session: { ...current.session, tableAssignmentVersion: 9, version: 5 },
      table: { ...current.table, assignmentVersion: 9 },
    } as never);
    expect(await f.query.resolve(input)).toBeNull();
  });
  it("rejects a non-consumed admission as binding authority", async () => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      admission: { ...current.admission, status: "Active", version: 1, consumedAt: null },
    } as never);
    expect(await f.query.resolve(input)).toBeNull();
  });
  it.each([
    ["diningSessionReference", id(90)],
    ["participantReference", id(90)],
    ["storeReference", id(90)],
    ["tableReference", id(90)],
    ["tableAssignmentVersion", 9],
    ["issuedAt", start],
    ["consumedAt", "2026-08-02T12:03:00.000Z"],
  ])("denies changed original admission %s", async (field, value) => {
    const f = fixture();
    const current = source();
    f.readCurrent.mockResolvedValue({
      ...current,
      admission: { ...current.admission, [field]: value },
    } as never);
    expect(await f.query.resolve(input)).toBeNull();
  });
  it("rejects nested admission getters without running them", async () => {
    const f = fixture();
    const current = source();
    const getter = vi.fn(() => 2);
    Object.defineProperty(current.admission, "tableAssignmentVersion", {
      enumerable: true,
      get: getter,
    });
    f.readCurrent.mockResolvedValue(current);
    await expect(f.query.resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("current Dining Host submission facts", () => {
  const hostInput = { ...input, purpose: "DiningHostSubmission" };
  function hostFixture() {
    const snapshot = { ...source() };
    const readCurrent = vi.fn(async () => snapshot);
    return {
      snapshot,
      readCurrent,
      query: createDiningHostSubmissionQuery({ scope, repository: { readCurrent }, now: () => at }),
    };
  }
  it("accepts the current Host with the original coherent owner snapshot", async () => {
    const f = hostFixture();
    f.snapshot.session = {
      ...f.snapshot.session,
      hostParticipantReference: f.snapshot.participant.participantReference,
    };
    const result = await f.query.resolve(hostInput);
    expect(result?.phase).toBe("Active");
    expect(result?.participantReference).toBe(id(4));
    expect(f.readCurrent).toHaveBeenCalledTimes(1);
  });
  it("does not grant submission authority to an ordinary bound participant", async () => {
    const f = hostFixture();
    expect(await f.query.resolve(hostInput)).toBeNull();
  });
  it("rejects a former Host after reassignment on the next read", async () => {
    const f = hostFixture();
    f.snapshot.session = {
      ...f.snapshot.session,
      hostParticipantReference: f.snapshot.participant.participantReference,
    };
    expect(await f.query.resolve(hostInput)).not.toBeNull();
    f.snapshot.session = {
      ...f.snapshot.session,
      version: 4,
      hostParticipantReference: source().session.hostParticipantReference,
    };
    expect(await f.query.resolve(hostInput)).toBeNull();
  });
  it("rejects Closing even when the participant remains Host", async () => {
    const f = hostFixture();
    f.snapshot.session = {
      ...f.snapshot.session,
      phase: "Closing",
      hostParticipantReference: f.snapshot.participant.participantReference,
    };
    expect(await f.query.resolve(hostInput)).toBeNull();
  });
  it("does not accept the general binding purpose as a submission request", async () => {
    const f = hostFixture();
    await expect(f.query.resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    expect(f.readCurrent).not.toHaveBeenCalled();
  });
});

describe("DEC-DINING-ANY-PARTICIPANT-SUBMIT current participant submission facts", () => {
  const submitInput = { ...input, purpose: "DiningParticipantSubmission" };
  function participantFixture() {
    const snapshot = { ...source() };
    const readCurrent = vi.fn(async () => snapshot);
    return {
      snapshot,
      readCurrent,
      query: createDiningParticipantSubmissionQuery({
        scope,
        repository: { readCurrent },
        now: () => at,
      }),
    };
  }
  it("accepts an ordinary (non-Host) active participant of the Active Session", async () => {
    const f = participantFixture();
    expect(f.snapshot.session.hostParticipantReference).not.toBe(id(4));
    const result = await f.query.resolve(submitInput);
    expect(result?.phase).toBe("Active");
    expect(result?.participantReference).toBe(id(4));
    expect(f.readCurrent).toHaveBeenCalledTimes(1);
  });
  it("accepts the Host too", async () => {
    const f = participantFixture();
    f.snapshot.session = {
      ...f.snapshot.session,
      hostParticipantReference: f.snapshot.participant.participantReference,
    };
    expect((await f.query.resolve(submitInput))?.participantReference).toBe(id(4));
  });
  it("accepts a participant after the Host has left (Session without a Host)", async () => {
    const f = participantFixture();
    f.snapshot.session = { ...f.snapshot.session, hostParticipantReference: null };
    expect((await f.query.resolve(submitInput))?.participantReference).toBe(id(4));
  });
  it("refuses a participant who has left the table", async () => {
    const f = participantFixture();
    f.snapshot.participant = {
      ...f.snapshot.participant,
      status: "Left",
      leftAt: f.snapshot.table.observedAt,
    };
    expect(await f.query.resolve(submitInput)).toBeNull();
  });
  it("refuses a Closing Session", async () => {
    const f = participantFixture();
    f.snapshot.session = { ...f.snapshot.session, phase: "Closing" };
    expect(await f.query.resolve(submitInput)).toBeNull();
  });
  it("refuses a participant of another Session", async () => {
    const f = participantFixture();
    f.snapshot.participant = {
      ...f.snapshot.participant,
      diningSessionReference: f.snapshot.participant.participantReference,
    };
    expect(await f.query.resolve(submitInput)).toBeNull();
  });
  it.each(["GuestSessionBinding", "DiningHostSubmission"])(
    "does not accept the %s purpose as a participant submission request",
    async (purpose) => {
      const f = participantFixture();
      await expect(f.query.resolve({ ...input, purpose })).rejects.toMatchObject({
        code: "DINING_SESSION_INPUT_INVALID",
      });
      expect(f.readCurrent).not.toHaveBeenCalled();
    },
  );
});

/**
 * WP-2423 table-move-payment (v15 fabf0261, 2026-11-06): staff moved the party; the phone that
 * joined before the move follows it (payment, order page, next round), on Dining's recorded Move
 * off the table the phone joined at.
 */
describe("WP-2423 a phone follows the party staff moved", () => {
  const moved = (
    change: Partial<{ to: string; version: number; from: string; movedAt: string }> = {},
  ): DiningGuestBindingReadSnapshot => {
    const base = source();
    const to = change.to ?? id(50),
      version = change.version ?? 7;
    return {
      ...base,
      session: { ...base.session, tableReference: to, tableAssignmentVersion: version },
      table: { ...base.table, tableReference: to, assignmentVersion: version },
      followedMove: { fromTableReference: change.from ?? id(5), movedAt: change.movedAt ?? at },
    } as DiningGuestBindingReadSnapshot;
  };
  const query = (snapshot: DiningGuestBindingReadSnapshot | null, kind = "GuestSessionBinding") =>
    (kind === "GuestSessionBinding"
      ? createDiningGuestBindingQuery
      : createDiningParticipantSubmissionQuery)({
      scope,
      repository: { readCurrent: async () => snapshot },
      now: () => at,
    });
  it("is current at the new table, named by the code it scanned or by the table it sits at now", async () => {
    for (const tableReference of [id(5), id(50)]) {
      const found = await query(moved()).resolve({ ...input, tableReference });
      expect(found?.tableReference).toBe(id(50));
      expect(found?.tableAssignmentVersion).toBe(7);
    }
    // The next round is prepared at the table the party sits at (the guest preparation names it).
    const submitter = await query(moved(), "DiningParticipantSubmission").resolve({
      ...input,
      purpose: "DiningParticipantSubmission",
      tableReference: id(50),
    });
    expect(submitter?.tableReference).toBe(id(50));
  });
  it("follows A to B and back to A (same table, a later assignment)", async () => {
    const found = await query(moved({ to: id(5), version: 9 })).resolve(input);
    expect(found?.tableReference).toBe(id(5));
    expect(found?.tableAssignmentVersion).toBe(9);
  });
  it("still works without a move, and for an owner snapshot without the move field", async () => {
    expect((await query({ ...source(), followedMove: null }).resolve(input))?.tableReference).toBe(
      id(5),
    );
    expect((await query(source()).resolve(input))?.tableReference).toBe(id(5));
  });
  it.each([
    ["no recorded move", { followedMove: null }],
    ["a move off another table", { from: id(51) }],
    ["a move before the phone joined", { movedAt: "2026-08-02T12:01:30.000Z" }],
    ["a move after this reading", { movedAt: "2026-08-02T12:03:00.000Z" }],
  ])("refuses a party at another table with %s", async (_name, change) => {
    const snapshot =
      "followedMove" in change
        ? { ...moved(), followedMove: null }
        : moved(change as Parameters<typeof moved>[0]);
    expect(await query(snapshot).resolve(input)).toBeNull();
  });
  it("refuses a table the party never sat at", async () => {
    expect(await query(moved()).resolve({ ...input, tableReference: id(52) })).toBeNull();
  });
  it("still refuses a participant staff removed after the move", async () => {
    const snapshot = moved();
    const left = {
      ...snapshot,
      participant: { ...snapshot.participant, status: "Left", version: 2, leftAt: at },
    } as DiningGuestBindingReadSnapshot;
    expect(await query(left).resolve(input)).toBeNull();
  });
  it("refuses a malformed move", async () => {
    const snapshot = { ...moved(), followedMove: { fromTableReference: id(5) } } as never;
    await expect(query(snapshot).resolve(input)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
});
