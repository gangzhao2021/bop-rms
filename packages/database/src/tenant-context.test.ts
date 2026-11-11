import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import {
  remainingRequestAcquireBudgetMs,
  runWithRequestAcquireBudget,
} from "./connection-acquire.js";
import {
  TenantContextDatabaseError,
  tenantContextDatabaseDiagnostic,
  withTenantContextTransaction,
} from "./tenant-context.js";

const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000041";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000042";
/** WP-2423 M35: the validated scope, written into the BEGIN round trip. */
const scopeText = (brand: string, store: string) =>
  `SELECT set_config('bop.brand_id', '${brand}', true), set_config('bop.store_id', '${store}', true)`;

class FakeClient {
  readonly trace: { text: string; values?: readonly unknown[] }[] = [];
  failOn: string | undefined;
  released = 0;
  destroyed = false;

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.trace.push({ text, ...(values === undefined ? {} : { values }) });
    if (text === this.failOn) throw new Error(`raw-${text}-failure`);
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  }

  release(destroy = false): void {
    this.released += 1;
    this.destroyed = destroy;
  }
}

function pool(client: FakeClient): Pick<Pool, "connect"> {
  return {
    connect: async () => client as unknown as PoolClient,
  };
}

describe("transaction-local Tenant database context", () => {
  it("sets exact parameterized local Brand and empty Store inside one owned transaction", async () => {
    const client = new FakeClient();
    const value = await withTenantContextTransaction(pool(client), { brandId: BRAND }, async () => {
      client.trace.push({ text: "CALLBACK" });
      return "result";
    });
    expect(value).toBe("result");
    // WP-2423 item 4 and M35: BEGIN and both scope settings in one round trip.
    expect(client.trace).toEqual([
      { text: "BEGIN; " + scopeText(BRAND, "") },
      { text: "CALLBACK" },
      { text: "COMMIT" },
    ]);
    expect(client.trace.map((item) => item.text).join("\n")).not.toMatch(
      /(^|\s)SET\s+(?:SESSION\s+)?bop\./u,
    );
    expect(client.released).toBe(1);
  });

  it("sets Store context in the same round trip, writing only validated UUIDv7 values", async () => {
    const client = new FakeClient();
    await withTenantContextTransaction(
      pool(client),
      { brandId: BRAND, storeId: STORE },
      async () => undefined,
    );
    expect(client.trace[0]).toEqual({ text: "BEGIN; " + scopeText(BRAND, STORE) });
    // Anything that is not a UUIDv7 never reaches the text: refused before a connection is taken.
    let acquired = 0;
    for (const storeId of [STORE + "'", "x', true); RESET ROLE; --", STORE.toUpperCase()])
      await expect(
        withTenantContextTransaction(
          {
            connect: async () => {
              acquired += 1;
              return new FakeClient() as unknown as PoolClient;
            },
          },
          { brandId: BRAND, storeId },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "TENANT_DATABASE_SCOPE_INVALID" });
    expect(acquired).toBe(0);
  });

  it("rejects malformed, unknown-field and accessor-bearing scope before pool acquisition", async () => {
    let acquisitions = 0;
    const fakePool = {
      connect: async () => {
        acquisitions += 1;
        return new FakeClient() as unknown as PoolClient;
      },
    };
    for (const scope of [
      { brandId: "not-a-uuid" },
      { brandId: BRAND, permission: "admin" },
      { brandId: BRAND, storeId: "not-a-uuid" },
      Object.create(null),
    ])
      await expect(
        withTenantContextTransaction(fakePool, scope as never, async () => undefined),
      ).rejects.toMatchObject({ code: "TENANT_DATABASE_SCOPE_INVALID" });

    let invoked = false;
    const accessor = {};
    Object.defineProperty(accessor, "brandId", {
      enumerable: true,
      get() {
        invoked = true;
        return BRAND;
      },
    });
    await expect(
      withTenantContextTransaction(fakePool, accessor as never, async () => undefined),
    ).rejects.toBeInstanceOf(TenantContextDatabaseError);
    expect(invoked).toBe(false);
    expect(acquisitions).toBe(0);
  });

  it("rolls back, releases and preserves the exact callback error", async () => {
    const client = new FakeClient();
    const businessError = new Error("synthetic-business-conflict");
    await expect(
      withTenantContextTransaction(pool(client), { brandId: BRAND, storeId: STORE }, async () => {
        throw businessError;
      }),
    ).rejects.toBe(businessError);
    expect(client.trace.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(1);
  });

  it("maps acquire, setup and commit failures to stable infrastructure errors", async () => {
    await expect(
      withTenantContextTransaction(
        {
          connect: async () => {
            throw new Error("raw-acquire-secret");
          },
        },
        { brandId: BRAND },
        async () => undefined,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "TENANT_DATABASE_ACQUIRE_FAILED",
        message: "tenant database connection is unavailable",
      }),
    );

    for (const failure of ["BEGIN; " + scopeText(BRAND, ""), "COMMIT"]) {
      const client = new FakeClient();
      client.failOn = failure;
      await expect(
        withTenantContextTransaction(pool(client), { brandId: BRAND }, async () => undefined),
      ).rejects.toEqual(
        expect.objectContaining({
          code: "TENANT_DATABASE_TRANSACTION_FAILED",
          message: "tenant database transaction failed",
        }),
      );
      expect(client.released).toBe(1);
      expect(client.destroyed).toBe(true);
      expect(client.trace.some((item) => item.text === "ROLLBACK")).toBe(true);
    }
  });
  it("WP-2423 (v15 2026-10-17): reports a setup or COMMIT on a lost connection as 08006", async () => {
    for (const failure of ["BEGIN; " + scopeText(BRAND, ""), "COMMIT"]) {
      const client = new FakeClient();
      client.query = async (text: string, values?: readonly unknown[]) => {
        client.trace.push({ text, ...(values === undefined ? {} : { values }) });
        if (text === failure) throw new Error("Connection terminated unexpectedly");
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      };
      await expect(
        withTenantContextTransaction(pool(client), { brandId: BRAND }, async () => undefined),
      ).rejects.toMatchObject({
        code: "TENANT_DATABASE_TRANSACTION_FAILED",
        diagnostic: { sqlState: "08006", constraint: null, table: null, closed: false },
      });
      expect(client.destroyed).toBe(true);
    }
    // A server-side SQLSTATE is kept as is; an unrecognised failure stays without one.
    const timedOut = new FakeClient();
    timedOut.query = async (text: string) => {
      if (text === "COMMIT") throw Object.assign(new Error("private"), { code: "25P03" });
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    };
    await expect(
      withTenantContextTransaction(pool(timedOut), { brandId: BRAND }, async () => undefined),
    ).rejects.toMatchObject({ diagnostic: { sqlState: "25P03" } });
    const unknown = new FakeClient();
    unknown.failOn = "COMMIT";
    await expect(
      withTenantContextTransaction(pool(unknown), { brandId: BRAND }, async () => undefined),
    ).rejects.toMatchObject({ diagnostic: { sqlState: null } });
  });
  it("WP-2423 item 4: sends parameterless limits with BEGIN and refuses any other setup", async () => {
    const client = new FakeClient();
    const limits = "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'";
    await withTenantContextTransaction(
      pool(client),
      { brandId: BRAND, storeId: STORE },
      async () => undefined,
      "ReadWrite",
      limits,
    );
    expect(client.trace.map((item) => item.text)).toEqual([
      "BEGIN; " + limits + "; " + scopeText(BRAND, STORE),
      "COMMIT",
    ]);
    const snapshot = new FakeClient();
    await withTenantContextTransaction(
      pool(snapshot),
      { brandId: BRAND },
      async () => undefined,
      "Snapshot",
      limits,
    );
    expect(snapshot.trace[0]?.text).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY; " + limits + "; " + scopeText(BRAND, ""),
    );
    // A failure after BEGIN in the same round trip rolls back and discards the connection.
    const failing = new FakeClient();
    failing.failOn = "BEGIN; " + limits + "; " + scopeText(BRAND, "");
    await expect(
      withTenantContextTransaction(
        pool(failing),
        { brandId: BRAND },
        async () => undefined,
        "ReadWrite",
        limits,
      ),
    ).rejects.toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_FAILED" });
    expect(failing.trace.at(-1)?.text).toBe("ROLLBACK");
    expect(failing.destroyed).toBe(true);
    let acquisitions = 0;
    const counting = {
      connect: async () => {
        acquisitions += 1;
        return new FakeClient() as unknown as PoolClient;
      },
    };
    for (const setup of [
      "SET ROLE postgres",
      "SET LOCAL statement_timeout = '5s'; RESET ALL",
      "SET LOCAL bop.brand_id = '" + BRAND + "'",
      "",
    ])
      await expect(
        withTenantContextTransaction(
          counting,
          { brandId: BRAND },
          async () => undefined,
          "ReadWrite",
          setup,
        ),
      ).rejects.toMatchObject({ code: "TENANT_DATABASE_SCOPE_INVALID" });
    expect(acquisitions).toBe(0);
  });
  it("discards rollback failures and preserves even an undefined callback rejection", async () => {
    const client = new FakeClient();
    client.failOn = "ROLLBACK";
    let rejected = false;
    await withTenantContextTransaction(pool(client), { brandId: BRAND }, async () => {
      return Promise.reject(undefined);
    }).catch((error: unknown) => {
      rejected = true;
      expect(error).toBeUndefined();
    });
    expect(rejected).toBe(true);
    expect(client.destroyed).toBe(true);
    expect(client.released).toBe(1);
  });
});

