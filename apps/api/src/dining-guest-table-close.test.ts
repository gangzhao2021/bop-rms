import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiningGuestTableClose } from "./dining-guest-table-close.js";

const owner = vi.hoisted(() => ({ page: vi.fn(), started: vi.fn() }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  listOpenDiningGuestStartedSessions: (...args: unknown[]) => owner.page(...args),
  listDiningGuestStartedSessions: (...args: unknown[]) => owner.started(...args),
}));
beforeEach(() => vi.resetAllMocks());
const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const closer = () =>
  createDiningGuestTableClose({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    providerAccountReference: id(4),
    environment: "Test",
    transactions: { run: (work) => work({ query: vi.fn() } as never) },
    authorize: async () => true,
    now: () => "2026-11-05T12:00:00.000Z",
    newReference: () => id(9),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    orderAudit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });

describe("DEC-DINING-GUEST-TABLE-START: the worker's cycle", () => {
  it("tries every table, then fails with the first failure, and the next cycle moves on", async () => {
    owner.page.mockImplementation(
      async (_tx: unknown, _owner: unknown, input: { after: string | null }) =>
        input.after === null ? [id(10), id(11)] : [],
    );
    const first = new Error("DINING_GUEST_TABLE_CLOSE_INVALID");
    owner.started.mockRejectedValueOnce(first).mockRejectedValue(new Error("second"));
    const failures: unknown[] = [];
    const system = closer();
    await expect(
      system.runOnce({ limit: 2, onFailure: (error) => failures.push(error) }),
    ).rejects.toBe(first);
    // Both were tried and both reported; one stuck table keeps no other from its turn.
    expect(owner.started).toHaveBeenCalledTimes(2);
    expect(failures).toHaveLength(2);
    expect(await system.runOnce({ limit: 2 })).toBe(0);
    expect(owner.page.mock.calls[1]?.[2]).toEqual({ after: id(11), limit: 2 });
  });
  it("a table that isn't closable, or that someone else was on just then, is no failure", async () => {
    owner.page.mockResolvedValue([id(10), id(11), id(12), id(13)]);
    // Not one a guest started (any more): held, and quiet.
    owner.started.mockResolvedValueOnce(new Map());
    owner.started.mockRejectedValueOnce(Object.assign(new Error("lock"), { code: "55P03" }));
    owner.started.mockRejectedValueOnce(
      Object.assign(new Error("lost"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" }),
    );
    owner.started.mockRejectedValueOnce(
      Object.assign(new Error("changed"), { code: "DINING_CLOSING_VERSION_CONFLICT" }),
    );
    const failures: unknown[] = [];
    expect(await closer().runOnce({ limit: 10, onFailure: (error) => failures.push(error) })).toBe(
      0,
    );
    expect(failures).toEqual([]);
  });
});
