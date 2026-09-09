import { describe, expect, it, vi } from "vitest";
import {
  createDiningCartParticipationQuery,
  type DiningParticipationReadSnapshot,
} from "../application/dining-cart-participation-query.js";
const id = (n: number) => `018f2000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T12:02:00.000Z",
  start = "2026-08-02T12:00:00.000Z",
  join = "2026-08-02T12:01:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const input = { purpose: "Cart", diningSessionReference: id(3), participantReference: id(4) };
function source(): DiningParticipationReadSnapshot {
  return {
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
  } as DiningParticipationReadSnapshot;
}
function fixture() {
  const readCurrent = vi.fn<(input: unknown) => Promise<DiningParticipationReadSnapshot | null>>(
    async () => source(),
  );
  const now = vi.fn(() => at);
  return {
    readCurrent,
    now,
    query: createDiningCartParticipationQuery({ scope, repository: { readCurrent }, now }),
  };
}
describe("Dining current Cart participation facts", () => {
  it("returns minimal immutable current facts with one scoped coherent read", async () => {
    const f = fixture();
    const result = await f.query.resolve(input);
    expect(result).toEqual({
      schemaVersion: 1,
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
    ["session", "phase", "Closing"],
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
      session: { ...current.session, hostParticipantReference: id(4) },
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
    const query = createDiningCartParticipationQuery({
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
      return { ...current, participant: { ...current.participant, participantReference } } as never;
    });
    const results = await Promise.all([
      f.query.resolve(input),
      f.query.resolve({ ...input, participantReference: id(8) }),
    ]);
    expect(results.map((x) => x?.participantReference)).toEqual([id(4), id(8)]);
    expect(f.readCurrent).toHaveBeenCalledTimes(2);
  });
});
