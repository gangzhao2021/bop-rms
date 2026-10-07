import assert from "node:assert/strict";
import pg from "pg";
import {
  createPostgresProductEditorAllergenRegistrySource,
  parseProductAggregate,
  productEditorAllergenRegistryFields,
} from "../../rms/catalog/src/index.ts";

const id = (n) => `019a2421-0200-7000-8000-${n.toString(16).padStart(12, "0")}`;
/** Actual owner SQL/RLS/locks; this controlled candidate and User holder are not
 * an ordinary Create, actual Session/IAM or Safety publication qualification. */
export async function proveProductEditorAllergenRegistry({
  client,
  clientConfig,
  role,
  brand,
  registry,
  allergen,
  actor,
  at,
  digest,
}) {
  assert.match(role, /^wp1028_[a-z0-9_]+$/u);
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: brand,
    internalCode: "EDITOR_DICTIONARY_TEST",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: actor,
    draft: {
      versionReference: id(2),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic editor candidate" },
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
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [allergen],
        nutritionProfile: null,
      },
    },
  });
  const request = {
    profile: "CatalogProductEditorAllergenRegistryRequestV1",
    intentKind: "EditorCreate",
    tenantReference: id(3),
    brandReference: brand,
    actorReference: actor,
    operationReference: id(4),
    aggregate,
    registryVersionReference: registry,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
  };
  const run = async (value, work) => {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const tx = { query: (text, values) => client.query(text, values) },
      guards = [];
    const source = createPostgresProductEditorAllergenRegistrySource({
      tenantReference: request.tenantReference,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => at },
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.equal(input.actorKind, "User");
          assert.equal(input.request.brandReference, brand);
          assert.equal(input.request.actorReference, actor);
          assert.equal(input.request.operationReference, request.operationReference);
          assert.equal(input.purposeCode, "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ");
          assert.equal(input.permission, "catalog.manage");
          assert.equal(input.owningAction, "catalog.product.manage");
          assert.deepEqual(input.requiredFields, productEditorAllergenRegistryFields);
        },
      },
      async registerBeforeCommit(actual, async, final) {
        assert.equal(actual, tx);
        guards.push({ async, final });
      },
    });
    try {
      const result = await source.withCurrentRegistry(tx, value, work);
      for (const guard of guards) await guard.async();
      for (const guard of guards) guard.final();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  await assert.rejects(
    run(request, async () => undefined),
    { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
  );
  await client.query("RESET ROLE");
  await client.query(
    `GRANT UPDATE ON rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry TO ${role}`,
  );
  await client.query(`SET ROLE ${role}`);
  await run(request, async (snapshot) => {
    assert.equal(snapshot.registryVersionReference, registry);
    assert.equal(snapshot.vocabularyIntegrity, "Registered");
    assert.equal(snapshot.eligibility, "NotEvaluated");
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].allergenReference, allergen);
    assert.equal(snapshot.entries[0].code, "MILK");
    assert.equal(snapshot.entries[0].localizedNames["en-CA"], "Milk");
    assert.equal(Object.hasOwn(snapshot, "evidence"), false);
    const probe = new pg.Client(clientConfig);
    await probe.connect();
    try {
      await probe.query("SET statement_timeout='250ms'");
      await assert.rejects(
        probe.query(
          "UPDATE rms_catalog.allergen_registry_entry SET localized_names_json=$1 WHERE registry_version_id=$2 AND brand_id=$3 AND allergen_id=$4",
          [{ "en-CA": "Changed" }, registry, brand, allergen],
        ),
        { code: "57014" },
      );
    } finally {
      await probe.end();
    }
  });
  const unknown = parseProductAggregate({
    ...aggregate,
    draft: {
      ...aggregate.draft,
      editorContent: { ...aggregate.draft.editorContent, allergenReferences: [id(99)] },
    },
  });
  await assert.rejects(
    run({ ...request, aggregate: unknown }, async () => undefined),
    { code: "CATALOG_LIFECYCLE_CONFLICT" },
  );
}
