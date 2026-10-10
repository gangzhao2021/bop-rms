import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresCatalogAllergenCoverageSource } from "../../rms/catalog/src/index.ts";
import { parseRecipeSourceCoverage } from "../../rms/recipe/src/index.ts";
/** Real Catalog persistence/locks/RLS with explicit synthetic authority/professional facts. */
export async function exerciseCatalogAllergenCoverage({ admin, context, role, id, scope, at }) {
  const tables =
    "rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion";
  await admin.query(`GRANT USAGE ON SCHEMA rms_catalog TO ${role}`);
  await admin.query(`GRANT SELECT,MAINTAIN ON ${tables} TO ${role}`);
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.recipe_allergen_source_capture TO ${role}`,
  );
  let sequence = 45000,
    allowed = true;
  const request = { actorReference: id(3), purpose: "RecipeProjectionBuild", observedAtUtc: at };
  const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
  function source(failure = false) {
    return createPostgresCatalogAllergenCoverageSource({
      scope,
      generateReference: () => id(++sequence),
      authorize: async (tx, input) => {
        const row = (
          await tx.query(
            "SELECT current_setting('bop.tenant_id') AS tenant,current_setting('bop.brand_id') AS brand,current_setting('bop.store_id') AS store",
            [],
          )
        ).rows[0];
        assert.deepEqual(row, {
          tenant: scope.tenantReference,
          brand: scope.brandReference,
          store: "",
        });
        assert.equal(input.actorReference, id(3));
        assert.equal(input.purpose, "RecipeProjectionBuild");
        assert.equal(input.family, "Allergen");
        return allowed;
      },
      runner: {
        async run(work) {
          const client = new pg.Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            const value = await work({
              query: async (sql, values) => {
                if (
                  failure &&
                  sql.startsWith("INSERT INTO rms_catalog.recipe_allergen_source_capture")
                )
                  throw Error("synthetic seal failure");
                return client.query(sql, [...values]);
              },
            });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      },
    });
  }
  const empty = await source().capture(request);
  assert.equal(empty.coverage.dependencies.length, 0);
  parseRecipeSourceCoverage(empty.coverage);
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    empty.coverage.snapshotReference,
  );
  const registry = id(40000),
    allergen = id(40001),
    evidence = id(40002),
    subject = id(40003);
  async function registryVersion(client, ref, entry, status = "Approved") {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO rms_catalog.allergen_registry_version(registry_version_id,brand_id,jurisdiction_code,policy_document_digest,reviewed_at,reviewer_actor_id,status) VALUES($1,$2,'ON',$3,$4,$5,$6)",
        [ref, scope.brandReference, `sha256:${"a".repeat(64)}`, at, id(3), status],
      );
      await client.query(
        "INSERT INTO rms_catalog.allergen_registry_entry(registry_version_id,brand_id,allergen_id,allergen_code,localized_names_json) VALUES($1,$2,$3,'MILK',$4::jsonb)",
        [ref, scope.brandReference, entry, JSON.stringify({ "en-CA": "Synthetic milk" })],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  async function evidenceVersion(
    client,
    ref,
    status = "Approved",
    until = "2026-10-28T00:00:00.000Z",
    classification = "Contains",
  ) {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO rms_catalog.allergen_source_evidence(evidence_id,brand_id,subject_id,subject_kind,source_version_id,supplier_id,document_digest,reviewed_at,valid_until,evidence_status) VALUES($1,$2,$3,'Ingredient',$4,NULL,$5,$6,$7,$8)",
        [
          ref,
          scope.brandReference,
          subject,
          id(40004),
          `sha256:${"b".repeat(64)}`,
          "2026-09-01T00:00:00.000Z",
          until,
          status,
        ],
      );
      await client.query(
        "INSERT INTO rms_catalog.allergen_source_assertion(evidence_id,brand_id,registry_version_id,allergen_id,classification) VALUES($1,$2,$3,$4,$5)",
        [ref, scope.brandReference, registry, allergen, classification],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  await registryVersion(admin, registry, allergen);
  await evidenceVersion(admin, evidence);
  await rejects(
    source().withCurrent(request, empty, async () => null),
    "ALLERGEN_SOURCE_CHANGED",
  );
  const initial = await source().capture(request);
  assert.equal(initial.coverage.dependencies.length, 2);
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    initial.coverage.snapshotReference,
  );
  const writer = new pg.Client(context.clientConfig);
  await writer.connect();
  async function held(captured, mutation) {
    let release, ready;
    const hold = new Promise((resolve) => {
        release = resolve;
      }),
      acquired = new Promise((resolve) => {
        ready = resolve;
      });
    const reading = source().withCurrent(request, captured, async () => {
      ready();
      await hold;
      return "held";
    });
    try {
      await acquired;
      const writing = Promise.resolve()
        .then(mutation)
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
      try {
        let blocked = false;
        for (let n = 0; n < 100; n++) {
          const row = (
            await admin.query("SELECT wait_event_type AS kind FROM pg_stat_activity WHERE pid=$1", [
              writer.processID,
            ])
          ).rows[0];
          if (row?.kind === "Lock") {
            blocked = true;
            break;
          }
          await delay(10);
        }
        assert.equal(blocked, true);
      } finally {
        release();
      }
      assert.equal(await reading, "held");
      const outcome = await writing;
      if (!outcome.ok) throw outcome.error;
    } finally {
      release();
      await reading.catch(() => undefined);
    }
  }
  try {
    await writer.query("SET lock_timeout='5s'");
    // Assertions and registry entries are append-only since WP-2423 (migration 2000_015): an
    // UPDATE is a no-op, so it can neither change a sealed snapshot nor reseal it. A source changes
    // only by appending evidence or a registry version, exercised below.
    await writer.query(
      "UPDATE rms_catalog.allergen_source_assertion SET classification='CrossContactPossible' WHERE evidence_id=$1",
      [evidence],
    );
    await writer.query(
      "UPDATE rms_catalog.allergen_registry_entry SET localized_names_json=$1::jsonb WHERE registry_version_id=$2",
      [JSON.stringify({ "en-CA": "Synthetic changed milk" }), registry],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT classification FROM rms_catalog.allergen_source_assertion WHERE evidence_id=$1",
          [evidence],
        )
      ).rows[0].classification,
      "Contains",
    );
    await source().withCurrent(request, initial, async () => null);
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      initial.coverage.snapshotReference,
    );
    await held(initial, () => evidenceVersion(writer, id(40010), "Invalidated"));
    await rejects(
      source().withCurrent(request, initial, async () => null),
      "ALLERGEN_SOURCE_CHANGED",
    );
    const count = (
      await admin.query(
        "SELECT count(*)::text AS count FROM rms_catalog.recipe_allergen_source_capture",
      )
    ).rows[0].count;
    await rejects(source(true).capture(request), "ALLERGEN_SOURCE_UNAVAILABLE");
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::text AS count FROM rms_catalog.recipe_allergen_source_capture",
        )
      ).rows[0].count,
      count,
    );
    const invalidated = await source().capture(request);
    assert.equal(invalidated.coverage.dependencies.length, 3);
    assert.equal(
      invalidated.coverage.dependencies.find((d) => d.versionReference === evidence)?.digest,
      initial.coverage.dependencies.find((d) => d.versionReference === evidence)?.digest,
    );
    await held(invalidated, () => registryVersion(writer, id(40020), id(40021), "Superseded"));
    await rejects(
      source().withCurrent(request, invalidated, async () => null),
      "ALLERGEN_SOURCE_CHANGED",
    );
    await evidenceVersion(
      admin,
      id(40030),
      "Conflicting",
      "2026-09-02T00:00:00.000Z",
      "Unverified",
    );
    await registryVersion(admin, id(40040), id(40041), "Invalidated");
    const complete = await source().capture(request);
    assert.equal(complete.coverage.dependencies.length, 6);
    parseRecipeSourceCoverage(complete.coverage);
    // Coverage is raw history completeness; expiry never becomes approval and does not mutate version digest.
    const later = await source().capture({ ...request, observedAtUtc: "2026-11-28T00:00:00.000Z" });
    assert.equal(later.coverage.snapshotReference, complete.coverage.snapshotReference);
    await rejects(
      source().withCurrent(request, complete, async () => {
        throw Error("synthetic private detail");
      }),
      "ALLERGEN_SOURCE_UNAVAILABLE",
    );
    await rejects(
      source().withCurrent(request, complete, async () => {
        allowed = false;
        return "private";
      }),
      "ALLERGEN_SOURCE_PERMISSION_DENIED",
    );
    allowed = true;
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      complete.coverage.snapshotReference,
    );
    await admin.query(`SET ROLE ${role}`);
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id','',false)",
      [scope.tenantReference, scope.brandReference],
    );
    assert.equal(
      (
        await admin.query(
          "UPDATE rms_catalog.recipe_allergen_source_capture SET content_digest=$1",
          [`sha256:${"f".repeat(64)}`],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_catalog.recipe_allergen_source_capture")).rowCount,
      0,
    );
    for (const foreign of [
      { tenantReference: id(40999), brandReference: scope.brandReference },
      { ...scope, brandReference: id(40999) },
    ]) {
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
        [foreign.tenantReference, foreign.brandReference],
      );
      assert.equal(
        (await admin.query("SELECT * FROM rms_catalog.recipe_allergen_source_capture")).rowCount,
        0,
      );
    }
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await writer.end();
  }
}
