const mock = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mock.audit,
}));
import { beforeEach, expect, it, vi } from "vitest";
import { createPostgresDiningItemServiceStore } from "../infrastructure/persistence/dining-item-service-store.js";

/**
 * M147 (v15 batch 5): a serve that lost to another screen, or whose party moved, merged or left,
 * is certain under the dish's lock and answers "changed" (409, read again); a store that cannot
 * read or whose rows are out of scope stays "could not confirm" (503). Nothing is written either way.
 */
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const CHANGED = { code: "DINING_ITEM_SERVICE_CHANGED" };
const UNAVAILABLE = { code: "DINING_ITEM_SERVICE_UNAVAILABLE" };
function record(patch: Record<string, unknown> = {}) {
  return {
    serviceReference: id(1),
    operationReference: id(2),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    diningSessionReference: id(6),
    tableReference: id(7),
    orderReference: id(8),
    orderBatchReference: id(9),
    orderItemReference: id(10),
    actorReference: id(11),
    sourceCheckpoint: id(12),
    auditReference: id(13),
    sessionVersion: 2,
    tableAssignmentVersion: 3,
    expectedOrderVersion: 5,
    expectedItemServiceVersion: 0,
    itemServiceVersion: 1,
    quantity: 1,
    purposeCode: "ServeDiningOrderItem",
    permissionCode: "dining.item.serve",
    servedAt: "2026-09-13T12:00:00.000Z",
    recordedAt: "2026-09-13T12:00:01.000Z",
    sourceDigest: "a".repeat(64),
    ...patch,
  };
}
function table(patch: Record<string, unknown> = {}) {
  return {
    tableReference: id(7),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    stableLabel: "T1",
    areaReference: id(14),
    areaCode: "DINING",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: id(6),
    aggregateVersion: 2,
    createdAt: "2026-09-13T11:00:00.000Z",
    observedAt: "2026-09-13T11:00:00.000Z",
    ...patch,
  };
}
function session(patch: Record<string, unknown> = {}) {
  return {
    diningSessionReference: id(6),
    brandReference: id(4),
    storeReference: id(5),
    tableReference: id(7),
    tableAssignmentVersion: 3,
    phase: "Active",
    version: 2,
    startedByActorReference: id(11),
    startedAt: "2026-09-13T11:00:00.000Z",
    hostParticipantReference: null,
    ...patch,
  };
}
const audit = (candidate: ReturnType<typeof record>) => ({
  auditId: candidate.auditReference,
  brandId: candidate.brandReference,
  storeId: candidate.storeReference,
  actor: { type: "User", reference: candidate.actorReference },
  actionCode: "DINING_ITEM_SERVED",
  targetType: "OrderItem",
  targetId: candidate.orderItemReference,
  correlationId: candidate.operationReference,
  occurredAt: candidate.recordedAt,
  afterSummary: { quantity: candidate.quantity, version: candidate.itemServiceVersion },
  reasonCode: "STAFF_SERVED",
  sourceChannel: "MERCHANT_WEB",
  dataClassification: "Restricted",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});

beforeEach(() => {
  vi.resetAllMocks();
  mock.audit.mockResolvedValue(undefined);
});
function setup(input: {
  candidate?: ReturnType<typeof record>;
  prior?: unknown[];
  table?: unknown;
  session?: unknown;
  history?: unknown[];
  readyQuantity?: number;
  brokenRead?: boolean;
}) {
  const candidate = input.candidate ?? record();
  const query = vi.fn(async (sql: string) => {
    if (input.brokenRead === true && sql.includes("FROM rms_dining.dining_session"))
      return { rowCount: 0 };
    return {
      rows: sql.includes("operation_id=$4")
        ? (input.prior ?? []).map((record_json) => ({ record_json }))
        : sql.includes("SELECT table_snapshot")
          ? [{ table_snapshot: input.table ?? table() }]
          : sql.includes("SELECT session_snapshot")
            ? input.session === null
              ? []
              : [{ session_snapshot: input.session ?? session() }]
            : sql.includes("order_item_id=$4")
              ? (input.history ?? []).map((record_json) => ({ record_json }))
              : [],
      rowCount: sql.startsWith("INSERT") ? 1 : 0,
    };
  });
  const store = createPostgresDiningItemServiceStore({
    scope: { tenantReference: id(3), brandReference: id(4), storeReference: id(5) },
    authorize: async () => true,
    validateCurrent: async () => ({ orderedQuantity: 2, readyQuantity: input.readyQuantity ?? 2 }),
    audit: async () => audit(candidate),
  });
  return {
    query,
    commit: () => store.commit({ transaction: { query }, record: candidate }),
    inserted: () => query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
  };
}

