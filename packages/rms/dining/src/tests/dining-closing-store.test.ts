import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresDiningClosingStore, type DiningTableTransactionRunner } from "../index.js";
const id = (n: number) => `01902282-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:01:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const hashes = {
  hashIntent: (value: string) => createHash("sha256").update(value).digest("hex") as never,
  equals: (a: string, b: string) => a === b,
};
const record = () => ({
  action: "Begin",
  session: {
    diningSessionReference: id(5),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(4),
    tableAssignmentVersion: 2,
    phase: "Closing",
    version: 3,
    startedByActorReference: id(8),
    startedAt: "2026-09-09T09:00:00.000Z",
    hostParticipantReference: id(9),
  },
  operationReference: id(7),
  operationIntentHash: hashes.hashIntent(`Begin:${id(5)}:2:${at}`),
  closureEvidenceDigest: null,
  taskReferences: [],
});
const audit = () => ({
  auditId: id(10),
  brandId: id(2),
  storeId: id(3),
  actor: { type: "System" },
  actionCode: "DINING_SESSION_CLOSING_BEGIN",
  targetType: "DiningSession",
  targetId: id(5),
  reasonCode: "AUTHORIZED_OPERATION",
  correlationId: id(11),
  occurredAt: at,
  sourceChannel: "CUSTOMER_PWA",
  dataClassification: "Restricted",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});
const command = () => ({ record: record(), expectedSessionVersion: 2, audit: audit() });
const row = () => ({ record: record(), expected_version: "2", requested_at: at });
function fixture(result: unknown = { rows: [] }) {
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
  return { store: createPostgresDiningClosingStore(runner, scope, hashes), calls, query };
}
const denied = { code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE" };
describe("WP-2282 Closing owner storage", () => {
  it("returns immutable scoped history with its verified canonical intent", async () => {
    const source = row();
    const { store, query } = fixture({ rows: [source] });
    const result = await store.resolveOperation(id(7) as never);
    expect(result).toEqual(source.record);
    expect(Object.isFrozen(result?.session)).toBe(true);
    source.record.session.tableReference = id(99);
    expect(result?.session.tableReference).toBe(id(4));
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(7)]);
  });
  it("loads exact current Session and never writes", async () => {
    const { store, query } = fixture({ rows: [{ session: record().session }] });
    expect(await store.load(id(5) as never)).toEqual(record().session);
    expect(query.mock.calls.at(-1)?.[1]).toEqual([id(1), id(2), id(3), id(5)]);
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it.each(["load", "resolveOperation"] as const)("returns null for absent %s", async (method) => {
    expect(await fixture().store[method](id(7) as never)).toBeNull();
  });
  it.each(["load", "resolveOperation"] as const)("rejects invalid %s before IO", async (method) => {
    const { store, calls } = fixture();
    await expect(store[method]("invalid" as never)).rejects.toMatchObject({
      code: "DINING_CLOSING_INPUT_INVALID",
    });
    expect(calls).not.toHaveBeenCalled();
  });
  it.each(["brandReference", "storeReference", "diningSessionReference"])(
    "denies foreign current %s",
    async (field) => {
      const { store } = fixture({ rows: [{ session: { ...record().session, [field]: id(99) } }] });
      await expect(store.load(id(5) as never)).rejects.toMatchObject(denied);
    },
  );
  it.each(["action", "operationReference", "operationIntentHash", "extra"])(
    "rejects corrupt history %s",
    async (field) => {
      const source = row();
      const { store } = fixture({
        rows: [{ ...source, record: { ...source.record, [field]: id(99) } }],
      });
      await expect(store.resolveOperation(id(7) as never)).rejects.toMatchObject(denied);
    },
  );
  it.each(["expected_version", "requested_at"])(
    "rejects inconsistent history %s",
    async (field) => {
      const { store } = fixture({
        rows: [
          { ...row(), [field]: field === "expected_version" ? "3" : "2026-09-09T09:02:00.000Z" },
        ],
      });
      await expect(store.resolveOperation(id(7) as never)).rejects.toMatchObject(denied);
    },
  );
  it.each(["phase", "version", "storeReference", "startedAt"])(
    "rejects incoherent historical Session %s",
    async (field) => {
      const source = row();
      const value =
        field === "phase"
          ? "Active"
          : field === "version"
            ? 4
            : field === "startedAt"
              ? "2026-09-09T10:00:00.000Z"
              : id(99);
      source.record.session = { ...source.record.session, [field]: value };
      await expect(
        fixture({ rows: [source] }).store.resolveOperation(id(7) as never),
      ).rejects.toMatchObject(denied);
    },
  );
  it.each(["brandId", "storeId", "targetId", "actionCode", "sourceChannel", "dataClassification"])(
    "rejects incompatible Audit %s before IO",
    async (field) => {
      const { store, calls } = fixture();
      await expect(
        store.commit({ ...command(), audit: { ...audit(), [field]: id(99) } } as never),
      ).rejects.toMatchObject(denied);
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each(["actor", "afterSummary"])("denies inappropriate System Audit %s", async (field) => {
    const { store, calls } = fixture();
    await expect(
      store.commit({
        ...command(),
        audit: {
          ...audit(),
          [field]:
            field === "actor" ? { type: "Service", reference: id(99) } : { detail: "private" },
        },
      } as never),
    ).rejects.toMatchObject(denied);
    expect(calls).not.toHaveBeenCalled();
  });
  it("converges an original commit without updating Session or appending Audit", async () => {
    const { store, query } = fixture({ rows: [row()] });
    expect(await store.commit(command() as never)).toEqual(record());
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("denies a different intent under the same operation", async () => {
    const source = row();
    source.requested_at = "2026-09-09T09:02:00.000Z";
    source.record.operationIntentHash = hashes.hashIntent(
      `Begin:${id(5)}:2:${source.requested_at}`,
    );
    await expect(
      fixture({ rows: [source] }).store.commit(command() as never),
    ).rejects.toMatchObject({ code: "DINING_CLOSING_IDEMPOTENCY_CONFLICT" });
  });
  it("fences a stale Session before any write", async () => {
    const { store, query } = fixture();
    query.mockImplementation(async (sql) =>
      sql.includes("FROM rms_dining.dining_session ")
        ? { rows: [{ session: record().session }] }
        : { rows: [] },
    );
    await expect(store.commit(command() as never)).rejects.toMatchObject({
      code: "DINING_CLOSING_VERSION_CONFLICT",
    });
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("does not invoke database result getters", async () => {
    const getter = vi.fn();
    const { store } = fixture(Object.defineProperty({}, "rows", { get: getter }));
    await expect(store.load(id(5) as never)).rejects.toMatchObject(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("redacts synchronous runner and hash failures", async () => {
    const runner = {
      run: () => {
        throw new Error("private SQL");
      },
    };
    const store = createPostgresDiningClosingStore(runner, scope, hashes);
    const error = await store.load(id(5) as never).catch((value: unknown) => value);
    expect(error).toMatchObject(denied);
    expect(String(error)).not.toContain("private SQL");
    const badHash = createPostgresDiningClosingStore(runner, scope, {
      ...hashes,
      hashIntent: () => {
        throw new Error("private hash");
      },
    });
    await expect(badHash.commit(command() as never)).rejects.toMatchObject(denied);
  });
});

it.each([
  "tableReference",
  "tableAssignmentVersion",
  "hostParticipantReference",
  "startedByActorReference",
])("WP-2282 prevents Closing from changing Session %s", async (field) => {
  const { store, query } = fixture();
  query.mockImplementation(async (sql) =>
    sql.includes("FROM rms_dining.dining_session ")
      ? {
          rows: [
            {
              session: {
                ...record().session,
                phase: "Active",
                version: 2,
                [field]: field === "tableAssignmentVersion" ? 5 : id(99),
              },
            },
          ],
        }
      : { rows: [] },
  );
  await expect(store.commit(command() as never)).rejects.toMatchObject(denied);
  expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});
it("WP-2282 preserves Finalize Task references and closure digest", async () => {
  const source = row();
  const final = {
    ...source.record,
    action: "Finalize",
    session: { ...source.record.session, phase: "Closed" },
    closureEvidenceDigest: "a".repeat(64),
    taskReferences: [id(20)],
    operationIntentHash: hashes.hashIntent(`Finalize:${id(5)}:2:${at}`),
  };
  const { store } = fixture({ rows: [{ ...source, record: final }] });
  expect(await store.resolveOperation(id(7) as never)).toEqual(final);
});
