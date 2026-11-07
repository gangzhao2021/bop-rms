import { describe, expect, it, vi } from "vitest";
import { createManualOutboxRecoveryStore } from "../infrastructure/messaging/manual-outbox-recovery-store.js";
import type { ConsumerTransaction } from "../contracts/consumer-inbox.js";
const id = (n: number) => `0190fab3-0000-7000-8000-${String(n).padStart(12, "0")}`;
const command = {
  deadLetterId: id(1),
  brandId: id(2),
  storeId: id(3),
  actorId: id(4),
  actionId: id(5),
  idempotencyKey: id(6),
  permission: "EVENTING_DEAD_LETTER_RETRY",
  purpose: "RELIABILITY_RECOVERY",
  reason: "DEPENDENCY_RECOVERED",
  expectedVersion: 2n,
};
function fixture(allowed = true) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const transaction = { query } as ConsumerTransaction;
  const run = vi.fn();
  const authorizeAndFence = vi.fn(async () => allowed);
  return {
    query,
    run,
    authorizeAndFence,
    store: createManualOutboxRecoveryStore({
      scope: { brandId: id(2), storeId: id(3) },
      registryDigest: "sha256:" + "a".repeat(64),
      transactions: {
        run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => {
          run();
          return work(transaction);
        },
      },
      authorizeAndFence,
      generateReference: () => id(8),
      now: () => "2026-09-20T14:00:00.000Z",
    }),
  };
}
describe("manual recovery scheduling boundary", () => {
  it("rejects foreign scope before opening a transaction", async () => {
    const f = fixture();
    await expect(f.store.schedule({ ...command, storeId: id(99) })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects extra fields and accessor intent before invoking authority", async () => {
    const f = fixture();
    await expect(f.store.schedule({ ...command, clearance: true })).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    const input = { ...command };
    Object.defineProperty(input, "actorId", {
      get: () => {
        throw new Error("getter invoked");
      },
    });
    await expect(f.store.schedule(input)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("requires current authority before reading replay receipts", async () => {
    const f = fixture(false);
    await expect(f.store.schedule(command)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.authorizeAndFence).toHaveBeenCalledTimes(1);
  });
  it("bounds database exceptions without echoing source details", async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error("private database error"));
    await expect(f.store.schedule(command)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Manual Outbox recovery could not be scheduled.",
    });
  });
  it("fails a missing target without writing an intent", async () => {
    const f = fixture();
    await expect(f.store.schedule(command)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.query.mock.calls.some((call) => String(call[0]).startsWith("INSERT"))).toBe(false);
  });
});
