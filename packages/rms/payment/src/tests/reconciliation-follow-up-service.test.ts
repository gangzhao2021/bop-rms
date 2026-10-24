import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createReconciliationFollowUpService,
  type ReconciliationFollowUpTransition,
  type ReconciliationFollowUpPorts,
} from "../application/reconciliation-follow-up-service.js";
const id = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  exceptionReference: id(4),
};
const now = "2026-09-20T10:01:00.000Z";
const current = {
  ...scope,
  version: 1,
  status: "Open",
  acknowledgedByReference: null,
  ownerReference: null,
  openedAt: now,
  updatedAt: now,
};
const command = {
  ...scope,
  expectedVersion: 1,
  operationReference: id(5),
  actorReference: id(6),
  action: "Acknowledge",
  assigneeReference: null,
  occurredAt: now,
};
function fixture() {
  let stored: ReconciliationFollowUpTransition | null = null;
  const tx = {} as ConsumerTransaction;
  const ports: ReconciliationFollowUpPorts = {
    now: () => now,
    transactions: {
      run: async (work) => {
        const before = stored;
        try {
          return await work(tx);
        } catch (e) {
          stored = before;
          throw e;
        }
      },
    },
    authorize: vi.fn(async () => true),
    records: {
      lock: vi.fn(async () => undefined),
      findOperation: vi.fn(async () => stored),
      readCurrent: vi.fn(async () => current),
      append: vi.fn(async (t, row) => {
        expect(t).toBe(tx);
        stored = row;
      }),
    },
    audit: {
      append: vi.fn(async (t) => {
        expect(t).toBe(tx);
      }),
    },
  };
  return { ports, service: createReconciliationFollowUpService(ports), stored: () => stored };
}
it("records one transition and Audit, replays without another append", async () => {
  const f = fixture();
  expect((await f.service.execute(command)).status).toBe("Created");
  expect((await f.service.execute(command)).status).toBe("Duplicate");
  expect(f.ports.records.append).toHaveBeenCalledOnce();
  expect(f.ports.audit.append).toHaveBeenCalledOnce();
  expect(f.ports.records.readCurrent).toHaveBeenCalledOnce();
});
it("rejects operation-key reuse with a different actor", async () => {
  const f = fixture();
  await f.service.execute(command);
  await expect(f.service.execute({ ...command, actorReference: id(8) })).rejects.toThrow(
    "CONFLICT",
  );
  expect(f.ports.audit.append).toHaveBeenCalledOnce();
});
it("checks current authorization even for replay", async () => {
  const f = fixture();
  await f.service.execute(command);
  vi.mocked(f.ports.authorize).mockResolvedValue(false);
  await expect(f.service.execute(command)).rejects.toThrow("PERMISSION_DENIED");
  expect(f.ports.records.append).toHaveBeenCalledOnce();
});
it("rejects future time before any owner transaction", async () => {
  const f = fixture();
  await expect(
    f.service.execute({ ...command, occurredAt: "2026-09-20T10:02:00.000Z" }),
  ).rejects.toThrow("CONFLICT");
  expect(f.ports.records.lock).not.toHaveBeenCalled();
});
it.each(["audit", "revoked"])("propagates %s failure so transaction rolls back", async (mode) => {
  const f = fixture();
  if (mode === "audit")
    vi.mocked(f.ports.audit.append).mockRejectedValue(new Error("private detail"));
  else
    vi.mocked(f.ports.audit.append).mockImplementation(async () => {
      vi.mocked(f.ports.authorize).mockResolvedValue(false);
    });
  await expect(f.service.execute(command)).rejects.toThrow(
    mode === "audit" ? "UNAVAILABLE" : "PERMISSION_DENIED",
  );
  expect(f.stored()).toBeNull();
});
it("rejects corrupt stored replay outcome", async () => {
  const f = fixture();
  await f.service.execute(command);
  const saved = f.stored();
  if (!saved) throw Error("Expected committed fixture transition");
  vi.mocked(f.ports.records.findOperation).mockResolvedValue({
    ...saved,
    after: { ...saved.after, version: 99 },
  });
  await expect(f.service.execute(command)).rejects.toThrow("CONFLICT");
});
