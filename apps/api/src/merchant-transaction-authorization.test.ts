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

  it("reads the Store scope's own refusal in the final re-check as a denial, other failures as failures", async () => {
    const ended = () => Promise.reject(new Error("STORE_SERVICE_PERMISSION_DENIED"));
    await expect(
      withMerchantTransactionAuthorization(
        { transaction: {}, resolve: async () => ({}), recheck: ended, denied },
        async () => "reply",
      ),
    ).rejects.toThrow("SYNTHETIC_DENIED");
    await expect(
      withMerchantTransactionAuthorization(
        { transaction: {}, resolve: async () => ({}), recheck: async () => true, denied },
        async (authority) => {
          authority.recheckBeforeReply(ended);
          return "reply";
        },
      ),
    ).rejects.toThrow("SYNTHETIC_DENIED");
    await expect(
      withMerchantTransactionAuthorization(
        {
          transaction: {},
          resolve: async () => ({}),
          recheck: () => Promise.reject(new Error("SYNTHETIC_LOCK_TIMEOUT")),
          denied,
        },
        async () => "reply",
      ),
    ).rejects.toThrow("SYNTHETIC_LOCK_TIMEOUT");
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
 * merchant scope — directly (`.allowed()`, `.authorizeAction(s)(`, `resolve(`, `resolveScope(`, a
 * resolved scope's `allowed` passed on as the callback, or `allowed` destructured from it) or
 * through a local helper that does. Merchant reads and commands use
 * `withMerchantTransactionAuthorization`.
 *
 * Modules that still re-resolve inside owner callbacks are listed below with their current
 * count; the list may only shrink. Every merchant command and read migrated on 2026-10-15
 * (commands resolve the caller once at the start and once before the commit, inside the
 * transaction). The one left is the Store setup save, whose authoring reads renew a time-bounded
 * authorization lease (`authorizationValidUntil`) on each read by design; it is a rare
 * configuration write, not a busy-Store command. A new command or read must use
 * withMerchantTransactionAuthorization instead.
 */
const knownOccurrences: Readonly<Record<string, number>> = {
  "merchant-store-setup.ts": 1,
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
      // A call, or the resolver passed on as an owner callback (`authorize: current.allowed`).
      "\\.allowed\\b",
      "\\.authorizeActions?\\(",
      // `allowed` destructured from a resolved scope (`const { allowed } = await resolve(...)`).
      ...(/\{[^}]*\ballowed\b[^}]*\}\s*=\s*await\s+\w+\(/u.test(source) ? ["\\ballowed\\("] : []),
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
    // The resolver passed on as the callback, and `allowed` destructured from a resolved scope.
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const r = read({ context, authorize: current.allowed });",
      ),
    ).toBe(1);
    expect(
      ownerReadFullResolutions(
        "const resolve = createMerchantStoreScope(source);\n" +
          "const { store, allowed } = await resolve(tx, cookie, 'x');\n" +
          "const r = read({ authorize: async () => (await allowed()) === true });",
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
