import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import {
  productVariantCreationFields,
  parseProductVariantCreationRequest,
  type ProductVariantCreationAbsence,
} from "../contracts/product-variant-identity-history.js";
import {
  createPostgresProductVariantCreationSource,
  type ProductVariantCreationSourceOptions,
} from "../infrastructure/persistence/product-reference-history-source-store.js";

const id = (n: number) => `019a2421-0100-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T15:00:00.000Z",
  until = "2026-10-04T15:00:05.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
type Tx = Parameters<ProductVariantCreationSourceOptions["registerBeforeCommit"]>[0];
function fixture() {
  // Controlled SQL fixture; no native persistence or permission fact is claimed.
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "INITIAL_VARIANT",
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
      localizedNames: { "en-CA": "Synthetic initial Product" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
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
            disposition: "NotGenerated",
            skuReference: null,
          },
        ],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  const request = {
    profile: "CatalogProductVariantCreationRequestV1" as const,
    operationReference: id(9),
    aggregate,
    originalIntentDigest: hash("full actual synthetic Create"),
    observedAt: at,
    validUntil: until,
  };
  const state = {
    now: at,
    deny: false,
    isolation: "read committed",
    source: {
      productExists: false,
      operationExists: false,
      historyExists: false,
      observedAt: at,
    } as unknown,
    resultOverride: undefined as unknown,
  };
  const events: string[] = [],
    sql: { sql: string; values: readonly unknown[] }[] = [],
    guards: { async: () => Promise<void>; final: () => void }[] = [];
  const query: Tx["query"] = async <Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ) => {
    sql.push({ sql: text, values });
    events.push(text.includes("'productExists'") ? "absence" : "query");
    const result = text.includes("transaction_isolation")
      ? { rows: [{ isolation: state.isolation }] }
      : text.includes("'productExists'")
        ? (state.resultOverride ?? { rows: [{ source: state.source }] })
        : { rows: [] };
    return result as { rows: readonly Row[]; rowCount?: number | null };
  };
  const tx: Tx = { query },
    authority = vi.fn<
      ProductVariantCreationSourceOptions["authority"]["holdUntilTransactionCompletes"]
    >(async () => {
      events.push("authority");
      if (state.deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    register = vi.fn<ProductVariantCreationSourceOptions["registerBeforeCommit"]>(
      async (actual, guard, final) => {
        expect(actual).toBe(tx);
        events.push("registered");
        guards.push({ async: guard, final });
      },
    );
  const options: ProductVariantCreationSourceOptions = {
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => state.now },
    transactions: { run: (work) => work(tx) },
    authority: { holdUntilTransactionCompletes: authority },
    registerBeforeCommit: register,
  };
  const source = createPostgresProductVariantCreationSource(options);
  return {
    aggregate,
    request,
    state,
    events,
    sql,
    guards,
    tx,
    authority,
    register,
    options,
    source,
    async commit() {
      for (const guard of guards) await guard.async();
      for (const guard of guards) guard.final();
      events.push("commit");
    },
  };
}

it("reads actual absence under original writer lock order and binds full nonempty initial Variant content", async () => {
  const f = fixture(),
    token = Object.freeze({ accepted: true }),
    consumer = vi.fn(async (proof: ProductVariantCreationAbsence, tx: Tx) => {
      expect(tx).toBe(f.tx);
      expect(proof).toMatchObject({
        profile: "CatalogProductVariantCreationAbsenceV1",
        productReference: id(1),
        versionReference: id(4),
        operationReference: id(9),
        aggregateSnapshotDigest: hash(f.aggregate),
        originalIntentDigest: f.request.originalIntentDigest,
        absence: "NoRecordedProductOrOperation",
        eligibility: "NotEvaluated",
      });
      expect(Object.isFrozen(proof)).toBe(true);
      return token;
    });
  expect(await f.source.withCreationAbsence(f.request, consumer)).toBe(token);
  expect(f.events[0]).toBe("registered");
  expect(
    f.sql.filter((q) => q.sql.includes("pg_advisory_xact_lock")).map((q) => q.values[0]),
  ).toEqual([
    "CatalogProductSource:" + id(2),
    "CatalogProductOperation:" + id(2) + ":" + id(9),
    "CatalogProduct:" + id(2) + ":" + id(1),
  ]);
  const read = f.sql.find((q) => q.sql.includes("'productExists'"));
  expect(read?.values).toEqual([id(2), id(1), id(9), id(4)]);
  expect(read?.sql).not.toContain("intent_digest=");
  expect(f.authority.mock.calls[0]?.[1]).toMatchObject({
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    purposeCode: "CATALOG_PRODUCT_VARIANT_CREATION_CHECK",
    permission: "catalog.product.history.read",
    owningAction: "catalog.product.create",
    requiredScope: "FullBrandScope",
    request: f.request,
    requiredFields: productVariantCreationFields,
    validUntil: until,
  });
  await f.commit();
  expect(consumer).toHaveBeenCalledOnce();
  expect(f.events.at(-1)).toBe("commit");
});

it("reholds the original proof after this transaction's INSERT without repeating an absence query or renewing time", async () => {
  const f = fixture();
  let original: ProductVariantCreationAbsence | undefined;
  await f.source.withCreationAbsence(f.request, async (proof) => {
    original = proof;
    f.state.source = {
      productExists: true,
      operationExists: true,
      historyExists: true,
      observedAt: at,
    };
  });
  f.state.now = "2026-10-04T15:00:01.000Z";
  await f.source.withCreationAbsence(f.request, async (proof) => expect(proof).toBe(original));
  // A later owning callback may run after this source's own async guard.
  const guard = f.guards[0];
  if (!guard) throw Error("Missing guard");
  await guard.async();
  await f.source.withCreationAbsence(f.request, async (proof) => expect(proof).toBe(original));
  guard.final();
  expect(f.sql.filter((q) => q.sql.includes("'productExists'"))).toHaveLength(1);
  expect(f.register).toHaveBeenCalledOnce();
  expect(original?.validUntil).toBe(until);
});

it.each(["productExists", "operationExists", "historyExists"])(
  "refuses existing %s before a creation consumer",
  async (field) => {
    const f = fixture(),
      work = vi.fn();
    f.state.source = {
      productExists: false,
      operationExists: false,
      historyExists: false,
      observedAt: at,
      [field]: true,
    };
    await expect(f.source.withCreationAbsence(f.request, work)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(work).not.toHaveBeenCalled();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it.each(["brand", "actor", "field", "lease", "root"])(
  "poisons an invalid %s request before SQL even when caught",
  async (kind) => {
    const f = fixture(),
      raw = structuredClone(f.request),
      work = vi.fn();
    if (kind === "brand") Object.assign(raw.aggregate, { brandReference: id(55) });
    if (kind === "actor") Object.assign(raw.aggregate, { createdByActorReference: id(55) });
    if (kind === "field") Object.assign(raw, { used: [] });
    if (kind === "lease") raw.validUntil = "2026-10-04T15:00:05.001Z";
    if (kind === "root") Object.assign(raw.aggregate, { aggregateVersion: 2 });
    await expect(f.source.withCreationAbsence(raw, work)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.sql).toEqual([]);
    expect(work).not.toHaveBeenCalled();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it.each(["missing", "extra", "null-absence", "future", "stale-isolation"])(
  "refuses incomplete or malformed actual SQL %s",
  async (kind) => {
    const f = fixture();
    if (kind === "missing") f.state.resultOverride = { rows: [] };
    if (kind === "extra")
      f.state.resultOverride = { rows: [{ source: f.state.source, extra: true }] };
    if (kind === "null-absence")
      f.state.source = {
        productExists: null,
        operationExists: false,
        historyExists: false,
        observedAt: at,
      };
    if (kind === "future")
      f.state.source = {
        productExists: false,
        operationExists: false,
        historyExists: false,
        observedAt: "2026-10-04T15:00:00.001Z",
      };
    if (kind === "stale-isolation") f.state.isolation = "repeatable read";
    await expect(
      f.source.withCreationAbsence(f.request, async () => undefined),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);

it("captures the original closed input and configured methods before the first await", async () => {
  const f = fixture(),
    raw = structuredClone(f.request),
    replacement = vi.fn(async () => {
      throw Error("replacement");
    });
  f.authority.mockImplementationOnce(async () => {
    Object.assign(raw.aggregate, { internalCode: "MUTATED" });
    Object.assign(raw, { operationReference: id(99) });
    Object.assign(f.options.authority, { holdUntilTransactionCompletes: replacement });
    Object.assign(f.options.transactions, { run: replacement });
    Object.assign(f.options.clock, { now: () => until });
  });
  const proof = await f.source.withCreationAbsence(raw, async (p) => p);
  expect(proof.operationReference).toBe(id(9));
  expect(proof.aggregateSnapshotDigest).toBe(hash(f.aggregate));
  await f.commit();
  expect(replacement).not.toHaveBeenCalled();
});

it("retains poison after a swallowed nested entry or a changed second request", async () => {
  for (const nested of [true, false]) {
    const f = fixture();
    let caught: unknown;
    if (nested) {
      await expect(
        f.source.withCreationAbsence(f.request, async () => {
          try {
            await f.source.withCreationAbsence(f.request, async () => undefined);
          } catch (error) {
            caught = error;
          }
        }),
      ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    } else {
      await f.source.withCreationAbsence(f.request, async () => undefined);
      try {
        await f.source.withCreationAbsence(
          { ...f.request, operationReference: id(99) },
          async () => undefined,
        );
      } catch (error) {
        caught = error;
      }
    }
    expect(caught).toBeInstanceOf(CatalogError);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  }
});

it.each(["denial", "clock", "query", "consumer"])(
  "keeps failure through outer COMMIT after %s",
  async (kind) => {
    const f = fixture();
    if (kind === "consumer") {
      await expect(
        f.source.withCreationAbsence(f.request, async () => {
          throw Error("private callback failure");
        }),
      ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    } else {
      await f.source.withCreationAbsence(f.request, async () => undefined);
      if (kind === "denial") f.state.deny = true;
      if (kind === "clock") f.state.now = until;
      if (kind === "query") Object.assign(f.tx, { query: async () => ({ rows: [] }) });
    }
    await expect(f.commit()).rejects.toMatchObject({
      code: kind === "denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.events).not.toContain("commit");
  },
);

it("final sync assertion catches a later authority consuming the original deadline", async () => {
  const f = fixture();
  await f.source.withCreationAbsence(f.request, async () => undefined);
  const guard = f.guards[0];
  if (!guard) throw Error("Missing guard");
  await guard.async();
  f.state.now = until;
  expect(() => guard.final()).toThrow(CatalogError);
});

it("requires exactly one completed async guard before the synchronous final assertion", async () => {
  const f = fixture();
  await f.source.withCreationAbsence(f.request, async () => undefined);
  const guard = f.guards[0];
  if (!guard) throw Error("Missing guard");
  expect(() => guard.final()).toThrow(CatalogError);
  const second = fixture();
  await second.source.withCreationAbsence(second.request, async () => undefined);
  const g = second.guards[0];
  if (!g) throw Error("Missing guard");
  await g.async();
  await expect(g.async()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(() => g.final()).toThrow(CatalogError);
});

function baseSkuRequest() {
  const f = fixture(),
    content = f.aggregate.draft.editorContent;
  if (!content) throw Error("Missing content");
  const sku = {
    skuReference: id(10),
    productReference: id(1),
    brandReference: id(2),
    skuCode: "BASE",
    lifecycle: "Draft",
    localizedNames: { "en-CA": "Base" },
    variantSelections: [],
    unitOfSale: "SYNTHETIC",
    unitQuantity: "1",
    createdAt: at,
    createdByActorReference: id(3),
  };
  return {
    ...f.request,
    aggregate: {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        skus: [sku],
        editorContent: { ...content, variantDimensions: [], variantCombinations: [] },
      },
    },
  };
}
it("binds an actual allocated single base SKU into original Create absence", async () => {
  const f = fixture(),
    request = baseSkuRequest(),
    parsed = parseProductVariantCreationRequest(request);
  expect(parsed.aggregate.draft.skus).toHaveLength(1);
  await f.source.withCreationAbsence(request, async (proof) => {
    expect(proof.aggregateSnapshotDigest).toBe(hash(parsed.aggregate));
  });
  await f.commit();
  expect(f.events).toContain("commit");
});
it.each([
  "foreignBrand",
  "foreignProduct",
  "wrongActor",
  "wrongTime",
  "nonDraft",
  "multiple",
  "variant",
])("refuses %s initial base SKU", (kind) => {
  const request = baseSkuRequest(),
    sku = request.aggregate.draft.skus[0];
  if (!sku) throw Error("Missing SKU");
  if (kind === "foreignBrand") sku.brandReference = id(50);
  if (kind === "foreignProduct") sku.productReference = id(50);
  if (kind === "wrongActor") sku.createdByActorReference = id(50);
  if (kind === "wrongTime") sku.createdAt = "2026-10-04T14:59:59.000Z";
  if (kind === "nonDraft") sku.lifecycle = "Active";
  if (kind === "multiple")
    request.aggregate.draft.skus.push({ ...sku, skuReference: id(50), skuCode: "SECOND" });
  if (kind === "variant")
    Object.assign(sku, {
      variantSelections: [{ dimensionReference: id(6), valueReference: id(7) }],
    });
  expect(() => parseProductVariantCreationRequest(request)).toThrow(CatalogError);
});
