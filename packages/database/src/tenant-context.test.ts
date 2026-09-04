import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { TenantContextDatabaseError, withTenantContextTransaction } from "./tenant-context.js";

const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000041";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000042";

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
    expect(client.trace).toEqual([
      { text: "BEGIN" },
      {
        text: "SELECT set_config('bop.brand_id', $1, true)",
        values: [BRAND],
      },
      {
        text: "SELECT set_config('bop.store_id', $1, true)",
        values: [""],
      },
      { text: "CALLBACK" },
      { text: "COMMIT" },
    ]);
    expect(client.trace.map((item) => item.text).join("\n")).not.toMatch(
      /(^|\s)SET\s+(?:SESSION\s+)?bop\./u,
    );
    expect(client.released).toBe(1);
  });

  it("sets Store context with the same static SQL and no identifier interpolation", async () => {
    const client = new FakeClient();
    await withTenantContextTransaction(
      pool(client),
      { brandId: BRAND, storeId: STORE },
      async () => undefined,
    );
    expect(client.trace[2]).toEqual({
      text: "SELECT set_config('bop.store_id', $1, true)",
      values: [STORE],
    });
    expect(
      client.trace.some((item) => item.text.includes(BRAND) || item.text.includes(STORE)),
    ).toBe(false);
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

    for (const failure of ["SELECT set_config('bop.brand_id', $1, true)", "COMMIT"]) {
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
