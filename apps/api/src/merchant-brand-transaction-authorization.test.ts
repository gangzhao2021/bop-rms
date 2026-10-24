import { describe, expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import {
  createMerchantCategoryTransactions,
  deferMerchantTransactionStatement,
  merchantTransactionPhase,
} from "./merchant-category-transactions.js";
import {
  rememberBrandTransactionDecisions,
  rememberBrandTransactionValue,
  rememberedBrandTransaction,
  restoreBrandTransactionRowSecurity,
  withRememberedBrandAuthorization,
} from "./merchant-brand-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const brand = "01902423-0000-7000-8000-000000000001";
const store = "01902423-0000-7000-8000-000000000002";

function fixture() {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    statements.push({ sql, values });
    return { rows: [], rowCount: 0 };
  });
  const source: PersistentMerchantBffOptions["transactions"] = {
    run: (work) => work({ query }),
  };
  let at = Date.parse("2026-10-16T10:00:00.000Z");
  const now = () => new Date(at).toISOString();
  const advance = (milliseconds: number) => {
    at += milliseconds;
  };
  return { ...createMerchantCategoryTransactions(source), statements, now, advance };
}

const decision = (action: string, effect = "Allow") =>
  Object.freeze({ effect, action, scopeKind: "Brand" });

/** A Brand policy whose current answers the test changes; counts each full resolution. */
function policy(validUntil: string | null = null) {
  const denied = new Set<string>();
  const resolutions: (readonly string[])[] = [];
  const resolve = vi.fn(async (actions: readonly string[]) => {
    resolutions.push(actions);
    return Object.freeze({
      decisions: Object.freeze(
        actions.map((action) => decision(action, denied.has(action) ? "Deny" : "Allow")),
      ),
      validUntil,
    });
  });
  return { denied, resolutions, resolve };
}

