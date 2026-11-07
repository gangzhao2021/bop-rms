import { describe, expect, it, vi } from "vitest";
import { createAbuseBudgetConsumer } from "./abuse-budget.js";
const hash = () => Buffer.alloc(32, 1);
const policy = { bucketClass: "GUEST_SESSION" as const, windowSeconds: 600, limitCount: 20 };
describe("atomic abuse budget consumer", () => {
  it("uses fixed server-time windows and only a copied keyed hash", async () => {
    let at = "2026-09-19T12:09:59.999Z";
    const query = vi.fn(async () => ({
      rows: [{ allowed: true, remaining: 19, retry_after_seconds: 0 }],
    }));
    const consumer = createAbuseBudgetConsumer({ ...policy, now: () => at, query });
    const original = hash();
    await consumer.consume(original);
    const first = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(first[1]).toEqual(["GUEST_SESSION", original, "2026-09-19T12:00:00.000Z", 600, 20, at]);
    expect(first[1][1]).not.toBe(original);
    at = "2026-09-19T12:10:00.000Z";
    await consumer.consume(original);
    const second = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(second[1][2]).toBe(at);
  });
  it("returns committed denial without retrying or throwing it away", async () => {
    const row = { allowed: false, remaining: 0, retry_after_seconds: 40 };
    const query = vi.fn(async () => ({ rows: [row] }));
    expect(
      await createAbuseBudgetConsumer({
        ...policy,
        now: () => "2026-09-19T12:09:20.000Z",
        query,
      }).consume(hash()),
    ).toEqual(row);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("rejects impossible database results without leaking them", async () => {
    for (const rows of [
      [],
      [{ allowed: true, remaining: 20, retry_after_seconds: 0 }],
      [{ allowed: false, remaining: 1, retry_after_seconds: 1 }],
      [{ allowed: false, remaining: 0, retry_after_seconds: 601 }],
      [{ allowed: true, remaining: 1, retry_after_seconds: 1 }],
      [{ allowed: true, remaining: 1, retry_after_seconds: 0, private: "hidden" }],
    ]) {
      const consumer = createAbuseBudgetConsumer({
        ...policy,
        now: () => "2026-09-19T12:00:00.000Z",
        query: async () => ({ rows }),
      });
      await expect(consumer.consume(hash())).rejects.toThrow("ABUSE_BUDGET_UNAVAILABLE");
    }
  });
  it("sanitizes database failures with no retained private cause", async () => {
    const consumer = createAbuseBudgetConsumer({
      ...policy,
      now: () => "2026-09-19T12:00:00.000Z",
      query: async () => {
        throw new Error("private connection detail");
      },
    });
    const error = await consumer.consume(hash()).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "ABUSE_BUDGET_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
  });
  it("rejects invalid clock and hash before querying", async () => {
    const query = vi.fn();
    for (const at of ["invalid", "2026-09-19T12:00:00Z"]) {
      await expect(
        createAbuseBudgetConsumer({ ...policy, now: () => at, query }).consume(hash()),
      ).rejects.toThrow("ABUSE_BUDGET_UNAVAILABLE");
    }
    await expect(
      createAbuseBudgetConsumer({
        ...policy,
        now: () => "2026-09-19T12:00:00.000Z",
        query,
      }).consume(new Uint8Array(31)),
    ).rejects.toThrow("ABUSE_BUDGET_UNAVAILABLE");
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects unsupported and unbounded policies", () => {
    const base = { ...policy, now: () => "", query: vi.fn() };
    for (const options of [
      { ...base, windowSeconds: 0 },
      { ...base, windowSeconds: 86401 },
      { ...base, limitCount: 0 },
      { ...base, limitCount: 2147483648 },
      { ...base, bucketClass: "UNKNOWN" as "GUEST_SESSION" },
    ])
      expect(() => createAbuseBudgetConsumer(options)).toThrow("ABUSE_BUDGET_UNAVAILABLE");
  });
});
