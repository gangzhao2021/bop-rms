import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningServeCommand } from "./merchant-dining-serve-command.js";
const m = vi.hoisted(() => ({
  scope: vi.fn(),
  find: vi.fn(),
  load: vi.fn(),
  prior: vi.fn(),
  table: vi.fn(),
  commit: vi.fn(),
  compose: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresMerchantOrderIndex: () => ({ find: m.find }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningItemServiceOperationReader: () => ({ load: m.prior }),
}));
vi.mock("./dining-order-preparation-progress.js", () => ({
  createDiningOrderPreparationProgress: () => ({ load: m.load }),
}));
vi.mock("./merchant-dining-table-context.js", () => ({
  createMerchantDiningTableContext: () => ({ load: m.table }),
}));
vi.mock("./merchant-dining-item-service-composition.js", () => ({
  createMerchantDiningItemServiceComposition: m.compose,
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-20T11:00:00.000Z";
const current = () => ({
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(8),
  orderVersion: 5,
  items: [
    {
      orderItemReference: id(10),
      orderBatchReference: id(9),
      orderedQuantity: 2,
      phase: "Ready",
      everAccepted: true,
      everStarted: true,
    },
  ],
});
type Options = Parameters<typeof createMerchantDiningServeCommand>[0];
function setup() {
  const allowed = vi.fn(async () => true),
    authenticate = vi.fn(async () => ({ sessionReference: id(20) }));
  m.scope.mockResolvedValue({
    selected: { tenantReference: id(3) },
    context: { brand: { brandReference: id(4) } },
    store: { storeReference: id(5) },
    actorReference: id(11),
    allowed,
  });
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}));
  let ref = 30;
  const reference = vi.fn(() => id(ref++));
  const execute = createMerchantDiningServeCommand({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    reference,
    audit: {
      reasonCode: "DINING_ITEM_SERVED",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      operationReference: id(2),
      orderReference: id(8),
      orderItemReference: id(10),
      quantity: 1,
      expectedOrderVersion: 5,
      expectedItemServiceVersion: 0,
      expectedSessionVersion: 2,
      expectedTableAssignmentVersion: 3,
    },
  };
  return { execute, input, allowed, authenticate, run, reference };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue({
    orderType: "DineIn",
    diningSessionReference: id(6),
    guestSessionReference: id(21),
  });
  m.load.mockResolvedValue(current());
  m.prior.mockResolvedValue(null);
  m.table.mockResolvedValue({
    tableReference: id(7),
    sessionVersion: 2,
    tableAssignmentVersion: 3,
  });
  m.compose.mockImplementation(() => ({ commit: m.commit }));
  m.commit.mockImplementation(async ({ record }) => ({ status: "Created", record }));
});
it("generates actor, table, time and audit server-side after owner fences", async () => {
  const f = setup();
  expect(await f.execute(f.input)).toEqual({ status: "Created", itemServiceVersion: 1 });
  const call = m.commit.mock.calls[0]?.[0];
  expect(call.record).toMatchObject({
    actorReference: id(11),
    tableReference: id(7),
    quantity: 1,
    servedAt: at,
    recordedAt: at,
    expectedItemServiceVersion: 0,
    sourceCheckpoint: id(8),
  });
  expect(call.guestSessionReference).toBe(id(21));
  expect(m.load.mock.invocationCallOrder[0]).toBeLessThan(m.prior.mock.invocationCallOrder[0] ?? 0);
  const audit = await m.compose.mock.calls[0]?.[0].audit(call.record);
  expect(audit).toMatchObject({
    actor: { type: "User", reference: id(11) },
    actionCode: "DINING_ITEM_SERVED",
    sourceChannel: "MERCHANT_WEB",
  });
});
it("returns identical original result on retry without new identifiers or append", async () => {
  const f = setup();
  await f.execute(f.input);
  const saved = m.commit.mock.calls[0]?.[0].record;
  m.prior.mockResolvedValue(saved);
  m.commit.mockClear();
  f.reference.mockClear();
  expect(await f.execute(f.input)).toEqual({ status: "AlreadyCommitted", itemServiceVersion: 1 });
  expect(m.commit).not.toHaveBeenCalled();
  expect(f.reference).not.toHaveBeenCalled();
});
it("denies changed retry intent and another actor", async () => {
  const f = setup();
  await f.execute(f.input);
  const saved = m.commit.mock.calls[0]?.[0].record;
  m.commit.mockClear();
  m.prior.mockResolvedValue(saved);
  await expect(
    f.execute({ ...f.input, command: { ...f.input.command, quantity: 2 } }),
  ).rejects.toThrow();
  m.prior.mockResolvedValue({ ...saved, actorReference: id(99) });
  await expect(f.execute(f.input)).rejects.toThrow();
  expect(m.commit).not.toHaveBeenCalled();
});
it.each([
  "actorReference",
  "guestSessionReference",
  "tableReference",
  "auditReference",
  "servedAt",
])("rejects client authority field %s", async (key) => {
  const f = setup();
  await expect(
    f.execute({ ...f.input, command: { ...f.input.command, [key]: id(99) } }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it.each([
  "expectedOrderVersion",
  "expectedSessionVersion",
  "expectedTableAssignmentVersion",
] as const)("rejects changed %s before writing", async (key) => {
  const f = setup();
  f.input.command[key]++;
  await expect(f.execute(f.input)).rejects.toThrow();
  expect(m.commit).not.toHaveBeenCalled();
});
it("rejects non-ready items and permission denial", async () => {
  const f = setup();
  m.load.mockResolvedValue({
    ...current(),
    items: [{ ...current().items[0], phase: "InProgress" }],
  });
  await expect(f.execute(f.input)).rejects.toThrow();
  expect(m.commit).not.toHaveBeenCalled();
  f.allowed.mockResolvedValue(false);
  m.find.mockClear();
  await expect(f.execute(f.input)).rejects.toThrow();
  expect(m.find).not.toHaveBeenCalled();
});
