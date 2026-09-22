import { expect, it, vi } from "vitest";
import { createTaskRecord, createPostgresTaskQueueReader } from "../index.js";
const id = (n: number) => "0190fad3-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
const assignment = {
  assignmentReference: id(6),
  target: { kind: "Queue", reference: id(7) },
  assignedBy: id(8),
  assignedAt: at,
  reasonCode: "MANAGER_REVIEW",
};
const task = createTaskRecord({
  taskReference: id(10),
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
  escalationPolicyReference: id(5),
  escalationHistory: [],
  terminalOutcome: null,
  version: 2,
  createdAt: at,
  updatedAt: at,
});
const row = (n: number) => ({
  task_id: id(n),
  version: 2,
  record_json: { ...task, taskReference: id(n) },
  version_count: "2",
  minimum_version: 1,
});
const input = {
  queueReference: id(7),
  afterTaskReference: null as string | null,
  limit: 2,
  observedAt: at,
};
function fixture(data: unknown[]) {
  const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: data }),
    authorizeAndFence = vi.fn(async () => true);
  return {
    query,
    authorizeAndFence,
    reader: createPostgresTaskQueueReader({ scope: task.scope, authorizeAndFence }),
  };
}
it("returns bounded immutable current tasks and a keyset continuation", async () => {
  const f = fixture([row(10), row(11), row(12)]),
    page = await f.reader.list({ query: f.query }, input);
  expect(page.items.map((t) => t.taskReference)).toEqual([id(10), id(11)]);
  expect(page.nextAfterTaskReference).toBe(id(11));
  expect(Object.isFrozen(page.items)).toBe(true);
  expect(f.authorizeAndFence).toHaveBeenCalledTimes(2);
});
it("finishes a page without inventing a continuation", async () => {
  const f = fixture([row(12)]);
  expect(
    (await f.reader.list({ query: f.query }, { ...input, afterTaskReference: id(11) }))
      .nextAfterTaskReference,
  ).toBeNull();
});
it.each(
  [
    [row(11), row(10)],
    [row(10), row(10)],
    [{ ...row(10), version_count: "1" }],
    [{ ...row(10), record_json: { ...task, scope: { ...task.scope, storeReference: id(99) } } }],
    [
      {
        ...row(10),
        record_json: {
          ...task,
          currentAssignment: { ...assignment, target: { kind: "Queue", reference: id(99) } },
          assignmentHistory: [{ ...assignment, target: { kind: "Queue", reference: id(99) } }],
        },
      },
    ],
    [{ ...row(10), record_json: { ...task, updatedAt: "2026-09-20T00:00:01.000Z" } }],
  ].map((data) => ({ data })),
)("rejects unordered, duplicate, incomplete, foreign or future rows %#", async ({ data }) => {
  const f = fixture(data);
  await expect(f.reader.list({ query: f.query }, input)).rejects.toThrow("TASK_STORE_UNAVAILABLE");
});
it("rejects a row at or before the cursor", async () => {
  const f = fixture([row(10)]);
  await expect(
    f.reader.list({ query: f.query }, { ...input, afterTaskReference: id(10) }),
  ).rejects.toThrow();
});
it("denies before querying and on final authority loss", async () => {
  const a = fixture([]);
  a.authorizeAndFence.mockResolvedValue(false);
  await expect(a.reader.list({ query: a.query }, input)).rejects.toThrow();
  expect(a.query).not.toHaveBeenCalled();
  const b = fixture([]);
  b.authorizeAndFence.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(b.reader.list({ query: b.query }, input)).rejects.toThrow();
});
it("rejects unbounded requests before querying", async () => {
  const f = fixture([]);
  await expect(f.reader.list({ query: f.query }, { ...input, limit: 101 })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
