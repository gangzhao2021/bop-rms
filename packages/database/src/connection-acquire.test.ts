import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  acquireTenantConnection,
  isTransientConnectionAcquireFailure,
  endRequestAcquireBudget,
  noteTenantDatabaseAnswered,
  noteRequestCommittedWrite,
  remainingRequestAcquireBudgetMs,
  runWithRequestAcquireBudget,
  watchTenantConnectionPool,
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

describe("WP-2423 reads-under-burst: the rush is told apart from a fault, and a cut read stops", () => {
  const budget = () =>
    (globalThis as Record<symbol, { getStore(): { shed?: boolean; cut?: boolean } | undefined }>)[
      Symbol.for("bop.database.request-acquire-budget")
    ]?.getStore();
  /**
   * A pg pool's public face: `max`, its clients (open or still opening) and the `acquire` and
   * `release` events of the clients it hands out. `handedOut` clients are out with other work.
   */
  const pool = (
    connect: () => Promise<PoolClient>,
    shape: { max: number; total: number; handedOut: number },
  ) => {
    const events = new EventEmitter();
    let started = false;
    return Object.assign(events, {
      options: { max: shape.max },
      totalCount: shape.total,
      connect: vi.fn(() => {
        // The other work took its clients before this request asked (after the pool is watched).
        if (!started) for (let i = 0; i < shape.handedOut; i += 1) events.emit("acquire");
        started = true;
        return connect();
      }),
    });
  };
  const outcome = async (
    target: Parameters<typeof acquireTenantConnection>[0],
    budgetMs = 1_000,
  ) => {
    const run = runWithRequestAcquireBudget(budgetMs, async () => {
      await acquireTenantConnection(target, { budgetMs }).catch(() => undefined);
      const store = budget() as { shed?: boolean; faulted?: boolean } | undefined;
      return { shed: store?.shed === true, faulted: store?.faulted === true };
    });
    await vi.advanceTimersByTimeAsync(2_000);
    return run;
  };
  const hang = () => new Promise<PoolClient>(() => undefined);
  const fails = (error: () => Error) => async (): Promise<PoolClient> => {
    throw error();
  };
  it("notes the rush only when the pool was full of other work, or the server had too many connections", async () => {
    vi.useFakeTimers();
    try {
      const full = { max: 2, total: 2, handedOut: 2 };
      // Every connection out with other work until the wait ran out: the rush.
      expect(await outcome(pool(hang, full))).toEqual({ shed: true, faulted: false });
      // The pool's own queue wait ran out while it was full of work: the rush.
      expect(await outcome(pool(fails(poolTimeout), full), 300)).toEqual({
        shed: true,
        faulted: false,
      });
      // The server has too many connections (53300): the rush.
      expect(await outcome(pool(fails(tooMany), { max: 2, total: 0, handedOut: 0 }), 300)).toEqual({
        shed: true,
        faulted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a database that refuses, hangs or cannot be reached a fault, never the rush (b12 review)", async () => {
    vi.useFakeTimers();
    try {
      const fault = { shed: false, faulted: true };
      // A wrong password (28P01).
      expect(await outcome(pool(fails(badPassword), { max: 2, total: 0, handedOut: 0 }))).toEqual(
        fault,
      );
      // A new connection that timed out: pg's own error when the database host hangs or cannot
      // be reached, even with the pool at its limit.
      const connectTimeout = () => new Error("Connection terminated due to connection timeout");
      expect(
        await outcome(pool(fails(connectTimeout), { max: 2, total: 1, handedOut: 1 }), 300),
      ).toEqual(fault);
      expect(
        await outcome(pool(fails(connectTimeout), { max: 2, total: 2, handedOut: 2 }), 300),
      ).toEqual(fault);
      // The pool's queue wait ran out while its connections were still opening (none handed out).
      expect(
        await outcome(pool(fails(poolTimeout), { max: 2, total: 2, handedOut: 0 }), 300),
      ).toEqual(fault);
      // A connect that hangs with an empty or idle pool, until the request's wait ran out.
      expect(await outcome(pool(hang, { max: 2, total: 1, handedOut: 0 }))).toEqual(fault);
      expect(await outcome(pool(hang, { max: 2, total: 0, handedOut: 0 }))).toEqual(fault);
      // A pool with no public face (a test double): unknown, so never the rush.
      expect(await outcome({ connect: vi.fn(hang) })).toEqual(fault);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WP-2423 (rush-reads-and-orders-changes): a wait that ran out while the database was answering other work is the rush", async () => {
    // v15 2026-11-13: in the burst, cart reads that found no connection were logged level 50. A
    // slot freed in the rush was being reopened (its handshake to a database busy with 57 others
    // ran out, or the request's wait ended while it was still opening), so the pool was not "full
    // of work" at that moment, though the database was answering everything else.
    vi.useFakeTimers();
    try {
      const busy = (connect: () => Promise<PoolClient>, answeredAgoMs: number, healthy = true) => {
        const target = pool(connect, { max: 2, total: 2, handedOut: 0 });
        watchTenantConnectionPool(target);
        // Other work came back answered (or failed) a moment ago; one client is still out with
        // work and the other slot is opening again.
        target.emit("acquire");
        target.emit("release", healthy ? false : new Error("lost"));
        target.emit("acquire");
        target.emit("release", healthy ? undefined : new Error("lost"));
        target.emit("acquire");
        vi.advanceTimersByTime(answeredAgoMs);
        return target;
      };
      const connectTimeout = () => new Error("Connection terminated due to connection timeout");
      const rush = { shed: true, faulted: false };
      const fault = { shed: false, faulted: true };
      // The new connection's handshake ran out while the database answered other work.
      expect(await outcome(busy(fails(connectTimeout), 1_000), 300)).toEqual(rush);
      // The request's wait ended while that slot was still opening.
      expect(await outcome(busy(hang, 1_000))).toEqual(rush);
      // The pool's own queue wait ran out with one slot opening again.
      expect(await outcome(busy(fails(poolTimeout), 1_000), 300)).toEqual(rush);
      // Nothing answered for longer than the window (the database hung or went away): a fault.
      expect(await outcome(busy(fails(connectTimeout), 6_000), 300)).toEqual(fault);
      expect(await outcome(busy(hang, 6_000))).toEqual(fault);
      // Work that came back failed is no sign of an answering database.
      expect(await outcome(busy(fails(connectTimeout), 1_000, false), 300)).toEqual(fault);
      // A refusal stays a fault however busy the database is.
      expect(await outcome(busy(fails(badPassword), 1_000), 300)).toEqual(fault);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WP-2423 (rush-reads-and-orders-changes review): when the database last answered is read on the runner's own clock", async () => {
    // Review: the answering window compared Date.now() although the runner injects its `now`.
    const connectTimeout = () => new Error("Connection terminated due to connection timeout");
    const at = async (clock: number, answeredAt: number) => {
      const target = pool(fails(connectTimeout), { max: 2, total: 2, handedOut: 0 });
      let now = answeredAt;
      // The pool is first watched by the runner, so its answers are timed on that clock.
      const first = runWithRequestAcquireBudget(1_000, () =>
        acquireTenantConnection(target, { budgetMs: 100, now: () => now }).catch(() => undefined),
      );
      await first;
      target.emit("acquire");
      target.emit("release", undefined);
      target.emit("acquire");
      now = clock;
      return runWithRequestAcquireBudget(1_000, async () => {
        await acquireTenantConnection(target, { budgetMs: 100, now: () => now }).catch(
          () => undefined,
        );
        const store = budget() as { shed?: boolean; faulted?: boolean } | undefined;
        return { shed: store?.shed === true, faulted: store?.faulted === true };
      });
    };
    // Answered 1 s before on the runner's clock (whatever the wall clock says): the rush.
    expect(await at(5_000_000, 4_999_000)).toEqual({ shed: true, faulted: false });
    // Nothing answered for 6 s on that clock: a fault.
    expect(await at(5_000_000, 4_994_000)).toEqual({ shed: false, faulted: true });
  });

  it("WP-2423 (rush-logging-and-entry): a pool that got nothing back for ten seconds is the rush while the database answers the heartbeat", async () => {
    // v15 2026-11-13, three bursts: every guest cart read of the API's pool waited its whole 10 s
    // and failed at the same moment (TENANT_DATABASE_ACQUIRE_FAILED under GUEST_SESSION_UNAVAILABLE
    // or GUEST_BINDING_SOURCE_UNAVAILABLE), the pool's last answer 10 s old and its slots opening
    // again, while the entry's staff reads on the same database were answered throughout. All
    // were logged level 50: the pool alone could not tell the rush from a database that hangs.
    vi.useFakeTimers();
    try {
      const connectTimeout = () => new Error("Connection terminated due to connection timeout");
      const silent = (connect: () => Promise<PoolClient>, heartbeatAgoMs: number | null) => {
        const target = pool(connect, { max: 2, total: 2, handedOut: 1 });
        watchTenantConnectionPool(target);
        // The pool's last answer, long before this request's wait ran out.
        target.emit("acquire");
        target.emit("release", undefined);
        vi.advanceTimersByTime(10_000);
        if (heartbeatAgoMs !== null) {
          noteTenantDatabaseAnswered(target);
          vi.advanceTimersByTime(heartbeatAgoMs);
        }
        return target;
      };
      const rush = { shed: true, faulted: false };
      const fault = { shed: false, faulted: true };
      // The database answered the heartbeat a moment ago: each way the wait ran out is the rush.
      expect(await outcome(silent(fails(connectTimeout), 1_000), 300)).toEqual(rush);
      expect(await outcome(silent(hang, 1_000))).toEqual(rush);
      expect(await outcome(silent(fails(poolTimeout), 1_000), 300)).toEqual(rush);
      // No heartbeat runs, or none answered within the window (the database hung or went away).
      expect(await outcome(silent(fails(connectTimeout), null), 300)).toEqual(fault);
      expect(await outcome(silent(hang, 6_000))).toEqual(fault);
      expect(await outcome(silent(fails(poolTimeout), 6_000), 300)).toEqual(fault);
      // A refusal stays a fault whatever the heartbeat says.
      expect(await outcome(silent(fails(badPassword), 1_000), 300)).toEqual(fault);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes no connection for a read already answered or abandoned (cut), even after its answer", async () => {
    const connect = vi.fn(async () => client());
    const outcome = await runWithRequestAcquireBudget(
      10_000,
      async () => {
        const store = budget() as { cut?: boolean; ended?: boolean } | undefined;
        if (store) {
          store.cut = true;
          // The busy answer was sent (the response finished): still cut, never unbounded.
          store.ended = true;
        }
        return acquireTenantConnection({ connect }, { budgetMs: 10_000 }).then(
          () => "connection",
          (error: { code?: string }) => String(error.code),
        );
      },
      { answerWithinMs: 12_000 },
    );
    expect(outcome).toBe("TENANT_DATABASE_ACQUIRE_FAILED");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("WP-2423 reads-under-burst (b12 review): a cut read is not starved for good", () => {
  it("lets what a cut read still runs after the clients' 15 s window take connections again", async () => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(async () => client());
      const store = () =>
        (globalThis as Record<symbol, { getStore(): { cut?: boolean } | undefined }>)[
          Symbol.for("bop.database.request-acquire-budget")
        ]?.getStore();
      const outcome = runWithRequestAcquireBudget(
        10_000,
        async () => {
          const budget = store();
          if (budget) budget.cut = true;
          const inside = await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).then(
            () => "connection",
            (error: { code?: string }) => String(error.code),
          );
          // Work it started (a timer, lazy set-up later requests share) runs on past 15 s.
          await new Promise((resolve) => setTimeout(resolve, 15_001));
          const after = await acquireTenantConnection({ connect }, { budgetMs: 10_000 }).then(
            () => "connection",
            (error: { code?: string }) => String(error.code),
          );
          return { inside, after };
        },
        { answerWithinMs: 12_000 },
      );
      await vi.advanceTimersByTimeAsync(15_100);
      expect(await outcome).toEqual({
        inside: "TENANT_DATABASE_ACQUIRE_FAILED",
        after: "connection",
      });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
