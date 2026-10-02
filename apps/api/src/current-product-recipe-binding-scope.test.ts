import { it, expect, vi, beforeEach } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  productPricingBindingCurrentSourceFields,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import { buildRecipeReferenceSourceSnapshot } from "@rms/recipe";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRaw as raw,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import { createCurrentProductRecipeBindingScopeSource as create } from "./current-product-recipe-binding-scope.js";
const protocol = vi.hoisted(() => ({ catalog: vi.fn(), recipe: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPricingBindingSourceStore: protocol.catalog,
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createPostgresRecipeReferenceSourceStore: protocol.recipe,
}));
type Options = Parameters<typeof create>[0];
type Tx = Parameters<ReturnType<typeof create>["withCurrentScope"]>[0];
const request: ProductLifecycleReviewRequest = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW",
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(3),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 2,
  originalProductVersionReference: id(5),
  beforeLifecycle: "Draft",
  targetLifecycle: "Archived",
  reasonCode: "SYNTHETIC",
  activeSkuCount: 0,
};
const input = () => ({
  request,
  observedAt: at,
  validUntil: "2026-09-29T12:00:20.000Z",
  activationAt: "2026-09-30T00:00:00.000Z",
});
let clock: string,
  changed: boolean,
  denied: boolean,
  duplicate: boolean,
  wrongResult: boolean,
  holds: number;
