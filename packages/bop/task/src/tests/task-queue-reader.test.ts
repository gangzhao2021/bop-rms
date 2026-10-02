import { expect, it, vi } from "vitest";
import {
  createTaskRecord,
  createPostgresTaskQueueReader,
  parseTaskQueueFilters,
} from "../index.js";
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
    authorizeAndFence = vi.fn<
      Parameters<typeof createPostgresTaskQueueReader>[0]["authorizeAndFence"]
    >(async () => true);
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

it("normalizes immutable filters without retaining mutable caller objects", () => {
  const value = { owner: { kind: "ByActor", actorReference: id(8) }, overdue: false };
  const parsed = parseTaskQueueFilters(value);
  value.owner.actorReference = id(99);
  expect(parsed.owner).toEqual({ kind: "ByActor", actorReference: id(8) });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.owner)).toBe(true);
  expect(parsed.status).toBeNull();
});
it.each([
  null,
  [],
  Object.create(null),
  { status: "Completed" },
  { taskType: "unsafe keyword" },
  { severityCode: "x' OR TRUE --" },
  { exactReference: "not-an-id" },
  { overdue: "true" },
  { storeReference: id(99) },
  { owner: { kind: "ByActor" } },
  { owner: { kind: "Unclaimed", actorReference: id(8) } },
  { owner: { kind: "ByActor", actorReference: id(8), email: "synthetic@example.invalid" } },
  { [Symbol("hidden")]: true },
  Object.defineProperty({}, "status", { value: "Assigned" }),
  new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("unsafe proxy detail");
      },
    },
  ),
])("rejects malformed or scope-expanding filters before authority access %#", async (filters) => {
  const f = fixture([]);
  await expect(f.reader.list({ query: f.query }, { ...input, filters })).rejects.toThrow(
    "TASK_STORE_UNAVAILABLE",
  );
  expect(f.authorizeAndFence).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(() => parseTaskQueueFilters(filters)).toThrow("task input is invalid");
});
it("does not invoke hostile filter accessors", async () => {
  const getter = vi.fn(() => "Assigned");
  const filters = Object.defineProperty({}, "status", { enumerable: true, get: getter });
  const f = fixture([]);
  await expect(f.reader.list({ query: f.query }, { ...input, filters })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("binds normalized filters as values and presents the same fenced query twice", async () => {
  const f = fixture([row(10)]);
  await f.reader.list(
    { query: f.query },
    {
      ...input,
      filters: {
        status: "Assigned",
        taskType: task.taskType,
        severityCode: "CRITICAL",
        exactReference: task.source.sourceReference,
        owner: { kind: "Unclaimed" },
        overdue: false,
      },
    },
  );
  const call = f.query.mock.calls[1];
  if (call === undefined) throw new Error("expected owner query");
  const [sql, values] = call;
  expect(sql).not.toContain(task.taskType);
  expect(values).toEqual([
    id(2),
    id(3),
    null,
    id(7),
    3,
    "Assigned",
    task.taskType,
    "CRITICAL",
    id(4),
    "Unclaimed",
    null,
    false,
    at,
  ]);
  expect(f.authorizeAndFence.mock.calls[0]?.[1]).toBe(f.authorizeAndFence.mock.calls[1]?.[1]);
});
it.each([
  { status: "Claimed" },
  { taskType: "OTHER" },
  { severityCode: "LOW" },
  { exactReference: id(99) },
  { overdue: true },
  { owner: { kind: "ByActor", actorReference: id(8) } },
  { owner: { kind: "ByOtherActor", actorReference: id(8) } },
])("rejects a nonmatching lookahead as well as returned page items %#", async (filters) => {
  const f = fixture([row(10), row(11), row(12)]);
  await expect(f.reader.list({ query: f.query }, { ...input, filters })).rejects.toThrow(
    "TASK_STORE_UNAVAILABLE",
  );
});
it("does not return a valid-looking page when only its lookahead violates filters", async () => {
  const f = fixture([
    row(10),
    row(11),
    { ...row(12), record_json: { ...row(12).record_json, severityCode: "LOW" } },
  ]);
  await expect(
    f.reader.list({ query: f.query }, { ...input, filters: { severityCode: "CRITICAL" } }),
  ).rejects.toThrow();
});
it("uses the current claim, including other-actor exclusion and strict due boundary", async () => {
  const claim = {
    claimReference: id(40),
    actorReference: id(8),
    eligibilityEvidenceReference: id(41),
    membershipReference: id(42),
    storeAssignmentReference: id(43),
    claimedAt: at,
  };
  const claimedRow = {
    ...row(10),
    version: 3,
    version_count: "3",
    record_json: {
      ...task,
      version: 3,
      status: "Claimed",
      currentClaim: claim,
      claimHistory: [claim],
    },
  };
  const f = fixture([claimedRow]);
  expect(
    (
      await f.reader.list(
        { query: f.query },
        {
          ...input,
          filters: {
            status: "Claimed",
            owner: { kind: "ByActor", actorReference: id(8) },
            overdue: false,
          },
        },
      )
    ).items,
  ).toHaveLength(1);
  for (const owner of [{ kind: "Unclaimed" }, { kind: "ByOtherActor", actorReference: id(8) }]) {
    const denied = fixture([claimedRow]);
    await expect(
      denied.reader.list({ query: denied.query }, { ...input, filters: { owner } }),
    ).rejects.toThrow();
  }
  const overdue = fixture([row(10)]);
  expect(
    (
      await overdue.reader.list(
        { query: overdue.query },
        { ...input, observedAt: "2026-09-20T00:00:00.001Z", filters: { overdue: true } },
      )
    ).items,
  ).toHaveLength(1);
});
