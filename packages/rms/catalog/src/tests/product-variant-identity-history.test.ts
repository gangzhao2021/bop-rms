import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import { CatalogError, type ProductLifecycleTransaction } from "../index.js";
import { createPostgresProductVariantIdentityHistorySource } from "../infrastructure/persistence/product-reference-history-source-store.js";
import {
  buildProductVariantIdentityHistory,
  parseProductVariantIdentityHistorySnapshot,
  assertProductVariantIdentityHistory,
  parseProductVariantCreationRequest,
  buildProductVariantCreationAbsence,
  parseProductVariantCreationAbsence,
  assertProductVariantCreationAbsence,
} from "../contracts/product-variant-identity-history.js";
const id = (n: number) => `019a2421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T03:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function candidate(full = true) {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "VARIANT_HISTORY",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic" },
          variantSelections: [{ dimensionReference: id(6), valueReference: id(7) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      ...(full
        ? {
            editorContent: {
              profile: "CatalogProductEditorContentV1",
              localizedShortDescriptions: {},
              localizedDescriptions: { "en-CA": "Private synthetic note omitted from source" },
              preparationNotes: {},
              tagReferences: [],
              attributeValues: [],
              media: [],
              variantDimensions: [
                {
                  dimensionReference: id(6),
                  code: "SIZE",
                  localizedNames: { "en-CA": "Size" },
                  sortOrder: 0,
                  selectionRequirement: "Required",
                  values: [
                    {
                      valueReference: id(7),
                      code: "SMALL",
                      localizedNames: { "en-CA": "Small" },
                      sortOrder: 0,
                      attributeReference: null,
                      mediaReference: null,
                    },
                  ],
                },
              ],
              variantCombinations: [
                {
                  selections: [{ dimensionReference: id(6), valueReference: id(7) }],
                  disposition: "Valid",
                  skuReference: id(5),
                },
              ],
              optionRules: [],
              allergenReferences: [],
              nutritionProfile: null,
            },
          }
        : {}),
    },
  });
}
function fixture(full = true) {
  const aggregate = candidate(full),
    request = {
      productReference: id(1),
      expectedAggregateVersion: 1,
      originalIntentDigest: hash("actual candidate intent"),
    };
  const source = {
    aggregateVersion: 1,
    observedAt: at,
    history: [
      { aggregate, operationReference: id(9), snapshotDigest: hash(aggregate), coherent: true },
    ],
  };
  return { aggregate, request, source };
}
it.each(["ClosedCatalogError", "UnknownDriverError"] as const)(
  "actual variant history consumer preserves only closed dependency errors: %s",
  async (kind) => {
    const f = fixture(),
      original =
        kind === "ClosedCatalogError"
          ? new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE")
          : new Error("Synthetic private callback detail"),
      query = vi.fn(async (sql: string) =>
        sql.includes("transaction_isolation")
          ? { rows: [{ isolation: "read committed" }] }
          : sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")
            ? { rows: [] }
            : { rows: [{ source: f.source }] },
      ),
      tx: ProductLifecycleTransaction = { query: query as ProductLifecycleTransaction["query"] },
      hold = vi.fn(async () => undefined),
      store = createPostgresProductVariantIdentityHistorySource({
        tenantReference: id(20),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => at },
        transactions: { run: async (work) => work(tx) },
        authority: { holdUntilTransactionCompletes: hold },
      }),
      work = vi.fn(async () => {
        throw original;
      });
    let caught: unknown;
    try {
      await store.withCurrentSnapshot(f.request, work);
    } catch (error) {
      caught = error;
    }
    expect(work).toHaveBeenCalledOnce();
    expect(hold).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(CatalogError);
    expect(caught).toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      message: "catalog is unavailable",
    });
    if (kind === "ClosedCatalogError") expect(caught).toBe(original);
    else expect(caught).not.toBe(original);
  },
);
function creation() {
  const old = candidate(),
    content = old.draft.editorContent;
  if (!content) throw Error("Missing synthetic content");
  const aggregate = parseProductAggregate({
    ...old,
    draft: {
      ...old.draft,
      skus: [],
      editorContent: {
        ...content,
        variantCombinations: [
          {
            selections: [{ dimensionReference: id(6), valueReference: id(7) }],
            disposition: "NotGenerated",
            skuReference: null,
          },
        ],
      },
    },
  });
  return {
    profile: "CatalogProductVariantCreationRequestV1" as const,
    operationReference: id(9),
    aggregate,
    originalIntentDigest: hash("actual Create intent"),
    observedAt: at,
    validUntil: "2026-09-30T03:00:05.000Z",
  };
}
it("keeps nonempty initial Variant definitions as a distinct absent-history proof, never V1 history", () => {
  const raw = structuredClone(creation()),
    request = parseProductVariantCreationRequest(raw),
    proof = buildProductVariantCreationAbsence(
      { productExists: false, operationExists: false, historyExists: false, observedAt: at },
      request,
    );
  expect(request.aggregate.draft.editorContent?.variantDimensions).toHaveLength(1);
  expect(request.aggregate.draft.editorContent?.variantCombinations[0]?.disposition).toBe(
    "NotGenerated",
  );
  expect(proof.absence).toBe("NoRecordedProductOrOperation");
  expect(proof.eligibility).toBe("NotEvaluated");
  expect(Object.hasOwn(proof, "used")).toBe(false);
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.aggregate)).toBe(true);
  expect(Object.isFrozen(proof)).toBe(true);
  expect(parseProductVariantCreationAbsence(proof)).toEqual(proof);
  expect(() => assertProductVariantCreationAbsence(request, proof)).not.toThrow();
  expect(() => parseProductVariantIdentityHistorySnapshot(proof)).toThrow();
  Object.assign(raw.aggregate, { internalCode: "CHANGED" });
  expect(request.aggregate.internalCode).toBe("VARIANT_HISTORY");
  expect(() => assertProductVariantCreationAbsence(raw, proof)).toThrow();
});
it.each(["productExists", "operationExists", "historyExists"])(
  "refuses actual %s rather than treating it as empty history",
  (field) => {
    const raw = {
      productExists: false,
      operationExists: false,
      historyExists: false,
      observedAt: at,
      [field]: true,
    };
    expect(() => buildProductVariantCreationAbsence(raw, creation())).toThrow();
  },
);
it.each(["root", "actor-clock", "lease", "unknown", "missing-content", "base-version"])(
  "rejects invalid initial Create %s",
  (kind) => {
    const r = structuredClone(creation());
    if (kind === "root") Object.assign(r.aggregate, { aggregateVersion: 2 });
    if (kind === "actor-clock")
      Object.assign(r.aggregate, { createdAt: "2026-09-30T03:00:01.000Z" });
    if (kind === "lease") r.validUntil = "2026-09-30T03:00:05.001Z";
    if (kind === "unknown") Object.assign(r, { used: [] });
    if (kind === "missing-content") Reflect.deleteProperty(r.aggregate.draft, "editorContent");
    if (kind === "base-version") Object.assign(r.aggregate.draft, { baseVersionReference: id(50) });
    expect(() => parseProductVariantCreationRequest(r)).toThrow();
  },
);
it("refuses request getters, forged snapshot digests and a differently bound original operation", () => {
  const request = creation(),
    getter = vi.fn(() => request.aggregate),
    raw: Record<string, unknown> = { ...request };
  Object.defineProperty(raw, "aggregate", { enumerable: true, get: getter });
  expect(() => parseProductVariantCreationRequest(raw)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const proof = buildProductVariantCreationAbsence(
    { productExists: false, operationExists: false, historyExists: false, observedAt: at },
    request,
  );
  expect(() => parseProductVariantCreationAbsence({ ...proof, digest: hash("other") })).toThrow();
  const body = { ...proof, operationReference: id(99) };
  const { digest: ignored, ...changed } = body;
  void ignored;
  expect(() =>
    assertProductVariantCreationAbsence(request, { ...changed, digest: hash(changed) }),
  ).toThrow();
});
it("derives complete minimal used identities without content prose or sale eligibility", () => {
  const f = fixture(),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  expect(snapshot.used).toEqual([
    { dimensionReference: id(6), dimensionCode: "SIZE", valueReference: id(7), valueCode: "SMALL" },
  ]);
  expect(snapshot.eligibility).toBe("NotEvaluated");
  expect(JSON.stringify(snapshot)).not.toContain("Private synthetic");
  expect(parseProductVariantIdentityHistorySnapshot(snapshot)).toEqual(snapshot);
  expect(() => assertProductVariantIdentityHistory(f.aggregate, snapshot)).not.toThrow();
});
it("retains legacy SKU identities with unknown codes, without inventing definitions", () => {
  const f = fixture(false),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  expect(snapshot.used[0]?.dimensionCode).toBeNull();
  expect(snapshot.used[0]?.valueCode).toBeNull();
  expect(() => assertProductVariantIdentityHistory(candidate(), snapshot)).not.toThrow();
});
it.each(["dimension", "value", "remove"])(
  "refuses historical %s reinterpretation or removal",
  (kind) => {
    const f = fixture(),
      snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request),
      changed = structuredClone(f.aggregate);
    if (!changed.draft.editorContent) throw new Error("Missing fixture content");
    if (kind === "remove") {
      Object.assign(changed.draft.editorContent, {
        variantDimensions: [],
        variantCombinations: [],
      });
      Object.assign(changed.draft.skus[0] ?? {}, { variantSelections: [] });
    } else {
      const d = changed.draft.editorContent.variantDimensions[0];
      if (!d) throw new Error("Missing fixture dimension");
      if (kind === "dimension") Object.assign(d, { code: "NEW_CODE" });
      else Object.assign(d.values[0] ?? {}, { code: "NEW_CODE" });
    }
    expect(() => assertProductVariantIdentityHistory(changed, snapshot)).toThrow();
  },
);
it.each(["gap", "digest", "coherence", "brand", "future", "duplicate"])(
  "refuses %s in committed history",
  (kind) => {
    const f = fixture(),
      source = structuredClone(f.source),
      row = source.history[0];
    if (!row) throw new Error("Missing fixture history");
    if (kind === "gap") source.history = [];
    if (kind === "digest") row.snapshotDigest = hash("tampered");
    if (kind === "coherence") row.coherent = false;
    if (kind === "brand") {
      Object.assign(row.aggregate, { brandReference: id(99) });
      row.snapshotDigest = hash(row.aggregate);
    }
    if (kind === "future") source.observedAt = "2026-09-29T00:00:00.000Z";
    if (kind === "duplicate") source.history.push(row);
    expect(() => buildProductVariantIdentityHistory(source, id(2), f.request)).toThrow();
  },
);
it("refuses unbound candidate Brand/Product/root and snapshot digest changes", () => {
  const f = fixture(),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  for (const patch of [
    { productReference: id(99) },
    { brandReference: id(99) },
    { aggregateVersion: 4 },
  ])
    expect(() =>
      assertProductVariantIdentityHistory({ ...f.aggregate, ...patch }, snapshot),
    ).toThrow();
  expect(() =>
    parseProductVariantIdentityHistorySnapshot({
      ...snapshot,
      originalIntentDigest: hash("other intent"),
    }),
  ).toThrow();
});
it("does not invoke historical aggregate accessors", () => {
  const f = fixture(),
    getter = vi.fn(() => f.aggregate),
    row = { ...f.source.history[0] };
  Object.defineProperty(row, "aggregate", { enumerable: true, get: getter });
  expect(() =>
    buildProductVariantIdentityHistory({ ...f.source, history: [row] }, id(2), f.request),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("preserves earlier usage even after the current SKU stops selecting it", () => {
  const f = fixture(),
    changed = structuredClone(f.aggregate);
  if (!changed.draft.editorContent) throw new Error("Missing fixture content");
  Object.assign(changed, { aggregateVersion: 2 });
  Object.assign(changed.draft.editorContent, { variantDimensions: [], variantCombinations: [] });
  Object.assign(changed.draft.skus[0] ?? {}, { variantSelections: [] });
  const source = {
    ...f.source,
    aggregateVersion: 2,
    history: [
      ...f.source.history,
      {
        aggregate: changed,
        operationReference: id(10),
        snapshotDigest: hash(changed),
        coherent: true,
      },
    ],
  };
  const snapshot = buildProductVariantIdentityHistory(source, id(2), {
    ...f.request,
    expectedAggregateVersion: 2,
  });
  expect(snapshot.used).toHaveLength(1);
  expect(() => assertProductVariantIdentityHistory(changed, snapshot)).toThrow();
});
it("refuses historical dimension code reuse on a different used value", () => {
  const f = fixture(),
    changed = structuredClone(f.aggregate);
  const d = changed.draft.editorContent?.variantDimensions[0],
    c = changed.draft.editorContent?.variantCombinations[0];
  if (!d || !c) throw new Error("Missing fixture mapping");
  Object.assign(changed, { aggregateVersion: 2 });
  Object.assign(d, { code: "REINTERPRETED" });
  Object.assign(d.values[0] ?? {}, { valueReference: id(8) });
  Object.assign(c, { selections: [{ dimensionReference: id(6), valueReference: id(8) }] });
  Object.assign(changed.draft.skus[0] ?? {}, {
    variantSelections: [{ dimensionReference: id(6), valueReference: id(8) }],
  });
  const source = {
    ...f.source,
    aggregateVersion: 2,
    history: [
      ...f.source.history,
      {
        aggregate: changed,
        operationReference: id(10),
        snapshotDigest: hash(changed),
        coherent: true,
      },
    ],
  };
  expect(() =>
    buildProductVariantIdentityHistory(source, id(2), {
      ...f.request,
      expectedAggregateVersion: 2,
    }),
  ).toThrow();
});
