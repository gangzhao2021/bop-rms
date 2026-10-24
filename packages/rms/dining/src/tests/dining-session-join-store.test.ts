import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDiningSessionJoinStore,
  type DiningTableTransactionRunner,
  type DiningJoinAuditFactory,
} from "../index.js";
const id = (n: number) => `01902278-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T14:01:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const credentials = {
  hashOperationIntent: (value: string) => createHash("sha256").update(value).digest("hex") as never,
  equals: (a: string, b: string) => a === b,
};
const record = () => {
  const operationReference = id(7),
    operationIntentHash = credentials.hashOperationIntent(`Join:${id(80)}:${id(6)}`);
  return {
    session: {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(4),
      tableAssignmentVersion: 1,
      phase: "Active",
      version: 2,
      startedByActorReference: id(8),
      startedAt: at,
      hostParticipantReference: id(9),
    },
    participant: {
      participantReference: id(9),
      diningSessionReference: id(5),
      status: "Active",
      version: 1,
      joinedAt: at,
      leftAt: null,
    },
    admission: {
      admissionReference: id(10),
      diningSessionReference: id(5),
      participantReference: id(9),
      storeReference: id(3),
      tableReference: id(4),
      tableAssignmentVersion: 1,
      operationReference,
      operationIntentHash,
      status: "Active",
      version: 1,
      issuedAt: at,
      consumedAt: null,
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
      status: "Consumed",
      version: 2,
      issuedAt: at,
      expiresAt: "2026-09-09T14:16:00.000Z",
      consumedAt: at,
      revokedAt: null,
    },
    operationReference,
    operationIntentHash,
  };
};
const audit: DiningJoinAuditFactory = () => ({
  auditId: id(70),
  brandId: id(2),
  storeId: id(3),
  actor: { type: "System" },
  actionCode: "DINING_SESSION_JOIN",
  targetType: "DiningSession",
  targetId: id(5),
  reasonCode: "AUTHORIZED_DINING_JOIN",
  correlationId: id(7),
  occurredAt: at,
  sourceChannel: "CUSTOMER_PWA",
  dataClassification: "Restricted",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});
const input = () => ({
  record: record(),
  guestSessionReference: id(80),
  expectedSessionVersion: 1,
  expectedCapabilityVersion: 1,
});
function fixture(result: unknown, factory = audit) {
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
    store: createPostgresDiningSessionJoinStore(runner, scope, credentials, factory),
    calls,
    query,
  };
}
describe("WP-2278 scoped Guest Join storage", () => {
  it("returns copied immutable original history and exact scoped SQL", async () => {
    const source = record();
    const { store, query } = fixture({ rows: [{ record: source, guestSessionReference: id(80) }] });
    const found = await store.resolveJoinOperation(id(7) as never);
    expect(found).toEqual(source);
    expect(Object.isFrozen(found?.participant)).toBe(true);
    source.participant.participantReference = id(90);
    expect(found?.participant.participantReference).toBe(id(9));
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(7)]);
  });
  it("reads consumed capability history with current Session coherently", async () => {
    const { session, capability } = record();
    const { store, query } = fixture({ rows: [{ session, capability }] });
    expect(await store.resolveJoinState(capability.selectorHash as never)).toEqual({
      session,
      capability,
    });
    expect(query.mock.calls.at(-1)?.[0]).toContain("JOIN rms_dining.dining_session");
  });
  it.each([0, 2])("withholds absent or ambiguous selectors: %s matches", async (count) => {
    const { session, capability } = record();
    const { store } = fixture({
      rows: Array.from({ length: count }, () => ({ session, capability })),
    });
    expect(await store.resolveJoinState(capability.selectorHash as never)).toBeNull();
  });
  it.each(["brandReference", "storeReference", "diningSessionReference"])(
    "denies inconsistent current %s",
    async (field) => {
      const { session, capability } = record();
      const { store } = fixture({
        rows: [{ session: { ...session, [field]: id(90) }, capability }],
      });
      await expect(store.resolveJoinState(capability.selectorHash as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each([{ phase: "Closing" }, { tableReference: id(90) }, { tableAssignmentVersion: 2 }])(
    "withholds unavailable current state %j",
    async (patch) => {
      const { session, capability } = record();
      const { store } = fixture({ rows: [{ session: { ...session, ...patch }, capability }] });
      expect(await store.resolveJoinState(capability.selectorHash as never)).toBeNull();
    },
  );
  it.each(["resolveJoinOperation", "resolveJoinState"] as const)(
    "rejects invalid %s locator without SQL",
    async (method) => {
      const { store, calls } = fixture({ rows: [] });
      await expect(store[method]("invalid" as never)).rejects.toMatchObject({
        code: "DINING_SESSION_INPUT_INVALID",
      });
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each(["participant", "admission", "capability", "session"])(
    "denies raw fields in %s history",
    async (field) => {
      const original = record();
      const bad = {
        ...original,
        [field]: { ...original[field as "participant"], extra: "synthetic-forbidden" },
      };
      const { store } = fixture({ rows: [{ record: bad, guestSessionReference: id(80) }] });
      await expect(store.resolveJoinOperation(id(7) as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["operationIntentHash", "operationReference"])(
    "denies wrong original %s",
    async (field) => {
      const { store } = fixture({
        rows: [{ record: { ...record(), [field]: id(90) }, guestSessionReference: id(80) }],
      });
      await expect(store.resolveJoinOperation(id(7) as never)).rejects.toMatchObject({
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each([
    "brandId",
    "storeId",
    "actionCode",
    "targetId",
    "sourceChannel",
    "dataClassification",
    "beforeSummary",
  ])("rejects invalid Audit %s before SQL", async (field) => {
    const factory: DiningJoinAuditFactory = (descriptor) => ({
      ...audit(descriptor),
      [field]: "invalid",
    });
    const { store, calls } = fixture({ rows: [] }, factory);
    await expect(store.join(input() as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(calls).not.toHaveBeenCalled();
  });
  it("converges on exact original history", async () => {
    const { store } = fixture({ rows: [{ record: record(), guestSessionReference: id(80) }] });
    expect(await store.join(input() as never)).toEqual(record());
  });
  it("rejects a changed Guest using the same operation", async () => {
    const current = input();
    const intent = credentials.hashOperationIntent(`Join:${id(81)}:${id(6)}`);
    const changed = {
      ...current,
      guestSessionReference: id(81),
      record: {
        ...current.record,
        operationIntentHash: intent,
        admission: { ...current.record.admission, operationIntentHash: intent },
      },
    };
    const { store } = fixture({ rows: [{ record: record(), guestSessionReference: id(80) }] });
    await expect(store.join(changed as never)).rejects.toMatchObject({
      code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
    });
  });
  it("does not execute dependency row getters", async () => {
    const getter = vi.fn(() => []);
    const { store } = fixture(Object.defineProperty({}, "rows", { get: getter }));
    await expect(store.resolveJoinState("a".repeat(64) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("redacts private dependency exceptions", async () => {
    const runner: DiningTableTransactionRunner = {
      run: () => {
        throw new Error("private dependency");
      },
    };
    const store = createPostgresDiningSessionJoinStore(runner, scope, credentials, audit);
    await expect(store.resolveJoinOperation(id(7) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects original capabilities issued before Session start", async () => {
    const original = record();
    const bad = {
      ...original,
      capability: {
        ...original.capability,
        issuedAt: "2026-09-09T14:00:59.999Z",
        expiresAt: "2026-09-09T14:15:59.999Z",
      },
    };
    const { store } = fixture({ rows: [{ record: bad, guestSessionReference: id(80) }] });
    await expect(store.resolveJoinOperation(id(7) as never)).rejects.toMatchObject({
      code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
    });
  });
});
