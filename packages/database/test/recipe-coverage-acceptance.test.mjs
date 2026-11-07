import { exerciseRecipeCorePublication } from "../test-support/recipe-core-publication.mjs";
import { exerciseRecipeSourceAssembly } from "../test-support/recipe-source-assembly.mjs";
import { exerciseCatalogAllergenCoverage } from "../test-support/catalog-allergen-coverage.mjs";
import { exerciseInventoryRecipeCoverage } from "../test-support/inventory-recipe-coverage.mjs";
import { exerciseRecipeOwnerCoverage } from "../test-support/recipe-owner-coverage.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresRecipeCoveragePublicationStore,
  parseRecipeCoverageSnapshot,
  recipeSourceFamilies,
} from "../../rms/recipe/src/index.ts";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) };
const at = "2026-09-27T12:00:00.000Z";
const coverage = () => ({
  ...scope,
  sources: recipeSourceFamilies.map((family, i) => ({
    family,
    ...scope,
    snapshotReference: id(10 + i),
    digest: `sha256:${"a".repeat(64)}`,
    complete: true,
    dependencies: [
      {
        objectReference: id(30 + i),
        versionReference: id(50 + i),
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  })),
});
const input = (n, revision = "0", captured = coverage()) => ({
  generationReference: id(n),
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  expectedRevision: revision,
  builtAt: at,
  coverage: captured,
});
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
// Explicit synthetic authorization/source fence. This tests actual storage, not foreign-feed locking.
function fence(current = coverage(), allowed = true) {
  return {
    async withAuthorizedCurrentCoverage(value, work) {
      assert.equal(value.actorReference, id(3));
      assert.equal(value.purpose, "RecipeProjectionBuild");
      if (!allowed) throw Error("synthetic denied");
      return work(current);
    },
  };
}
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2404_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_recipe,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe_admin_source_checkpoint TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_recipe.recipe_admin_source_generation TO ${role}`,
    );
    await admin.query(
      `INSERT INTO rms_recipe.recipe_admin_projection_generation(generation_id,brand_id,projection_version,source_event_sequence,built_at) VALUES($1,$2,1,12345,$3)`,
      [id(99), id(2), at],
    );
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_recipe.recipe_admin_source_binding TO ${role}`,
    );
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    let failureStage = null;
    function runner(options = {}) {
      return {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query(`SET ROLE ${role}`);
            await client.query("BEGIN");
            try {
              const result = await work({
                async query(sql, values) {
                  if (
                    options.failSwitch &&
                    sql.startsWith("UPDATE rms_recipe.recipe_admin_source_checkpoint")
                  )
                    throw Error("synthetic switch failure");
                  let result;
                  try {
                    result = await client.query(sql, [...values]);
                  } catch (error) {
                    failureStage = {
                      operation: sql.startsWith("INSERT")
                        ? "insert"
                        : sql.startsWith("UPDATE")
                          ? "switch"
                          : "read",
                      sqlState: /^[A-Z0-9]{5}$/u.test(error.code ?? "") ? error.code : "unknown",
                    };
                    throw error;
                  }
                  if (
                    options.afterSwitch &&
                    sql.startsWith("UPDATE rms_recipe.recipe_admin_source_checkpoint")
                  )
                    await options.afterSwitch();
                  return result;
                },
              });
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          } finally {
            await client.end();
          }
        },
      };
    }
    const store = (source = fence(), options = {}) =>
      createPostgresRecipeCoveragePublicationStore(runner(options), scope, source);
    const first = await store()
      .publish(input(100))
      .catch(() => {
        assert.fail(`Synthetic publication diagnostic: ${JSON.stringify(failureStage)}`);
      });
    assert.deepEqual(first, {
      generationReference: id(100),
      publicationRevision: "1",
      active: true,
      replay: false,
    });
    assert.deepEqual(await store().publish(input(100)), { ...first, replay: true });
    await rejects(
      store().publish({ ...input(100), builtAt: "2026-09-27T12:00:01.000Z" }),
      "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
    );
    const persisted = (
      await admin.query(
        "SELECT record_json AS record FROM rms_recipe.recipe_admin_source_generation WHERE generation_id=$1",
        [id(100)],
      )
    ).rows[0];
    assert.deepEqual(
      parseRecipeCoverageSnapshot(persisted.record.coverage),
      parseRecipeCoverageSnapshot(coverage()),
    );
    await rejects(
      store(fence(coverage(), false)).publish(input(101, "1")),
      "RECIPE_PUBLICATION_UNAVAILABLE",
    );
    const incomplete = coverage();
    incomplete.sources[0].complete = false;
    await rejects(store(fence(incomplete)).publish(input(102, "1")), "RECIPE_COVERAGE_INCOMPLETE");
    const changed = coverage();
    changed.sources[0].snapshotReference = id(80);
    changed.sources[0].dependencies[0].versionReference = id(81);
    await rejects(store(fence(changed)).publish(input(103, "1")), "RECIPE_COVERAGE_CHANGED");
    const conflicting = coverage();
    conflicting.sources[0].dependencies[0].digest = `sha256:${"c".repeat(64)}`;
    await rejects(
      store(fence(conflicting)).publish(input(104, "1")),
      "RECIPE_COVERAGE_INTEGRITY_CONFLICT",
    );
    await rejects(
      store(fence(), { failSwitch: true }).publish(input(105, "1")),
      "RECIPE_PUBLICATION_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_generation",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT publication_revision::text AS revision FROM rms_recipe.recipe_admin_source_checkpoint",
        )
      ).rows[0].revision,
      "1",
    );
    // Real competing PostgreSQL transactions: one succeeds, one retains stale expected revision.
    const competing = await Promise.allSettled([
      store().publish(input(106, "1")),
      store().publish(input(107, "1")),
    ]);
    assert.equal(competing.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      competing.find((x) => x.status === "rejected").reason.code,
      "RECIPE_PUBLICATION_VERSION_CONFLICT",
    );
    const winner = competing.find((x) => x.status === "fulfilled").value;
    assert.equal(winner.publicationRevision, "2");
    assert.equal((await store().publish(input(100))).active, false);
    // Pause after switch but before COMMIT. Other connections retain previous complete head/history.
    let release;
    let switched;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      switched = resolve;
    });
    const pending = store(fence(), {
      afterSwitch: async () => {
        switched();
        await waiting;
      },
    }).publish(input(108, "2"));
    try {
      await ready;
      assert.equal(
        (
          await admin.query(
            "SELECT active_generation_id AS generation FROM rms_recipe.recipe_admin_source_checkpoint",
          )
        ).rows[0].generation,
        winner.generationReference,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_generation WHERE generation_id=$1",
            [id(108)],
          )
        ).rows[0].count,
        0,
      );
    } finally {
      release();
    }
    assert.equal((await pending).publicationRevision, "3");
    // Compare every retained binding, not just capture/current from this attempt.
    const oldSnapshotConflict = coverage();
    oldSnapshotConflict.sources[0].dependencies[0].versionReference = id(120);
    await rejects(
      store(fence(oldSnapshotConflict)).publish(input(109, "3", oldSnapshotConflict)),
      "RECIPE_COVERAGE_INTEGRITY_CONFLICT",
    );
    const oldObjectConflict = coverage();
    oldObjectConflict.sources[0].snapshotReference = id(121);
    oldObjectConflict.sources[0].dependencies[0].digest = `sha256:${"c".repeat(64)}`;
    await rejects(
      store(fence(oldObjectConflict)).publish(input(110, "3", oldObjectConflict)),
      "RECIPE_COVERAGE_INTEGRITY_CONFLICT",
    );
    const advanced = coverage();
    advanced.sources[0].snapshotReference = id(122);
    advanced.sources[0].dependencies[0].versionReference = id(123);
    advanced.sources[0].dependencies[0].digest = `sha256:${"c".repeat(64)}`;
    await rejects(
      store(fence(advanced), {
        afterSwitch: async () => {
          throw Error("synthetic interruption after switch");
        },
      }).publish(input(111, "3", advanced)),
      "RECIPE_PUBLICATION_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT publication_revision::text AS revision FROM rms_recipe.recipe_admin_source_checkpoint",
        )
      ).rows[0].revision,
      "3",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_generation",
        )
      ).rows[0].count,
      3,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_admin_source_binding",
        )
      ).rows[0].count,
      14,
    );
    assert.equal(
      (await store(fence(advanced)).publish(input(112, "3", advanced))).publicationRevision,
      "4",
    );
    await admin.query(`SET ROLE ${role}`);
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
      [scope.tenantReference, scope.brandReference],
    );
    assert.equal(
      (
        await admin.query(
          "UPDATE rms_recipe.recipe_admin_source_generation SET builder_actor_id=$1",
          [id(90)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_recipe.recipe_admin_source_generation")).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query("UPDATE rms_recipe.recipe_admin_source_binding SET binding_json=$1", [
          JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_recipe.recipe_admin_source_binding")).rowCount,
      0,
    );
    await assert.rejects(
      admin.query("UPDATE rms_recipe.recipe_admin_source_checkpoint SET publication_revision=99"),
      (error) => error.code === "23503",
    );
    for (const foreign of [
      { tenantReference: id(90), brandReference: id(2) },
      { tenantReference: id(1), brandReference: id(90) },
    ]) {
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
        [foreign.tenantReference, foreign.brandReference],
      );
      assert.equal(
        (await admin.query("SELECT * FROM rms_recipe.recipe_admin_source_generation")).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("SELECT * FROM rms_recipe.recipe_admin_source_checkpoint")).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("SELECT * FROM rms_recipe.recipe_admin_source_binding")).rowCount,
        0,
      );
    }
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
      [scope.tenantReference, scope.brandReference],
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_recipe.recipe_admin_source_checkpoint(tenant_id,brand_id,publication_revision) VALUES($1,$2,0)",
        [id(90), id(2)],
      ),
      (error) => error.code === "42501",
    );
    await admin.query("RESET ROLE");
    assert.equal(
      (
        await admin.query(
          "SELECT source_event_sequence::text AS sequence FROM rms_recipe.recipe_admin_projection_generation WHERE generation_id=$1",
          [id(99)],
        )
      ).rows[0].sequence,
      "12345",
    );
    await exerciseRecipeOwnerCoverage({ admin, context, role, id, scope, at });
    await exerciseInventoryRecipeCoverage({ admin, context, role, id, scope, at });
    await exerciseCatalogAllergenCoverage({ admin, context, role, id, scope, at });
    await exerciseRecipeSourceAssembly({ admin, context, role, id, at });
    await exerciseRecipeCorePublication({ admin, context, role, id, at });
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}
it("atomically publishes durable Recipe coverage with replay, concurrency, rollback and RLS", async () => {
  await withIsolatedDatabase({ caseId: "recipe_coverage", root }, prove);
}, 120_000);
