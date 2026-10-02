import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createPostgresRecipeOwnerCoverageSource,
  createPostgresRecipeProjectionFactsSource,
  buildRecipeProjectionGraph,
  buildRecipeProjectionCore,
  createPostgresRecipePreparationCoverageSource,
  createPostgresRecipeSubstitutionCoverageSource,
  createPostgresRecipeUsageCoverageSource,
  createRecipePreparationContentBinding,
} from "../../rms/recipe/src/index.ts";
import { insertRecipeVersion } from "../../rms/recipe/src/infrastructure/persistence/recipe-version-write.ts";
import { preparationRecipeFixture } from "../../rms/recipe/src/tests/recipe-preparation-content.fixture.ts";
import {
  preparationPublicationFixture,
  preparationTestHash,
} from "../../rms/recipe/src/tests/recipe-preparation-publication.fixture.ts";
/** Actual owner rows/locks/capture storage; explicit synthetic read authorization, no real safety facts. */
export async function exerciseRecipeOwnerCoverage({ admin, context, role, id, scope, at }) {
  await admin.query(`GRANT SELECT ON rms_recipe.recipe,rms_recipe.recipe_version TO ${role}`);
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_recipe.recipe_admin_source_capture TO ${role}`,
  );
  await admin.query(`GRANT MAINTAIN ON rms_recipe.recipe TO ${role}`);
  await admin.query(
    `GRANT SELECT ON rms_recipe.recipe_preparation_content,rms_recipe.recipe_modifier_version TO ${role}`,
  );
  await admin.query(`GRANT MAINTAIN ON rms_recipe.recipe_preparation_content TO ${role}`);
  await admin.query(`GRANT SELECT ON rms_recipe.recipe_scope_binding TO ${role}`);
  await admin.query(
    `GRANT MAINTAIN ON rms_recipe.recipe_modifier_version,rms_recipe.recipe_scope_binding TO ${role}`,
  );
  await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_store_id() TO ${role}`);
  let directoryLeases = 0;
  let directoryVersion = 9990;
  let sequence = 8000;
  let allowed = true;
  let factsAllowed = true;
  let factsAuthorizationCalls = 0;
  let failure = null;
  function runner(preSnapshot = false, family = "Recipe") {
    return {
      async run(work) {
        if (family === "Usage") assert.ok(directoryLeases > 0);
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          if (preSnapshot) {
            await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            await client.query("SELECT count(*) FROM rms_recipe.recipe");
          }
          const result = await work({
            query: async (sql, values) => {
              try {
                return await client.query(sql, [...values]);
              } catch (error) {
                failure = {
                  operation: sql.startsWith("LOCK TABLE")
                    ? "lock"
                    : sql.startsWith("INSERT")
                      ? "insert"
                      : "read",
                  sqlState: /^[A-Z0-9]{5}$/u.test(error.code ?? "") ? error.code : "unknown",
                };
                throw error;
              }
            },
          });
          await client.query("COMMIT");
          if (family === "Usage") assert.ok(directoryLeases > 0);
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
  const request = { actorReference: id(3), purpose: "RecipeProjectionBuild", observedAtUtc: at };
  function source(preSnapshot = false, family = "Recipe") {
    const createSource = {
      Recipe: createPostgresRecipeOwnerCoverageSource,
      ProjectionFacts: createPostgresRecipeProjectionFactsSource,
      Preparation: createPostgresRecipePreparationCoverageSource,
      Substitution: createPostgresRecipeSubstitutionCoverageSource,
      Usage: createPostgresRecipeUsageCoverageSource,
    }[family];
    return createSource({
      runner: runner(preSnapshot, family),
      scope,
      usageStores: {
        async withCurrent(input, work) {
          assert.equal(input.family, "Usage");
          directoryLeases += 1;
          try {
            return await work({
              ...scope,
              snapshotReference: id(directoryVersion),
              digest: preparationTestHash(
                `synthetic-complete-Brand-Store-directory-${directoryVersion}`,
              ),
              complete: true,
              storeReferences: [id(9911)],
            });
          } finally {
            directoryLeases -= 1;
          }
        },
      },
      generateReference: () => id(++sequence),
      authorizeFacts: async (_tx, input) => {
        factsAuthorizationCalls++;
        assert.equal(input.access, "ProjectionFacts");
        assert.equal(input.family, "Recipe");
        return factsAllowed;
      },
      authorize: async (tx, input) => {
        assert.equal(
          (await tx.query("SELECT current_setting('bop.store_id',true) AS store", [])).rows[0]
            .store,
          "",
        );
        return (
          allowed &&
          input.actorReference === id(3) &&
          input.tenantReference === scope.tenantReference &&
          input.brandReference === scope.brandReference &&
          input.purpose === "RecipeProjectionBuild"
        );
      },
    });
  }
  const empty = await source()
    .capture(request)
    .catch(() => {
      assert.fail(`Synthetic Recipe source diagnostic: ${JSON.stringify(failure)}`);
    });
  assert.equal(empty.coverage.dependencies.length, 0);
  assert.equal(empty.coverage.family, "Recipe");
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    empty.coverage.snapshotReference,
  );
  function snapshot(n, version = 1) {
    const base = preparationRecipeFixture({ version });
    return {
      ...base,
      recipeReference: id(n),
      versionReference: id(n + version + 100),
      brandReference: scope.brandReference,
      stableCode: `SYNTHETIC_OWNER_${n}`,
    };
  }
  async function seed(client, snapshot, create = true) {
    await client.query("BEGIN");
    try {
      if (create)
        await client.query(
          "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
          [
            snapshot.recipeReference,
            snapshot.brandReference,
            snapshot.stableCode,
            snapshot.createdAt,
            id(3),
          ],
        );
      await insertRecipeVersion(
        { query: (sql, values) => client.query(sql, [...values]) },
        snapshot,
        () => id(++sequence),
      );
      if (create)
        await client.query(
          "UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2",
          [snapshot.versionReference, snapshot.recipeReference],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const firstSnapshot = snapshot(400);
  await seed(admin, firstSnapshot);
  await assert.rejects(
    source().withCurrent(request, empty, async () => null),
    (error) => error.code === "RECIPE_SOURCE_CHANGED",
  );
  const first = await source().capture(request);
  assert.deepEqual(first.coverage.dependencies, [
    {
      objectReference: firstSnapshot.recipeReference,
      versionReference: firstSnapshot.versionReference,
      digest: firstSnapshot.snapshotDigest,
    },
  ]);
  assert.notEqual(first.coverage.snapshotReference, empty.coverage.snapshotReference);
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    first.coverage.snapshotReference,
  );
  // Current-version replacement is blocked even for an administrative writer by the owner's SHARE lock.
  const nextSnapshot = snapshot(400, 2);
  await seed(admin, nextSnapshot, false);
  const writer = new pg.Client(context.clientConfig);
  await writer.connect();
  async function blocked() {
    for (let i = 0; i < 100; i += 1) {
      const row = (
        await admin.query("SELECT wait_event_type AS kind FROM pg_stat_activity WHERE pid=$1", [
          writer.processID,
        ])
      ).rows[0];
      if (row?.kind === "Lock") return;
      await delay(10);
    }
    assert.fail("synthetic owner writer did not wait on held source lock");
  }
  async function heldMutation(captured, mutation, factory = source) {
    let release, ready;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const acquired = new Promise((resolve) => {
      ready = resolve;
    });
    const reading = factory().withCurrent(request, captured, async (current) => {
      assert.equal(current.coverage.snapshotReference, captured.coverage.snapshotReference);
      ready();
      await hold;
      return current;
    });
    try {
      await acquired;
      const writing = mutation();
      try {
        await blocked();
      } finally {
        release();
      }
      await reading;
      await writing;
    } finally {
      release();
      await reading.catch(() => undefined);
    }
  }
  try {
    await writer.query("SET lock_timeout='5s'");
    await heldMutation(first, () =>
      writer.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
        [nextSnapshot.versionReference, nextSnapshot.recipeReference],
      ),
    );
    await assert.rejects(
      source().withCurrent(request, first, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const current = await source().capture(request);
    assert.equal(current.coverage.dependencies[0].versionReference, nextSnapshot.versionReference);
    const secondSnapshot = snapshot(600);
    await heldMutation(current, () => seed(writer, secondSnapshot));
    await assert.rejects(
      source().withCurrent(request, current, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const both = await source().capture(request);
    assert.equal(both.coverage.dependencies.length, 2);
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      both.coverage.snapshotReference,
    );
    const missing = { ...both, coverage: { ...both.coverage, snapshotReference: id(9999) } };
    await assert.rejects(
      source().withCurrent(request, missing, async () => null),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    await assert.rejects(
      source().withCurrent(request, both, async () => {
        throw Error("synthetic callback failure");
      }),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      both.coverage.snapshotReference,
    );
    allowed = false;
    await assert.rejects(
      source().capture(request),
      (error) => error.code === "RECIPE_SOURCE_PERMISSION_DENIED",
    );
    allowed = true;
    await assert.rejects(
      source().withCurrent(request, both, async () => {
        allowed = false;
        return "private";
      }),
      (error) => error.code === "RECIPE_SOURCE_PERMISSION_DENIED",
    );
    allowed = true;
    // A caller's pre-existing snapshot cannot be treated as current after locking.
    await assert.rejects(
      source(true).capture(request),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    assert.equal(failure.sqlState, "25001");
    // A parent pins the historical child even while that child's current version is newer.
    const parent = {
      ...snapshot(1000),
      ingredients: preparationRecipeFixture({ sub: firstSnapshot }).ingredients.map((item) => ({
        ...item,
        unitDimension: firstSnapshot.yieldDimension,
      })),
    };
    await seed(admin, parent);
    await assert.rejects(
      source().withCurrent(request, both, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const graph = await source().capture(request);
    assert.deepEqual(
      graph.coverage.dependencies
        .filter((entry) => entry.objectReference === firstSnapshot.recipeReference)
        .map((entry) => entry.versionReference),
      [firstSnapshot.versionReference, nextSnapshot.versionReference],
    );
    assert.equal(graph.coverage.dependencies.length, 4);
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      graph.coverage.snapshotReference,
    );
    const facts = () => source(false, "ProjectionFacts");
    const factsSeal = await facts().capture(request);
    assert.equal(factsSeal.coverage.snapshotReference, graph.coverage.snapshotReference);
    const payload = await facts().withCurrentFacts(request, graph, async (value) => value);
    const rebuilt = buildRecipeProjectionGraph(payload);
    const core = buildRecipeProjectionCore(payload);
    assert.equal(core.rows.length, 3);
    assert.equal(core.graph.nodes.length, 4);
    assert.equal(
      core.rows.find((item) => item.recipeReference === firstSnapshot.recipeReference)
        .versionReference,
      nextSnapshot.versionReference,
    );
    assert.equal(
      core.rows.find((item) => item.recipeReference === parent.recipeReference).ingredients[0]
        .sourceVersionReference,
      firstSnapshot.versionReference,
    );
    assert.equal(core.rows[0].ingredients[0].unitCostMinorNumerator, undefined);
    assert.equal(core.rows[0].ingredients[0].allergens, undefined);
    assert.deepEqual(
      await facts().withCurrentFacts(request, graph, async (value) =>
        buildRecipeProjectionCore(value),
      ),
      core,
    );
    assert.equal(rebuilt.currentRoots.length, 3);
    assert.equal(rebuilt.nodes.length, 4);
    assert.equal(rebuilt.edges.length, 1);
    assert.equal(rebuilt.edges[0].toVersionReference, firstSnapshot.versionReference);
    assert.deepEqual(
      buildRecipeProjectionGraph({
        ...payload,
        currentRecipes: [...payload.currentRecipes].reverse(),
        recipes: [...payload.recipes].reverse(),
      }),
      rebuilt,
    );
    assert.deepEqual(
      await facts().withCurrentFacts(request, graph, async (value) =>
        buildRecipeProjectionGraph(value),
      ),
      rebuilt,
    );
    assert.equal(payload.currentRecipes.length, 3);
    assert.equal(payload.recipes.length, 4);
    assert.equal(
      payload.currentRecipes.find(
        (value) => value.recipeReference === firstSnapshot.recipeReference,
      ).versionReference,
      nextSnapshot.versionReference,
    );
    assert.deepEqual(
      payload.recipes
        .filter((value) => value.recipeReference === firstSnapshot.recipeReference)
        .map((value) => value.versionReference),
      [firstSnapshot.versionReference, nextSnapshot.versionReference],
    );
    assert.deepEqual(
      payload.recipes.map((value) => ({
        objectReference: value.recipeReference,
        versionReference: value.versionReference,
        digest: value.snapshotDigest,
      })),
      graph.coverage.dependencies,
    );
    assert.equal(
      payload.currentRecipes.find((value) => value.recipeReference === parent.recipeReference)
        .ingredients[0].sourceVersionReference,
      firstSnapshot.versionReference,
    );
    assert.equal(Object.isFrozen(payload), true);
    assert.equal(Object.isFrozen(payload.currentRecipes), true);
    assert.equal(Object.isFrozen(payload.recipes[0].ingredients), true);
    assert.equal(factsAuthorizationCalls, 8);
    factsAllowed = false;
    await assert.rejects(
      facts().withCurrentFacts(request, graph, async () => "private"),
      (error) => error.code === "RECIPE_SOURCE_PERMISSION_DENIED",
    );
    factsAllowed = true;
    await assert.rejects(
      facts().withCurrentFacts(request, graph, async () => {
        factsAllowed = false;
        return "private";
      }),
      (error) => error.code === "RECIPE_SOURCE_PERMISSION_DENIED",
    );
    factsAllowed = true;
    await assert.rejects(
      facts().withCurrentFacts(request, graph, async () => {
        throw Error("synthetic private graph detail");
      }),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    const factsFence = () => ({
      withCurrent: (input, captured, work) =>
        facts().withCurrentFacts(input, captured, (value) => work(value.source)),
    });
    // A lock acquisition must protect exact current-root selection during raw facts use.
    await heldMutation(
      graph,
      () =>
        writer.query(
          "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=1 WHERE recipe_id=$2",
          [firstSnapshot.versionReference, firstSnapshot.recipeReference],
        ),
      factsFence,
    );
    await assert.rejects(
      facts().withCurrentFacts(request, graph, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    await admin.query(
      "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
      [nextSnapshot.versionReference, nextSnapshot.recipeReference],
    );
    assert.equal(
      (await facts().capture(request)).coverage.snapshotReference,
      graph.coverage.snapshotReference,
    );
    // The closure can be identical while current selections change: parent now pins v2,
    // and child switches to v1. Neither transition may reuse the former source identity.
    const nextParent = {
      ...snapshot(1000, 2),
      ingredients: preparationRecipeFixture({ sub: nextSnapshot }).ingredients,
    };
    await seed(admin, nextParent, false);
    await admin.query(
      "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
      [nextParent.versionReference, nextParent.recipeReference],
    );
    const historicalParent = {
      ...snapshot(1100),
      ingredients: preparationRecipeFixture({ sub: firstSnapshot }).ingredients.map((item) => ({
        ...item,
        unitDimension: firstSnapshot.yieldDimension,
      })),
    };
    await seed(admin, historicalParent);
    const beforeSelection = await source().capture(request);
    await admin.query(
      "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=1 WHERE recipe_id=$2",
      [firstSnapshot.versionReference, firstSnapshot.recipeReference],
    );
    const afterSelection = await source().capture(request);
    // Both versions stay covered via roots and the parent; only their roles change.
    assert.deepEqual(afterSelection.coverage.dependencies, beforeSelection.coverage.dependencies);
    assert.notEqual(
      afterSelection.coverage.snapshotReference,
      beforeSelection.coverage.snapshotReference,
    );
    assert.notEqual(afterSelection.coverage.digest, beforeSelection.coverage.digest);
    await assert.rejects(
      source().withCurrent(request, beforeSelection, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const preparation = () => source(false, "Preparation");
    const emptyPreparation = await preparation().capture(request);
    assert.equal(emptyPreparation.coverage.family, "Preparation");
    assert.equal(emptyPreparation.coverage.dependencies.length, 0);
    assert.notEqual(
      emptyPreparation.coverage.snapshotReference,
      afterSelection.coverage.snapshotReference,
    );
    assert.equal(
      (await preparation().capture(request)).coverage.snapshotReference,
      emptyPreparation.coverage.snapshotReference,
    );
    const published = { ...snapshot(1800), lifecycle: "Published" };
    await seed(admin, published);
    await assert.rejects(
      preparation().withCurrent(request, emptyPreparation, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const beforeContent = await preparation().capture(request);
    function publication(n) {
      const base = preparationPublicationFixture(published).record;
      const candidate = { ...base.content, contentReference: id(n) };
      const content = {
        ...candidate,
        contentDigest: preparationTestHash(
          createRecipePreparationContentBinding(candidate, published),
        ),
      };
      return {
        ...base,
        operationReference: id(n + 1),
        content,
        reviewEvidence: {
          ...base.reviewEvidence,
          contentReference: content.contentReference,
          contentDigest: content.contentDigest,
        },
      };
    }
    async function seedContent(client, record) {
      await client.query(
        `INSERT INTO rms_recipe.recipe_preparation_content(content_id,brand_id,recipe_id,recipe_version_id,modifier_rule_version_id,operation_id,actor_id,audit_id,content_digest,published_at,record_json) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          record.content.contentReference,
          scope.brandReference,
          record.recipeReference,
          record.recipeVersionReference,
          record.operationReference,
          record.actorReference,
          id(9700),
          record.content.contentDigest,
          record.publishedAt,
          JSON.stringify(record),
        ],
      );
    }
    const content = publication(9500);
    await heldMutation(beforeContent, () => seedContent(writer, content), preparation);
    await assert.rejects(
      preparation().withCurrent(request, beforeContent, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const populated = await preparation().capture(request);
    assert.deepEqual(populated.coverage.dependencies, [
      {
        objectReference: content.content.contentReference,
        versionReference: content.operationReference,
        digest: content.content.contentDigest,
      },
    ]);
    assert.equal(
      (await preparation().capture(request)).coverage.snapshotReference,
      populated.coverage.snapshotReference,
    );
    await assert.rejects(
      source().withCurrent(request, populated, async () => null),
      (error) => error.code === "RECIPE_SOURCE_INPUT_INVALID",
    );
    const rule = {
      ruleReference: id(9800),
      ruleVersionReference: id(9801),
      ruleDigest: preparationTestHash("synthetic-configured-rule"),
      brandReference: scope.brandReference,
      recipeVersionReference: published.versionReference,
      selection: { bindingReference: id(9802), optionReference: id(9803), quantity: 1 },
      changes: [],
    };
    const proof = {
      ruleReference: rule.ruleReference,
      ruleVersionReference: rule.ruleVersionReference,
      brandReference: scope.brandReference,
      recipeVersionReference: rule.recipeVersionReference,
      ruleDigest: rule.ruleDigest,
      draftAuthorActorReference: id(3),
      reviews: ["Cost", "FoodSafety"].map((reviewKind, i) => ({
        reviewReference: id(9810 + i),
        reviewKind,
        reviewerActorReference: id(9820 + i),
        evidenceDigest: preparationTestHash("synthetic-modifier-review"),
        decision: "Approved",
        reviewedAt: published.createdAt,
      })),
    };
    await admin.query(
      "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at,review_evidence_json) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'Published',$9,$10,$11,$12,$13,$14,$11,$15)",
      [
        rule.ruleVersionReference,
        rule.ruleReference,
        scope.brandReference,
        published.recipeReference,
        published.versionReference,
        rule.selection.bindingReference,
        rule.selection.optionReference,
        rule.selection.quantity,
        rule.ruleDigest,
        rule,
        published.createdAt,
        id(9830),
        id(3),
        id(9831),
        proof,
      ],
    );
    const configured = preparationPublicationFixture(published, rule).record;
    await admin.query(
      `INSERT INTO rms_recipe.recipe_preparation_content(content_id,brand_id,recipe_id,recipe_version_id,modifier_rule_version_id,operation_id,actor_id,audit_id,content_digest,published_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        configured.content.contentReference,
        scope.brandReference,
        configured.recipeReference,
        configured.recipeVersionReference,
        configured.modifierRuleVersionReference,
        configured.operationReference,
        configured.actorReference,
        id(9702),
        configured.content.contentDigest,
        configured.publishedAt,
        JSON.stringify(configured),
      ],
    );
    const configuredCoverage = await preparation().capture(request);
    assert.equal(configuredCoverage.coverage.dependencies.length, 2);
    assert.deepEqual(
      configuredCoverage.coverage.dependencies.find(
        (entry) => entry.objectReference === configured.content.contentReference,
      ),
      {
        objectReference: configured.content.contentReference,
        versionReference: configured.operationReference,
        digest: configured.content.contentDigest,
      },
    );
    await assert.rejects(
      preparation().withCurrent(request, populated, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const substitution = () => source(false, "Substitution"),
      usage = () => source(false, "Usage");
    const initialRules = await substitution().capture(request);
    assert.equal(initialRules.coverage.dependencies.length, 1);
    assert.equal(initialRules.coverage.dependencies[0].versionReference, rule.ruleVersionReference);
    assert.equal(
      (await substitution().capture(request)).coverage.snapshotReference,
      initialRules.coverage.snapshotReference,
    );
    const invalidatedRule = {
      ...rule,
      ruleVersionReference: id(9840),
      ruleDigest: preparationTestHash("synthetic-invalidated-rule"),
    };
    await heldMutation(
      initialRules,
      () =>
        writer.query(
          "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at,review_evidence_json) VALUES($1,$2,$3,2,$4,$5,$6,$7,$8,'Invalidated',$9,$10,$11,$12,$13,$14,$11,NULL)",
          [
            invalidatedRule.ruleVersionReference,
            rule.ruleReference,
            scope.brandReference,
            published.recipeReference,
            published.versionReference,
            rule.selection.bindingReference,
            rule.selection.optionReference,
            rule.selection.quantity,
            invalidatedRule.ruleDigest,
            invalidatedRule,
            published.createdAt,
            id(9841),
            id(3),
            id(9842),
          ],
        ),
      substitution,
    );
    await assert.rejects(
      substitution().withCurrent(request, initialRules, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const changedRules = await substitution().capture(request);
    assert.deepEqual(
      changedRules.coverage.dependencies.map((entry) => entry.versionReference),
      [rule.ruleVersionReference, invalidatedRule.ruleVersionReference],
    );
    assert.equal(
      (await substitution().capture(request)).coverage.snapshotReference,
      changedRules.coverage.snapshotReference,
    );
    const emptyUsage = await usage().capture(request);
    assert.equal(emptyUsage.coverage.dependencies.length, 1);
    await heldMutation(
      emptyUsage,
      () =>
        writer.query(
          "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id(9900),
            published.versionReference,
            published.recipeReference,
            scope.brandReference,
            id(9910),
            id(9911),
            id(9912),
            published.createdAt,
          ],
        ),
      usage,
    );
    await assert.rejects(
      usage().withCurrent(request, emptyUsage, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const binding = await usage().capture(request);
    assert.equal(binding.coverage.dependencies.length, 2);
    const ownedBinding = binding.coverage.dependencies.find(
      (entry) => entry.objectReference === id(9900),
    );
    assert.equal(ownedBinding.versionReference, id(9900));
    assert.equal(
      (await usage().capture(request)).coverage.snapshotReference,
      binding.coverage.snapshotReference,
    );
    await assert.rejects(
      substitution().withCurrent(request, binding, async () => null),
      (error) => error.code === "RECIPE_SOURCE_INPUT_INVALID",
    );
    assert.equal(
      (
        await admin.query(
          "UPDATE rms_recipe.recipe_scope_binding SET sku_id=$1 WHERE recipe_scope_binding_id=$2",
          [id(9913), id(9900)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          "DELETE FROM rms_recipe.recipe_scope_binding WHERE recipe_scope_binding_id=$1",
          [id(9900)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await usage().capture(request)).coverage.snapshotReference,
      binding.coverage.snapshotReference,
    );
    directoryVersion = 9991;
    await assert.rejects(
      usage().withCurrent(request, binding, async () => null),
      (error) => error.code === "RECIPE_SOURCE_CHANGED",
    );
    const newDirectoryCoverage = await usage().capture(request);
    assert.notEqual(
      newDirectoryCoverage.coverage.snapshotReference,
      binding.coverage.snapshotReference,
    );
    assert.equal(directoryLeases, 0);
    const policySnapshot = { ...snapshot(2000), substitutionPolicyReference: id(2001) };
    await seed(admin, policySnapshot);
    await assert.rejects(
      substitution().capture(request),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    // A persisted record with valid schema bindings but contradictory content is not sealed.
    const brokenPublished = { ...snapshot(1900), lifecycle: "Published" };
    await seed(admin, brokenPublished);
    const corrupt = preparationPublicationFixture(brokenPublished).record;
    const corruptRecord = {
      ...corrupt,
      content: { ...corrupt.content, contentDigest: `sha256:${"f".repeat(64)}` },
      reviewEvidence: { ...corrupt.reviewEvidence, contentDigest: `sha256:${"f".repeat(64)}` },
    };
    await admin.query(
      `INSERT INTO rms_recipe.recipe_preparation_content(content_id,brand_id,recipe_id,recipe_version_id,modifier_rule_version_id,operation_id,actor_id,audit_id,content_digest,published_at,record_json) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        corruptRecord.content.contentReference,
        scope.brandReference,
        corruptRecord.recipeReference,
        corruptRecord.recipeVersionReference,
        corruptRecord.operationReference,
        corruptRecord.actorReference,
        id(9701),
        corruptRecord.content.contentDigest,
        corruptRecord.publishedAt,
        JSON.stringify(corruptRecord),
      ],
    );
    const sealsBefore = (
      await admin.query(
        "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture WHERE source_family='Preparation'",
      )
    ).rows[0].count;
    await assert.rejects(
      preparation().capture(request),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture WHERE source_family='Preparation'",
        )
      ).rows[0].count,
      sealsBefore,
    );
    const graphCount = (
      await admin.query("SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture")
    ).rows[0].count;
    const missingChild = snapshot(1500);
    const brokenParent = {
      ...snapshot(1200),
      ingredients: preparationRecipeFixture({ sub: missingChild }).ingredients,
    };
    await seed(admin, brokenParent);
    await assert.rejects(
      source().capture(request),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture",
        )
      ).rows[0].count,
      graphCount,
    );
    // Absent current pointer is not a complete/empty source. No seal may be committed.
    const countBefore = (
      await admin.query("SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture")
    ).rows[0].count;
    await admin.query(
      "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_INCOMPLETE',1,$3,$4,$3)",
      [id(900), scope.brandReference, firstSnapshot.createdAt, id(3)],
    );
    await assert.rejects(
      source().capture(request),
      (error) => error.code === "RECIPE_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_capture",
        )
      ).rows[0].count,
      countBefore,
    );
    await admin.query(`SET ROLE ${role}`);
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
      [scope.tenantReference, scope.brandReference],
    );
    await assert.rejects(
      admin.query("UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1"),
      (error) => error.code === "42501",
    );
    assert.equal(
      (
        await admin.query(
          "UPDATE rms_recipe.recipe_admin_source_capture SET captured_by_actor_id=$1",
          [id(99)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_recipe.recipe_admin_source_capture")).rowCount,
      0,
    );
    await admin.query("SELECT set_config('bop.tenant_id',$1,false)", [id(999)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_recipe.recipe_admin_source_capture")).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await writer.end();
  }
}