describe("the safe diagnostic of a failed statement (WP-2423 item 10)", () => {
  const failure = (fields: Record<string, unknown>, message = "text") =>
    Object.assign(new Error(message), fields);

  it("names the table of a missing grant or a refused row, which only the message holds", () => {
    expect(
      tenantContextDatabaseDiagnostic(
        failure({ code: "42501" }, "permission denied for table product_publication_content"),
      ),
    ).toMatchObject({ sqlState: "42501", table: "product_publication_content" });
    expect(
      tenantContextDatabaseDiagnostic(
        failure(
          { code: "42501" },
          'new row violates row-level security policy for table "membership"',
        ),
      ),
    ).toMatchObject({ sqlState: "42501", table: "membership" });
    expect(
      tenantContextDatabaseDiagnostic(
        failure({ code: "42501" }, "permission denied for schema rms_x"),
      ).table,
    ).toBe("rms_x");
  });

  it("reads nothing else from a message", () => {
    for (const message of [
      "permission denied for table a; guest Sam",
      "permission denied for table Sam's",
      "duplicate key value violates unique constraint",
    ])
      expect(tenantContextDatabaseDiagnostic(failure({ code: "42501" }, message)).table).toBeNull();
    expect(
      tenantContextDatabaseDiagnostic(failure({ code: "23514", table: "product" }, "x")).table,
    ).toBe("product");
  });
});

