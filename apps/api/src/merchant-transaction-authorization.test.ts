import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";

const denied = (): never => {
  throw new Error("SYNTHETIC_DENIED");
};

describe("withMerchantTransactionAuthorization", () => {
  it("resolves once, guards owner reads without re-resolving and re-checks once before the reply", async () => {
    const tx = { name: "tx" },
      wrapper = { name: "wrapper" },
      scope = { store: "s1" };
    const resolve = vi.fn(async () => scope),
      recheck = vi.fn(async () => true);
    const result = await withMerchantTransactionAuthorization(
      { transaction: tx, resolve, recheck, denied },
      async (authority) => {
        expect(authority.scope).toBe(scope);
        expect(await authority.guard()).toBe(true);
        expect(await authority.guard(tx)).toBe(true);
        expect(await authority.guard(tx, scope)).toBe(true);
        expect(await authority.guard(tx, { store: "s1" })).toBe(false);
        expect(await authority.guard(wrapper)).toBe(false);
        authority.bind(wrapper);
        expect(await authority.guard(wrapper)).toBe(true);
        expect(recheck).not.toHaveBeenCalled();
        return "reply";
      },
    );
    expect(result).toBe("reply");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith(scope);
  });

  it("refuses the reply when the final full re-check fails (Session revoked during the read)", async () => {
    const work = vi.fn(async () => "reply");
    await expect(
      withMerchantTransactionAuthorization(
        {
          transaction: {},
          resolve: async () => ({}),
          recheck: async () => false,
          denied,
        },
        work,
      ),
    ).rejects.toThrow("SYNTHETIC_DENIED");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("re-checks a permission an owner-read adapter resolved during the run", async () => {
    const later = vi.fn(async () => false);
    await expect(
      withMerchantTransactionAuthorization(
        { transaction: {}, resolve: async () => ({}), recheck: async () => true, denied },
        async (authority) => {
          authority.recheckBeforeReply(later);
          return "reply";
        },
      ),
    ).rejects.toThrow("SYNTHETIC_DENIED");
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("never runs the work when the initial resolution refuses, and the guard ends with the run", async () => {
    const work = vi.fn(async () => "reply");
    await expect(
      withMerchantTransactionAuthorization(
        { transaction: {}, resolve: async () => denied(), recheck: async () => true, denied },
        work,
      ),
    ).rejects.toThrow("SYNTHETIC_DENIED");
    expect(work).not.toHaveBeenCalled();
    const tx = {};
    const escaped = await withMerchantTransactionAuthorization(
      { transaction: tx, resolve: async () => ({}), recheck: async () => true, denied },
      async (authority) => authority.guard,
    );
    expect(await escaped(tx)).toBe(false);
  });

  it("does not return the reply when the work fails, and runs no re-check", async () => {
    const recheck = vi.fn(async () => true);
    await expect(
      withMerchantTransactionAuthorization(
        { transaction: {}, resolve: async () => ({}), recheck, denied },
        async () => {
          throw new Error("SYNTHETIC_OWNER_FAILURE");
        },
      ),
    ).rejects.toThrow("SYNTHETIC_OWNER_FAILURE");
    expect(recheck).not.toHaveBeenCalled();
  });
});

/**
 * Static guard (WP-2423): an owner-read authorization callback (`authorize`, `authorizeQueue`,
 * `authorizeKitchen`, `authorizeDining`, `authorizeAndFence` …) must not re-resolve the caller's
 * merchant scope — directly (`.allowed()`, `.authorizeAction(`, `resolve(`, `resolveScope(`) or
 * through a local helper that does. Merchant reads use `withMerchantTransactionAuthorization`.
 *
 * Modules that still re-resolve inside owner callbacks are listed below with their current
 * count (2026-10-14); the list may only shrink. They are commands (writes, out of this change's
 * scope) and a few merchant screens outside the polled reads migrated first (inventory items,
 * stock counts, Store configuration, refund payment context, role administration, table QR codes,
 * receipt profile). A new read must use withMerchantTransactionAuthorization instead.
 */
const knownOccurrences: Readonly<Record<string, number>> = {
  "merchant-card-machine-payment.ts": 4,
  "merchant-card-machine-refund.ts": 1,
  "merchant-counter-order.ts": 2,
  "merchant-dining-closing-command.ts": 2,
  "merchant-dining-host-selection.ts": 1,
  "merchant-dining-host-transfer.ts": 1,
  "merchant-dining-join-regenerate.ts": 1,
  "merchant-dining-order-close-command.ts": 5,
  "merchant-dining-session-start.ts": 1,
  "merchant-dining-table-qr.ts": 1,
  "merchant-inventory-items.ts": 1,
  "merchant-kitchen-command.ts": 2,
  "merchant-mfa-step-up.ts": 3,
  "merchant-order-acceptance-hold-refund.ts": 1,
  "merchant-order-item-staff-cancellation.ts": 11,
  "merchant-order-staff-cancellation.ts": 3,
  "merchant-ordinary-refund-decline.ts": 1,
  "merchant-pickup-handoff.ts": 1,
  "merchant-pickup-not-collected.ts": 1,
  "merchant-pickup-proof.ts": 1,
  "merchant-reconciliation-follow-up-transactions.ts": 1,
  "merchant-refund-payment-context.ts": 3,
  "merchant-refund-transactions.ts": 1,
  "merchant-role-administration.ts": 1,
  "merchant-sole-operator-setting.ts": 2,
  "merchant-stock-counts.ts": 1,
  "merchant-store-configuration-ordinary.ts": 1,
  "merchant-store-configuration-reference-sources.ts": 2,
  "merchant-store-configuration.ts": 4,
  "merchant-store-receipt-profile.ts": 1,
};

/** The source text of the expression that starts at `start`, up to its end in the enclosing list. */
function expressionText(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return source.slice(start, index);
      depth -= 1;
    } else if ((char === "," || char === ";") && depth === 0) return source.slice(start, index);
  }
  return source.slice(start);
}

const escape = (name: string) => name.replace(/[$]/gu, "\\$");

/**
 * Owner-read callbacks in `source` (a module that resolves the merchant scope with
 * `createMerchantStoreScope`) that re-resolve it in full: a call to the resolver, to a resolved
 * scope's `.allowed()` / `.authorizeAction(`, or to a local helper that does either.
 */
export function ownerReadFullResolutions(source: string): number {
  if (!/\bcreate(?:Initially\w*)?MerchantStoreScope\b/u.test(source)) return 0;
  const resolvers = [
    ...source.matchAll(/\b(\w+)\s*=\s*create(?:Initially\w*)?MerchantStoreScope\(/gu),
  ].map((match) => match[1] as string);
  const direct = new RegExp(
    [
      "\\.allowed\\(\\)",
      "\\.authorizeAction\\(",
      ...resolvers.map((name) => "\\b" + escape(name) + "\\("),
    ].join("|"),
    "u",
  );
  const helpers = new Set<string>();
  const declaration =
    /(?:const|let)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=;]+)?=>|(?:async\s+)?function\s+(\w+)\s*\(/gu;
  const callsHelper = (text: string) =>
    [...helpers].some((helper) => new RegExp("\\b" + escape(helper) + "\\b", "u").test(text));
  for (let changed = true; changed;) {
    changed = false;
    for (const match of source.matchAll(declaration)) {
      const name = match[1] ?? match[2];
      if (name === undefined || helpers.has(name) || resolvers.includes(name)) continue;
      const body = expressionText(source, (match.index ?? 0) + match[0].length);
      if (direct.test(body) || callsHelper(body)) {
        helpers.add(name);
        changed = true;
      }
    }
  }
  let count = 0;
  for (const match of source.matchAll(/\bauthorize\w*\s*:\s*/gu)) {
    const body = expressionText(source, (match.index ?? 0) + match[0].length);
    if (direct.test(body) || callsHelper(body)) count += 1;
  }
  return count;
}

describe("owner-read authorization static guard", () => {
  it("flags an owner-read callback that re-resolves the merchant scope", () => {
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const s = createStore({ authorize: async () => (await scope.allowed()) === true });",
      ),
    ).toBe(1);
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const still = async () => (await current.authorizeAction('x'))?.effect === 'Allow';\n" +
          "const r = read({ authorize: still });",
      ),
    ).toBe(1);
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const again = async (tx) => resolve(tx, cookie, 'x');\n" +
          "const r = read({ authorize: async (tx) => (await again(tx)) !== null });",
      ),
    ).toBe(1);
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const r = read({ authorize: (tx) => authority.guard(tx) });",
      ),
    ).toBe(0);
  });

  it("finds no new owner read that re-resolves the merchant scope in apps/api", () => {
    const directory = new URL(".", import.meta.url);
    const found: Record<string, number> = {};
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const count = ownerReadFullResolutions(readFileSync(new URL(file, directory), "utf8"));
      if (count > 0) found[file] = count;
    }
    const regressions = Object.entries(found).filter(
      ([file, count]) => count > (knownOccurrences[file] ?? 0),
    );
    expect(regressions).toEqual([]);
  });
});
