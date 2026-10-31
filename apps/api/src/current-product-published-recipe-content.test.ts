import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createCurrentProductPublishedRecipeContentSource as create } from "./current-product-published-recipe-content.js";
import type { CurrentProductStoreRecipePolicy } from "./current-product-store-recipe-policy.js";
import type { CurrentPublishedRecipeContent } from "@rms/recipe";
const protocol = vi.hoisted(() => ({ selection: vi.fn(), content: vi.fn() }));
vi.mock("./current-product-store-recipe-policy.js", () => ({
  createCurrentProductStoreRecipePolicySource: () => ({
    withCurrentResolution: protocol.selection,
  }),
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createCurrentPublishedRecipeContentSource: protocol.content,
}));
const id = (n: number) => `018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T18:00:00.000Z",
  until = "2026-08-13T18:00:05.000Z";
let clock = at,
  denied = false,
  childCalls = 0,
  repeated = false,
  substitute = false,
  baseLate = false as boolean | "expiry";
const tx = { query: vi.fn(async () => ({ rows: [] })) };
const resolution = () =>
  ({
    profile: "CurrentProductStoreRecipePolicyV1",
    tenantReference: id(9),
    originalObservedAt: at,
    validUntil: until,
    recipe: {
      decision: denied ? "HardError" : "PassForDirectBrandAndStoreBindings",
      operationReference: id(80),
      originalIntentDigest: "sha256:" + "d".repeat(64),
      activationAt: "2026-08-14T00:00:00.000Z",
      resolutions: [6, 7].map((n) => ({
        skuReference: id(n),
        status: "ResolvedStoredVersion",
        recipeReference: id(1),
        recipeVersionReference: id(2),
      })),
    },
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  }) as unknown as CurrentProductStoreRecipePolicy;
// Synthetic factory protocol only; actual owning data/parsers are tested separately.
const content = {
  profile: "CurrentPublishedRecipeContentV1",
  tenantReference: id(9),
  validUntil: until,
  contents: [],
  childReferences: "NotEvaluated",
  eligibility: "NotEvaluated",
} as unknown as CurrentPublishedRecipeContent;
function options() {
  return {
    tenantReference: id(9),
    brandReference: id(10),
    actorReference: id(3),
    clock: { now: () => clock },
    catalogAuthority: {
      async holdUntilTransactionCompletes() {
        return;
      },
    },
    recipeAuthority: {
      async holdUntilTransactionCompletes() {
        return;
      },
    },
    storeAuthority: {
      async withCurrentBrandReferenceRead<T>(_r: unknown, work: () => Promise<T>) {
        return work();
      },
      async isCurrent() {
        return true;
      },
    },
    brandAuthority: {
      async withCurrentContentRead<T>(_r: unknown, _f: unknown, work: () => Promise<T>) {
        return work();
      },
      async isCurrent() {
        return true;
      },
    },
    contentAuthority: {
      async holdUntilTransactionCompletes(actual: unknown, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({ tenantReference: id(9) });
        if (denied) throw new Error("synthetic current fields denied");
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  denied = false;
  clock = at;
  childCalls = 0;
  repeated = false;
  substitute = false;
  baseLate = false;
  protocol.selection.mockImplementation(async (actual, value, work) => {
    expect(actual).toBe(tx);
    expect(value).toEqual({ original: "selector" });
    const answer = await work(resolution());
    if (baseLate && baseLate === "expiry") clock = until;
    else if (baseLate) throw new Error("synthetic final policy change");
    return answer;
  });
  protocol.content.mockImplementation((actual) => ({
    async withCurrentContent(
      value: unknown,
      work: (v: CurrentPublishedRecipeContent) => Promise<unknown>,
    ) {
      childCalls++;
      expect(value).toMatchObject({
        request: {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(10),
          actorReference: id(3),
          operationReference: id(80),
          catalogIntentDigest: "sha256:" + "d".repeat(64),
        },
        observedAt: at,
        validUntil: until,
        activationAt: "2026-08-14T00:00:00.000Z",
        recipeVersions: [{ recipeReference: id(1), versionReference: id(2) }],
      });
      return actual.transactions.run(async (facade: unknown) => {
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(9) });
        const answer = await work(content);
        if (repeated) await work(content);
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(9) });
        return substitute ? { substitute: true } : answer;
      });
    },
  }));
});
it("deduplicates selected whole versions, holds original Tx and returns bounded incomplete content", async () => {
  const h = options();
  const source = create(h);
  h.brandReference = id(99);
  h.actorReference = id(99);
  h.contentAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replacement");
  };
  const answer = await source.withCurrentContent(tx, { original: "selector" }, async (c) => {
    expect(c.selection.recipe.resolutions).toHaveLength(2);
    expect(c.recipeContents).toBe(content);
    expect(c.publishValidation).toBe("Incomplete");
    const { digest, ...body } = c;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
    return "ok";
  });
  expect(answer).toBe("ok");
  expect(childCalls).toBe(1);
});
it("refuses unavailable selection before content work", async () => {
  denied = true;
  await expect(
    create(options()).withCurrentContent(tx, { original: "selector" }, async () => "no"),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(childCalls).toBe(0);
});
it.each([
  "fields",
  "query",
  "base",
  "duplicate",
  "substitute",
  "reentry",
  "expiry",
  "rollbackClock",
  "outerExpiry",
])("refuses late %s and poisoned UoW", async (key) => {
  const source = create(options());
  let entered = false;
  await expect(
    source.withCurrentContent(tx, { original: "selector" }, async () => {
      entered = true;
      if (key === "fields") denied = true;
      if (key === "query") tx.query = vi.fn(async () => ({ rows: [] }));
      if (key === "base") baseLate = true;
      if (key === "outerExpiry") baseLate = "expiry";
      if (key === "expiry") clock = until;
      if (key === "rollbackClock") clock = "2026-08-13T17:59:59.999Z";
      if (key === "duplicate") repeated = true;
      if (key === "substitute") substitute = true;
      if (key === "reentry")
        await source
          .withCurrentContent(tx, { original: "selector" }, async () => "no")
          .catch(() => undefined);
      return "no";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(entered).toBe(true);
  await expect(
    source.withCurrentContent(tx, { original: "selector" }, async () => "no"),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
