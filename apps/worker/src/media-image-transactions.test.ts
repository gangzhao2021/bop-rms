import { expect, it, vi } from "vitest";
import {
  createMediaImageWorkerTransactions,
  type MediaImageWorkerConnection,
  type MediaImageWorkerTransaction,
  type MediaImageWorkerTransactionsOptions,
} from "./media-image-transactions.js";

const id = (n: number) => "019a2421-0024-7000-8000-" + n.toString(16).padStart(12, "0"),
  unavailable = expect.objectContaining({ code: "MEDIA_WORKER_TRANSACTION_UNAVAILABLE" }),
  unknown = expect.objectContaining({
    code: "COMMIT_OUTCOME_UNKNOWN",
    message: "MEDIA_WORKER_COMMIT_OUTCOME_UNKNOWN",
  });
function deferred() {
  let resolve: () => void = () => {
    throw Error("Uninitialized test gate");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// Controlled connection only: these tests prove lifecycle ordering, not pool,
// PostgreSQL, IAM, scanner or Media business evidence.
function harness() {
  const events: string[] = [],
    calls: { sql: string; values: readonly unknown[] }[] = [],
    releases: boolean[] = [];
  const state: {
    failSql?: string;
    rollbackFail?: boolean;
    releaseFail?: boolean;
    queryGate?: ReturnType<typeof deferred>;
    malformed?: boolean;
    acquisitions: number;
    queryOnCommit?: () => void;
  } = { acquisitions: 0 };
  const connection: MediaImageWorkerConnection = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      events.push(sql);
      calls.push({ sql, values });
      if (sql === "SELECT DELAYED") {
        await state.queryGate?.promise;
        events.push("delayed-finished");
      }
      if (sql === "COMMIT") state.queryOnCommit?.();
      if (sql === state.failSql || (sql === "ROLLBACK" && state.rollbackFail))
        throw Error("RAW_SYNTHETIC_CONNECTION_DETAIL");
      if (state.malformed && sql === "SELECT BUSINESS")
        return { rows: null } as unknown as { rows: readonly Row[] };
      return {
        rows: (sql === "SELECT BUSINESS" ? [{ value: 7 }] : []) as unknown as readonly Row[],
        rowCount: sql === "SELECT BUSINESS" ? 1 : 0,
      };
    },
    async release(discard) {
      releases.push(discard);
      events.push("release:" + discard);
      if (state.releaseFail) throw Error("RAW_SYNTHETIC_RELEASE_DETAIL");
    },
  };
  const options: MediaImageWorkerTransactionsOptions = {
    acquire: async () => {
      state.acquisitions++;
      return connection;
    },
    tenantReference: id(1),
    scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
  };
  const host = createMediaImageWorkerTransactions(options);
  const register = (tx: MediaImageWorkerTransaction) =>
    host.registerBeforeCommit(
      tx,
      async () => {
        events.push("guard");
      },
      () => {
        events.push("final");
      },
    );
  return { host, options, connection, events, calls, releases, state, register };
}

it("sets actual READ COMMITTED and full scope before work and runs all async guards before consecutive final assertions and COMMIT", async () => {
  const h = harness(),
    receipt = Object.freeze({ operation: id(4) });
  let workCalls = 0;
  const result = await h.host.transactions.run(async (tx) => {
    workCalls++;
    expect(tx).not.toBe(h.connection);
    expect(Object.isFrozen(tx)).toBe(true);
    expect(h.calls[0]).toEqual({ sql: "BEGIN ISOLATION LEVEL READ COMMITTED", values: [] });
    expect(h.calls[1]?.values).toEqual([id(1), id(2), id(3)]);
    expect(h.calls[1]?.sql).toContain("bop.tenant_id");
    expect(await tx.query<{ value: number }>("SELECT BUSINESS", [])).toEqual({
      rows: [{ value: 7 }],
      rowCount: 1,
    });
    await h.host.registerBeforeCommit(
      tx,
      async () => {
        h.events.push("async-one");
        await tx.query("SELECT HELD_AUTHORITY", []);
      },
      () => {
        h.events.push("final-one");
      },
    );
    await h.host.registerBeforeCommit(
      tx,
      async () => {
        h.events.push("async-two");
      },
      () => {
        h.events.push("final-two");
      },
    );
    return receipt;
  });
  expect(result).toBe(receipt);
  expect(workCalls).toBe(1);
  expect(h.state.acquisitions).toBe(1);
  expect(h.events.slice(-7)).toEqual([
    "async-one",
    "SELECT HELD_AUTHORITY",
    "async-two",
    "final-one",
    "final-two",
    "COMMIT",
    "release:false",
  ]);
});