describe("WP-2423 outage-reads-and-retry review: a request's transaction says whether it wrote", () => {
  const probe = "SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS wrote";
  class Answering extends FakeClient {
    constructor(private readonly wrote: boolean) {
      super();
    }
    override async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
      const result = await super.query(text, values);
      return text === probe ? ({ rows: [{ wrote: this.wrote }], rowCount: 1 } as never) : result;
    }
  }
  it("a write marks the request (its later connections wait their own budget); a read does not", async () => {
    await runWithRequestAcquireBudget(10_000, async () => {
      const read = new Answering(false);
      await withTenantContextTransaction(pool(read), { brandId: BRAND }, async () => undefined);
      expect(read.trace.map((step) => step.text).slice(-2)).toEqual([probe, "COMMIT"]);
      expect(remainingRequestAcquireBudgetMs()).toBe(10_000);
      // A snapshot is read-only: no probe.
      const snapshot = new Answering(false);
      await withTenantContextTransaction(
        pool(snapshot),
        { brandId: BRAND },
        async () => undefined,
        "Snapshot",
      );
      expect(snapshot.trace.map((step) => step.text)).not.toContain(probe);
      const write = new Answering(true);
      await withTenantContextTransaction(pool(write), { brandId: BRAND }, async () => undefined);
      // The request no longer bounds its acquires, and its next transactions need no probe.
      expect(remainingRequestAcquireBudgetMs()).toBeUndefined();
      const after = new Answering(true);
      await withTenantContextTransaction(pool(after), { brandId: BRAND }, async () => undefined);
      expect(after.trace.map((step) => step.text)).not.toContain(probe);
    });
  });
  it("outside a request nothing is probed, and a probe that fails fails the transaction", async () => {
    const plain = new FakeClient();
    await withTenantContextTransaction(pool(plain), { brandId: BRAND }, async () => undefined);
    expect(plain.trace.map((step) => step.text)).not.toContain(probe);
    await runWithRequestAcquireBudget(10_000, async () => {
      const failing = new FakeClient();
      failing.failOn = probe;
      await expect(
        withTenantContextTransaction(pool(failing), { brandId: BRAND }, async () => undefined),
      ).rejects.toBeInstanceOf(TenantContextDatabaseError);
      expect(failing.trace.map((step) => step.text)).toContain("ROLLBACK");
      expect(failing.trace.map((step) => step.text)).not.toContain("COMMIT");
    });
  });
});
