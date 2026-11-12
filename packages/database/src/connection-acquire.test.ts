import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  acquireTenantConnection,
  isTransientConnectionAcquireFailure,
  endRequestAcquireBudget,
  noteRequestCommittedWrite,
  remainingRequestAcquireBudgetMs,
  runWithRequestAcquireBudget,
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

describe("WP-2423 (outage-reads-and-retry) one waiting budget per request", () => {
  it("a request's later transactions wait only what is left, so it answers within 15 s", async () => {
    vi.useFakeTimers();
    try {
      // Every connection is busy: each acquire waits in the pool's queue until its time runs out.
      const connect = vi.fn(() => new Promise<PoolClient>(() => undefined));
      const started = Date.now();
      const outcome = runWithRequestAcquireBudget(10_000, async () => {
        const failures: number[] = [];
        for (let read = 0; read < 3; read++) {
          await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).catch(
            (error: { code?: string }) => {
              expect(error.code).toBe("TENANT_DATABASE_ACQUIRE_FAILED");
              failures.push(Date.now() - started);
            },
          );
        }
        return failures;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // Before: three reads of 10 s each (30 s). Now the first spends the request's 10 s and the
      // next two answer "busy" at once, without queueing again.
      expect(await outcome).toEqual([10_000, 10_000, 10_000]);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only waiting is counted: connections that come at once never spend the budget", async () => {
    const ready = client();
    const connect = vi.fn(async () => ready);
    await runWithRequestAcquireBudget(50, async () => {
      for (let step = 0; step < 40; step++)
        await expect(acquireTenantConnection({ connect }, { budgetMs: 2000 })).resolves.toBe(ready);
      expect(remainingRequestAcquireBudgetMs()).toBeGreaterThan(0);
    });
    // Outside a request each acquire keeps its own budget.
    expect(remainingRequestAcquireBudgetMs()).toBeUndefined();
  });
});

describe("WP-2423 outage-reads-and-retry review: the budget never stops a command half way", () => {
  /** Every connection busy; the time each acquire waited before it answered "busy". */
  const waits = async (steps: (() => void)[]) => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(() => new Promise<PoolClient>(() => undefined));
      const outcome = runWithRequestAcquireBudget(10_000, async () => {
        const waited: number[] = [];
        for (const step of steps) {
          step();
          const started = Date.now();
          await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).catch(() =>
            waited.push(Date.now() - started),
          );
        }
        return waited;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  };
  it("after a transaction of the request committed a write, later ones wait their full budget", async () => {
    // Without a write the second answers "busy" at once; after one it waits its own 10 s, so a
    // command that began changing things finishes slowly instead of stopping half done.
    expect(await waits([() => undefined, () => undefined])).toEqual([10_000, 0]);
    expect(await waits([() => undefined, noteRequestCommittedWrite])).toEqual([10_000, 10_000]);
  });
  it("work still running after the answer was sent, or past the 15 s clients wait, is not bounded", async () => {
    expect(await waits([() => undefined, endRequestAcquireBudget])).toEqual([10_000, 10_000]);
    // A stream's revalidation timer 15 s after its request began: its own budget, never "busy".
    expect(await waits([() => undefined, () => vi.advanceTimersByTime(5_000)])).toEqual([
      10_000, 10_000,
    ]);
  });
});

describe("WP-2423 guest-table-open-and-busy-reads: a read answers within its time", () => {
  it("a read takes no further connection once its whole work time is spent, a command still does", async () => {
    vi.useFakeTimers();
    try {
      const ready = client();
      // Connections come at once (no waiting), but each step's work takes 4 s.
      const connect = vi.fn(async () => ready);
      const reads = async () => {
        const outcomes: string[] = [];
        for (let step = 0; step < 4; step++) {
          outcomes.push(
            await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).then(
              () => "connection",
              (error: { code?: string }) => String(error.code),
            ),
          );
          await vi.advanceTimersByTimeAsync(4_000);
        }
        return outcomes;
      };
      // Before: only waiting counted, so the read went on working to 16 s, past the 15 s the
      // phone waits. Now after 12 s in all it answers "busy" at once.
      expect(await runWithRequestAcquireBudget(10_000, reads, { answerWithinMs: 12_000 })).toEqual([
        "connection",
        "connection",
        "connection",
        "TENANT_DATABASE_ACQUIRE_FAILED",
      ]);
      // A command has no answer time: its work is never cut by the clock.
      expect(await runWithRequestAcquireBudget(10_000, reads)).toEqual([
        "connection",
        "connection",
        "connection",
        "connection",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read's wait for a connection ends when its answer time does, not after its whole budget", async () => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(() => new Promise<PoolClient>(() => undefined));
      const outcome = runWithRequestAcquireBudget(
        10_000,
        async () => {
          await vi.advanceTimersByTimeAsync(9_000);
          const started = Date.now();
          await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).catch(() => undefined);
          return Date.now() - started;
        },
        { answerWithinMs: 12_000 },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      // 9 s of work done, 3 s of the read's time left: it waits 3 s, not its 10 s budget.
      expect(await outcome).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
