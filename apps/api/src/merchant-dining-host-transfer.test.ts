import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningHostTransfer } from "./merchant-dining-host-transfer.js";
const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  transfer: vi.fn(),
  options: null as unknown,
  runner: null as unknown,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningHostTransferStore: (runner: unknown, options: unknown) => {
    m.runner = runner;
    m.options = options;
    return { transfer: m.transfer };
  },
}));
const id = (n: number) => "0190fa41-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-21T03:45:00.000Z";
type Options = Parameters<typeof createMerchantDiningHostTransfer>[0];
function setup() {
  const tx = {},
    allowed = vi.fn(async () => true),
    authorize = vi.fn(async () => ({ sessionReference: id(1) }));
  let rolledBack = false;
  const references = vi.fn(() => id(9));
  m.resolve.mockResolvedValue({
    selected: { tenantReference: id(2) },
    context: { brand: { brandReference: id(3) }, resolvedAt: at },
    store: { storeReference: id(4) },
    actorReference: id(5),
    allowed,
  });
  const command = {
    operationReference: id(6),
    diningSessionReference: id(7),
    expectedSessionVersion: 3,
    expectedHostParticipantReference: id(8),
    targetParticipantReference: id(10),
  };
  m.transfer.mockImplementation(async (c) => ({
    status: "Applied",
    record: {
      command: c,
      previousSession: { hostParticipantReference: id(8) },
      session: { diningSessionReference: id(7), hostParticipantReference: id(10), version: 4 },
    },
  }));
  const transfer = createMerchantDiningHostTransfer({
    persistence: {
      now: () => at,
      transactions: {
        run: async (work: (tx: unknown) => Promise<unknown>) => {
          try {
            return await work(tx);
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        },
      },
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    newReference: references,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return {
    transfer,
    input: { sessionCookie: "synthetic", csrf: "synthetic", command },
    tx,
    allowed,
    authorize,
    references,
    rolledBack: () => rolledBack,
  };
}
beforeEach(() => vi.clearAllMocks());
it("derives scoped actor/time and requires current employee permission", async () => {
  const f = setup();
  const result = await f.transfer(f.input);
  expect(m.resolve).toHaveBeenCalledWith(f.tx, "synthetic", "dining.host.transfer", id(1));
  expect(m.transfer).toHaveBeenCalledWith({
    ...f.input.command,
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    actorType: "Staff",
    actorReference: id(5),
    purposeCode: "TransferDiningHost",
    permissionCode: "dining.host.transfer",
    reasonCode: "STAFF_HOST_TRANSFER",
    observedAt: at,
  });
  expect(result).toEqual({
    status: "Applied",
    operationReference: id(6),
    diningSessionReference: id(7),
    previousHostParticipantReference: id(8),
    hostParticipantReference: id(10),
    sessionVersion: 4,
    transferredAt: at,
  });
  const runner = m.runner as { run(work: (tx: unknown) => Promise<unknown>): Promise<unknown> };
  expect(await runner.run(async (tx) => tx)).toBe(f.tx);
});
it.each([
  { actorReference: id(99) },
  { tenantReference: id(99) },
  { observedAt: at },
  { reasonCode: "INJECTED" },
])("rejects injected authority %j", async (extra) => {
  const f = setup();
  await expect(
    f.transfer({ ...f.input, command: { ...f.input.command, ...extra } }),
  ).rejects.toThrow("DINING_HOST_TRANSFER_UNAVAILABLE");
  expect(m.transfer).not.toHaveBeenCalled();
});
it("does not access owner store when permission denied", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.transfer(f.input)).rejects.toThrow();
  expect(m.transfer).not.toHaveBeenCalled();
  expect(f.rolledBack()).toBe(true);
});
it("rolls back after authority loss at final check", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.transfer(f.input)).rejects.toThrow();
  expect(f.rolledBack()).toBe(true);
});
it("preserves original retry receipt time without exposing private context", async () => {
  const f = setup();
  m.transfer.mockImplementation(async (c) => ({
    status: "AlreadyApplied",
    record: {
      command: { ...c, observedAt: "2026-09-21T03:40:00.000Z" },
      previousSession: { hostParticipantReference: id(8) },
      session: { diningSessionReference: id(7), hostParticipantReference: id(10), version: 4 },
    },
  }));
  const result = await f.transfer(f.input);
  expect(result.status).toBe("AlreadyApplied");
  expect(result.transferredAt).toBe("2026-09-21T03:40:00.000Z");
  expect(result).not.toHaveProperty("actorReference");
  expect(f.references).not.toHaveBeenCalled();
});
