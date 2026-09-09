import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDiningSessionStartStore,
  type DiningTableTransactionRunner,
} from "../index.js";
const id = (n: number) => `01902275-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:01:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const credentials = {
  hashOperationIntent: (value: string) => createHash("sha256").update(value).digest("hex") as never,
  equals: (a: string, b: string) => a === b,
};
const record = () => ({
  session: {
    diningSessionReference: id(5),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(4),
    tableAssignmentVersion: 1,
    phase: "Active",
    version: 1,
    startedByActorReference: id(8),
    startedAt: at,
    hostParticipantReference: null,
  },
  capability: {
    capabilityReference: id(6),
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: id(3),
    tableReference: id(4),
    diningSessionReference: id(5),
    selectorHash: "a".repeat(64),
    pepperVersion: 1,
    assignmentVersion: 1,
    generation: 1,
    status: "Active",
    version: 1,
    issuedAt: at,
    expiresAt: "2026-09-09T09:16:00.000Z",
    consumedAt: null,
    revokedAt: null,
  },
  operationReference: id(7),
  operationIntentHash: credentials.hashOperationIntent(`Start:${id(4)}:1:Invitation`),
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
  return { store: createPostgresDiningSessionStartStore(runner, scope, credentials), calls, query };
}
describe("WP-2275 scoped Session start storage", () => {
  it("returns copied immutable original results with exact scoped SQL parameters", async () => {
    const source = record();
    const { store, query } = fixture({ rows: [{ record: source }] });
    const result = await store.resolveStartOperation(id(7) as never);
    expect(result).toEqual(source);
    expect(Object.isFrozen(result?.capability)).toBe(true);
    source.session.storeReference = id(90);
    expect(result?.session.storeReference).toBe(id(3));
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(7)]);
  });
  it("returns a frozen scoped current Session", async () => {
    const { store } = fixture({ rows: [{ session: record().session }] });
    expect(Object.isFrozen(await store.loadSession(id(5)))).toBe(true);
  });
  it("returns null for absence", async () => {
    const { store } = fixture({ rows: [] });
    expect(await store.loadSession(id(5))).toBeNull();
    expect(await store.resolveStartOperation(id(7) as never)).toBeNull();
  });
  it.each(["loadSession", "resolveStartOperation"] as const)(
    "rejects bad %s locators before a transaction",
    async (method) => {
      const { store, calls } = fixture({ rows: [] });
      await expect(store[method]("invalid" as never)).rejects.toMatchObject({
        code: "DINING_SESSION_INPUT_INVALID",
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each(["brandReference", "storeReference", "diningSessionReference"])(
    "rejects wrong current Session %s",
    async (field) => {
      const { store } = fixture({ rows: [{ session: { ...record().session, [field]: id(90) } }] });
      await expect(store.loadSession(id(5))).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["operationReference", "operationIntentHash", "extra"])(
    "rejects malformed original %s",
    async (field) => {
      const { store } = fixture({ rows: [{ record: { ...record(), [field]: id(90) } }] });
      await expect(store.resolveStartOperation(id(7) as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("checks the actual canonical intent hash, not only its grammar", async () => {
    const { store } = fixture({
      rows: [{ record: { ...record(), operationIntentHash: "f".repeat(64) } }],
    });
    await expect(store.resolveStartOperation(id(7) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("does not execute database-result accessors", async () => {
    const getter = vi.fn(() => {
      throw new Error("private database detail");
    });
    const source = Object.defineProperty({}, "rows", { get: getter });
    const { store } = fixture(source);
    await expect(store.loadSession(id(5))).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects invalid write intent and Audit before opening any transaction", async () => {
    const { store, calls } = fixture({ rows: [] });
    await expect(
      store.start({ record: record(), expectedAssignmentVersion: 2, audit: {} } as never),
    ).rejects.toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
    expect(calls).not.toHaveBeenCalled();
  });
  it("redacts runner exceptions", async () => {
    const store = createPostgresDiningSessionStartStore(
      {
        run: async () => {
          throw new Error("private database detail");
        },
      },
      scope,
      credentials,
    );
    const error = await store.loadSession(id(5)).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
    expect(String(error)).not.toContain("private database detail");
  });
});
