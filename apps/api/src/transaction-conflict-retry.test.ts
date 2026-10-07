import { describe, expect, it, vi } from "vitest";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

const conflict = () =>
  Object.assign(new Error("conflict"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
describe("WP-2423 transaction conflict retry", () => {
  it("reruns only conflicted transactions, with bounded backoff", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    let calls = 0;
    const result = await retryTransactionConflict(
      async () => {
        calls += 1;
        if (calls < 3) throw conflict();
        return "done";
      },
      { sleep, random: () => 0.5 },
    );
    expect(result).toBe("done");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([150, 300]);
  });
  it("gives up after the attempt limit and never retries other failures", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    await expect(
      retryTransactionConflict(async () => Promise.reject(conflict()), { sleep, attempts: 3 }),
    ).rejects.toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
    expect(sleep).toHaveBeenCalledTimes(2);
    const work = vi.fn(async () => Promise.reject(new Error("PermissionDenied")));
    await expect(retryTransactionConflict(work, { sleep })).rejects.toThrow("PermissionDenied");
    expect(work).toHaveBeenCalledTimes(1);
  });
});