it("captures configuration and acquire method while encoding Brand Store context as empty", async () => {
  const h = harness(),
    options = {
      ...h.options,
      scope: { kind: "Brand" as const, brandReference: id(2), storeReference: null },
    };
  const host = createMediaImageWorkerTransactions(options);
  Object.assign(options.scope, { brandReference: id(99), storeReference: id(3) });
  Object.assign(options, {
    tenantReference: id(98),
    acquire: async () => {
      throw Error("Replaced port");
    },
  });
  await host.transactions.run(async (tx) => {
    await host.registerBeforeCommit(
      tx,
      async () => {
        /* Synthetic current authority. */
      },
      () => {
        /* Synthetic original lease. */
      },
    );
  });
  expect(h.calls[1]?.values).toEqual([id(1), id(2), ""]);
  expect(h.releases).toEqual([false]);
});

it.each(["extra", "getter", "tenant", "brand-store", "store-null"])(
  "rejects closed configuration %s before acquiring a connection",
  (fault) => {
    const h = harness(),
      options: Record<string, unknown> = { ...h.options, scope: { ...h.options.scope } };
    let reads = 0;
    if (fault === "extra") options.assumeTrusted = true;
    if (fault === "getter")
      Object.defineProperty(options, "acquire", {
        enumerable: true,
        get() {
          reads++;
          return h.options.acquire;
        },
      });
    if (fault === "tenant") options.tenantReference = "not-an-owner";
    if (fault === "brand-store")
      options.scope = { kind: "Brand", brandReference: id(2), storeReference: id(3) };
    if (fault === "store-null")
      options.scope = { kind: "Store", brandReference: id(2), storeReference: null };
    expect(() =>
      createMediaImageWorkerTransactions(options as unknown as MediaImageWorkerTransactionsOptions),
    ).toThrow(unavailable);
    expect(reads).toBe(0);
    expect(h.state.acquisitions).toBe(0);
  },
);

it.each([
  "work",
  "caught-query",
  "malformed-query",
  "no-guard",
  "async-guard",
  "final-assert",
  "late-revocation",
  "lease-expired",
])("rolls back and refuses %s without leaking the underlying error", async (fault) => {
  const h = harness();
  let current = true,
    clock = 0;
  if (fault === "caught-query") h.state.failSql = "SELECT BUSINESS";
  if (fault === "malformed-query") h.state.malformed = true;
  const result = h.host.transactions.run(async (tx) => {
    if (fault === "caught-query" || fault === "malformed-query")
      await tx.query("SELECT BUSINESS", []).catch(() => undefined);
    if (fault === "work") throw Error("RAW_SYNTHETIC_WORK_DETAIL");
    if (fault !== "no-guard") {
      await h.host.registerBeforeCommit(
        tx,
        async () => {
          if (fault === "async-guard" || !current) throw Error("RAW_SYNTHETIC_AUTHORITY_DETAIL");
        },
        () => {
          if (fault === "final-assert" || clock >= 5) throw Error("RAW_SYNTHETIC_LEASE_DETAIL");
        },
      );
      if (fault === "lease-expired")
        await h.host.registerBeforeCommit(
          tx,
          async () => {
            clock = 5;
          },
          () => {
            /* Later final must not run past the first denial. */
          },
        );
    }
    if (fault === "late-revocation") current = false;
    return "must-not-return";
  });
  await expect(result).rejects.toThrow(unavailable);
  expect(h.events).toContain("ROLLBACK");
  expect(h.events).not.toContain("COMMIT");
  expect(h.releases).toEqual([false]);
});

it("drains already dispatched unawaited work SQL before rollback, and admits no late SQL", async () => {
  const h = harness(),
    entered = deferred(),
    gate = deferred();
  h.state.queryGate = gate;
  let captured: MediaImageWorkerTransaction | undefined, pending: Promise<unknown> | undefined;
  const running = h.host.transactions.run(async (tx) => {
    captured = tx;
    await h.register(tx);
    pending = tx.query("SELECT DELAYED", []).catch((error: unknown) => error);
    entered.resolve();
  });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.events).not.toContain("COMMIT");
  expect(h.releases).toHaveLength(0);
  gate.resolve();
  await expect(running).rejects.toThrow(unavailable);
  await pending;
  expect(h.events.indexOf("delayed-finished")).toBeLessThan(h.events.indexOf("ROLLBACK"));
  if (!captured) throw Error("Missing fixture facade");
  await expect(captured.query("INSERT ESCAPED", [])).rejects.toThrow(unavailable);
  expect(h.events).not.toContain("INSERT ESCAPED");
  expect(h.releases).toEqual([false]);
});

