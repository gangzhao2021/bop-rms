import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDiningGuestBindingStore,
  type DiningTableTransactionRunner,
} from "../index.js";
const id = (n: number) => `01902280-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T15:03:00.000Z",
  started = "2026-09-09T15:01:00.000Z",
  joined = "2026-09-09T15:02:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const input = () => ({
  brandReference: id(2),
  storeReference: id(3),
  diningSessionReference: id(5),
  participantReference: id(6),
  observedAt: at,
});
const snapshot = () => ({
  admission: {
    admissionReference: id(20),
    diningSessionReference: id(5),
    participantReference: id(6),
    storeReference: id(3),
    tableReference: id(4),
    tableAssignmentVersion: 2,
    operationReference: id(21),
    operationIntentHash: "a".repeat(64),
    status: "Consumed",
    version: 2,
    issuedAt: joined,
    consumedAt: at,
  },
  session: {
    diningSessionReference: id(5),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(4),
    tableAssignmentVersion: 2,
    phase: "Active",
    version: 2,
    startedByActorReference: id(8),
    startedAt: started,
    hostParticipantReference: id(6),
  },
  participant: {
    participantReference: id(6),
    diningSessionReference: id(5),
    status: "Active",
    version: 1,
    joinedAt: joined,
    leftAt: null,
  },
  table: {
    ...scope,
    tableReference: id(4),
    stableLabel: "T-1",
    areaReference: id(9),
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: id(5),
    aggregateVersion: 3,
    createdAt: started,
    observedAt: started,
  },
});
function fixture(result: unknown) {
  const calls = vi.fn();
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async () => result,
  );
  const runner: DiningTableTransactionRunner = {
    async run<T>(action: Parameters<DiningTableTransactionRunner["run"]>[0]) {
      calls();
      return (await action({ query })) as T;
    },
  };
  return { store: createPostgresDiningGuestBindingStore(runner, scope), calls, query };
}
describe("WP-2299 coherent current binding storage", () => {
  it("returns copied scalar table evidence with Session assignment rather than aggregate revision", async () => {
    const source = snapshot();
    const { store, query } = fixture({ rows: [source] });
    const found = await store.readCurrent(input() as never);
    expect(found?.table).toEqual({
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(4),
      assignmentVersion: 2,
      tableState: "Eligible",
      activeDiningSessionReference: id(5),
      observedAt: at,
    });
    expect(Object.isFrozen(found?.participant)).toBe(true);
    source.participant.participantReference = id(90);
    expect(found?.participant.participantReference).toBe(id(6));
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[1]?.[0]).toContain("JOIN rms_dining.dining_participant");
    expect(query.mock.calls[1]?.[0]).toContain("JOIN rms_dining.dining_table");
    expect(query.mock.calls[1]?.[0]).toContain("JOIN rms_dining.dining_identity_admission");
    expect(found?.admission.status).toBe("Consumed");
    expect(Object.isFrozen(found?.admission)).toBe(true);
    expect(query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), id(5), id(6)]);
  });
  it("returns null for absence and does not cache", async () => {
    const { store, query } = fixture({ rows: [] });
    expect(await store.readCurrent(input() as never)).toBeNull();
    expect(await store.readCurrent(input() as never)).toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each(["brandReference", "storeReference"])(
    "refuses foreign requested %s before I/O",
    async (field) => {
      const { store, calls } = fixture({ rows: [] });
      expect(await store.readCurrent({ ...input(), [field]: id(90) } as never)).toBeNull();
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each(["diningSessionReference", "participantReference", "observedAt"])(
    "rejects invalid requested %s before I/O",
    async (field) => {
      const { store, calls } = fixture({ rows: [] });
      await expect(
        store.readCurrent({ ...input(), [field]: "invalid" } as never),
      ).rejects.toMatchObject({ code: "DINING_SESSION_INPUT_INVALID" });
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["session", "brandReference"],
    ["session", "storeReference"],
    ["session", "diningSessionReference"],
    ["participant", "participantReference"],
    ["participant", "diningSessionReference"],
    ["admission", "storeReference"],
    ["admission", "diningSessionReference"],
    ["admission", "participantReference"],
    ["table", "tenantReference"],
    ["table", "brandReference"],
    ["table", "storeReference"],
  ])("rejects foreign %s.%s dependency facts", async (owner, field) => {
    const source = snapshot();
    const { store } = fixture({
      rows: [{ ...source, [owner]: { ...source[owner as "session"], [field]: id(90) } }],
    });
    await expect(store.readCurrent(input() as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    ["session", { phase: "Closed" }],
    ["session", { phase: "Cancelled" }],
    ["participant", { status: "Left", version: 2, leftAt: at }],
    ["table", { lifecycle: "Draft", activeDiningSessionReference: null }],
    ["table", { operationalState: "TemporarilyBlocked", blockReasonCode: "MAINTENANCE" }],
    ["table", { activeDiningSessionReference: null }],
    ["table", { activeDiningSessionReference: id(90) }],
    ["table", { tableReference: id(90) }],
    ["table", { observedAt: "2026-09-09T15:04:00.000Z" }],
    ["participant", { joinedAt: "2026-09-09T15:04:00.000Z" }],
    ["participant", { joinedAt: "2026-09-09T15:00:00.000Z" }],
    ["session", { startedAt: "2026-09-09T15:04:00.000Z" }],
  ])("withholds unavailable or inconsistent %s %j", async (owner, patch) => {
    const source = snapshot();
    const { store } = fixture({
      rows: [
        { ...source, [owner as string]: { ...source[owner as "session"], ...(patch as object) } },
      ],
    });
    expect(await store.readCurrent(input() as never)).toBeNull();
  });
  it("rejects input accessors without invoking them", async () => {
    const getter = vi.fn(() => id(5));
    const request = Object.defineProperty(input(), "diningSessionReference", {
      get: getter,
      enumerable: true,
    });
    const { store, calls } = fixture({ rows: [] });
    await expect(store.readCurrent(request as never)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });
  it("rejects result accessors without invoking them", async () => {
    const getter = vi.fn(() => []);
    const { store } = fixture(Object.defineProperty({}, "rows", { get: getter }));
    await expect(store.readCurrent(input() as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects unexpected result multiplicity", async () => {
    const { store } = fixture({ rows: [snapshot(), snapshot()] });
    await expect(store.readCurrent(input() as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("redacts dependency exceptions", async () => {
    const runner: DiningTableTransactionRunner = {
      run: () => {
        throw new Error("private dependency");
      },
    };
    const store = createPostgresDiningGuestBindingStore(runner, scope);
    await expect(store.readCurrent(input() as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("returns Closing facts for the dedicated binding query", async () => {
    const current = snapshot();
    const { store } = fixture({
      rows: [{ ...current, session: { ...current.session, phase: "Closing" } }],
    });
    expect(await store.readCurrent(input() as never)).toMatchObject({
      session: { phase: "Closing" },
      admission: { status: "Consumed" },
    });
  });
  it("captures request and constructor scope before transaction waits", async () => {
    const configured = { ...scope };
    const request = input();
    const query = vi.fn(async () => ({ rows: [snapshot()] }));
    const runner: DiningTableTransactionRunner = {
      async run<T>(action: Parameters<DiningTableTransactionRunner["run"]>[0]) {
        request.participantReference = id(99);
        configured.storeReference = id(99);
        return (await action({ query })) as T;
      },
    };
    const store = createPostgresDiningGuestBindingStore(runner, configured);
    expect(await store.readCurrent(request as never)).toMatchObject({
      participant: { participantReference: id(6) },
    });
    expect(query.mock.calls[1]).toEqual(
      expect.arrayContaining([[id(1), id(2), id(3), id(5), id(6)]]),
    );
  });
});
