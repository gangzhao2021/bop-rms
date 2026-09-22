import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createPostgresDiningExceptionTaskStore,
  createPostgresDiningExceptionTaskSource,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
} from "../index.js";
import type { EnsureDiningExceptionTaskInput } from "../application/ports/dining-closing-ports.js";
const id = (n: number) =>
  parseDiningReference("0190fac7-0000-7000-8000-" + String(n).padStart(12, "0"));
const at = parseDiningInstant("2026-09-20T00:00:00.000Z");
const hashes = {
  hashIntent: (value: string) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
  equals: (a: string, b: string) => a === b,
};
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
function request(order = id(5)): EnsureDiningExceptionTaskInput {
  return {
    purpose: "DINING_UNPAID_BATCH_EXCEPTION",
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(4),
    orderReference: order,
    evidenceVersion: 1,
    evidenceDigest: parseDiningHash("a".repeat(64)),
    intentHash: hashes.hashIntent(`DINING_UNPAID_BATCH_EXCEPTION:${id(3)}:${id(4)}:${order}:1`),
    requestedAt: at,
  };
}
const assignment = {
  assignmentReference: id(7),
  target: { kind: "Queue", reference: id(8) },
  assignedBy: id(9),
  assignedAt: at,
  reasonCode: "MANAGER_REVIEW",
};
const task = {
  taskReference: id(6),
  scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
  source: {
    sourceType: "DINING_SESSION",
    sourceReference: id(4),
    snapshotDigest: "sha256:" + "a".repeat(64),
  },
  taskType: "DINING_UNPAID_BATCH_EXCEPTION",
  severityCode: "CRITICAL",
  priorityCode: "CRITICAL",
  status: "Assigned",
  assignmentHistory: [assignment],
  currentAssignment: assignment,
  claimHistory: [],
  currentClaim: null,
  dueAt: at,
  escalationPolicyReference: id(10),
  escalationHistory: [],
  terminalOutcome: null,
  version: 2,
  createdAt: at,
  updatedAt: at,
};
const previous = {
  intent_hash: request().intentHash,
  evidence_digest: request().evidenceDigest,
  task_id: id(6),
  requested_at: at,
  task_json: task,
};
function fixture(found: unknown[] = [], output: unknown = task) {
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return {
      rows: sql.startsWith("SELECT intent_hash")
        ? found
        : sql.startsWith("INSERT")
          ? [{ task_id: id(6) }]
          : [],
    };
  });
  const tx = { query },
    createAndAssign = vi.fn(async () => output),
    authorizeAndFence = vi.fn(async () => true);
  const store = createPostgresDiningExceptionTaskStore({
    scope,
    hashes,
    transactions: { run: async (work) => work(tx) },
    createAndAssign,
    authorizeAndFence,
  });
  return { store, query, tx, createAndAssign, authorizeAndFence };
}
it("creates an accepted task and immutable association on the same transaction", async () => {
  const f = fixture(),
    result = await f.store.ensure(request());
  expect(f.createAndAssign).toHaveBeenCalledWith(f.tx, request());
  expect(result.task.status).toBe("Assigned");
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1);
  expect(f.authorizeAndFence).toHaveBeenCalledTimes(2);
});
it("replays the original acknowledgement with current authorization and no new task", async () => {
  const f = fixture([previous]);
  expect(
    (
      await f.store.ensure({
        ...request(),
        requestedAt: parseDiningInstant("2026-09-20T00:01:00.000Z"),
      })
    ).task.taskReference,
  ).toBe(id(6));
  expect(f.createAndAssign).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  expect(f.authorizeAndFence).toHaveBeenCalledTimes(2);
});
it("rejects changed closure evidence for the same identity", async () => {
  const f = fixture([previous]);
  await expect(
    f.store.ensure({ ...request(), evidenceDigest: parseDiningHash("b".repeat(64)) }),
  ).rejects.toMatchObject({ code: "DINING_CLOSING_IDEMPOTENCY_CONFLICT" });
  expect(f.createAndAssign).not.toHaveBeenCalled();
});
it("locks and queries each order separately in a shared session", async () => {
  const a = fixture(),
    b = fixture();
  await a.store.ensure(request());
  await b.store.ensure(request(id(11)));
  expect(a.query.mock.calls[1]?.[1]).not.toEqual(b.query.mock.calls[1]?.[1]);
  expect(b.query.mock.calls[2]?.[1][4]).toBe(id(11));
});
it("rejects a forged identity before accessing persistence", async () => {
  const f = fixture();
  await expect(f.store.ensure({ ...request(), orderReference: id(11) })).rejects.toMatchObject({
    code: "DINING_CLOSING_IDEMPOTENCY_CONFLICT",
  });
  expect(f.query).not.toHaveBeenCalled();
});
it.each([
  { ...task, scope: { ...task.scope, storeReference: id(12) } },
  { ...task, source: { ...task.source, sourceReference: id(12) } },
  { ...task, source: { ...task.source, snapshotDigest: "sha256:" + "b".repeat(64) } },
  { ...task, severityCode: "HIGH" },
  {
    ...task,
    currentAssignment: { ...assignment, target: { kind: "Role", reference: id(8) } },
    assignmentHistory: [{ ...assignment, target: { kind: "Role", reference: id(8) } }],
  },
])("rejects foreign or unaccepted Task acknowledgement %#", async (output) => {
  const f = fixture([], output);
  await expect(f.store.ensure(request())).rejects.toMatchObject({
    code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("reauthorizes replays and denies before creation", async () => {
  const f = fixture([previous]);
  f.authorizeAndFence.mockResolvedValue(false);
  await expect(f.store.ensure(request())).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects authority loss before transaction completion", async () => {
  const f = fixture();
  f.authorizeAndFence.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.store.ensure(request())).rejects.toMatchObject({
    code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects malformed stored acknowledgements", async () => {
  const f = fixture([{ ...previous, task_id: id(99) }]);
  await expect(f.store.ensure(request())).rejects.toMatchObject({
    code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
  });
});

function sourceFixture(change: Record<string, unknown> = {}, missing = false) {
  const row = {
    ...previous,
    tenant_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    session_id: id(4),
    order_id: id(5),
    evidence_version: "1",
    ...change,
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT tenant_id") ? (missing ? [] : [row]) : [],
  }));
  const authorizeAndFence = vi.fn(async () => true),
    source = createPostgresDiningExceptionTaskSource({ scope, hashes, authorizeAndFence });
  return { query, authorizeAndFence, read: () => source.load({ query }, { task, observedAt: at }) };
}
it("resolves the actual owner Order of a shared-session exception", async () => {
  const f = sourceFixture(),
    result = await f.read();
  expect(result?.orderReference).toBe(id(5));
  expect(result?.taskVersion).toBe(2);
  expect(result).not.toHaveProperty("resolved");
  expect(f.authorizeAndFence).toHaveBeenCalledTimes(2);
});
it("missing association is unknown, never financial clearance", async () => {
  const f = sourceFixture({}, true);
  expect(await f.read()).toBeNull();
});
it.each([
  { order_id: id(99) },
  { tenant_id: id(99) },
  { session_id: id(99) },
  { task_id: id(99) },
  { evidence_version: "0" },
  { evidence_digest: "b".repeat(64) },
  { intent_hash: "b".repeat(64) },
  { requested_at: "2026-09-21T00:00:00.000Z" },
  { task_json: { ...task, version: 3 } },
])("refuses mismatched owner acknowledgement %#", async (change) => {
  await expect(sourceFixture(change).read()).rejects.toThrow();
});
it("source read requires authority before and after lookup", async () => {
  const f = sourceFixture();
  f.authorizeAndFence.mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorizeAndFence.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
});