it("does not admit a work-context query that escapes into the asynchronous guard phase", async () => {
  const h = harness(),
    start = deferred();
  let escaped: Promise<unknown> | undefined;
  await expect(
    h.host.transactions.run(async (tx) => {
      escaped = start.promise
        .then(() => tx.query("INSERT ESCAPED", []))
        .catch((error: unknown) => error);
      await h.host.registerBeforeCommit(
        tx,
        async () => {
          start.resolve();
          await escaped;
        },
        () => {
          /* No authority mutation. */
        },
      );
    }),
  ).rejects.toThrow(unavailable);
  expect(await escaped).toMatchObject({ code: "MEDIA_WORKER_TRANSACTION_UNAVAILABLE" });
  expect(h.events).not.toContain("INSERT ESCAPED");
  expect(h.events).toContain("ROLLBACK");
});

it.each(["wrong-tx", "after-work", "duplicate", "overflow", "async-final", "final-query"])(
  "poisons caught %s guard misuse rather than dropping it",
  async (fault) => {
    const h = harness();
    let escaped: Promise<unknown> | undefined;
    await expect(
      h.host.transactions.run(async (tx) => {
        const guard = async () => {
            /* Current synthetic holder. */
          },
          final = () => {
            /* Original synthetic lease. */
          };
        await h.host.registerBeforeCommit(tx, guard, final);
        if (fault === "wrong-tx")
          await h.host.registerBeforeCommit(h.connection, guard, final).catch(() => undefined);
        if (fault === "duplicate")
          await h.host.registerBeforeCommit(tx, guard, final).catch(() => undefined);
        if (fault === "overflow")
          for (let n = 0; n < 64; n++)
            await h.host
              .registerBeforeCommit(
                tx,
                async () => {
                  /* Distinct holder. */
                },
                final,
              )
              .catch(() => undefined);
        if (fault === "after-work")
          await h.host.registerBeforeCommit(
            tx,
            async () => {
              await h.host
                .registerBeforeCommit(
                  tx,
                  async () => {
                    /* Must never register. */
                  },
                  final,
                )
                .catch(() => undefined);
            },
            final,
          );
        if (fault === "async-final")
          await h.host.registerBeforeCommit(
            tx,
            async () => {
              /* Valid async phase. */
            },
            async () => {
              /* Invalid asynchronous final. */
            },
          );
        if (fault === "final-query")
          await h.host.registerBeforeCommit(
            tx,
            async () => {
              /* Valid async phase. */
            },
            () => {
              escaped = tx.query("INSERT FINAL", []).catch((error: unknown) => error);
            },
          );
      }),
    ).rejects.toThrow(unavailable);
    await escaped;
    expect(h.events).not.toContain("COMMIT");
    expect(h.events).not.toContain("INSERT FINAL");
    expect(h.events).toContain("ROLLBACK");
  },
);

it("poisons a swallowed nested run before it acquires a second connection", async () => {
  const h = harness();
  await expect(
    h.host.transactions.run(async (tx) => {
      await h.register(tx);
      await h.host.transactions.run(async () => "nested").catch(() => undefined);
    }),
  ).rejects.toThrow(unavailable);
  expect(h.state.acquisitions).toBe(1);
  expect(h.releases).toEqual([false]);
  expect(h.events).not.toContain("COMMIT");
});

