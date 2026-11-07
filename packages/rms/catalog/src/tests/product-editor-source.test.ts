import { parseProductAggregate } from "../contracts/product.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
import { beforeEach, expect, it, vi } from "vitest";
import { createPostgresProductEditorSourceStore } from "../infrastructure/persistence/product-editor-source-store.js";
import {
  buildCatalogProductEditorSnapshot,
  parseCatalogProductEditorSnapshot,
  productEditorSnapshotFields,
} from "../contracts/product-editor-snapshot.js";
const state = vi.hoisted(() => ({ load: vi.fn(), factory: vi.fn() }));
vi.mock("../infrastructure/persistence/product-lifecycle-store.js", () => ({
  createPostgresProductLifecycleStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01902441-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z",
  until = "2026-09-30T22:00:05.000Z";
const query = () => ({ productReference: id(5), expectedAggregateVersion: 3 });
function aggregate() {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "EDITOR",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic editor" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: { "en-CA": "Synthetic complete description" },
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };
}
beforeEach(() => {
  state.load.mockReset();
  state.factory.mockReset();
});
function fixture() {
  let clock = at,
    isolation = "read committed";
  const tx = { query: vi.fn() },
    hold = vi.fn(async () => undefined),
    run = vi.fn();
  tx.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("transaction_isolation") ? [{ isolation }] : [],
  }));
  run.mockImplementation(async (work: (t: ProductLifecycleTransaction) => Promise<unknown>) =>
    work(tx),
  );
  state.load.mockResolvedValue(aggregate());
  state.factory.mockReturnValue({ load: state.load });
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    transactions: { run },
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: () => clock },
  };
  const source = createPostgresProductEditorSourceStore(options);
  return {
    tx,
    hold,
    run,
    source,
    options,
    setClock: (v: string) => {
      clock = v;
    },
    setIsolation: (v: string) => {
      isolation = v;
    },
  };
}
it("reads complete current content in the same transaction without a Validate command", async () => {
  const f = fixture();
  const r = await f.source.withCurrentSnapshot(query(), async (view, tx) => {
    expect(tx).toBe(f.tx);
    expect(view.aggregate.draft.editorContent).toEqual(aggregate().draft.editorContent);
    return view;
  });
  expect(r).toMatchObject({
    contentStatus: "Present",
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    observedAt: at,
    validUntil: until,
  });
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.hold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      actorKind: "User",
      permission: "catalog.manage",
      owningAction: "catalog.product.manage",
      purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
      requiredFields: productEditorSnapshotFields,
    }),
  );
  expect(state.load).toHaveBeenCalledWith(id(5));
  expect(parseCatalogProductEditorSnapshot(r)).toEqual(r);
});
it("keeps absent legacy content unavailable rather than inventing an empty value", async () => {
  const f = fixture(),
    a = aggregate();
  Reflect.deleteProperty(a.draft, "editorContent");
  state.load.mockResolvedValue(a);
  const r = await f.source.withCurrentSnapshot(query(), async (v) => v);
  expect(r.contentStatus).toBe("Unavailable");
  expect(Object.hasOwn(r.aggregate.draft, "editorContent")).toBe(false);
});
it.each(["missing", "root", "brand", "product", "future"])(
  "refuses %s current owner data",
  async (mode) => {
    const f = fixture(),
      a = aggregate();
    if (mode === "root") a.aggregateVersion++;
    if (mode === "brand") a.brandReference = id(9);
    if (mode === "product") a.productReference = id(9);
    if (mode === "future") a.updatedAt = until;
    state.load.mockResolvedValue(mode === "missing" ? null : a);
    const work = vi.fn();
    await expect(f.source.withCurrentSnapshot(query(), work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  },
);
it("requires complete current fields before any private read", async () => {
  const f = fixture();
  f.hold.mockRejectedValue(new Error("synthetic denial"));
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).rejects.toThrow();
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(state.load).not.toHaveBeenCalled();
});
it.each([until, "2026-09-30T21:59:59.999Z"])(
  "keeps original observation bounds after consumer %s",
  async (time) => {
    const f = fixture();
    await expect(
      f.source.withCurrentSnapshot(query(), async (v) => {
        f.setClock(time);
        return v;
      }),
    ).rejects.toThrow();
  },
);
it("checks expiry again after the final field holder", async () => {
  const f = fixture();
  f.hold.mockImplementation(async () => {
    if (f.hold.mock.calls.length === 3) f.setClock(until);
  });
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).rejects.toThrow();
});
it("checks original expiry after a slow outer runner completes", async () => {
  const f = fixture();
  f.run.mockImplementation(async (work) => {
    const r = await work(f.tx);
    f.setClock(until);
    return r;
  });
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).rejects.toThrow();
});
it.each(["repeat", "substitute", "skip"])("refuses defective %s runner", async (mode) => {
  const f = fixture();
  f.run.mockImplementation(async (work) => {
    if (mode === "skip") return {} as never;
    const r = await work(f.tx);
    if (mode === "repeat") {
      try {
        await work(f.tx);
      } catch {
        /* explicit defective runner */
      }
    }
    return mode === "substitute" ? ({} as never) : r;
  });
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).rejects.toThrow();
});
it("refuses unsupported isolation before lifecycle reads", async () => {
  const f = fixture();
  f.setIsolation("repeatable read");
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).rejects.toThrow();
  expect(state.load).not.toHaveBeenCalled();
});
it("captures configuration and method identity before options replacement", async () => {
  const f = fixture();
  f.options.actorReference = id(99);
  f.options.authority.holdUntilTransactionCompletes = vi.fn();
  await expect(f.source.withCurrentSnapshot(query(), async (v) => v)).resolves.toMatchObject({
    contentStatus: "Present",
  });
  expect(f.hold).toHaveBeenCalledWith(f.tx, expect.objectContaining({ actorReference: id(3) }));
});
it.each(["extra", "getter", "negativeRoot"])(
  "refuses %s request before transaction",
  async (mode) => {
    const f = fixture(),
      q = query(),
      get = vi.fn(() => id(5));
    if (mode === "extra") Object.assign(q, { validation: "Pass" });
    if (mode === "getter") Object.defineProperty(q, "productReference", { get, enumerable: true });
    if (mode === "negativeRoot") q.expectedAggregateVersion = -1;
    await expect(f.source.withCurrentSnapshot(q, async (v) => v)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  },
);
it.each(["digest", "content", "expiry", "qualification", "extra", "getter"])(
  "refuses %s envelope tampering",
  (mode) => {
    const view = structuredClone(
      buildCatalogProductEditorSnapshot(
        aggregate(),
        { tenantReference: id(1), brandReference: id(2) },
        query(),
        at,
      ),
    );
    const get = vi.fn(() => at);
    if (mode === "digest") Object.assign(view, { digest: "sha256:" + "0".repeat(64) });
    if (mode === "content")
      Object.assign(view.aggregate.draft.localizedNames, { "en-CA": "Changed" });
    if (mode === "expiry") Object.assign(view, { validUntil: "2026-09-30T22:01:00.000Z" });
    if (mode === "qualification") Object.assign(view, { eligibility: "Eligible" });
    if (mode === "extra") Object.assign(view, { approval: "Approved" });
    if (mode === "getter") Object.defineProperty(view, "observedAt", { get, enumerable: true });
    expect(() => parseCatalogProductEditorSnapshot(view)).toThrow();
    expect(get).not.toHaveBeenCalled();
  },
);
it("keeps the returned graph detached from the current reader object", async () => {
  const f = fixture(),
    a = aggregate();
  state.load.mockResolvedValue(a);
  const r = await f.source.withCurrentSnapshot(query(), async (v) => {
    a.draft.localizedNames["en-CA"] = "Changed";
    return v;
  });
  expect(r.aggregate.draft.localizedNames["en-CA"]).toBe("Synthetic editor");
  expect(Object.isFrozen(r.aggregate.draft.editorContent)).toBe(true);
});
it("requires a configured field holder", () => {
  const f = fixture();
  expect(() =>
    createPostgresProductEditorSourceStore({ ...f.options, authority: {} } as never),
  ).toThrow();
});

it("refuses a structurally valid full snapshot beyond its bounded byte envelope", () => {
  const a = aggregate();
  Reflect.deleteProperty(a.draft, "editorContent");
  const names = Object.fromEntries([
    ["en-CA", "S".repeat(120)],
    ...Array.from({ length: 127 }, (_, i) => [
      "aa-" + String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
      "S".repeat(120),
    ]),
  ]);
  Object.assign(a.draft, {
    skus: Array.from({ length: 600 }, (_, i) => ({
      skuReference: id(1000 + i),
      productReference: id(5),
      brandReference: id(2),
      skuCode: "SYNTHETIC_" + i,
      lifecycle: "Draft",
      localizedNames: names,
      variantSelections: [{ dimensionReference: id(2000), valueReference: id(3000 + i) }],
      unitOfSale: "EA",
      unitQuantity: "1",
      createdAt: at,
      createdByActorReference: id(3),
    })),
  });
  expect(() => parseProductAggregate(a)).not.toThrow();
  expect(new TextEncoder().encode(JSON.stringify(a)).length).toBeGreaterThan(8 * 1024 * 1024);
  expect(() =>
    buildCatalogProductEditorSnapshot(
      a,
      { tenantReference: id(1), brandReference: id(2) },
      query(),
      at,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});