const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) };
function catalogSource() {
  return buildProductPricingBindingSourceSnapshot(
    {
      observedAt: at,
      targetExists: true,
      precise: true,
      versionReference: id(5),
      categoryClassificationKnown: false,
      categoryReferences: null,
      primaryCategoryReference: null,
      taxClassificationReference: null,
      skuReferences: [id(6)],
      bindings: [
        {
          bindingReference: id(20),
          optionSetReference: id(70),
          optionSetVersionReference: id(71),
          enabledOptionReferences: [id(changed ? 81 : 80)],
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: [],
        },
      ],
    },
    request,
    at,
  );
}
function options(): Options {
  return {
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => clock },
    catalogAuthority: {
      async holdUntilTransactionCompletes(actual) {
        expect(actual).toBe(tx);
        holds++;
        if (denied) throw new Error("synthetic fields revoked");
      },
    },
    recipeAuthority: {
      async holdUntilTransactionCompletes(actual) {
        expect(actual).toBe(tx);
        holds++;
        if (denied) throw new Error("synthetic recipe revoked");
      },
    },
  };
}
beforeEach(() => {
  clock = at;
  changed = denied = duplicate = wrongResult = false;
  holds = 0;
  tx.query = vi.fn(async () => ({ rows: [] }));
  protocol.catalog.mockImplementation(
    (
      o: Parameters<
        typeof import("@rms/catalog").createPostgresProductPricingBindingSourceStore
      >[0],
    ) => ({
      async withCurrentSnapshot(
        r: ProductLifecycleReviewRequest,
        work: (v: ReturnType<typeof catalogSource>) => Promise<unknown>,
      ) {
        return o.transactions.run(async (actual) => {
          await o.authority.holdUntilTransactionCompletes(actual, {
            tenantReference: id(9),
            actorReference: id(2),
            request: r,
            purposeCode: "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ",
            permission: "catalog.manage",
            requiredFields: productPricingBindingCurrentSourceFields,
            observedAt: o.clock.now(),
          });
          const result = await work(catalogSource());
          if (duplicate) await work(catalogSource());
          return wrongResult ? {} : result;
        });
      },
    }),
  );
  protocol.recipe.mockImplementation(
    (o: Parameters<typeof import("@rms/recipe").createPostgresRecipeReferenceSourceStore>[0]) => ({
      async withCurrentSnapshot(
        r: Parameters<typeof buildRecipeReferenceSourceSnapshot>[1],
        work: (v: ReturnType<typeof buildRecipeReferenceSourceSnapshot>) => Promise<unknown>,
      ) {
        return o.transactions.run(async (actual) => {
          const hold = () =>
            o.authority.holdUntilTransactionCompletes(actual, {
              tenantReference: id(9),
              request: r,
              observedAt: o.clock.now(),
              requiredFields: [],
              permission: "recipe.manage",
              requiredScope: "FullBrandScope",
            });
          await hold();
          const v = raw();
          v.bindings = [];
          v.modifiers = [];
          v.bindingCount = "0";
          v.counts.bindings = "0";
          v.counts.modifiers = "0";
          const result = await work(buildRecipeReferenceSourceSnapshot(v, r, at));
          await hold();
          return result;
        });
      },
    }),
  );
});
const deniedError = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("directly constructs both public owners on the original transaction with original intent, deadline and final current read", async () => {
  const r = await create(options()).withCurrentScope(tx, input(), async (a) => a);
  expect(r.profile).toBe("CurrentProductRecipeBindingScopeV1");
  expect(r.recipe.eligibility).toBe("NotEvaluated");
  expect(r.publishValidation).toBe("Incomplete");
  expect(r.validUntil).toBe("2026-09-29T12:00:05.000Z");
  expect(holds).toBe(4);
  const { digest, ...body } = r;
  expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
});
it.each(["fields", "query", "expiry", "backward", "graph", "duplicate", "result"])(
  "refuses late %s after callback",
  async (kind) => {
    const provider = create(options());
    let reached = false;
    await expect(
      provider.withCurrentScope(tx, input(), async () => {
        reached = true;
        if (kind === "fields") denied = true;
        if (kind === "query") tx.query = vi.fn(async () => ({ rows: [] }));
        if (kind === "expiry") clock = "2026-09-29T12:00:05.000Z";
        if (kind === "backward") clock = "2026-09-29T11:59:59.999Z";
        if (kind === "graph") changed = true;
        if (kind === "duplicate") duplicate = true;
        if (kind === "result") wrongResult = true;
        return "answer";
      }),
    ).rejects.toThrow(deniedError);
    expect(reached).toBe(true);
  },
);
it("caught recursive admission poisons the outer transaction", async () => {
  const p = create(options());
  await expect(
    p.withCurrentScope(tx, input(), async () => {
      await expect(p.withCurrentScope(tx, input(), async () => "nested")).rejects.toThrow(
        deniedError,
      );
      return "outer";
    }),
  ).rejects.toThrow(deniedError);
});
it.each([
  "target",
  "Ready",
  "tenant",
  "wrongActor",
  "wrongBrand",
  "past",
  "long",
  "futureObservation",
])("rejects %s before work", async (kind) => {
  let v: unknown = input();
  if (kind === "target") v = { ...input(), target: {} };
  if (kind === "Ready") v = { ...input(), Ready: true };
  if (kind === "tenant") v = { ...input(), tenantReference: id(10) };
  if (kind === "wrongActor") v = { ...input(), request: { ...request, actorReference: id(10) } };
  if (kind === "wrongBrand") v = { ...input(), request: { ...request, brandReference: id(10) } };
  if (kind === "past") v = { ...input(), validUntil: at };
  if (kind === "long") v = { ...input(), validUntil: "2026-09-29T12:00:30.001Z" };
  if (kind === "futureObservation") v = { ...input(), observedAt: "2026-09-29T12:00:00.001Z" };
  const work = vi.fn(async () => true);
  await expect(create(options()).withCurrentScope(tx, v, work)).rejects.toThrow(deniedError);
  expect(work).not.toHaveBeenCalled();
});
it("captures clock/holders and keeps the earliest original deadline", async () => {
  const o = options(),
    p = create(o);
  o.clock.now = () => {
    throw new Error("replaced");
  };
  o.catalogAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced");
  };
  const r = await p.withCurrentScope(
    tx,
    { ...input(), validUntil: "2026-09-29T12:00:01.000Z" },
    async (r) => r,
  );
  expect(r.validUntil).toBe("2026-09-29T12:00:01.000Z");
});
