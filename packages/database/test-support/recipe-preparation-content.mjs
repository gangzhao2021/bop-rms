import { createKitchenRecipePreparationSource } from "../../../apps/api/src/kitchen-recipe-preparation-source.ts";
import {
  parseKitchenPreparationRequest,
  createKitchenPreparationEvidenceSetDigestBinding,
} from "../../rms/kitchen/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import {
  createPostgresRecipePreparationContentStore,
  createPostgresRecipeModifierSource,
  createPostgresConfiguredRecipePreparationSource,
  resolveRecipePreparation,
} from "../../rms/recipe/src/index.ts";
import {
  preparationPublicationFixture,
  preparationTestHash,
} from "../../rms/recipe/src/tests/recipe-preparation-publication.fixture.ts";

/** Actual published Recipe/Modifier and preparation storage; explicit synthetic reviews/capabilities. */
export async function exerciseRecipePreparationContent({
  admin,
  context,
  role,
  snapshot,
  rule,
  id,
}) {
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_recipe.recipe_preparation_content TO " + role,
  );
  let allowed = true;
  let publishing = true;
  let gates = 0;
  const hash = preparationTestHash;
  const publishedAt = new Date(Date.parse(snapshot.createdAt) + 1000).toISOString();
  const base = { ...preparationPublicationFixture(snapshot).record, publishedAt };
  const configured = { ...preparationPublicationFixture(snapshot, rule).record, publishedAt };
  let failureReached;
  function runner(failure = null) {
    return {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          const result = await work({
            query: async (sql, values) => {
              if (failure && sql.startsWith(failure)) {
                failureReached = true;
                throw new Error("synthetic preparation transaction failure");
              }
              return client.query(sql, [...values]);
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
  }
  const modifiers = createPostgresRecipeModifierSource(runner());
  const selectedOption = {
    optionReference: rule.selection.optionReference,
    quantity: rule.selection.quantity,
  };
  assert.deepEqual(await modifiers.resolveOptions(snapshot, [selectedOption], publishedAt), [rule]);
  await assert.rejects(
    modifiers.resolveOptions(snapshot, [{ ...selectedOption, quantity: 10000 }], publishedAt),
  );
  await assert.rejects(
    modifiers.resolveOptions(snapshot, [selectedOption, selectedOption], publishedAt),
  );
  const store = createPostgresRecipePreparationContentStore({
    brandReference: snapshot.brandReference,
    sha256: hash,
    authorizeRead: async () => allowed,
    authorizeWrite: async () => allowed,
    validatePublication: async () => {
      gates++;
      return publishing;
    },
    audit: async (record) => ({
      auditId: record.modifierRuleVersionReference === null ? id(9701) : id(9702),
      brandId: snapshot.brandReference,
      actor: { type: "User", reference: record.actorReference },
      actionCode: "RECIPE_PREPARATION_PUBLISHED",
      targetType: "RecipePreparationContent",
      targetId: record.content.contentReference,
      correlationId: record.operationReference,
      reasonCode: "SYNTHETIC_APPROVED",
      occurredAt: record.publishedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: {
        contentKind: record.modifierRuleVersionReference === null ? "Base" : "Modifier",
      },
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const query = {
    actorType: "System",
    actorReference: null,
    action: "ResolveRecipePreparationContent",
    purpose: "CreateKitchenWork",
    brandReference: snapshot.brandReference,
    storeReference: id(202),
    recipeReference: snapshot.recipeReference,
    recipeVersionReference: snapshot.versionReference,
    modifierRuleVersionReference: null,
    effectiveAt: publishedAt,
  };
  const read = (patch = {}) =>
    runner().run((transaction) => store.resolve({ transaction, query: { ...query, ...patch } }));
  const count = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_recipe.recipe_preparation_content) AS contents," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='RECIPE_PREPARATION_PUBLISHED') AS audits",
      )
    ).rows[0];
  assert.equal(await read(), null);
  for (const point of [
    "INSERT INTO platform_audit.audit_record",
    "INSERT INTO rms_recipe.recipe_preparation_content",
  ]) {
    failureReached = false;
    await assert.rejects(
      runner(point).run((transaction) => store.commit({ transaction, record: base })),
    );
    assert.equal(failureReached, true, point);
    assert.deepEqual(await count(), { contents: 0, audits: 0 });
  }
  allowed = false;
  let sourceReads = 0;
  await assert.rejects(
    runner().run((tx) =>
      store.resolve({
        transaction: {
          query: (sql, values) => {
            if (sql.includes("FROM rms_recipe.")) sourceReads++;
            return tx.query(sql, values);
          },
        },
        query,
      }),
    ),
  );
  assert.equal(sourceReads, 0);
  await assert.rejects(runner().run((transaction) => store.commit({ transaction, record: base })));
  allowed = true;
  publishing = false;
  await assert.rejects(runner().run((transaction) => store.commit({ transaction, record: base })));
  publishing = true;
  const written = await Promise.all([
    runner().run((transaction) => store.commit({ transaction, record: base })),
    runner().run((transaction) => store.commit({ transaction, record: base })),
  ]);
  assert.deepEqual(written.map((x) => x.status).sort(), ["AlreadyCommitted", "Committed"]);
  assert.deepEqual(written[0].record, written[1].record);
  assert.deepEqual(await count(), { contents: 1, audits: 1 });
  const beforeReplay = gates;
  assert.equal(
    (await runner().run((transaction) => store.commit({ transaction, record: base }))).status,
    "AlreadyCommitted",
  );
  assert.equal(gates, beforeReplay);
  await assert.rejects(
    runner().run((transaction) =>
      store.commit({
        transaction,
        record: { ...base, actorReference: id(9710) },
      }),
    ),
  );
  await assert.rejects(
    runner().run((transaction) =>
      store.commit({
        transaction,
        record: { ...base, operationReference: id(9711) },
      }),
    ),
    { code: "RECIPE_IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    runner().run((transaction) =>
      store.commit({
        transaction,
        record: {
          ...configured,
          reviewEvidence: { ...configured.reviewEvidence, contentDigest: hash("wrong") },
        },
      }),
    ),
  );
  assert.deepEqual(await count(), { contents: 1, audits: 1 });
  await runner().run((transaction) => store.commit({ transaction, record: configured }));
  // Both owner versions already exist, but preparation publication is still in the future.
  assert.equal(await read({ effectiveAt: snapshot.createdAt }), null);
  assert.equal(
    await read({
      effectiveAt: snapshot.createdAt,
      modifierRuleVersionReference: rule.ruleVersionReference,
    }),
    null,
  );
  const baseEvidence = await read();
  const modifierEvidence = await read({ modifierRuleVersionReference: rule.ruleVersionReference });
  assert.deepEqual(Object.keys(baseEvidence).sort(), [
    "content",
    "publicationReference",
    "publishedAt",
  ]);
  assert.deepEqual(baseEvidence.content, base.content);
  assert.deepEqual(modifierEvidence.content, configured.content);
  const result = resolveRecipePreparation({
    snapshot,
    content: baseEvidence.content,
    selections: [rule.selection],
    modifiers: [{ rule, content: modifierEvidence.content }],
    sha256: hash,
  });
  assert.equal(result.steps[0].durationSeconds, 90);
  assert.equal(result.steps[0].instructionText, "Synthetic reviewed preparation instruction.");
  assert.equal(result.appliedModifiers[0].ruleVersionReference, rule.ruleVersionReference);
  const preparedSource = createPostgresConfiguredRecipePreparationSource({
    brandReference: snapshot.brandReference,
    sha256: hash,
    content: store,
    authorize: async () => allowed,
  });
  const preparedInput = {
    actorType: "System",
    actorReference: null,
    action: "ResolveConfiguredRecipePreparation",
    purpose: "CreateKitchenWork",
    brandReference: snapshot.brandReference,
    storeReference: id(500),
    skuReference: id(206),
    effectiveAt: publishedAt,
    selectedOptions: [selectedOption],
  };
  const prepared = await runner().run((tx) => preparedSource.resolve(tx, preparedInput));
  assert.deepEqual(prepared.preparation, result);
  assert.equal(
    prepared.display.instructions[0],
    "Sequence group 0 (same group may run in parallel), 90 seconds: Synthetic reviewed preparation instruction.",
  );
  assert.deepEqual(
    prepared.display.requiredStationCapabilityReferences,
    [...new Set(result.steps.map((step) => step.capabilityReference))].sort(),
  );
  assert.deepEqual(prepared.publicationReferences, [
    base.operationReference,
    configured.operationReference,
  ]);
  assert.equal(prepared.skuReference, id(206));
  assert.equal("snapshot" in prepared, false);
  assert.equal("ingredients" in prepared.preparation, false);
  await assert.rejects(
    runner().run((tx) =>
      preparedSource.resolve(tx, { ...preparedInput, effectiveAt: snapshot.createdAt }),
    ),
  );
  allowed = false;
  let preparationQueries = 0;
  await assert.rejects(
    runner().run((tx) =>
      preparedSource.resolve(
        {
          query: (sql, values) => {
            preparationQueries++;
            return tx.query(sql, values);
          },
        },
        preparedInput,
      ),
    ),
  );
  assert.equal(preparationQueries, 0);
  allowed = true;
  const kitchenSource = createKitchenRecipePreparationSource({
    brandReference: snapshot.brandReference,
    storeReference: id(500),
    recipe: preparedSource,
    authorize: async () => allowed,
    sha256: hash,
    deriveReference: (purpose, identity) => {
      const hex = hash(purpose + identity).slice(7);
      return (
        hex.slice(0, 8) +
        "-" +
        hex.slice(8, 12) +
        "-7" +
        hex.slice(13, 16) +
        "-8" +
        hex.slice(17, 20) +
        "-" +
        hex.slice(20, 32)
      );
    },
  });
  const kitchenQuery = parseKitchenPreparationRequest({
    actorType: "System",
    actorReference: null,
    action: "ResolveRecipePreparationEvidence",
    purpose: "CreateKitchenWork",
    brandReference: snapshot.brandReference,
    storeReference: id(500),
    effectiveAt: publishedAt,
    sourceEvidenceReference: id(9801),
    sourceEvidenceVersion: 1,
    sourceEvidenceDigest: hash("SYNTHETIC_ORDER_SOURCE"),
    items: [
      {
        orderItemReference: id(9802),
        ordinal: 1,
        quantity: 2,
        productReference: id(9803),
        productVersionReference: id(9804),
        skuReference: id(206),
        menuVersionReference: id(9805),
        selectedOptions: [selectedOption],
        sourceLineDigest: hash("SYNTHETIC_ORDER_LINE"),
      },
    ],
  });
  const kitchenEvidence = await runner().run((tx) => kitchenSource.resolve(tx, kitchenQuery));
  assert.ok(kitchenEvidence);
  assert.deepEqual(kitchenEvidence.items[0].instructions, prepared.display.instructions);
  assert.equal(kitchenEvidence.items[0].quantity, 2);
  assert.equal(
    kitchenEvidence.evidenceDigest,
    hash(createKitchenPreparationEvidenceSetDigestBinding(kitchenEvidence)),
  );
  assert.deepEqual(
    await runner().run((tx) => kitchenSource.resolve(tx, kitchenQuery)),
    kitchenEvidence,
  );
  const changedSource = await runner().run((tx) =>
    kitchenSource.resolve(tx, {
      ...kitchenQuery,
      sourceEvidenceDigest: hash("SYNTHETIC_CHANGED_ORDER_SOURCE"),
    }),
  );
  assert.notEqual(
    changedSource.items[0].preparationReference,
    kitchenEvidence.items[0].preparationReference,
  );
  const after = await count();
  assert.deepEqual(after, { contents: 2, audits: 2 });
  allowed = false;
  await assert.rejects(read());
  await assert.rejects(runner().run((transaction) => store.commit({ transaction, record: base })));
  allowed = true;
  await assert.rejects(read({ action: "UnexpectedAction" }));
  await assert.rejects(read({ brandReference: id(99) }));
  await assert.rejects(read({ modifierRuleVersionReference: id(9999) }));
  // Fixture current-state removal proves fresh reads fail but immutable operation recovery survives.
  await admin.query("UPDATE rms_recipe.recipe SET current_version_id=NULL WHERE recipe_id=$1", [
    snapshot.recipeReference,
  ]);
  await assert.rejects(read());
  assert.equal(
    (await runner().run((transaction) => store.commit({ transaction, record: base }))).status,
    "AlreadyCommitted",
  );
  await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
    snapshot.versionReference,
    snapshot.recipeReference,
  ]);
  await runner().run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true)", [snapshot.brandReference]);
    assert.equal(
      (
        await tx.query("UPDATE rms_recipe.recipe_preparation_content SET content_digest=$1", [
          hash("changed"),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_recipe.recipe_preparation_content", [])).rowCount,
      0,
    );
    await tx.query("SELECT set_config('bop.brand_id',$1,true)", [id(99)]);
    assert.equal(
      (await tx.query("SELECT * FROM rms_recipe.recipe_preparation_content", [])).rows.length,
      0,
    );
  });
  assert.deepEqual(await count(), after);
}
