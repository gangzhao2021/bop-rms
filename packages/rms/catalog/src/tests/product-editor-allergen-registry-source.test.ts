import { expect, it, vi } from "vitest";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import {
  buildProductEditorAllergenRegistrySnapshot,
  parseProductEditorAllergenRegistryRequest,
  productEditorAllergenRegistryFields,
} from "../contracts/product-editor-allergen-registry.js";
import { createPostgresProductEditorAllergenRegistrySource } from "../infrastructure/persistence/product-editor-allergen-registry-source.js";
const id = (n: number) => "019a2421-0100-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T15:00:00.000Z",
  until = "2026-10-04T15:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
type Options = Parameters<typeof createPostgresProductEditorAllergenRegistrySource>[0];
type Tx = Parameters<Options["registerBeforeCommit"]>[0];
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "SYNTHETIC_PRODUCT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(3),
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic Product" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [id(6)],
        nutritionProfile: null,
      },
    },
  });
  const request = {
      profile: "CatalogProductEditorAllergenRegistryRequestV1",
      intentKind: "EditorCreate",
      tenantReference: id(7),
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(8),
      aggregate,
      registryVersionReference: id(9),
      originalIntentDigest: digest,
      observedAt: at,
      validUntil: until,
    },
    facts = {
      registryVersionReference: id(9),
      brandReference: id(2),
      jurisdictionCode: "CA-ON",
      policyDocumentDigest: digest,
      reviewedAt: at,
      reviewerActorReference: id(10),
      status: "Approved",
      entries: [{ allergenReference: id(6), code: "MILK", localizedNames: { "en-CA": "Milk" } }],
    };
  let now = at,
    deny = false,
    committed = false,
    coherent = true,
    rows: unknown[] = [facts],
    isolation = "read committed";
  const guards: { async(): Promise<void>; final(): void }[] = [],
    sql: { text: string; values: readonly unknown[] }[] = [];
  const hold = vi.fn(async () => {
    if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const tx: Tx = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      sql.push({ text, values });
      return {
        rows: (text.includes("transaction_isolation")
          ? [{ isolation }]
          : text.includes("SELECT jsonb_build_object")
            ? rows.map((facts) => ({ facts, coherent }))
            : []) as unknown as readonly Row[],
      };
    },
  };
  const options: Options = {
      tenantReference: id(7),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => now },
      authority: { holdUntilTransactionCompletes: hold },
      async registerBeforeCommit(actual, async, final) {
        if (actual !== tx || typeof final !== "function")
          throw new Error("Wrong controlled transaction");
        guards.push({ async, final });
      },
    },
    source = createPostgresProductEditorAllergenRegistrySource(options);
  return {
    aggregate,
    request,
    facts,
    tx,
    options,
    source,
    sql,
    hold,
    guards,
    get committed() {
      return committed;
    },
    now(value: string) {
      now = value;
    },
    deny() {
      deny = true;
    },
    rows(value: unknown[]) {
      rows = value;
    },
    coherent(value: boolean) {
      coherent = value;
    },
    isolation(value: string) {
      isolation = value;
    },
    read<T>(work: Parameters<typeof source.withCurrentRegistry<T>>[2], value: unknown = request) {
      return source.withCurrentRegistry(tx, value, work);
    },
    async run<T>(work: () => Promise<T>) {
      const result = await work();
      for (const guard of guards) await guard.async();
      for (const guard of guards) guard.final();
      committed = true;
      return result;
    },
  };
}
it("reads the real selected dictionary only and holds exact editor authority through commit", async () => {
  const h = fixture();
  const result = await h.run(() => h.read(async (snapshot) => snapshot));
  expect(h.committed).toBe(true);
  expect(result).toMatchObject({
    vocabularyIntegrity: "Registered",
    eligibility: "NotEvaluated",
    registryVersionReference: id(9),
    entries: h.facts.entries,
  });
  expect(result).not.toHaveProperty("evidence");
  expect(result).not.toHaveProperty("classification");
  expect(h.hold).toHaveBeenCalledTimes(3);
  expect(h.hold).toHaveBeenCalledWith(h.tx, {
    request: parseProductEditorAllergenRegistryRequest(h.request),
    actorKind: "User",
    purposeCode: "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ",
    permission: "catalog.manage",
    owningAction: "catalog.product.manage",
    requiredFields: productEditorAllergenRegistryFields,
  });
  expect(
    h.sql.some(
      (q) =>
        q.text ===
        "LOCK TABLE rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry IN SHARE MODE",
    ),
  ).toBe(true);
  expect(h.sql.some((q) => /allergen_source_|recipe_|menu_|INSERT|UPDATE/.test(q.text))).toBe(
    false,
  );
});
it("accepts a full prospective DraftReplace snapshot and registered references", () => {
  const h = fixture(),
    aggregate = parseProductAggregate({ ...h.aggregate, aggregateVersion: 2 });
  expect(
    buildProductEditorAllergenRegistrySnapshot(
      { ...h.request, intentKind: "DraftReplace", aggregate },
      h.facts,
    ).request.aggregate.aggregateVersion,
  ).toBe(2);
});
it.each([
  ["profile", "CatalogMenuAllergenRequestV1"],
  ["intentKind", "Publication"],
  ["originalIntentDigest", "bad"],
  ["validUntil", "2026-10-04T15:00:05.001Z"],
  ["observedAt", "2026-10-04T14:59:59.000Z"],
  ["validUntil", at],
  ["brandReference", id(99)],
  ["unused", true],
])("refuses altered request %s", (field, value) => {
  const h = fixture();
  expect(() =>
    parseProductEditorAllergenRegistryRequest({ ...h.request, [field as string]: value }),
  ).toThrow(CatalogError);
});
it.each([
  ["status", "Superseded"],
  ["status", "Invalidated"],
  ["brandReference", id(99)],
  ["registryVersionReference", id(99)],
  ["reviewedAt", until],
  ["policyDocumentDigest", "bad"],
  ["reviewerActorReference", "bad"],
  ["jurisdictionCode", "unregistered"],
  ["unused", true],
])("refuses unapproved/malformed registry %s=%s", (field, value) => {
  const h = fixture();
  expect(() =>
    buildProductEditorAllergenRegistrySnapshot(h.request, { ...h.facts, [field as string]: value }),
  ).toThrow(CatalogError);
});
it.each(["duplicate identity", "duplicate code", "missing locale", "extra field"])(
  "rejects registry entry %s",
  (kind) => {
    const h = fixture(),
      entry = h.facts.entries[0];
    if (!entry) throw new Error("Missing fixture");
    const entries =
      kind === "duplicate identity"
        ? [entry, entry]
        : kind === "duplicate code"
          ? [entry, { ...entry, allergenReference: id(99) }]
          : [
              {
                ...entry,
                ...(kind === "missing locale"
                  ? { localizedNames: { "fr-CA": "Lait" } }
                  : { unused: true }),
              },
            ];
    expect(() =>
      buildProductEditorAllergenRegistrySnapshot(h.request, { ...h.facts, entries }),
    ).toThrow(CatalogError);
  },
);
it("rejects a known unregistered selected allergen as a content conflict", () => {
  const h = fixture();
  expect(() =>
    buildProductEditorAllergenRegistrySnapshot(h.request, { ...h.facts, entries: [] }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
});
it.each(["missing", "duplicate", "incoherent", "isolation"])(
  "refuses actual %s source",
  async (kind) => {
    const h = fixture();
    if (kind === "missing") h.rows([]);
    if (kind === "duplicate") h.rows([h.facts, h.facts]);
    if (kind === "incoherent") h.coherent(false);
    if (kind === "isolation") h.isolation("repeatable read");
    await expect(h.run(() => h.read(async () => undefined))).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  },
);
it("retains its original locked snapshot and deadline across sequential reholds", async () => {
  const h = fixture();
  await h.run(async () => {
    const first = await h.read(async (s) => s);
    h.rows([{ ...h.facts, status: "Invalidated" }]); // SQL changes cannot occur through the held SHARE lock.
    const second = await h.read(async (s) => s);
    expect(second).toBe(first);
  });
  expect(h.sql.filter((q) => q.text.includes("SELECT jsonb_build_object"))).toHaveLength(1);
  expect(h.guards).toHaveLength(1);
});
it.each(["operation", "candidate", "lease"])(
  "refuses changed original %s on a rehold",
  async (kind) => {
    const h = fixture();
    await expect(
      h.run(async () => {
        await h.read(async () => undefined);
        const changed = {
          ...h.request,
          ...(kind === "operation"
            ? { operationReference: id(99) }
            : kind === "lease"
              ? { validUntil: "2026-10-04T15:00:04.000Z" }
              : {
                  aggregate: parseProductAggregate({
                    ...h.aggregate,
                    internalCode: "OTHER_PRODUCT",
                  }),
                }),
        };
        await h.read(async () => undefined, changed).catch(() => undefined);
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(h.committed).toBe(false);
  },
);
it("prevents commit after a malformed first request is swallowed", async () => {
  const h = fixture();
  await expect(
    h.run(async () => {
      await h.read(async () => undefined, { ...h.request, extra: true }).catch(() => undefined);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(h.committed).toBe(false);
});
it("captures the full candidate before the first awaited authority call", async () => {
  const h = fixture(),
    raw = structuredClone(h.request);
  h.hold.mockImplementationOnce(async () => {
    raw.operationReference = id(99);
    Object.assign(raw.aggregate.draft, { editorContent: undefined });
  });
  const result = await h.run(() => h.read(async (s) => s, raw));
  expect(result.request.operationReference).toBe(id(8));
  expect(result.request.aggregate.draft.editorContent?.allergenReferences).toEqual([id(6)]);
});
it.each(["expiry", "clock rollback", "query swap", "late denial"])(
  "retains %s through final commit",
  async (kind) => {
    const h = fixture();
    await expect(
      h.run(async () => {
        await h.read(async () => undefined);
        h.guards.push({
          async: async () => {
            if (kind === "late denial") h.deny();
            else if (kind === "query swap") h.tx.query = async () => ({ rows: [] });
            else h.now(kind === "expiry" ? until : "2026-10-04T14:59:59.000Z");
          },
          final: () => undefined,
        });
        if (kind === "late denial")
          h.guards.push({
            async: async () => {
              await h.read(async () => undefined);
            },
            final: () => undefined,
          });
      }),
    ).rejects.toHaveProperty(
      "code",
      kind === "late denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(h.committed).toBe(false);
  },
);
it("poisons a caught reentrant callback", async () => {
  const h = fixture();
  await expect(
    h.run(() =>
      h.read(async () => {
        await h.read(async () => undefined).catch(() => undefined);
      }),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
