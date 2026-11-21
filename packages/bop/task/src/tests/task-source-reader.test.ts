import { expect, it, vi } from "vitest";
import { createTaskRecord, createPostgresTaskSourceReader } from "../index.js";
const id = (n: number) => "0190fac6-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
const task = createTaskRecord({
  taskReference: id(1),
  scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
  source: {
    sourceType: "ORDER",
    sourceReference: id(4),
    snapshotDigest: "sha256:" + "a".repeat(64),
  },
  taskType: "REVIEW_ORDER",
  severityCode: "HIGH",
  priorityCode: "HIGH",
  status: "Open",
  assignmentHistory: [],
  currentAssignment: null,
  claimHistory: [],
  currentClaim: null,
  dueAt: at,
  escalationPolicyReference: id(5),
  escalationHistory: [],
  terminalOutcome: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const row = {
  task_id: task.taskReference,
  version: 1,
  record_json: task,
  version_count: "1",
  minimum_version: 1,
};
const input = { sourceType: "ORDER", sourceReference: id(4), observedAt: at };
function fixture(data: unknown[], authorizeAndFence = async () => true) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: data });
  return {
    query,
    reader: createPostgresTaskSourceReader({ scope: task.scope, authorizeAndFence }),
  };
}
it("returns a complete immutable current snapshot", async () => {
  const f = fixture([row]);
  const result = await f.reader.load({ query: f.query }, input);
  expect(result.tasks).toEqual([task]);
  expect(Object.isFrozen(result.tasks)).toBe(true);
  expect(result.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it.each([
  { ...row, version_count: "0" },
  { ...row, minimum_version: 2 },
  { ...row, record_json: { ...task, source: { ...task.source, sourceReference: id(9) } } },
  { ...row, record_json: { ...task, scope: { ...task.scope, storeReference: id(9) } } },
  { ...row, record_json: { ...task, updatedAt: "2026-09-21T00:00:00.000Z" } },
])("rejects incomplete, foreign or future history %#", async (value) => {
  const f = fixture([value]);
  await expect(f.reader.load({ query: f.query }, input)).rejects.toThrow("TASK_STORE_UNAVAILABLE");
});
it("denies before any query", async () => {
  const f = fixture([], async () => false);
  await expect(f.reader.load({ query: f.query }, input)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects revoked authorization after reading", async () => {
  let calls = 0;
  const f = fixture([], async () => ++calls === 1);
  await expect(f.reader.load({ query: f.query }, input)).rejects.toThrow();
});
it("rejects truncation instead of returning partial tasks", async () => {
  const f = fixture(Array.from({ length: 1001 }, () => row));
  await expect(f.reader.load({ query: f.query }, input)).rejects.toThrow();
});
