import { describe, it, expect } from "vitest";
import {
  buildRecipeInventoryReferenceSnapshot,
  parseRecipeInventoryReferenceSnapshot,
  parseRecipeInventoryReferenceRequest,
  createPostgresRecipeInventoryReferenceSourceStore,
  recipeInventoryReferenceFields,
  RecipeWorkflowError,
  type RecipeInventoryChangeReference,
} from "../index.js";
const id = (n: number) => `01902417-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing");
  return value;
}
function raw() {
  const period = {
    effectiveFrom: "2027-01-01T00:00:00.000Z",
    effectiveUntil: null as string | null,
  };
  return {
    generation: "7" as string | null,
    observedAt: at,
    counts: { recipes: "2", versions: "2", ingredients: "2", modifiers: "2", changes: "3" },
    recipes: [10, 20].map((n) => ({
      recipeReference: id(n),
      brandReference: id(1),
      aggregateVersion: 2,
      currentVersionReference: id(n + 1) as string | null,
      updatedAt: at,
      precise: true,
    })),
    versions: [10, 20].map((n) => ({
      recipeReference: id(n),
      recipeVersionReference: id(n + 1),
      brandReference: id(1),
      versionNumber: 1,
      lifecycle: "Archived",
      snapshotDigest: digest,
      ...period,
      timeZone: "America/Toronto",
      createdAt: at,
      precise: true,
    })),
    ingredients: [
      {
        requirementReference: id(50),
        recipeReference: id(10),
        recipeVersionReference: id(11),
        brandReference: id(1),
        sourceKind: "SubRecipe",
        sourceReference: id(20),
        sourceVersionReference: id(21),
      },
      {
        requirementReference: id(51),
        recipeReference: id(20),
        recipeVersionReference: id(21),
        brandReference: id(1),
        sourceKind: "InventoryItem",
        sourceReference: id(70),
        sourceVersionReference: id(71),
      },
    ],
    modifiers: [1, 2].map((version) => ({
      ruleReference: id(30),
      ruleVersionReference: id(30 + version),
      recipeReference: id(20),
      recipeVersionReference: id(21),
      brandReference: id(1),
      bindingReference: id(40),
      optionReference: id(41),
      version,
      lifecycle: version === 1 ? "Draft" : "Archived",
      ruleDigest: digest,
      ...period,
      occurredAt: at,
      changeCount: version === 1 ? 2 : 1,
      precise: true,
    })),
    changes: [
      {
        ruleVersionReference: id(31),
        sequence: 1,
        action: "Add",
        requirementReference: id(60),
        sourceKind: "InventoryItem",
        sourceReference: id(80),
        sourceVersionReference: id(81),
      },
      { ruleVersionReference: id(31), sequence: 2, action: "Remove", requirementReference: id(99) },
      {
        ruleVersionReference: id(32),
        sequence: 1,
        action: "Replace",
        requirementReference: id(51),
        replacementRequirementReference: id(61),
        sourceKind: "SubRecipe",
        sourceReference: id(10),
        sourceVersionReference: id(11),
      },
    ] as RecipeInventoryChangeReference[],
  };
}
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
describe("complete stored Recipe Inventory references", () => {
  it("retains pinned operation UUID, all historical conditional changes and unresolved removal", () => {
    const s = buildRecipeInventoryReferenceSnapshot(raw(), request, at);
    expect(s.ingredients[1]?.sourceVersionReference).toBe(id(71));
    expect(s.changes.map((c) => c.action)).toEqual(["Add", "Remove", "Replace"]);
    expect(s.removalResolution).toBe("Unavailable");
    expect(s.conditionalApplicability).toBe("Unavailable");
    expect(s.versions.map((v) => v.lifecycle)).toEqual(["Archived", "Archived"]);
    expect(Object.keys(s.ingredients[1] ?? {})).toHaveLength(7);
    expect(Object.isFrozen(s.changes[0])).toBe(true);
    expect(parseRecipeInventoryReferenceSnapshot(s, request, at)).toEqual(s);
  });
  it("sorts without including observation in stable digest", () => {
    const r = raw(),
      s = buildRecipeInventoryReferenceSnapshot(r, request, at);
    r.ingredients.reverse();
    r.changes.reverse();
    r.observedAt = "2026-09-29T12:00:01.000Z";
    expect(buildRecipeInventoryReferenceSnapshot(r, request, r.observedAt).digest).toBe(s.digest);
  });
  it("supports empty root/version/change arrays without inventing Inventory use", () => {
    const r = raw();
    r.ingredients = [];
    r.changes = [];
    r.modifiers.forEach((m) => (m.changeCount = 0));
    r.counts.ingredients = r.counts.changes = "0";
    expect(buildRecipeInventoryReferenceSnapshot(r, request, at).changes).toEqual([]);
    const empty = {
      generation: null,
      observedAt: at,
      counts: { recipes: "0", versions: "0", ingredients: "0", modifiers: "0", changes: "0" },
      recipes: [],
      versions: [],
      ingredients: [],
      modifiers: [],
      changes: [],
    };
    expect(buildRecipeInventoryReferenceSnapshot(empty, request, at).generation).toBe("0");
  });
  it.each([
    "count",
    "generation",
    "brand",
    "currentPointer",
    "duplicateRoot",
    "duplicateVersion",
    "ingredientParent",
    "duplicateIngredient",
    "subRecipeVersion",
    "baseCycle",
    "modifierParent",
    "modifierSequence",
    "changeDuplicate",
    "changeGap",
    "changeParent",
    "changeCount",
    "conditionalMissingVersion",
    "precise",
    "time",
    "zone",
    "extra",
  ])("refuses incoherent %s", (kind) => {
    const r = raw(),
      root = required(r.recipes[0]),
      v = required(r.versions[0]),
      i = required(r.ingredients[0]),
      m = required(r.modifiers[0]);
    if (kind === "count") r.counts.changes = "4";
    if (kind === "generation") r.generation = null;
    if (kind === "brand") root.brandReference = id(9);
    if (kind === "currentPointer") root.currentVersionReference = id(21);
    if (kind === "duplicateRoot") r.recipes[1] = root;
    if (kind === "duplicateVersion") r.versions[1] = v;
    if (kind === "ingredientParent") i.recipeReference = id(20);
    if (kind === "duplicateIngredient") {
      r.ingredients.push(i);
      r.counts.ingredients = "3";
    }
    if (kind === "subRecipeVersion") i.sourceVersionReference = id(11);
    if (kind === "baseCycle") {
      Object.assign(required(r.ingredients[1]), {
        sourceKind: "SubRecipe",
        sourceReference: id(10),
        sourceVersionReference: id(11),
      });
    }
    if (kind === "modifierParent") m.recipeVersionReference = id(11);
    if (kind === "modifierSequence") required(r.modifiers[1]).version = 3;
    if (kind === "changeDuplicate") r.changes[1] = required(r.changes[0]);
    if (kind === "changeGap") r.changes[1] = { ...required(r.changes[1]), sequence: 3 };
    if (kind === "changeParent")
      r.changes[0] = { ...required(r.changes[0]), ruleVersionReference: id(99) };
    if (kind === "changeCount") m.changeCount = 1;
    if (kind === "conditionalMissingVersion")
      Object.assign(required(r.changes[2]), { sourceVersionReference: id(99) });
    if (kind === "precise") v.precise = false;
    if (kind === "time") v.createdAt = "2026-02-30T00:00:00.000Z";
    if (kind === "zone") v.timeZone = "Unavailable/Zone";
    if (kind === "extra") Object.assign(i, { unitCostMinorNumerator: "1" });
    expect(() => buildRecipeInventoryReferenceSnapshot(r, request, at)).toThrow(denied);
  });
  it("refuses descriptor attacks, wrong intent, digest, time and aggregate overflow", () => {
    let calls = 0;
    const r = raw();
    Object.defineProperty(r, "generation", {
      enumerable: true,
      get() {
        calls++;
        return "7";
      },
    });
    expect(() => buildRecipeInventoryReferenceSnapshot(r, request, at)).toThrow(denied);
    expect(calls).toBe(0);
    expect(() => parseRecipeInventoryReferenceRequest({ ...request, extra: true })).toThrow(denied);
    const s = buildRecipeInventoryReferenceSnapshot(raw(), request, at);
    expect(() =>
      parseRecipeInventoryReferenceSnapshot(s, { ...request, operationReference: id(90) }, at),
    ).toThrow(denied);
    expect(() =>
      parseRecipeInventoryReferenceSnapshot(
        { ...s, digest: "sha256:" + "b".repeat(64) },
        request,
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      buildRecipeInventoryReferenceSnapshot(raw(), request, "2026-09-29T12:00:05.001Z"),
    ).toThrow(denied);
    const full = raw();
    full.ingredients = Array.from({ length: 10000 }, (_, n) => ({
      ...required(full.ingredients[1]),
      requirementReference: id(100 + n),
    }));
    full.counts.ingredients = "10000";
    expect(() => buildRecipeInventoryReferenceSnapshot(full, request, at)).toThrow(denied);
  });
});
function holder() {
  let generation = "7",
    now = at,
    allow = true;
  const sql: string[] = [],
    events: string[] = [];
  const tx = {
    async query<T extends Record<string, unknown>>(q: string, values: readonly unknown[]) {
      void values;
      sql.push(q);
      let rows: Record<string, unknown>[] = [];
      if (q.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      if (q.startsWith("SELECT jsonb_build_object(")) rows = [{ source: raw() }];
      if (q.includes(" AS header")) rows = [{ header: { generation } }];
      return { rows: rows as T[] };
    },
  };
  const options = {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        const result = await work(tx);
        events.push("commit");
        return result;
      },
    },
    clock: { now: () => now },
    authority: {
      async holdUntilTransactionCompletes(actual: typeof tx, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          request,
          permission: "recipe.manage",
          requiredScope: "FullBrandScope",
          requiredFields: recipeInventoryReferenceFields,
        });
        events.push("authorize");
        if (!allow) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
      },
    },
  };
  return {
    options,
    tx,
    source: createPostgresRecipeInventoryReferenceSourceStore(options),
    sql,
    events,
    mutate: () => {
      generation = "8";
    },
    stale: () => {
      now = "2026-09-29T12:00:05.001Z";
    },
    deny: () => {
      allow = false;
    },
  };
}
describe("same caller UoW Recipe source lifetime", () => {
  it("holds exact current field authority and shared fence until consumer return and outer commit", async () => {
    const h = holder(),
      marker = { done: true };
    expect(
      await h.source.withCurrentSnapshot(request, async (source) => {
        expect(source.recipes).toHaveLength(2);
        h.events.push("consumer");
        return marker;
      }),
    ).toBe(marker);
    expect(h.events).toEqual(["authorize", "authorize", "consumer", "authorize", "commit"]);
    expect(h.sql.some((q) => q.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  });
  it.each(["mutation", "stale", "permission"])(
    "denies late %s before outer completion",
    async (kind) => {
      const h = holder();
      await expect(
        h.source.withCurrentSnapshot(request, async () => {
          h.events.push("consumer");
          if (kind === "mutation") h.mutate();
          if (kind === "stale") h.stale();
          if (kind === "permission") h.deny();
          return true;
        }),
      ).rejects.toMatchObject({
        code: kind === "permission" ? "RECIPE_PERMISSION_DENIED" : "RECIPE_DEPENDENCY_UNAVAILABLE",
      });
      expect(h.events).toContain("consumer");
      expect(h.events).not.toContain("commit");
    },
  );
  it.each(["substituted", "repeated", "isolation"])("refuses %s runner evidence", async (kind) => {
    const h = holder();
    const source = createPostgresRecipeInventoryReferenceSourceStore({
      ...h.options,
      transactions: {
        async run<T>(work: (actual: typeof h.tx) => Promise<T>): Promise<T> {
          if (kind === "isolation")
            return work({
              query: async <T extends Record<string, unknown>>(q: string, v: readonly unknown[]) =>
                q.includes("transaction_isolation")
                  ? { rows: [{ isolation: "repeatable read" }] as unknown as T[] }
                  : h.tx.query<T>(q, v),
            });
          const selected = await work(h.tx);
          if (kind === "repeated") return work(h.tx);
          void selected;
          return {} as T;
        },
      },
    });
    await expect(source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("denies foreign request and current permission before source SQL", async () => {
    const h = holder();
    await expect(
      h.source.withCurrentSnapshot({ ...request, brandReference: id(99) }, async () => true),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    expect(h.sql).toEqual([]);
    h.deny();
    await expect(h.source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "RECIPE_PERMISSION_DENIED",
    });
    expect(h.sql).toEqual([]);
  });
});