it("serves a dish read at its current serving version", async () => {
  const f = setup({});
  await expect(f.commit()).resolves.toMatchObject({ status: "Created" });
  expect(f.inserted()).toBe(true);
});

it("answers changed when another screen served the dish since this screen read it", async () => {
  // Another screen recorded serving version 1; this screen still read version 0.
  const f = setup({
    history: [
      record({ serviceReference: id(30), operationReference: id(31), auditReference: id(32) }),
    ],
  });
  await expect(f.commit()).rejects.toMatchObject(CHANGED);
  expect(f.inserted()).toBe(false);
});

it("answers changed when less is left to serve than this tap asks for", async () => {
  const first = record({
    serviceReference: id(30),
    operationReference: id(31),
    auditReference: id(32),
  });
  const f = setup({
    candidate: record({ expectedItemServiceVersion: 1, itemServiceVersion: 2 }),
    history: [first],
    readyQuantity: 1,
  });
  await expect(f.commit()).rejects.toMatchObject(CHANGED);
  expect(f.inserted()).toBe(false);
});

it.each([
  [
    "the party left or moved off the table",
    { table: table({ activeDiningSessionReference: id(40) }) },
  ],
  [
    "the table is no longer seating",
    {
      table: table({
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "MAINTENANCE",
        activeDiningSessionReference: null,
      }),
    },
  ],
  ["the party moved to another table", { session: session({ tableReference: id(41) }) }],
  ["the party was reassigned", { session: session({ tableAssignmentVersion: 4 }) }],
  ["the party changed since the read", { session: session({ version: 3 }) }],
  ["the table is closed", { session: session({ phase: "Closed" }) }],
])("answers changed when %s", async (_name, patch) => {
  const f = setup(patch);
  await expect(f.commit()).rejects.toMatchObject(CHANGED);
  expect(f.inserted()).toBe(false);
});

it("serves a table that is checking out", async () => {
  await expect(setup({ session: session({ phase: "Closing" }) }).commit()).resolves.toMatchObject({
    status: "Created",
  });
});

it.each([
  ["a table row out of this store", { table: table({ storeReference: id(50) }) }],
  ["a session row out of this store", { session: session({ storeReference: id(50) }) }],
  ["a missing session", { session: null }],
  ["a read the database could not answer", { brokenRead: true }],
])("stays could-not-confirm for %s, never changed", async (_name, patch) => {
  const f = setup(patch);
  await expect(f.commit()).rejects.toMatchObject(UNAVAILABLE);
  expect(f.inserted()).toBe(false);
});

it("answers the same operation's retry as already served even after the dish moved on", async () => {
  const candidate = record();
  const f = setup({
    candidate,
    prior: [candidate],
    history: [
      candidate,
      record({
        serviceReference: id(30),
        operationReference: id(31),
        auditReference: id(32),
        expectedItemServiceVersion: 1,
        itemServiceVersion: 2,
      }),
    ],
  });
  await expect(f.commit()).resolves.toMatchObject({ status: "AlreadyCommitted" });
  expect(f.inserted()).toBe(false);
});