describe("Brand-scope authorization once per transaction (WP-2423)", () => {
  it("resolves every ask in full outside a live host transaction", async () => {
    const f = fixture(),
      p = policy();
    const driver = { query: vi.fn() };
    expect(rememberedBrandTransaction(driver)).toBe(false);
    for (let i = 0; i < 3; i++)
      await rememberBrandTransactionDecisions(driver, {
        scope: "s",
        actions: ["catalog.manage"],
        now: f.now,
        resolve: p.resolve,
      });
    expect(p.resolve).toHaveBeenCalledTimes(3);
  });

  it("reuses one resolution per transaction, widens new asks and re-checks the union once before commit", async () => {
    const f = fixture(),
      p = policy();
    const ask = (tx: unknown, actions: readonly string[]) =>
      rememberBrandTransactionDecisions(tx, {
        scope: "s",
        actions,
        now: f.now,
        resolve: p.resolve,
      });
    const result = await f.transactions.run(async (tx) => {
      expect(merchantTransactionPhase(tx)).toBe("work");
      expect(rememberedBrandTransaction(tx)).toBe(true);
      await f.registerBeforeCommit(tx, async () => {
        expect(merchantTransactionPhase(tx)).toBe("checks");
        // The host's own check asks in its check phase: resolved afresh (it is that owner's own
        // late re-check), never answered from the work's resolution.
        expect((await ask(tx, ["catalog.manage", "catalog.option_set.read"]))?.decisions).toEqual([
          decision("catalog.manage"),
          decision("catalog.option_set.read"),
        ]);
      });
      for (let i = 0; i < 50; i++) await ask(tx, ["catalog.manage"]);
      // A new action is resolved together with the actions already asked for.
      const wider = await ask(tx, ["catalog.option_set.read", "catalog.manage"]);
      expect(wider?.decisions).toEqual([
        decision("catalog.option_set.read"),
        decision("catalog.manage"),
      ]);
      for (let i = 0; i < 50; i++) await ask(tx, ["catalog.option_set.read"]);
      return "written";
    });
    expect(result).toBe("written");
    expect(p.resolutions).toEqual([
      ["catalog.manage"],
      ["catalog.option_set.read", "catalog.manage"],
      // The owner's own before-commit check.
      ["catalog.manage", "catalog.option_set.read"],
      // The single re-check, after every other before-commit check: every remembered action.
      ["catalog.manage", "catalog.option_set.read"],
    ]);
  });

  it("refuses the commit when an answer changed while the transaction ran", async () => {
    const f = fixture(),
      p = policy();
    let wrote = false;
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(tx, async () => undefined);
        expect(
          (
            await rememberBrandTransactionDecisions(tx, {
              scope: "s",
              actions: ["catalog.option_set.publish"],
              now: f.now,
              resolve: p.resolve,
            })
          )?.decisions[0]?.effect,
        ).toBe("Allow");
        // The grant is withdrawn after the admission; the transaction's work still completes.
        p.denied.add("catalog.option_set.publish");
        wrote = true;
        return "written";
      }),
    ).rejects.toEqual(new CatalogError("CATALOG_PERMISSION_DENIED"));
    expect(wrote).toBe(true);
    expect(p.resolve).toHaveBeenCalledTimes(2);
  });

  it("re-checks after every other before-commit check, so a grant withdrawn by one is caught", async () => {
    const f = fixture(),
      p = policy();
    const ask = (tx: unknown) =>
      rememberBrandTransactionDecisions(tx, {
        scope: "s",
        actions: ["catalog.product.manage"],
        now: f.now,
        resolve: p.resolve,
      });
    await expect(
      f.transactions.run(async (tx) => {
        await ask(tx);
        // Registered after the memo's own re-check, it still runs before it.
        await f.registerBeforeCommit(tx, async () => {
          expect((await ask(tx))?.decisions[0]?.effect).toBe("Allow");
          p.denied.add("catalog.product.manage");
          expect((await ask(tx))?.decisions[0]?.effect).toBe("Allow");
        });
        return "written";
      }),
    ).rejects.toEqual(new CatalogError("CATALOG_PERMISSION_DENIED"));
  });

  it("lets an owner's own before-commit check see a grant withdrawn during the work", async () => {
    const f = fixture(),
      p = policy();
    const ask = (tx: unknown) =>
      rememberBrandTransactionDecisions(tx, {
        scope: "s",
        actions: ["organization.manage"],
        now: f.now,
        resolve: p.resolve,
      });
    const seen: string[] = [];
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(tx, async () => {
          seen.push(String((await ask(tx))?.decisions[0]?.effect));
          // Later asks of the check phase reuse that fresh check-phase answer.
          seen.push(String((await ask(tx))?.decisions[0]?.effect));
          if (seen.includes("Deny")) throw new Error("OWNER_PERMISSION_DENIED");
        });
        seen.push(String((await ask(tx))?.decisions[0]?.effect));
        p.denied.add("organization.manage");
        seen.push(String((await ask(tx))?.decisions[0]?.effect));
        return "written";
      }),
      // The owner's refusal ends the transaction (the host reports it in its own terms).
    ).rejects.toBeInstanceOf(Error);
    // Work: one resolution, reused; check phase: one fresh resolution, reused.
    expect(seen).toEqual(["Allow", "Allow", "Deny", "Deny"]);
    expect(p.resolve).toHaveBeenCalledTimes(2);
  });

  it("never carries an answer into another transaction", async () => {
    const f = fixture(),
      p = policy();
    const ask = (tx: unknown) =>
      rememberBrandTransactionDecisions(tx, {
        scope: "s",
        actions: ["catalog.manage"],
        now: f.now,
        resolve: p.resolve,
      });
    let first: unknown;
    await f.transactions.run(async (tx) => {
      first = tx;
      await f.registerBeforeCommit(tx, async () => undefined);
      await ask(tx);
      await ask(tx);
      return "one";
    });
    // A completed transaction's object no longer remembers anything.
    expect(rememberedBrandTransaction(first)).toBe(false);
    await ask(first);
    p.denied.add("catalog.manage");
    await f.transactions.run(async (tx) => {
      expect(tx).not.toBe(first);
      await f.registerBeforeCommit(tx, async () => undefined);
      expect((await ask(tx))?.decisions[0]?.effect).toBe("Deny");
      return "two";
    });
    // First: resolve + final re-check; the closed object: full; second: resolve + re-check.
    expect(p.resolve).toHaveBeenCalledTimes(5);
  });

  it("refuses the commit when the re-check itself is refused (Session ended)", async () => {
    const f = fixture();
    let calls = 0;
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(tx, async () => undefined);
        await rememberBrandTransactionValue(tx, {
          scope: "s",
          key: "store-scope",
          now: f.now,
          resolve: async () => {
            if (++calls > 1) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
            return "admitted";
          },
          same: (a, b) => a === b,
        });
      }),
    ).rejects.toEqual(new CatalogError("CATALOG_PERMISSION_DENIED"));
    expect(calls).toBe(2);
  });

  it("resolves again once an answer's boundary passes, never extending it", async () => {
    const f = fixture(),
      p = policy("2026-10-16T10:00:01.000Z");
    await f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      const ask = () =>
        rememberBrandTransactionDecisions(tx, {
          scope: "s",
          actions: ["catalog.manage"],
          now: f.now,
          resolve: p.resolve,
        });
      await ask();
      f.advance(500);
      await ask();
      expect(p.resolve).toHaveBeenCalledTimes(1);
      f.advance(500);
      await ask();
      expect(p.resolve).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps answers apart per scope and never reuses a refusal for another action set", async () => {
    const f = fixture();
    const resolve = vi.fn(async (actions: readonly string[]) =>
      actions.includes("store.only")
        ? null
        : Object.freeze({ decisions: actions.map((a) => decision(a)), validUntil: null }),
    );
    await f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      const ask = (scope: string, actions: readonly string[]) =>
        rememberBrandTransactionDecisions(tx, { scope, actions, now: f.now, resolve });
      await ask("actor-a", ["catalog.manage"]);
      await ask("actor-b", ["catalog.manage"]);
      expect(resolve).toHaveBeenCalledTimes(2);
      // The widened set is refused: the ask is resolved on its own and the refusal kept apart.
      expect(await ask("actor-a", ["store.only"])).toBeNull();
      expect((await ask("actor-a", ["catalog.manage"]))?.decisions).toEqual([
        decision("catalog.manage"),
      ]);
    });
  });

  it("restores the row-level-security scope before the next statement only", async () => {
    const f = fixture();
    await f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      await restoreBrandTransactionRowSecurity(tx, brand, store);
      await restoreBrandTransactionRowSecurity(tx, brand, null);
      expect(f.statements).toEqual([]);
      await tx.query("SELECT 1", []);
      await tx.query("SELECT 2", []);
      expect(f.statements).toEqual([
        {
          sql: "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          values: [brand],
        },
        { sql: "SELECT 1", values: [] },
        { sql: "SELECT 2", values: [] },
      ]);
      // Only transaction-local bop scope settings may be deferred.
      expect(deferMerchantTransactionStatement(tx, "DELETE FROM x", [])).toBe(false);
    });
    await expect(
      restoreBrandTransactionRowSecurity({ query: vi.fn() }, brand, null),
    ).rejects.toEqual(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
  });

  it("remembers asks on another runner's transaction and re-checks them when its work settles", async () => {
    const f = fixture(),
      p = policy();
    const statements: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };
    const ask = () =>
      rememberBrandTransactionDecisions(tx, {
        scope: "s",
        actions: ["catalog.menu.manage"],
        now: f.now,
        resolve: p.resolve,
        restore: () => restoreBrandTransactionRowSecurity(tx, brand, null),
      });
    expect(
      await withRememberedBrandAuthorization(tx, async () => {
        expect(rememberedBrandTransaction(tx)).toBe(true);
        for (let i = 0; i < 10; i++) await ask();
        return "read";
      }),
    ).toBe("read");
    // One resolution for the work, one re-check after it; no memo once the work settled.
    expect(p.resolve).toHaveBeenCalledTimes(2);
    expect(rememberedBrandTransaction(tx)).toBe(false);
    // Without a host to defer to, a reuse restores the Brand scope at once.
    expect(statements).toHaveLength(9);
    p.denied.add("catalog.menu.manage");
    await expect(
      withRememberedBrandAuthorization(tx, async () => {
        p.denied.delete("catalog.menu.manage");
        await ask();
        p.denied.add("catalog.menu.manage");
        return "written";
      }),
    ).rejects.toEqual(new CatalogError("CATALOG_PERMISSION_DENIED"));
  });
});
