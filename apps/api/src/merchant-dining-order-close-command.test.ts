import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  authority: vi.fn(),
  receipt: vi.fn(),
  position: vi.fn(),
  proof: vi.fn(),
  prepared: vi.fn(),
  replay: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("./merchant-order-closure-authority.js", () => ({
  createMerchantOrderClosureAuthority: () => mocks.authority,
}));
vi.mock("./dining-settled-close-evidence.js", () => ({
  createDiningSettledCloseEvidence: () => ({ load: mocks.proof }),
}));
vi.mock("./settled-order-close.js", () => ({
  createSettledOrderClose: (options: unknown) => {
    mocks.runtime(options);
    return { commitPrepared: mocks.prepared, commit: mocks.replay };
  },
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderClosureStore: () => ({ readOperation: mocks.receipt }),
  createPostgresOrderClosurePosition: () => mocks.position,
}));
import { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    actor = id(4),
    allowed = vi.fn(async () => true),
    now = vi.fn(() => at),
    tx = { query: vi.fn() };
  mocks.scope.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: actor,
    allowed,
  });
  mocks.authority.mockResolvedValue(true);
  mocks.receipt.mockResolvedValue(null);
  mocks.position.mockResolvedValue({
    status: "Open",
    orderVersion: 3,
    closureVersion: 0,
    closureReference: null,
  });
  mocks.proof.mockResolvedValue({
    decision: { eligible: true },
    evidence: {},
    evidenceDigest: "sha256:" + "a".repeat(64),
  });
  const records: Record<string, unknown>[] = [];
  mocks.prepared.mockImplementation(async (_tx, input) => {
    if (!(await input.authorizeIntent())) throw new Error("denied");
    const record = await input.prepareClosure({
      finalityReference: input.financial.finalityReference,
      decidedAt: input.financial.observedAt,
    });
    records.push(record);
    return { status: "Committed", closure: record };
  });
  mocks.replay.mockImplementation(async (_tx, input) => ({
    status: "AlreadyCommitted",
    closure: input.closure,
  }));
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(20) })) },
    resolveConfiguration = vi.fn(async () => ({
      providerAccountReference: id(5),
      environment: "Test" as const,
      diningSessionReference: id(6),
      guestSessionReference: id(7),
    }));
  let seq = 100;
  const newReference = vi.fn(() => id(seq++));
  const persistence = {
    now,
    transactions: { run: async (work: (tx: unknown) => Promise<unknown>) => work(tx) },
  } as unknown as PersistentMerchantBffOptions;
  const command = {
    orderReference: id(8),
    operationReference: id(9),
    expectedOrderVersion: 3,
    expectedClosureVersion: 0,
    reasonCode: "CUSTOMER_FINISHED",
  };
  const handler = createMerchantDiningOrderCloseCommand({
    persistence,
    authentication: authentication as unknown as Parameters<
      typeof createMerchantDiningOrderCloseCommand
    >[0]["authentication"],
    resolveConfiguration,
    newReference,
    audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
  return {
    records,
    allowed,
    now,
    newReference,
    authentication,
    resolveConfiguration,
    scope,
    command,
    run: (payload: unknown = command) =>
      handler({ sessionCookie: "test-cookie", csrf: "test-csrf", command: payload }),
  };
}
it("derives staff/scope/time/references and returns only bounded receipt", async () => {
  const f = setup();
  expect(await f.run()).toEqual({ status: "Committed", closedOrderVersion: 3, closureVersion: 1 });
  expect(f.records[0]).toMatchObject({
    ...f.scope,
    actorType: "User",
    actorReference: id(4),
    occurredAt: at,
    reasonCode: "CUSTOMER_FINISHED",
  });
  expect(mocks.scope.mock.calls[0]?.slice(1)).toEqual(["test-cookie", "order.close", id(20)]);
  expect(mocks.prepared.mock.calls[0]?.[1].financial.operationReference).toBe(
    f.command.operationReference,
  );
});
it("reuses historical timestamp and finality without generating anything on retry", async () => {
  const f = setup();
  await f.run();
  mocks.receipt.mockResolvedValue(f.records[0]);
  f.now.mockReturnValue("2026-09-20T00:10:00.000Z");
  const count = f.newReference.mock.calls.length;
  expect((await f.run()).status).toBe("AlreadyCommitted");
  expect(f.newReference).toHaveBeenCalledTimes(count);
  expect(mocks.prepared).toHaveBeenCalledOnce();
  expect(mocks.proof).toHaveBeenCalledOnce();
  expect(mocks.replay.mock.calls[0]?.[1].financial.observedAt).toBe(at);
});
it.each([{ reasonCode: "CHANGED" }, { expectedOrderVersion: 4 }, { expectedClosureVersion: 1 }])(
  "rejects altered retry intent %#",
  async (change) => {
    const f = setup();
    await f.run();
    mocks.receipt.mockResolvedValue(f.records[0]);
    await expect(f.run({ ...f.command, ...change })).rejects.toThrow();
    expect(mocks.replay).not.toHaveBeenCalled();
  },
);
it.each([
  { actorReference: id(99) },
  { tenantReference: id(99) },
  { observedAt: at },
  { evidenceDigest: "sha256:" + "a".repeat(64) },
])("rejects client-owned authority or evidence %#", async (change) => {
  const f = setup();
  await expect(f.run({ ...f.command, ...change })).rejects.toThrow();
  expect(mocks.scope).not.toHaveBeenCalled();
});
it("CSRF/session failure precedes all business work", async () => {
  const f = setup();
  f.authentication.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.run()).rejects.toThrow();
  expect(mocks.scope).not.toHaveBeenCalled();
});
it("current permission denial precedes configuration/write", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
  expect(f.resolveConfiguration).not.toHaveBeenCalled();
  expect(mocks.prepared).not.toHaveBeenCalled();
});
it("stale closure version cannot write", async () => {
  const f = setup();
  mocks.position.mockResolvedValue({ status: "Open", orderVersion: 3, closureVersion: 2 });
  await expect(f.run()).rejects.toThrow();
  expect(mocks.prepared).not.toHaveBeenCalled();
});
it("ineligible proof fails preparation", async () => {
  const f = setup();
  mocks.proof.mockResolvedValue({ decision: { eligible: false } });
  await expect(f.run()).rejects.toThrow();
  expect(f.records).toHaveLength(0);
});
