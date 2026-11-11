import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  acquireTenantConnection,
  isTransientConnectionAcquireFailure,
} from "./connection-acquire.js";
import { createTenantTransactionRunner } from "./transaction-runner.js";

const scope = { brandId: "018f3f7a-8b1c-7a11-8d01-000000000041" };
const tooMany = () =>
  Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
const poolTimeout = () => new Error("timeout exceeded when trying to connect");
const badPassword = () =>
  Object.assign(new Error('password authentication failed for user "x"'), { code: "28P01" });

/** A fake clock: sleeping moves it on, so the budget is spent exactly as in production. */
function clock() {
  let at = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
    sleep: async (ms: number) => {
      pauses.push(ms);
      at += ms;
    },
  };
}
function client() {
  return { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() } as unknown as PoolClient;
}

describe("WP-2423 M68 (a) bounded retry when no connection is free", () => {
  it("retries a brief exhaustion with jittered pauses and returns the connection", async () => {
    const c = clock();
    const ready = client();
    const connect = vi
      .fn<() => Promise<PoolClient>>()
      .mockRejectedValueOnce(tooMany())
      .mockRejectedValueOnce(tooMany())
      .mockResolvedValueOnce(ready);
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    await expect(
      acquireTenantConnection({ connect }, { budgetMs: 5000, now: c.now, sleep: c.sleep, random }),
    ).resolves.toBe(ready);
    expect(connect).toHaveBeenCalledTimes(3);
    // 50 ms × 0.5, then 100 ms × ~1.5: small, growing and never all phones at once.
    expect(c.pauses).toEqual([25, 150]);
  });

  it("keeps retrying until the request's acquire budget is spent, then answers the outage", async () => {
    const c = clock();
    const connect = vi.fn<() => Promise<PoolClient>>().mockRejectedValue(tooMany());
    await expect(
      acquireTenantConnection(
        { connect },
        { budgetMs: 5000, now: c.now, sleep: c.sleep, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({
      code: "TENANT_DATABASE_ACQUIRE_FAILED",
      diagnostic: { sqlState: "53300" },
    });
    // Doubling pauses capped at 800 ms, for as long as the budget leaves room for a try.
    expect(c.pauses.slice(0, 6)).toEqual([50, 100, 200, 400, 800, 800]);
    expect(connect.mock.calls.length).toBeGreaterThan(4);
    expect(c.now()).toBeLessThanOrEqual(5000 - 100);
  });

  it("does not retry what waiting cannot fix", async () => {
    const c = clock();
    const connect = vi.fn<() => Promise<PoolClient>>().mockRejectedValue(badPassword());
    await expect(
      acquireTenantConnection({ connect }, { budgetMs: 5000, now: c.now, sleep: c.sleep }),
    ).rejects.toMatchObject({ code: "TENANT_DATABASE_ACQUIRE_FAILED" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(c.pauses).toEqual([]);
  });

  it("keeps every attempt inside the request's acquire budget", async () => {
    const c = clock();
    // The pool's own queue wait used the whole budget: there is no time left for a retry.
    const connect = vi.fn<() => Promise<PoolClient>>(async () => {
      c.advance(4950);
      throw poolTimeout();
    });
    await expect(
      acquireTenantConnection({ connect }, { budgetMs: 5000, now: c.now, sleep: c.sleep }),
    ).rejects.toMatchObject({ code: "TENANT_DATABASE_ACQUIRE_FAILED" });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a full pool: short queue waits are retried until a connection frees up", async () => {
    const c = clock();
    const ready = client();
    // Every connection in this process is busy: each attempt waits the pool's 2 s, then the
    // fourth finds one free, well inside the entry's 10 s budget.
    let attempts = 0;
    const connect = vi.fn<() => Promise<PoolClient>>(async () => {
      attempts += 1;
      if (attempts === 4) return ready;
      c.advance(2000);
      throw poolTimeout();
    });
    await expect(
      acquireTenantConnection(
        { connect },
        { budgetMs: 10_000, now: c.now, sleep: c.sleep, random: () => 0.5 },
      ),
    ).resolves.toBe(ready);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(c.pauses).toEqual([50, 100, 200]);
  });

  it("gives back a connection that arrives after the budget ran out", async () => {
    vi.useFakeTimers();
    try {
      const late = client();
      let deliver: (value: PoolClient) => void = () => undefined;
      const connect = vi.fn(
        () =>
          new Promise<PoolClient>((resolve) => {
            deliver = resolve;
          }),
      );
      const acquired = acquireTenantConnection({ connect }, { budgetMs: 200 });
      const outcome = expect(acquired).rejects.toMatchObject({
        code: "TENANT_DATABASE_ACQUIRE_FAILED",
      });
      await vi.advanceTimersByTimeAsync(200);
      await outcome;
      deliver(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies only passing failures as retryable", () => {
    expect(isTransientConnectionAcquireFailure(tooMany())).toBe(true);
    expect(isTransientConnectionAcquireFailure(poolTimeout())).toBe(true);
    expect(isTransientConnectionAcquireFailure({ code: "57P03" })).toBe(true);
    expect(isTransientConnectionAcquireFailure({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientConnectionAcquireFailure(badPassword())).toBe(false);
    expect(isTransientConnectionAcquireFailure({ code: "3D000" })).toBe(false);
    expect(isTransientConnectionAcquireFailure(new Error("other"))).toBe(false);
  });

  it("a request's transaction runs after a brief exhaustion instead of failing", async () => {
    const ready = client();
    const connect = vi
      .fn<() => Promise<PoolClient>>()
      .mockRejectedValueOnce(tooMany())
      .mockResolvedValueOnce(ready);
    const runner = createTenantTransactionRunner(
      { connect, options: { connectionTimeoutMillis: 5000, query_timeout: 5000 } },
      scope,
    );
    await expect(runner.run(async () => "ordered")).resolves.toBe("ordered");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ready.release).toHaveBeenCalledWith(false);
  });

  it("a request's transaction waits past one pool wait for a full pool, within its budget", async () => {
    vi.useFakeTimers();
    try {
      const ready = client();
      let attempts = 0;
      // Every pooled connection is busy for 5 s: the pool's 2 s queue wait runs out twice.
      const connect = vi.fn(
        () =>
          new Promise<PoolClient>((resolve, reject) => {
            attempts += 1;
            if (attempts >= 3) {
              resolve(ready);
              return;
            }
            setTimeout(() => reject(poolTimeout()), 2000);
          }),
      );
      const runner = createTenantTransactionRunner(
        { connect, options: { connectionTimeoutMillis: 2000, query_timeout: 5000 } },
        scope,
        { acquireBudgetMs: 10_000 },
      );
      const ran = runner.run(async () => "ordered");
      await vi.advanceTimersByTimeAsync(6000);
      await expect(ran).resolves.toBe("ordered");
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an acquire budget shorter than one pool wait or past the clients' 15 s", () => {
    const pool = {
      connect: vi.fn(),
      options: { connectionTimeoutMillis: 2000, query_timeout: 5000 },
    };
    for (const acquireBudgetMs of [1000, 15_001, 2.5])
      expect(() => createTenantTransactionRunner(pool, scope, { acquireBudgetMs })).toThrow(
        expect.objectContaining({ code: "TENANT_DATABASE_SCOPE_INVALID" }),
      );
  });
});
