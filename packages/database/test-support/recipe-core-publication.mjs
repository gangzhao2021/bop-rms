import assert from "node:assert/strict";
import pg from "pg";
import {
  createRecipeCoverageSourceAssembly,
  createRecipeCoreRebuildCoordinator,
  createPostgresRecipeCoreRebuildStateStore,
  createPostgresRecipeCoveragePublicationStore,
  createPostgresRecipeCorePublicationStore,
  createPostgresRecipeCoreQueryStore,
  createPostgresRecipeOwnerCoverageSource,
  createPostgresRecipeProjectionFactsSource,
  createPostgresRecipePreparationCoverageSource,
  createPostgresRecipeSubstitutionCoverageSource,
  createPostgresRecipeUsageCoverageSource,
} from "../../rms/recipe/src/index.ts";
import { createPostgresInventoryRecipeConfigurationSource } from "../../rms/inventory/src/index.ts";
import { createPostgresCatalogAllergenCoverageSource } from "../../rms/catalog/src/index.ts";
import { insertRecipeVersion } from "../../rms/recipe/src/infrastructure/persistence/recipe-version-write.ts";
import { preparationRecipeFixture } from "../../rms/recipe/src/tests/recipe-preparation-content.fixture.ts";
/** Actual six owner producers and row/coverage storage. Supplier/IAM/directory are explicit synthetic leases. */
export async function exerciseRecipeCorePublication({ admin, context, role, id, at }) {
  const scope = { tenantReference: id(60001), brandReference: id(60002) },
    held = new Map();
  let sequence = 61000,
    authorityHeld = 0,
    fieldsHeld = 0,
    rebuildStateHeld = 0,
    directoryHeld = 0,
    allowed = true,
    failureStage = null;
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_recipe.recipe_admin_core_generation,rms_recipe.recipe_admin_core_row,rms_recipe.recipe_admin_core_checkpoint TO ${role}`,
  );
  function runner(options = {}) {
    return {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await work({
            async query(sql, values) {
              if (options.query) assert.ok(fieldsHeld > 0);
              if (options.rebuildState) assert.ok(rebuildStateHeld > 0);
              if (options.publication || options.currentSources) {
                assert.ok(authorityHeld > 0);
                assert.ok(fieldsHeld > 0);
                assert.ok(directoryHeld > 0);
                assert.equal(held.size, 7);
              }
              if (options.fail && sql.startsWith(options.fail))
                throw Error("synthetic core rollback");
              try {
                const result = await client.query(sql, [...values]);
                if (
                  options.corruptRows &&
                  sql.startsWith("SELECT row_json AS record FROM rms_recipe.recipe_admin_core_row")
                )
                  return {
                    rows: result.rows.map((row) => ({
                      record: { ...row.record, displayNameCode: "CORRUPTED_DRIVER" },
                    })),
                  };
                if (
                  options.hostileGraph &&
                  sql.startsWith(
                    "SELECT publication_revision::text AS revision,core_digest AS digest",
                  )
                ) {
                  const graph = result.rows[0]?.graph;
                  if (graph?.nodes?.length)
                    Object.defineProperty(graph.nodes, "0", {
                      enumerable: true,
                      get: options.hostileGraph,
                    });
                }
                return result;
              } catch (error) {
                failureStage = { sqlState: error.code, operation: sql.slice(0, 70) };
                throw error;
              }
            },
          });
          if (options.beforeCommit) await options.beforeCommit();
          await client.query("COMMIT");
          if (options.rebuildState) assert.ok(rebuildStateHeld > 0);
          if (options.failAfterCommit) throw Error("synthetic lost committed response");
          if (options.query) assert.ok(fieldsHeld > 0);
          if (options.publication || options.currentSources) {
            assert.ok(fieldsHeld > 0);
            assert.ok(authorityHeld > 0);
            assert.equal(held.size, 7);
            assert.ok(directoryHeld > 0);
          }
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
  const options = {
    runner: runner(),
    scope,
    generateReference: () => id(++sequence),
    authorize: async () => authorityHeld > 0,
    authorizeFacts: async () => fieldsHeld > 0,
    usageStores: {
      async withCurrent(_input, work) {
        directoryHeld++;
        try {
          return await work({
            ...scope,
            snapshotReference: id(60003),
            digest: `sha256:${"d".repeat(64)}`,
            complete: true,
            storeReferences: [],
          });
        } finally {
          directoryHeld--;
        }
      },
    },
  };
  const supplierRead = {
    coverage: {
      ...scope,
      family: "Supplier",
      snapshotReference: id(60004),
      digest: `sha256:${"e".repeat(64)}`,
      complete: true,
      dependencies: [],
    },
    capturedAtUtc: at,
    asOfUtc: at,
  };
  const sources = {
    Recipe: createPostgresRecipeOwnerCoverageSource(options),
    Inventory: createPostgresInventoryRecipeConfigurationSource(options),
    Allergen: createPostgresCatalogAllergenCoverageSource(options),
    Preparation: createPostgresRecipePreparationCoverageSource(options),
    Substitution: createPostgresRecipeSubstitutionCoverageSource(options),
    Usage: createPostgresRecipeUsageCoverageSource(options),
    Supplier: {
      capture: async (request) => ({ ...supplierRead, asOfUtc: request.observedAtUtc }),
      withCurrent: async (request, _captured, work) =>
        work({ ...supplierRead, asOfUtc: request.observedAtUtc }),
    },
  };
  for (const [family, owner] of Object.entries(sources))
    sources[family] = {
      capture: owner.capture,
      withCurrent: (request, captured, work) =>
        owner.withCurrent(request, captured, async (value) => {
          held.set(family, (held.get(family) ?? 0) + 1);
          try {
            return await work(value);
          } finally {
            const count = held.get(family);
            if (count === 1) held.delete(family);
            else held.set(family, count - 1);
          }
        }),
    };
  const assembly = createRecipeCoverageSourceAssembly({
    scope,
    sources,
    authorization: {
      async withAuthorizedScope(_input, work) {
        authorityHeld++;
        try {
          return await work();
        } finally {
          authorityHeld--;
        }
      },
    },
  });
  const fieldAuthority = {
    async withAuthorizedFactsScope(input, work) {
      assert.deepEqual(input, {
        ...scope,
        actorReference: id(3),
        purpose: "RecipeProjectionBuild",
        access: "ProjectionFacts",
      });
      if (!allowed) throw Error("synthetic field permission denied");
      fieldsHeld++;
      try {
        return await work();
      } finally {
        fieldsHeld--;
      }
    },
  };
  const facts = createPostgresRecipeProjectionFactsSource(options);
  const store = (extra = {}) =>
    createPostgresRecipeCorePublicationStore(runner({ publication: true, ...extra }), scope, {
      coverage: assembly,
      facts,
      authorization: fieldAuthority,
    });
  const rebuildStateAuthority = {
    async withAuthorizedRebuildScope(input, work) {
      assert.deepEqual(input, {
        ...scope,
        generationReference: input.generationReference,
        actorReference: id(3),
        purpose: "RecipeProjectionBuild",
        observedAtUtc: input.observedAtUtc,
        access: "ProjectionRebuildState",
      });
      if (!allowed) throw Error("synthetic rebuild state denied");
      rebuildStateHeld++;
      try {
        return await work();
      } finally {
        rebuildStateHeld--;
      }
    },
  };
  const rebuildHead = () =>
    createPostgresRecipeCoreRebuildStateStore(
      runner({ rebuildState: true }),
      scope,
      rebuildStateAuthority,
    );
  const rebuildRequest = (n, observedAtUtc = at) => ({
    generationReference: id(n),
    actorReference: id(3),
    purpose: "RecipeProjectionBuild",
    observedAtUtc,
  });
  const rebuilder = (extra = {}) =>
    createRecipeCoreRebuildCoordinator({
      scope,
      head: rebuildHead(),
      sources: assembly,
      publication: store(extra),
    });
  const readAuthority = {
    async withAuthorizedCoreScope(input, work) {
      assert.deepEqual(input, {
        ...scope,
        actorReference: id(3),
        purpose: "RecipeProjectionRead",
        observedAtUtc: input.observedAtUtc,
        access: "ProjectionCore",
      });
      if (!allowed) throw Error("synthetic read denied");
      fieldsHeld++;
      try {
        return await work();
      } finally {
        fieldsHeld--;
      }
    },
  };
  // Explicit privileged synthetic service capability bridges source metadata; no runtime Read->Build grant.
  function reader(mode = "current") {
    return createPostgresRecipeCoreQueryStore(
      runner({ query: true, currentSources: mode === "current" }),
      scope,
      {
        authorization: readAuthority,
        coverage: {
          async withCurrentCoverage(input, work) {
            if (mode === "unconfirmed") return work(null);
            return assembly.withCurrentCoverage(
              {
                actorReference: id(3),
                purpose: "RecipeProjectionBuild",
                observedAtUtc: input.observedAtUtc,
              },
              work,
            );
          },
        },
      },
    );
  }
  const readRequest = (observedAtUtc = at) => ({
    actorReference: id(3),
    purpose: "RecipeProjectionRead",
    observedAtUtc,
  });
  assert.equal(await reader().load(readRequest()), null);
  const request = { actorReference: id(3), purpose: "RecipeProjectionBuild", observedAtUtc: at };
  const input = (n, revision, coverage) => ({
    generationReference: id(n),
    actorReference: id(3),
    purpose: "RecipeProjectionBuild",
    expectedRevision: revision,
    builtAt: at,
    coverage,
  });
  const count = async (table) =>
    (
      await admin.query(
        `SELECT count(*)::int AS count FROM rms_recipe.${table} WHERE tenant_id=$1 AND brand_id=$2`,
        [scope.tenantReference, scope.brandReference],
      )
    ).rows[0].count;
  const head = async (table) =>
    (
      await admin.query(
        `SELECT publication_revision::text AS revision,active_generation_id AS generation FROM rms_recipe.${table} WHERE tenant_id=$1 AND brand_id=$2`,
        [scope.tenantReference, scope.brandReference],
      )
    ).rows[0];
  const initialRebuildState = await rebuildHead().load(rebuildRequest(67000));
  assert.equal(initialRebuildState.sourceRevision, "0");
  assert.equal(initialRebuildState.coreRevision, "0");
  assert.equal(initialRebuildState.operation, null);
  const empty = await assembly.capture(request);
  const firstInput = input(63000, "0", empty),
    first = await store()
      .publish(firstInput)
      .catch((error) => {
        assert.fail(`Core publication diagnostic ${error.code}: ${JSON.stringify(failureStage)}`);
      });
  assert.equal(first.rowCount, 0);
  assert.equal(first.projectionVersion, 2);
  assert.equal(first.publicationRevision, "1");
  const emptyRead = await reader().load(readRequest());
  assert.equal(emptyRead.core.rows.length, 0);
  assert.equal(emptyRead.freshness, "Fresh");
  assert.equal(emptyRead.sourceCoverageStatus, "Current");
  assert.deepEqual(await store().publish(firstInput), { ...first, replay: true });
  allowed = false;
  await assert.rejects(
    store().publish(input(63001, "1", empty)),
    (error) => error.code === "RECIPE_PUBLICATION_UNAVAILABLE",
  );
  allowed = true;
  assert.equal(await count("recipe_admin_core_generation"), 1);
  const child = {
    ...preparationRecipeFixture(),
    recipeReference: id(62000),
    versionReference: id(62001),
    brandReference: scope.brandReference,
    stableCode: "SYNTHETIC_CORE_CHILD",
  };
  const parent = {
    ...preparationRecipeFixture({ sub: child }),
    recipeReference: id(62010),
    versionReference: id(62011),
    brandReference: scope.brandReference,
    stableCode: "SYNTHETIC_CORE_PARENT",
    ingredients: preparationRecipeFixture({ sub: child }).ingredients.map((item) => ({
      ...item,
      unitDimension: child.yieldDimension,
    })),
  };
  await admin.query("BEGIN");
  try {
    for (const snapshot of [child, parent]) {
      await admin.query(
        "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
        [
          snapshot.recipeReference,
          scope.brandReference,
          snapshot.stableCode,
          snapshot.createdAt,
          id(3),
        ],
      );
      await insertRecipeVersion(
        { query: (sql, values) => admin.query(sql, [...values]) },
        snapshot,
        () => id(++sequence),
      );
      await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
        snapshot.versionReference,
        snapshot.recipeReference,
      ]);
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  await assert.rejects(
    store().publish(input(63002, "1", empty)),
    (error) => error.code === "RECIPE_COVERAGE_CHANGED",
  );
  const covered = await assembly.capture(request),
    secondInput = input(63003, "1", covered),
    second = await store().publish(secondInput);
  assert.equal(second.rowCount, 2);
  assert.equal(second.publicationRevision, "2");
  const secondRead = await reader().load(readRequest());
  assert.equal(secondRead.generationReference, secondInput.generationReference);
  assert.equal(secondRead.core.rows.length, 2);
  assert.equal(secondRead.coreDigest, second.coreDigest);
  assert.equal(secondRead.freshness, "Fresh");
  assert.equal((await reader().load(readRequest("2026-09-27T12:00:30.000Z"))).freshness, "Fresh");
  assert.equal((await reader().load(readRequest("2026-09-27T12:00:30.001Z"))).freshness, "Stale");
  const unknown = await reader("unconfirmed").load(readRequest());
  assert.equal(unknown.freshness, "Stale");
  assert.equal(unknown.sourceCoverageStatus, "Unconfirmed");
  allowed = false;
  await assert.rejects(
    reader().load(readRequest()),
    (error) => error.code === "RECIPE_CORE_QUERY_UNAVAILABLE",
  );
  allowed = true;

  const records = (
    await admin.query(
      "SELECT row_json AS record FROM rms_recipe.recipe_admin_core_row WHERE generation_id=$1 ORDER BY recipe_id",
      [secondInput.generationReference],
    )
  ).rows.map((row) => row.record);
  assert.deepEqual(
    records.map((row) => row.recipeReference),
    [child.recipeReference, parent.recipeReference],
  );
  assert.equal(records[1].ingredients[0].sourceVersionReference, child.versionReference);
  assert.equal(records[0].ingredients[0].unitCostMinorNumerator, undefined);
  assert.equal(records[0].ingredients[0].allergens, undefined);
  assert.deepEqual(await store().publish(secondInput), { ...second, replay: true });
  await assert.rejects(
    store({ corruptRows: true }).publish(secondInput),
    (error) => error.code === "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
  );
  let graphGetterCalls = 0;
  await assert.rejects(
    store({
      hostileGraph: () => {
        graphGetterCalls++;
        throw Error("private raw driver");
      },
    }).publish(secondInput),
    (error) => error.code === "RECIPE_PUBLICATION_UNAVAILABLE",
  );
  assert.equal(graphGetterCalls, 0);
  assert.equal(
    (await head("recipe_admin_core_checkpoint")).generation,
    secondInput.generationReference,
  );

  await assert.rejects(
    store().publish({ ...secondInput, builtAt: "2026-09-27T12:00:01.000Z" }),
    (error) => error.code === "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
  );
  for (const fail of [
    "INSERT INTO rms_recipe.recipe_admin_core_generation",
    "INSERT INTO rms_recipe.recipe_admin_core_row",
    "UPDATE rms_recipe.recipe_admin_core_checkpoint",
  ]) {
    await assert.rejects(
      store({ fail }).publish(input(++sequence, "2", covered)),
      (error) => error.code === "RECIPE_PUBLICATION_UNAVAILABLE",
    );
    assert.deepEqual(await head("recipe_admin_source_checkpoint"), {
      revision: "2",
      generation: secondInput.generationReference,
    });
    assert.deepEqual(await head("recipe_admin_core_checkpoint"), {
      revision: "2",
      generation: secondInput.generationReference,
    });
    assert.equal(await count("recipe_admin_source_generation"), 2);
    assert.equal(await count("recipe_admin_core_generation"), 2);
    assert.equal(await count("recipe_admin_core_row"), 2);
  }
  let reached, release;
  const paused = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const thirdInput = input(63004, "2", covered),
    pending = store({
      beforeCommit: async () => {
        reached();
        await gate;
      },
    }).publish(thirdInput);
  await paused;
  try {
    assert.equal(
      (await head("recipe_admin_core_checkpoint")).generation,
      secondInput.generationReference,
    );
    assert.equal(
      (await head("recipe_admin_source_checkpoint")).generation,
      secondInput.generationReference,
    );
    assert.equal(await count("recipe_admin_core_row"), 2);
    assert.equal(
      (await reader().load(readRequest())).generationReference,
      secondInput.generationReference,
    );
  } finally {
    release();
  }
  const third = await pending;
  assert.equal(third.publicationRevision, "3");
  assert.equal(await count("recipe_admin_core_row"), 4);
  const competing = await Promise.allSettled([
    store().publish(input(63005, "3", covered)),
    store().publish(input(63006, "3", covered)),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    competing.find((result) => result.status === "rejected").reason.code,
    "RECIPE_PUBLICATION_VERSION_CONFLICT",
  );
  const winner = competing.find((result) => result.status === "fulfilled").value;
  assert.equal(winner.publicationRevision, "4");
  assert.equal((await store().publish(secondInput)).active, false);
  // A coverage-only refresh advances its own head while retaining active core rows.
  const metadataInput = input(63007, "4", covered);
  await createPostgresRecipeCoveragePublicationStore(runner(), scope, assembly).publish(
    metadataInput,
  );
  assert.equal((await head("recipe_admin_source_checkpoint")).revision, "5");
  assert.equal((await head("recipe_admin_core_checkpoint")).generation, winner.generationReference);
  await assert.rejects(
    store().publish(metadataInput),
    (error) => error.code === "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
  );
  const winnerInput = input(
    Number.parseInt(winner.generationReference.slice(-12), 16),
    "3",
    covered,
  );
  assert.equal((await store().publish(winnerInput)).active, true);
  assert.equal(
    (await reader().load(readRequest())).generationReference,
    winner.generationReference,
  );
  await admin.query(
    "INSERT INTO rms_catalog.allergen_registry_version(registry_version_id,brand_id,jurisdiction_code,policy_document_digest,reviewed_at,reviewer_actor_id,status) VALUES($1,$2,'ON',$3,$4,$5,'Approved')",
    [id(64000), scope.brandReference, `sha256:${"a".repeat(64)}`, at, id(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.allergen_registry_entry(registry_version_id,brand_id,allergen_id,allergen_code,localized_names_json) VALUES($1,$2,$3,'MILK',$4::jsonb)",
    [
      id(64000),
      scope.brandReference,
      id(64001),
      JSON.stringify({ "en-CA": "Synthetic query milk" }),
    ],
  );
  const changedRead = await reader().load(readRequest());
  assert.equal(changedRead.freshness, "Stale");
  assert.equal(changedRead.sourceCoverageStatus, "Changed");
  assert.equal(changedRead.generationReference, winner.generationReference);

  // Rebuild binds the actual source head5, not retained core head4. Read back a real COMMIT after response loss.
  const beforeRebuild = await rebuildHead().load(rebuildRequest(67000));
  assert.equal(beforeRebuild.sourceRevision, "5");
  assert.equal(beforeRebuild.coreRevision, "4");
  const recovered = await rebuilder({ failAfterCommit: true }).rebuild(rebuildRequest(67000));
  assert.equal(recovered.publicationRevision, "6");
  assert.equal(recovered.rowCount, 2);
  assert.equal(recovered.replay, true);
  assert.equal(recovered.active, true);
  assert.deepEqual(await head("recipe_admin_core_checkpoint"), {
    revision: "6",
    generation: id(67000),
  });
  let retryCaptures = 0,
    retryPublications = 0;
  const receiptOnly = createRecipeCoreRebuildCoordinator({
    scope,
    head: rebuildHead(),
    sources: {
      async capture() {
        retryCaptures++;
        throw Error("unexpected repeat capture");
      },
    },
    publication: {
      async publish() {
        retryPublications++;
        throw Error("unexpected repeat publication");
      },
    },
  });
  const extraRecipe = {
    ...preparationRecipeFixture(),
    recipeReference: id(62030),
    versionReference: id(62031),
    brandReference: scope.brandReference,
    stableCode: "SYNTHETIC_CORE_RECOVERY",
  };
  await admin.query("BEGIN");
  try {
    await admin.query(
      "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
      [
        extraRecipe.recipeReference,
        scope.brandReference,
        extraRecipe.stableCode,
        extraRecipe.createdAt,
        id(3),
      ],
    );
    await insertRecipeVersion(
      { query: (sql, values) => admin.query(sql, [...values]) },
      extraRecipe,
      () => id(++sequence),
    );
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
      extraRecipe.versionReference,
      extraRecipe.recipeReference,
    ]);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const laterClock = new Date(Date.parse(at) + 1000).toISOString();
  assert.deepEqual(await receiptOnly.rebuild(rebuildRequest(67000, laterClock)), recovered);
  const changedAfterReceipt = await reader().load(readRequest());
  assert.equal(changedAfterReceipt.core.rows.length, 2);
  assert.equal(changedAfterReceipt.sourceCoverageStatus, "Changed");
  assert.equal(changedAfterReceipt.freshness, "Stale");
  const rebuilt = await rebuilder().rebuild(rebuildRequest(67001));
  assert.equal(rebuilt.publicationRevision, "7");
  assert.equal(rebuilt.rowCount, 3);
  assert.equal(rebuilt.replay, false);
  const oldReceipt = await receiptOnly.rebuild(rebuildRequest(67000, laterClock));
  assert.equal(oldReceipt.active, false);
  assert.equal(oldReceipt.publicationRevision, "6");
  assert.equal(retryCaptures, 0);
  assert.equal(retryPublications, 0);
  assert.equal((await head("recipe_admin_core_checkpoint")).generation, id(67001));
  await assert.rejects(
    receiptOnly.rebuild(rebuildRequest(63007)),
    (error) => error.code === "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    rebuilder({ fail: "INSERT INTO rms_recipe.recipe_admin_core_generation" }).rebuild(
      rebuildRequest(67002),
    ),
    (error) => error.code === "RECIPE_PUBLICATION_UNAVAILABLE",
  );
  assert.equal((await rebuildHead().load(rebuildRequest(67002))).operation, null);
  assert.equal((await head("recipe_admin_source_checkpoint")).revision, "7");
  assert.equal((await head("recipe_admin_core_checkpoint")).revision, "7");
  const retried = await rebuilder().rebuild(rebuildRequest(67002));
  assert.equal(retried.publicationRevision, "8");
  assert.equal(retried.rowCount, 3);
  assert.equal(retried.replay, false);
  assert.equal(rebuildStateHeld, 0);

  // Explicit NOBYPASSRLS and immutable history; fixture grants are not live privileges.
  await admin.query(`SET ROLE ${role}`);
  await admin.query(
    "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id','',false)",
    [scope.tenantReference, scope.brandReference],
  );
  const update = await admin.query(
    'UPDATE rms_recipe.recipe_admin_core_row SET row_json=row_json||\'{"displayNameCode":"FORBIDDEN"}\'::jsonb WHERE generation_id=$1',
    [secondInput.generationReference],
  );
  assert.equal(update.rowCount, 0);
  assert.equal(
    (
      await admin.query(
        "DELETE FROM rms_recipe.recipe_admin_core_generation WHERE generation_id=$1",
        [secondInput.generationReference],
      )
    ).rowCount,
    0,
  );
  for (const config of [
    { tenant: id(60099), brand: scope.brandReference, store: "" },
    { tenant: scope.tenantReference, brand: id(60099), store: "" },
    { tenant: scope.tenantReference, brand: scope.brandReference, store: id(60099) },
  ]) {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
      [config.tenant, config.brand, config.store],
    );
    assert.equal(await count("recipe_admin_core_generation"), 0);
    assert.equal(await count("recipe_admin_core_row"), 0);
    assert.equal(await count("recipe_admin_core_checkpoint"), 0);
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_recipe.recipe_admin_core_checkpoint(tenant_id,brand_id,publication_revision,active_generation_id) VALUES($1,$2,0,NULL)",
        [scope.tenantReference, scope.brandReference],
      ),
      (error) => error.code === "42501",
    );
  }
  await admin.query("RESET ROLE");
  assert.equal(fieldsHeld, 0);
  assert.equal(authorityHeld, 0);
  assert.equal(directoryHeld, 0);
  assert.equal(held.size, 0);
}
