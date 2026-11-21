import { beforeEach, expect, it, vi } from "vitest";
import { ReconciliationFollowUpError } from "@rms/payment";
const d = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
import { createMerchantReconciliationFollowUpTransactions } from "./merchant-reconciliation-follow-up-transactions.js";
type Options = Parameters<typeof createMerchantReconciliationFollowUpTransactions>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
async function fixture() {
  const state = { tenant: id(1), brand: id(2), store: id(3), actor: id(4), allowed: true };
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: state.tenant },
    context: { brand: { brandReference: state.brand } },
    store: { storeReference: state.store },
    actorReference: state.actor,
    sessionReference: id(5),
    allowed: async () => state.allowed,
  }));
  const verifyAssignee = vi.fn(async () => true);
  const options = {
    persistence: {
      transactions: { run: async (work: (t: object) => Promise<unknown>) => work({}) },
    } as unknown as Options["persistence"],
    sessionCookie: "synthetic-cookie",
    sessionReference: id(5),
    exceptionReference: id(6),
    verifyAssignee,
  };
  const bridge = await createMerchantReconciliationFollowUpTransactions(options);
  const command = {
    ...bridge.scope,
    exceptionReference: id(6),
    actorReference: id(4),
    action: "Acknowledge" as const,
    assigneeReference: null,
  };
  return { state, verifyAssignee, bridge, command };
}
it("rechecks current exception authority and binds actor without requiring an Order", async () => {
  const f = await fixture();
  await f.bridge.transactions.run(async (tx) =>
    expect(await f.bridge.authorize(tx, f.command, "OperatePaymentReconciliation")).toBe(true),
  );
  expect(
    d.scope.mock.calls.every((c) => c[2] === "operations.order-exception.manage" && c[3] === id(5)),
  ).toBe(true);
  expect(f.verifyAssignee).not.toHaveBeenCalled();
});
it.each(["tenant", "brand", "store", "actor"])(
  "rejects changed %s selection before transaction work",
  async (field) => {
    const f = await fixture();
    f.state[field as "tenant" | "brand" | "store" | "actor"] = id(99);
    const work = vi.fn();
    await expect(f.bridge.transactions.run(work)).rejects.toThrow(ReconciliationFollowUpError);
    expect(work).not.toHaveBeenCalled();
  },
);
it("requires verified active assignee and does not allow a client actor substitution", async () => {
  const f = await fixture();
  await f.bridge.transactions.run(async (tx) => {
    expect(
      await f.bridge.authorize(
        tx,
        { ...f.command, actorReference: id(99) },
        "OperatePaymentReconciliation",
      ),
    ).toBe(false);
    const assignment = { ...f.command, action: "Assign" as const, assigneeReference: id(8) };
    f.verifyAssignee.mockResolvedValue(false);
    expect(await f.bridge.authorize(tx, assignment, "OperatePaymentReconciliation")).toBe(false);
    f.verifyAssignee.mockResolvedValue(true);
    expect(await f.bridge.authorize(tx, assignment, "OperatePaymentReconciliation")).toBe(true);
  });
  expect(f.verifyAssignee).toHaveBeenCalledWith(expect.anything(), {
    ...f.bridge.scope,
    actorReference: id(4),
    assigneeReference: id(8),
  });
});
it("rejects revoked authority before commit", async () => {
  const f = await fixture();
  await expect(
    f.bridge.transactions.run(async () => {
      f.state.allowed = false;
    }),
  ).rejects.toThrow(ReconciliationFollowUpError);
});
it("WP-2423: a run resolves the caller in full at its start and before its commit only", async () => {
  const f = await fixture();
  const allowed = vi.fn(async () => true);
  d.scope.mockClear();
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: f.state.tenant },
    context: { brand: { brandReference: f.state.brand } },
    store: { storeReference: f.state.store },
    actorReference: f.state.actor,
    sessionReference: id(5),
    allowed,
  }));
  const during: boolean[] = [];
  let ran: object | null = null;
  await f.bridge.transactions.run(async (tx) => {
    ran = tx;
    for (let i = 0; i < 5; i += 1)
      during.push(await f.bridge.authorize(tx, f.command, "OperatePaymentReconciliation"));
    during.push(await (await f.bridge.resolveAuthority(tx)).authorize());
    // Another transaction is not this run's.
    await expect(f.bridge.resolveAuthority({ query: vi.fn() })).rejects.toThrow(
      ReconciliationFollowUpError,
    );
  });
  expect(during).toEqual([true, true, true, true, true, true]);
  // One scope resolution and two permission checks for the run (the bound read is separate).
  expect(d.scope).toHaveBeenCalledOnce();
  expect(allowed).toHaveBeenCalledTimes(2);
  // The run has ended: its owner callbacks are refused.
  await expect(
    f.bridge.authorize(ran as never, f.command, "OperatePaymentReconciliation"),
  ).rejects.toThrow(ReconciliationFollowUpError);
});
it("WP-2423: a permission withdrawn during a run refuses it inside the transaction", async () => {
  const f = await fixture();
  let rolledBack: unknown = null;
  const options = {
    persistence: {
      transactions: {
        run: async (work: (t: object) => Promise<unknown>) =>
          work({}).catch((error: unknown) => {
            rolledBack = error;
            throw error;
          }),
      },
    },
    sessionCookie: "synthetic-cookie",
    sessionReference: id(5),
    exceptionReference: id(6),
    verifyAssignee: f.verifyAssignee,
  } as unknown as Options;
  const bridge = await createMerchantReconciliationFollowUpTransactions(options);
  const work = vi.fn(async () => {
    f.state.allowed = false;
    return "written";
  });
  await expect(bridge.transactions.run(work)).rejects.toMatchObject({
    code: "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED",
  });
  expect(work).toHaveBeenCalledOnce();
  expect(rolledBack).toBeInstanceOf(ReconciliationFollowUpError);
});