it("rejects an actual connection handed out twice and leaves rollback/release to its original owner", async () => {
  const h = harness(),
    entered = deferred(),
    resume = deferred();
  const first = h.host.transactions.run(async (tx) => {
    await h.register(tx);
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  await expect(h.host.transactions.run(async () => "wrong owner")).rejects.toThrow(unavailable);
  expect(h.releases).toHaveLength(0);
  resume.resolve();
  await expect(first).rejects.toThrow(unavailable);
  expect(h.events.filter((e) => e.startsWith("BEGIN"))).toHaveLength(1);
  expect(h.releases).toEqual([false]);
});

it("allows independent concurrent work on distinct acquired connections", async () => {
  const first = harness(),
    second = harness(),
    acquired = [first.connection, second.connection],
    gate = deferred(),
    entered = deferred();
  const host = createMediaImageWorkerTransactions({
    ...first.options,
    async acquire() {
      const connection = acquired.shift();
      if (!connection) throw Error("Missing fixture connection");
      return connection;
    },
  });
  const a = host.transactions.run(async (tx) => {
    await host.registerBeforeCommit(
      tx,
      async () => {
        /* Held A. */
      },
      () => {
        /* Lease A. */
      },
    );
    entered.resolve();
    await gate.promise;
    return "a";
  });
  await entered.promise;
  const b = await host.transactions.run(async (tx) => {
    await host.registerBeforeCommit(
      tx,
      async () => {
        /* Held B. */
      },
      () => {
        /* Lease B. */
      },
    );
    return "b";
  });
  gate.resolve();
  expect(await a).toBe("a");
  expect(b).toBe("b");
  expect(first.releases).toEqual([false]);
  expect(second.releases).toEqual([false]);
});

it.each(["function", "getter"])(
  "rejects raw query %s substitution and uses the captured connection for rollback",
  async (fault) => {
    const h = harness(),
      replacement = vi.fn(async () => ({ rows: [] }));
    const original = h.connection.query;
    let getters = 0;
    await expect(
      h.host.transactions.run(async (tx) => {
        await h.register(tx);
        if (fault === "function") Object.assign(h.connection, { query: replacement });
        else {
          Object.defineProperty(h.connection, "query", {
            configurable: true,
            get() {
              getters++;
              return replacement;
            },
          });
          await tx.query("INSERT SUBSTITUTED", []).catch(() => undefined);
          Object.defineProperty(h.connection, "query", { configurable: true, value: original });
        }
      }),
    ).rejects.toThrow(unavailable);
    expect(getters).toBe(0);
    expect(replacement).not.toHaveBeenCalled();
    expect(h.events).toContain("ROLLBACK");
    expect(h.events).not.toContain("COMMIT");
    expect(h.releases).toEqual([true]);
  },
);

it.each(["BEGIN ISOLATION LEVEL READ COMMITTED", "context", "ROLLBACK"])(
  "cleans up a %s failure with the correct discard decision",
  async (fault) => {
    const h = harness();
    if (fault === "context")
      h.state.failSql =
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)";
    else if (fault === "ROLLBACK") h.state.rollbackFail = true;
    else h.state.failSql = fault;
    await expect(
      h.host.transactions.run(async () => {
        throw Error("Synthetic work failure");
      }),
    ).rejects.toThrow(unavailable);
    expect(h.events).not.toContain("COMMIT");
    expect(h.releases).toEqual([fault !== "context"]);
    if (fault.startsWith("BEGIN")) expect(h.events).not.toContain("ROLLBACK");
    else expect(h.events).toContain("ROLLBACK");
  },
);

it("reports only bounded unknown outcome on failed COMMIT and discards without a misleading rollback", async () => {
  const h = harness();
  h.state.failSql = "COMMIT";
  await expect(
    h.host.transactions.run(async (tx) => {
      await h.register(tx);
      return "receipt";
    }),
  ).rejects.toThrow(unknown);
  expect(h.events).not.toContain("ROLLBACK");
  expect(h.releases).toEqual([true]);
});

it("retains an acknowledged commit even if release fails and refuses subsequent facade SQL", async () => {
  const h = harness();
  h.state.releaseFail = true;
  let captured: MediaImageWorkerTransaction | undefined;
  expect(
    await h.host.transactions.run(async (tx) => {
      captured = tx;
      await h.register(tx);
      return "acknowledged";
    }),
  ).toBe("acknowledged");
  if (!captured) throw Error("Missing fixture facade");
  await expect(captured.query("INSERT AFTER ACK", [])).rejects.toThrow(unavailable);
  expect(h.events).not.toContain("INSERT AFTER ACK");
  expect(h.events).not.toContain("ROLLBACK");
  expect(h.releases).toEqual([false]);
});

it("does not let a detached work callback start a new transaction after its original commit", async () => {
  const h = harness(),
    later = deferred();
  let detached: Promise<unknown> | undefined;
  await h.host.transactions.run(async (tx) => {
    await h.register(tx);
    detached = later.promise
      .then(() => h.host.transactions.run(async () => "escaped"))
      .catch((error: unknown) => error);
  });
  later.resolve();
  expect(await detached).toMatchObject({ code: "MEDIA_WORKER_TRANSACTION_UNAVAILABLE" });
  expect(h.state.acquisitions).toBe(1);
  expect(h.events.filter((sql) => sql === "COMMIT")).toHaveLength(1);
});

it("bounds acquisition errors without exposing connection details or invoking work", async () => {
  const h = harness(),
    work = vi.fn(async () => "must not run"),
    host = createMediaImageWorkerTransactions({
      ...h.options,
      async acquire() {
        throw Error("RAW_SYNTHETIC_POOL_DETAIL");
      },
    });
  await expect(host.transactions.run(work)).rejects.toThrow(unavailable);
  expect(work).not.toHaveBeenCalled();
  expect(h.events).toHaveLength(0);
});
