import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDiningJoinRegenerationStore,
  type DiningTableTransactionRunner,
} from "../index.js";
const id = (n: number) => `01902277-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:01:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const credentials = {
  hashOperationIntent: (value: string) => createHash("sha256").update(value).digest("hex") as never,
  equals: (a: string, b: string) => a === b,
};
const fixtureRecord = () => ({
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
    generation: 2,
    status: "Active",
    version: 1,
    issuedAt: at,
    expiresAt: "2026-09-09T09:16:00.000Z",
    consumedAt: null,
    revokedAt: null,
  },
  operationReference: id(7),
  operationIntentHash: credentials.hashOperationIntent(`Regenerate:${id(5)}:${id(4)}:1`),
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
  return {
    store: createPostgresDiningJoinRegenerationStore(runner, scope, credentials),
    calls,
    query,
  };
}
const record = () => {
  const { capability, operationReference, operationIntentHash } = fixtureRecord();
  return { capability, operationReference, operationIntentHash };
};
function writeInput() {
  const f = fixtureRecord();
  return {
    session: f.session,
    previous: {
      ...f.capability,
      capabilityReference: id(60),
      generation: 1,
      selectorHash: "b".repeat(64),
      status: "Revoked",
      version: 2,
      revokedAt: at,
    },
    replacement: f.capability,
    expectedCapabilityVersion: 1,
    operationReference: f.operationReference,
    operationIntentHash: f.operationIntentHash,
    audit: {
      auditId: id(70),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(8) },
      actionCode: "DINING_JOIN_CREDENTIAL_REGENERATE",
      targetType: "DiningTable",
      targetId: id(4),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(9),
      occurredAt: at,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  };
}
describe("WP-2277 scoped regeneration storage", () => {
  it("copies immutable history and binds all scope parameters", async () => {
    const source = record();
    const { store, query } = fixture({ rows: [{ record: source, actorReference: id(8) }] });
    const found = await store.resolveRegenerationOperation(id(7) as never);
    expect(found).toEqual(source);
    expect(Object.isFrozen(found?.capability)).toBe(true);
    source.capability.storeReference = id(90);
    expect(found?.capability.storeReference).toBe(id(3));
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(7)]);
  });
  it("reads a coherent frozen current state", async () => {
    const { session, capability } = fixtureRecord();
    const { store, query } = fixture({ rows: [{ session, capability }] });
    const found = await store.resolveActiveJoin(id(5) as never);
    expect(found).toEqual({ session, capability });
    expect(Object.isFrozen(found?.session)).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toContain("JOIN LATERAL");
  });
  it.each(["resolveActiveJoin", "resolveRegenerationOperation"] as const)(
    "handles missing %s and invalid locators",
    async (method) => {
      const { store, calls } = fixture({ rows: [] });
      expect(await store[method](id(5) as never)).toBeNull();
      calls.mockClear();
      await expect(store[method]("invalid" as never)).rejects.toMatchObject({
        code: "DINING_SESSION_INPUT_INVALID",
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each(["operationReference", "operationIntentHash", "extra"])(
    "denies corrupt history %s",
    async (field) => {
      const { store } = fixture({
        rows: [{ record: { ...record(), [field]: id(90) }, actorReference: id(8) }],
      });
      await expect(store.resolveRegenerationOperation(id(7) as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["brandReference", "storeReference", "diningSessionReference"])(
    "denies foreign current %s",
    async (field) => {
      const { session, capability } = fixtureRecord();
      const { store } = fixture({
        rows: [{ session: { ...session, [field]: id(90) }, capability }],
      });
      await expect(store.resolveActiveJoin(id(5) as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each([{ phase: "Closing" }, { tableAssignmentVersion: 2 }, { tableReference: id(90) }])(
    "withholds incompatible current state %j",
    async (patch) => {
      const { session, capability } = fixtureRecord();
      const { store } = fixture({ rows: [{ session: { ...session, ...patch }, capability }] });
      expect(await store.resolveActiveJoin(id(5) as never)).toBeNull();
    },
  );
  it("does not invoke row getters", async () => {
    const getter = vi.fn(() => []);
    const { store } = fixture(Object.defineProperty({}, "rows", { get: getter }));
    await expect(store.resolveActiveJoin(id(5) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects malformed writes before starting a transaction", async () => {
    const { store, calls } = fixture({ rows: [] });
    await expect(store.regenerate({} as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(calls).not.toHaveBeenCalled();
  });
  it("redacts dependency exceptions", async () => {
    const runner: DiningTableTransactionRunner = {
      run: () => {
        throw new Error("private credential");
      },
    };
    const store = createPostgresDiningJoinRegenerationStore(runner, scope, credentials);
    await expect(store.resolveActiveJoin(id(5) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each(["brandId", "storeId", "targetId", "actionCode", "occurredAt"])(
    "rejects invalid Audit %s before a transaction",
    async (field) => {
      const input = writeInput();
      const { store, calls } = fixture({ rows: [] });
      await expect(
        store.regenerate({ ...input, audit: { ...input.audit, [field]: "invalid" } } as never),
      ).rejects.toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each([
    "storeReference",
    "tableReference",
    "diningSessionReference",
    "assignmentVersion",
    "generation",
    "selectorHash",
  ])("rejects incoherent predecessor %s before a transaction", async (field) => {
    const input = writeInput();
    const { store, calls } = fixture({ rows: [] });
    const changed =
      field === "selectorHash"
        ? input.replacement.selectorHash
        : field.endsWith("Version") || field === "generation"
          ? 20
          : id(90);
    await expect(
      store.regenerate({ ...input, previous: { ...input.previous, [field]: changed } } as never),
    ).rejects.toMatchObject({ code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
    expect(calls).not.toHaveBeenCalled();
  });
  it("converges on matching history and rejects a changed Actor", async () => {
    const input = writeInput();
    const { store } = fixture({ rows: [{ record: record(), actorReference: id(8) }] });
    expect(await store.regenerate(input as never)).toEqual(record());
    await expect(
      store.regenerate({
        ...input,
        audit: { ...input.audit, actor: { type: "User", reference: id(90) } },
      } as never),
    ).rejects.toMatchObject({ code: "DINING_SESSION_IDEMPOTENCY_CONFLICT" });
  });
});
