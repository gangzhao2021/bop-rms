import { expect, it, vi } from "vitest";
import { parseProductAggregate, CatalogError } from "../contracts/product.js";
import {
  createPostgresProductOptionPriceContextSourceStore,
  productOptionPriceContextSourceFields,
} from "../infrastructure/persistence/product-option-price-context-source-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const contextId = (n: number) => "01902441-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const contextAt = "2026-09-30T22:00:00.000Z",
  contextUntil = "2026-09-30T22:00:05.000Z";
const contextRequest = () => ({
  productReference: contextId(5),
  expectedAggregateVersion: 3,
  bindingReference: contextId(20),
  optionReference: contextId(23),
});
function contextAggregate() {
  return parseProductAggregate({
    productReference: contextId(5),
    brandReference: contextId(2),
    internalCode: "PRICE_CONTEXT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: contextAt,
    createdByActorReference: contextId(3),
    updatedAt: contextAt,
    draft: {
      versionReference: contextId(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic context" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [
        {
          bindingReference: contextId(20),
          optionSetReference: contextId(21),
          optionSetVersionReference: contextId(22),
          purpose: "CUSTOMIZATION",
          sortOrder: 0,
          enabledOptionReferences: [contextId(23)],
          defaultSelections: [],
          minimumSelectionOverride: null,
          maximumSelectionOverride: null,
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: [],
          storeOverrideAllowed: false,
        },
      ],
      createdAt: contextAt,
      updatedAt: contextAt,
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: { "en-CA": "Synthetic complete content" },
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [
          {
            bindingReference: contextId(20),
            versionResolution: "CurrentPublished",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
}
function fixture() {
  let clock = contextAt,
    aggregate = contextAggregate(),
    lease = contextUntil,
    deny = false;
  const guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.includes("statement_timeout")) {
      expect(values).toHaveLength(1);
      expect(values[0]).toMatch(/^[1-9][0-9]*$/u);
      expect(Number(values[0])).toBeLessThanOrEqual(5000);
    }
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("jsonb_build_object"))
      return { rows: [{ snapshot: aggregate, precise: true }] };
    return { rows: [] };
  });
  const tx: ProductLifecycleTransaction = {
    query: async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
      const value = await query(sql, values);
      return value as unknown as { rows: readonly Row[] };
    },
  };
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        _tx: ProductLifecycleTransaction,
        input: { owningAction: string; purposeCode: string; requiredFields: readonly string[] },
      ) => {
        expect(input.owningAction).toBe("catalog.product.read");
        expect(input.purposeCode).toBe("CATALOG_PRODUCT_OPTION_PRICE_CONTEXT_READ");
        expect(input.requiredFields).toEqual(productOptionPriceContextSourceFields);
        if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { validUntil: lease };
      },
    ),
  };
  const options = {
    tenantReference: contextId(1),
    brandReference: contextId(2),
    actorReference: contextId(3),
    originalObservedAt: contextAt,
    originalValidUntil: contextUntil,
    clock: { now: () => clock },
    transactions: {
      run: async <T>(work: (actual: ProductLifecycleTransaction) => Promise<T>) => work(tx),
    },
    authority,
    registerBeforeCommit: async (
      _tx: ProductLifecycleTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) => {
      guards.push({ guard, final });
    },
  };
  const store = createPostgresProductOptionPriceContextSourceStore(options);
  const finish = async () => {
    for (const h of guards) await h.guard();
    for (const h of guards) h.final();
    return store.assertFinalized(tx);
  };
  return {
    tx,
    store,
    options,
    guards,
    calls,
    authority,
    finish,
    setClock: (value: string) => {
      clock = value;
    },
    setLease: (value: string) => {
      lease = value;
    },
    revoke: () => {
      deny = true;
    },
    change: () => {
      aggregate = parseProductAggregate({
        ...aggregate,
        draft: { ...aggregate.draft, localizedNames: { "en-CA": "Changed unrelated source" } },
      });
    },
  };
}
it("holds actual Product barrier and read fields, repeats before owning guard then finalizes exact host", async () => {
  const f = fixture();
  const p = await f.store.withCurrentSnapshot(contextRequest(), async (packet) => packet);
  expect(p.binding.bindingReference).toBe(contextId(20));
  expect(f.calls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
  expect(f.calls.some((s) => s.includes("INSERT") || s.includes("UPDATE"))).toBe(false);
  expect(f.guards).toHaveLength(1);
  await f.store.withCurrentSnapshot(
    { ...contextRequest(), optionReference: contextId(23) },
    async (p) => expect(p.aggregateDigest).toMatch(/^sha256:/),
  );
  expect(f.guards).toHaveLength(1);
  expect(await f.finish()).toBe(contextUntil);
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => undefined),
  ).rejects.toThrow();
});
it("permits exact source reread in earlier Context guard before owning guard begins", async () => {
  const f = fixture();
  const reread = async () => {
    await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  };
  await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  await reread();
  expect(await f.finish()).toBe(contextUntil);
});
it("rejects unrelated aggregate change during callback and poisons swallowed failure", async () => {
  const f = fixture();
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => f.change()),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  const first = f.guards.at(0);
  expect(first).toBeDefined();
  await expect(first?.guard()).rejects.toThrow();
  expect(() => first?.final()).toThrow();
});
it("rechecks current read permission through COMMIT", async () => {
  const f = fixture();
  await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  f.revoke();
  await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("rejects late source changes in actual owning final revalidation", async () => {
  const f = fixture();
  await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  f.change();
  await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
});
it("honors shorter actual source lease and remaining SQL timeouts", async () => {
  const f = fixture();
  f.setLease("2026-09-30T22:00:02.000Z");
  const p = await f.store.withCurrentSnapshot(contextRequest(), async (p) => p);
  expect(p.validUntil).toBe("2026-09-30T22:00:02.000Z");
  f.setClock(p.validUntil);
  await expect(f.finish()).rejects.toThrow();
  expect(f.calls.filter((s) => s.includes("statement_timeout")).length).toBeGreaterThan(0);
});
it("rejects backward clock even within original interval", async () => {
  const f = fixture();
  f.setClock("2026-09-30T22:00:01.000Z");
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => f.setClock(contextAt)),
  ).rejects.toThrow();
});
it("rejects captured query mutation and foreign borrowed transaction", async () => {
  const f = fixture();
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => {
      f.tx.query = async () => ({ rows: [] });
    }),
  ).rejects.toThrow();
  const g = fixture();
  await g.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  g.options.transactions.run = async <T>(
    work: (actual: ProductLifecycleTransaction) => Promise<T>,
  ) => work({ ...g.tx });
  await expect(
    g.store.withCurrentSnapshot(contextRequest(), async () => undefined),
  ).rejects.toThrow();
});
it("rejects object replacement even when same method is retained", async () => {
  const f = fixture();
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => {
      f.options.authority = { ...f.options.authority };
    }),
  ).rejects.toThrow();
});
it("refuses overlapping public reads and callback failure", async () => {
  const f = fixture();
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () =>
      f.store.withCurrentSnapshot(contextRequest(), async () => undefined),
    ),
  ).rejects.toThrow();
  const g = fixture();
  await expect(
    g.store.withCurrentSnapshot(contextRequest(), async () => {
      throw new Error("private callback failure");
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("requires actual exact-once completed async and sync guards", async () => {
  const f = fixture();
  await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  expect(() => f.store.assertFinalized(f.tx)).toThrow();
  const g = fixture();
  await g.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  const h = g.guards.at(0);
  expect(h).toBeDefined();
  expect(() => h?.final()).toThrow();
  const j = fixture();
  await j.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  const k = j.guards.at(0);
  await k?.guard();
  await expect(k?.guard()).rejects.toThrow();
});
it("rejects fake registration returns without assuming callback success", async () => {
  const f = fixture();
  Object.assign(f.options, { registerBeforeCommit: async () => true });
  const source = createPostgresProductOptionPriceContextSourceStore(f.options);
  await expect(
    source.withCurrentSnapshot(contextRequest(), async () => undefined),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("cannot retarget a held host to another saved Binding or Choice", async () => {
  const f = fixture();
  await f.store.withCurrentSnapshot(contextRequest(), async () => undefined);
  await expect(
    f.store.withCurrentSnapshot(
      { ...contextRequest(), optionReference: null },
      async () => undefined,
    ),
  ).rejects.toThrow();
});
it("refuses source expiry during callback before returning a held packet", async () => {
  const f = fixture();
  await expect(
    f.store.withCurrentSnapshot(contextRequest(), async () => f.setClock(contextUntil)),
  ).rejects.toThrow();
});
