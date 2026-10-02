import { describe, it, expect } from "vitest";
import {
  buildRecipeReferenceSourceSnapshot,
  parseRecipeReferenceSourceSnapshot,
  parseRecipeReferenceSourceRequest,
  createPostgresRecipeReferenceSourceStore,
  recipeReferenceSourceFields,
  RecipeWorkflowError,
} from "../index.js";
const id = (n: number) => `01902416-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw() {
  const parent = { recipeReference: id(10), recipeVersionReference: id(11), brandReference: id(1) },
    period = { effectiveFrom: "2027-01-01T00:00:00.000Z", effectiveUntil: null as string | null };
  return {
    generation: "7",
    bindingCount: "1",
    observedAt: at,
    counts: { recipes: "2", versions: "1", bindings: "1", modifiers: "2" },
    recipes: [
      {
        recipeReference: id(10),
        brandReference: id(1),
        aggregateVersion: 3,
        currentVersionReference: id(11) as string | null,
        updatedAt: at,
        precise: true,
      },
      {
        recipeReference: id(12),
        brandReference: id(1),
        aggregateVersion: 1,
        currentVersionReference: null as string | null,
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        ...parent,
        versionNumber: 1,
        lifecycle: "Published",
        snapshotDigest: digest,
        ...period,
        timeZone: "America/Toronto",
        createdAt: at,
        precise: true,
      },
    ],
    bindings: [
      {
        ...parent,
        bindingReference: id(20),
        skuReference: id(21),
        storeReference: id(99) as string | null,
        optionBindingReference: null as string | null,
        ...period,
        precise: true,
      },
    ],
    modifiers: [1, 2].map((version) => ({
      ...parent,
      ruleVersionReference: id(30 + version),
      ruleReference: id(30),
      bindingReference: id(40),
      optionReference: id(41),
      version,
      selectedQuantity: 1,
      lifecycle: version === 1 ? "Draft" : "Archived",
      ruleDigest: digest,
      ...period,
      occurredAt: at,
      precise: true,
    })),
  };
}
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
describe("complete minimal owning Recipe reference graph", () => {
  it("retains nullable root, all modifier history and unknown Store without applicability", () => {
    const s = buildRecipeReferenceSourceSnapshot(raw(), request, at);
    expect(s.recipes[1]?.currentVersionReference).toBe(null);
    expect(s.bindings[0]?.storeReference).toBe(id(99));
    expect(s.modifiers.map((m) => m.lifecycle)).toEqual(["Draft", "Archived"]);
    expect(s.applicability).toBe("Unavailable");
    expect(Object.isFrozen(s.bindings[0])).toBe(true);
    expect(parseRecipeReferenceSourceSnapshot(s, request, at)).toEqual(s);
  });
  it("sorts stable data independent from observation", () => {
    const r = raw(),
      s = buildRecipeReferenceSourceSnapshot(r, request, at);
    r.recipes.reverse();
    r.modifiers.reverse();
    r.observedAt = "2026-09-29T12:00:01.000Z";
    expect(buildRecipeReferenceSourceSnapshot(r, request, r.observedAt).digest).toBe(s.digest);
  });
  it("permits truly empty new Brand only", () => {
    const e = {
      generation: null,
      bindingCount: null,
      observedAt: at,
      counts: { recipes: "0", versions: "0", bindings: "0", modifiers: "0" },
      recipes: [],
      versions: [],
      bindings: [],
      modifiers: [],
    };
    expect(buildRecipeReferenceSourceSnapshot(e, request, at).generation).toBe("0");
    expect(() =>
      buildRecipeReferenceSourceSnapshot({ ...raw(), generation: null }, request, at),
    ).toThrow(denied);
  });
  it.each([
    "count",
    "bindingCount",
    "brand",
    "rootDuplicate",
    "pointer",
    "versionRoot",
    "versionDuplicate",
    "bindingParent",
    "bindingDuplicate",
    "modifierParent",
    "modifierGap",
    "modifierDuplicate",
    "precision",
    "zone",
    "offsetZone",
    "period",
    "calendar",
    "quantity",
    "generation",
  ])("refuses incomplete or incoherent %s", (kind) => {
    const r = raw(),
      root = r.recipes[0],
      version = r.versions[0],
      binding = r.bindings[0],
      modifier = r.modifiers[0],
      second = r.modifiers[1];
    if (!root || !version || !binding || !modifier || !second) throw new Error("fixture missing");
    if (kind === "count") r.counts.recipes = "3";
    if (kind === "bindingCount") r.bindingCount = "0";
    if (kind === "brand") root.brandReference = id(9);
    if (kind === "rootDuplicate") r.recipes[1] = root;
    if (kind === "pointer") root.currentVersionReference = id(99);
    if (kind === "versionRoot") version.recipeReference = id(12);
    if (kind === "versionDuplicate") {
      r.versions.push(version);
      r.counts.versions = "2";
    }
    if (kind === "bindingParent") binding.recipeVersionReference = id(99);
    if (kind === "bindingDuplicate") {
      r.bindings.push(binding);
      r.counts.bindings = r.bindingCount = "2";
    }
    if (kind === "modifierParent") modifier.recipeReference = id(12);
    if (kind === "modifierGap") second.version = 3;
    if (kind === "modifierDuplicate") second.ruleVersionReference = modifier.ruleVersionReference;
    if (kind === "precision") binding.precise = false;
    if (kind === "zone") version.timeZone = "Unavailable/Zone";
    if (kind === "offsetZone") version.timeZone = "+01:00";
    if (kind === "period") binding.effectiveUntil = binding.effectiveFrom;
    if (kind === "calendar") root.updatedAt = "2026-02-30T00:00:00.000Z";
    if (kind === "quantity") modifier.selectedQuantity = 10001;
    if (kind === "generation") r.generation = "9223372036854775808";
    expect(() => buildRecipeReferenceSourceSnapshot(r, request, at)).toThrow(denied);
  });
  it("refuses getters without invoking them, unexpected fields, stale source and changed intent", () => {
    let calls = 0;
    const r = raw();
    Object.defineProperty(r, "generation", {
      enumerable: true,
      get() {
        calls++;
        return "7";
      },
    });
    expect(() => buildRecipeReferenceSourceSnapshot(r, request, at)).toThrow(denied);
    expect(calls).toBe(0);
    expect(() => parseRecipeReferenceSourceRequest({ ...request, cost: "1" })).toThrow(denied);
    expect(() =>
      buildRecipeReferenceSourceSnapshot(raw(), request, "2026-09-29T12:00:05.001Z"),
    ).toThrow(denied);
    const s = buildRecipeReferenceSourceSnapshot(raw(), request, at);
    expect(() =>
      parseRecipeReferenceSourceSnapshot(s, { ...request, operationReference: id(9) }, at),
    ).toThrow(denied);
    expect(() =>
      parseRecipeReferenceSourceSnapshot({ ...s, digest: "sha256:" + "b".repeat(64) }, request, at),
    ).toThrow(denied);
  });
  it("refuses expanded aggregate budget instead of truncating", () => {
    const r = raw(),
      binding = r.bindings[0];
    if (!binding) throw new Error("fixture missing");
    r.bindings = Array.from({ length: 10000 }, (_, i) => ({
      ...binding,
      bindingReference: id(100 + i),
    }));
    r.counts.bindings = r.bindingCount = "10000";
    expect(() => buildRecipeReferenceSourceSnapshot(r, request, at)).toThrow(denied);
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
      if (q.includes(" AS header")) rows = [{ header: { generation, bindingCount: "1" } }];
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
          requiredFields: recipeReferenceSourceFields,
        });
        events.push("authorize");
        if (!allow) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
      },
    },
  };
  return {
    options,
    tx,
    source: createPostgresRecipeReferenceSourceStore(options),
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
    const source = createPostgresRecipeReferenceSourceStore({
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
