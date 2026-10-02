import { expect, it, vi } from "vitest";
import { CatalogError, CatalogProductListError } from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type Transaction = Parameters<
  Parameters<ReturnType<typeof createMerchantCategoryTransactions>["transactions"]["run"]>[0]
>[0];
function fixture() {
  const events: string[] = [];
  const query = vi.fn(async (): Promise<unknown> => ({
    rows: [],
    rowCount: 0,
  }));
  const source: PersistentMerchantBffOptions["transactions"] = {
    async run(work) {
      events.push("BEGIN");
      try {
        const result = await work({ query });
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { ...createMerchantCategoryTransactions(source), events, query };
}
it("runs registered checks inside the runner action before COMMIT and preserves result", async () => {
  const f = fixture();
  const result = await f.transactions.run(async (tx) => {
    await f.registerBeforeCommit(tx, async () => {
      f.events.push("CHECK_A");
      await tx.query("synthetic check", []);
    });
    await f.registerBeforeCommit(tx, async () => {
      f.events.push("CHECK_B");
    });
    f.events.push("WORK");
    return "RESULT";
  });
  expect(result).toBe("RESULT");
  expect(f.events).toEqual(["BEGIN", "WORK", "CHECK_A", "CHECK_B", "COMMIT"]);
});
it("missing COMMIT check registration forces rollback", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await tx.query("synthetic write", []);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each([true, false])(
  "check failure forces rollback with bounded error, Catalog=%s",
  async (catalog) => {
    const f = fixture();
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(tx, async () => {
          throw catalog
            ? new CatalogError("CATALOG_PERMISSION_DENIED")
            : new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL");
        });
      }),
    ).rejects.toMatchObject({
      code: catalog ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      message: "catalog is unavailable",
    });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("caught query failure still forces rollback", async () => {
  const f = fixture();
  f.query.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL"));
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      await tx.query("synthetic failed query", []).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["work", "checks"])("unawaited query during %s prevents COMMIT", async (stage) => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.query.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<unknown>;
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => {
        if (stage === "checks")
          pending = tx.query("synthetic pending", []).catch((error: unknown) => error);
      });
      if (stage === "work")
        pending = tx.query("synthetic pending", []).catch((error: unknown) => error);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  finish({ rows: [], rowCount: 0 });
  expect(await pending).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("reentrant registration during checks taints transaction even if caught", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => {
        await f.registerBeforeCommit(tx, async () => undefined).catch(() => undefined);
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("borrowed transaction cannot query or register after completion", async () => {
  const f = fixture();
  let captured!: Transaction;
  await f.transactions.run(async (tx) => {
    captured = tx;
    await f.registerBeforeCommit(tx, async () => undefined);
  });
  await expect(captured.query("late synthetic query", [])).rejects.toThrow();
  await expect(f.registerBeforeCommit(captured, async () => undefined)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("foreign host transaction cannot register checks", async () => {
  const f = fixture(),
    other = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await other.registerBeforeCommit(tx, async () => undefined);
    }),
  ).rejects.toThrow();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each([
  { rows: null },
  { rows: [], rowCount: -1 },
  {
    rows: [],
    get rowCount() {
      throw new Error("SYNTHETIC_ACCESSOR");
    },
  },
])("malformed result fails bounded without accessor execution %#", async (result) => {
  const f = fixture();
  f.query.mockResolvedValue(result);
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      await tx.query("synthetic malformed", []);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("finite registration budget cannot be bypassed by catching rejection", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      for (let i = 0; i < 64; i++) await f.registerBeforeCommit(tx, async () => undefined);
      await f.registerBeforeCommit(tx, async () => undefined).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("underlying transaction outcome failure remains unavailable", async () => {
  const host = createMerchantCategoryTransactions({
    run: async () => {
      throw new Error("SYNTHETIC_COMMIT_OUTCOME_UNKNOWN");
    },
  });
  await expect(host.transactions.run(async () => undefined)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
});

for (const stage of ["work", "check"] as const) {
  it.each(["Invalid", "Denied", "FeatureDisabled", "Unavailable", "Stale"] as const)(
    `preserves bounded Product List %s outcome from ${stage} with rollback`,
    async (code) => {
      const f = fixture();
      const error = new CatalogProductListError(code);
      await expect(
        f.transactions.run(async (tx) => {
          await f.registerBeforeCommit(tx, async () => {
            if (stage === "check") throw error;
          });
          if (stage === "work") throw error;
        }),
      ).rejects.toBe(error);
      expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    },
  );
}
