import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.scope }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: () => mock.store(),
}));
import { createMerchantDiningTableCommand } from "./merchant-dining-table-command.js";

const id = (n: number) => "0190fad7-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-25T12:00:00.000Z";
function fixture() {
  const table = {
      tableReference: id(5),
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      stableLabel: "T-1",
      areaReference: id(6),
      areaCode: "MAIN",
      capacity: 4,
      accessibilityAttributes: [],
      lifecycle: "Published",
      qrStatus: "Inactive",
      qrVersion: 0,
      operationalState: "Available",
      blockReasonCode: null,
      activeDiningSessionReference: null,
      aggregateVersion: 1,
      createdAt: at,
      observedAt: at,
    },
    tables = new Map([[id(5), table]]),
    operations = new Map(),
    throwAfterCommit = { value: false },
    allowed = vi.fn(async () => true),
    authorizeAction = vi.fn(async () => ({ effect: "Allow" })),
    tx = { query: vi.fn() },
    run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  mock.scope.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
    authorizeAction,
  });
  mock.store.mockReturnValue({
    resolveTableOperation: async (reference: string) => operations.get(reference) ?? null,
    loadTable: async (reference: string) => tables.get(reference) ?? null,
    commitTable: async (record: { operationReference: string; table: typeof table }) => {
      operations.set(record.operationReference, record);
      tables.set(record.table.tableReference, record.table);
      if (throwAfterCommit.value) throw new Error("response lost after commit");
    },
  });
  const execute = createMerchantDiningTableCommand({
    persistence: { transactions: { run }, now: () => at } as never,
    authentication: { authorize: vi.fn(async () => ({ sessionReference: id(8) })) } as never,
    newReference: () => id(10),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const input = (change = {}) => ({
    sessionCookie: "session",
    csrf: "csrf",
    command: {
      action: "SetBlock",
      tableReference: id(5),
      expectedAggregateVersion: 1,
      operationReference: id(7),
      reasonCode: "MAINTENANCE",
      ...change,
    },
  });
  return { execute, input, allowed, tables, operations, run, tx, throwAfterCommit };
}
beforeEach(() => vi.resetAllMocks());

it("commits an audited, scoped SetBlock and returns only the safe result", async () => {
  const f = fixture();
  await expect(f.execute(f.input())).resolves.toEqual({
    status: "Applied",
    tableReference: id(5),
    operationalState: "TemporarilyBlocked",
    aggregateVersion: 2,
  });
  expect(mock.scope).toHaveBeenCalledWith(f.tx, "session", "dining.operate", id(8));
  expect(f.operations.get(id(7))).toMatchObject({
    audit: {
      actor: { reference: id(4) },
      actionCode: "DINING_TABLE_SETBLOCK",
      targetId: id(5),
      correlationId: id(7),
    },
    event: { eventType: "DiningTableOperationalStateChanged", aggregateVersion: "2" },
  });
});

it("replays the same operation without a second commit", async () => {
  const f = fixture();
  await f.execute(f.input());
  await expect(f.execute(f.input())).resolves.toMatchObject({
    status: "AlreadyApplied",
    operationalState: "TemporarilyBlocked",
    aggregateVersion: 2,
  });
  expect(f.operations.size).toBe(1);
});

it("recovers an unknown commit outcome using the same operation reference", async () => {
  const f = fixture();
  f.throwAfterCommit.value = true;
  await expect(f.execute(f.input())).rejects.toThrow();
  f.throwAfterCommit.value = false;
  await expect(f.execute(f.input())).resolves.toMatchObject({
    status: "AlreadyApplied",
    operationalState: "TemporarilyBlocked",
    aggregateVersion: 2,
  });
  expect(f.operations.size).toBe(1);
});

it("requires current dining.operate before reading the table", async () => {
  const f = fixture();
  f.allowed.mockResolvedValue(false);
  await expect(f.execute(f.input())).rejects.toThrow();
  expect(mock.store).not.toHaveBeenCalled();
});

it("does not commit after current Store permission is lost before the owner write", async () => {
  const f = fixture();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.execute(f.input())).rejects.toThrow();
  expect(f.operations.size).toBe(0);
});

it("rejects a changed intent under the same operation reference", async () => {
  const f = fixture();
  await f.execute(f.input());
  await expect(f.execute(f.input({ reasonCode: "CLEANING" }))).rejects.toThrow();
  expect(f.operations.size).toBe(1);
});

it("enforces expected version and a valid reason code", async () => {
  const f = fixture();
  await expect(f.execute(f.input({ expectedAggregateVersion: 8 }))).rejects.toThrow();
  await expect(f.execute(f.input({ reasonCode: "bad code" }))).rejects.toThrow();
  expect(f.operations.size).toBe(0);
});

it("rejects a lifecycle transition that no longer applies", async () => {
  const f = fixture();
  await f.execute(f.input());
  await expect(
    f.execute(
      f.input({
        expectedAggregateVersion: 2,
        operationReference: id(9),
      }),
    ),
  ).rejects.toThrow();
  expect(f.operations.size).toBe(1);
});

it("clears an existing block as a separate versioned operation", async () => {
  const f = fixture();
  await f.execute(f.input());
  await expect(
    f.execute(
      f.input({
        action: "ClearBlock",
        expectedAggregateVersion: 2,
        operationReference: id(9),
        reasonCode: null,
      }),
    ),
  ).resolves.toMatchObject({ operationalState: "Available", aggregateVersion: 3 });
});
