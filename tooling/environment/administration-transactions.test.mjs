import { expect, it, vi } from "vitest";
import { createAdministrationTransactions } from "./administration-transactions.mjs";

function fixture() {
  const connection = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const database = { acquire: vi.fn(async () => connection) };
  return { connection, database, transactions: createAdministrationTransactions(database) };
}

it("runs finite READ COMMITTED without invented scope and closes the borrowed handle", async () => {
  const f = fixture();
  let escaped;
  await expect(
    f.transactions.run(async (tx) => {
      escaped = tx;
      await tx.query("SELECT owner_value", ["value"]);
      return "result";
    }),
  ).resolves.toBe("result");
  expect(f.connection.query.mock.calls).toEqual([
    ["BEGIN ISOLATION LEVEL READ COMMITTED"],
    ["SET LOCAL statement_timeout = '5s'"],
    ["SET LOCAL lock_timeout = '2s'"],
    ["SET LOCAL idle_in_transaction_session_timeout = '5s'"],
    ["SELECT owner_value", ["value"]],
    ["COMMIT"],
  ]);
  expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(false);
  await expect(escaped.query("INSERT escaped", [])).rejects.toThrow(
    "ADMINISTRATION_TRANSACTION_UNAVAILABLE",
  );
  expect(f.connection.query).toHaveBeenCalledTimes(6);
});

it.each([false, true])(
  "preserves owning business failure and discards the client, failed rollback=%s",
  async (rollbackFails) => {
    const f = fixture();
    const business = new Error("OWNING_PERMISSION_DENIED");
    f.connection.query.mockImplementation(async (sql) => {
      if (rollbackFails && sql === "ROLLBACK") throw new Error("private driver detail");
      return { rows: [] };
    });
    await expect(
      f.transactions.run(async () => {
        throw business;
      }),
    ).rejects.toBe(business);
    expect(f.connection.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(f.connection.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
  },
);

it("refuses COMMIT after a query failure caught by business work", async () => {
  const f = fixture();
  f.connection.query.mockImplementation(async (sql) => {
    if (sql === "UPDATE owning_row") throw new Error("private driver detail");
    return { rows: [] };
  });
  await expect(
    f.transactions.run(async (tx) => {
      await tx.query("UPDATE owning_row", []).catch(() => undefined);
      await expect(tx.query("INSERT after_failure", [])).rejects.toThrow(
        "ADMINISTRATION_TRANSACTION_UNAVAILABLE",
      );
    }),
  ).rejects.toThrow("ADMINISTRATION_TRANSACTION_UNAVAILABLE");
  expect(
    f.connection.query.mock.calls.some(
      ([sql]) => sql === "COMMIT" || sql === "INSERT after_failure",
    ),
  ).toBe(false);
  expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([false, true])(
  "drains unawaited query before rollback and release, query rejects=%s",
  async (rejects) => {
    const f = fixture();
    let settle;
    const queued = new Promise((resolve, reject) => {
      settle = () => (rejects ? reject(new Error("private detail")) : resolve({ rows: [] }));
    });
    const started = new Promise((resolve) => {
      f.connection.query.mockImplementation(async (sql) => {
        if (sql === "INSERT pending") {
          resolve();
          return queued;
        }
        return { rows: [] };
      });
    });
    let escaped;
    const run = f.transactions.run(async (tx) => {
      escaped = tx;
      void tx.query("INSERT pending", []);
    });
    await started;
    await Promise.resolve();
    expect(f.connection.release).not.toHaveBeenCalled();
    expect(
      f.connection.query.mock.calls.some(([sql]) => sql === "ROLLBACK" || sql === "COMMIT"),
    ).toBe(false);
    settle();
    await expect(run).rejects.toThrow("ADMINISTRATION_TRANSACTION_UNAVAILABLE");
    expect(f.connection.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(escaped.query("INSERT after_release", [])).rejects.toThrow(
      "ADMINISTRATION_TRANSACTION_UNAVAILABLE",
    );
  },
);

it.each(["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL lock_timeout = '2s'", "COMMIT"])(
  "bounds private failure at %s and always releases",
  async (failedSql) => {
    const f = fixture();
    f.connection.query.mockImplementation(async (sql) => {
      if (sql === failedSql) throw new Error("private connection detail");
      return { rows: [] };
    });
    await expect(f.transactions.run(async () => "value")).rejects.toThrow(
      /^ADMINISTRATION_TRANSACTION_UNAVAILABLE$/,
    );
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
  },
);

it("does not replace a business refusal when release fails", async () => {
  const f = fixture();
  const business = new Error("OWNING_VERSION_CONFLICT");
  f.connection.release.mockImplementation(() => {
    throw new Error("private release detail");
  });
  await expect(
    f.transactions.run(async () => {
      throw business;
    }),
  ).rejects.toBe(business);
  expect(f.connection.release).toHaveBeenCalledTimes(1);
});

it("bounds release and acquire failures", async () => {
  const f = fixture();
  f.connection.release.mockImplementation(() => {
    throw new Error("private release detail");
  });
  await expect(f.transactions.run(async () => "committed")).rejects.toThrow(
    /^ADMINISTRATION_TRANSACTION_UNAVAILABLE$/,
  );
  const unavailable = createAdministrationTransactions({
    acquire: async () => {
      throw new Error("private acquire detail");
    },
  });
  await expect(unavailable.run(async () => undefined)).rejects.toThrow(
    /^ADMINISTRATION_TRANSACTION_UNAVAILABLE$/,
  );
});

it("pins original connection ports rather than invoking a substituted query", async () => {
  const f = fixture();
  const foreign = vi.fn();
  await expect(
    f.transactions.run(async (tx) => {
      f.connection.query = foreign;
      await tx.query("INSERT foreign", []).catch(() => undefined);
    }),
  ).rejects.toThrow("ADMINISTRATION_TRANSACTION_UNAVAILABLE");
  expect(foreign).not.toHaveBeenCalled();
  expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
});
