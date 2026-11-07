import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  createRecipeMeasurementDraftService,
  createPostgresRecipeMeasurementDraftStore,
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
} from "../../rms/recipe/src/index.ts";
/** Actual local owning draft writer/DDL/recovery/Audit/Outbox. Synthetic scope,
 * permission and reference fixtures are not current unit or publication authority. */
export async function exerciseRecipeMeasurementDrafts({
  admin,
  context,
  role,
  published,
  tenantContext,
  permission,
  audit,
  id,
  at,
}) {
  await admin.query("GRANT SELECT,INSERT ON rms_recipe.recipe_measurement_content TO " + role);
  let sequence = 50000;
  const next = () => id(++sequence);
  const tables = [
    "rms_recipe.recipe",
    "rms_recipe.recipe_version",
    "rms_recipe.recipe_ingredient_requirement",
    "rms_recipe.recipe_allergen_evidence",
    "rms_recipe.recipe_preparation_step",
    "rms_recipe.recipe_scope_binding",
    "rms_recipe.recipe_review_record",
    "rms_recipe.recipe_operation_record",
    "rms_recipe.recipe_reference_generation",
    "rms_recipe.recipe_reference_binding",
    "rms_recipe.recipe_measurement_content",
    "rms_inventory.inventory_item",
    "rms_inventory.inventory_item_version",
    "rms_inventory.inventory_item_operation",
    "rms_inventory.configuration_reference_generation",
    "platform_audit.audit_record",
    "platform_audit.audit_chain_head",
    "platform_eventing.outbox_event",
  ];
  async function state() {
    const result = [];
    for (const table of tables)
      result.push(
        (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
          .rows,
      );
    return result;
  }
  async function transaction(work) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }
  function content(core) {
    const raw = {
      profile: "RecipeMeasurementContentV2",
      snapshot: core,
      measurements: core.ingredients.map((i) => ({
        requirementReference: i.requirementReference,
        usageUnitCode: "KG",
        usageDimension: i.unitDimension,
        targetUnitCode: "KG",
        targetDimension: i.unitDimension,
        conversionKind: "InventoryBaseUnitIdentity",
        conversionReference: null,
      })),
    };
    return requireRecipeMeasurementContentDigest({
      ...raw,
      snapshot: { ...core, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
    });
  }
  const root = next();
  const firstContent = content({
    ...published,
    recipeReference: root,
    versionReference: next(),
    stableCode: "SYNTHETIC_MEASUREMENT_DRAFT",
    lifecycle: "Draft",
    aggregateVersion: 1,
    versionNumber: 1,
  });
  const first = {
    action: "CreateDraft",
    operationReference: next(),
    expectedAggregateVersion: null,
    candidate: firstContent,
    occurredAt: at,
  };
  const second = {
    action: "ReplaceDraft",
    operationReference: next(),
    expectedAggregateVersion: 1,
    candidate: content({
      ...firstContent.snapshot,
      versionReference: next(),
      aggregateVersion: 2,
      versionNumber: 2,
    }),
    occurredAt: at,
  };
  let revoked = false;
  async function execute(input, mode = null) {
    let reached = false,
      armed = false,
      appended = false,
      own;
    const result = await transaction(async (client) => {
      if (mode) {
        const marker = await client.query(
          "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
          [id(2), id(1)],
        );
        assert.equal(marker.rowCount, 1);
        armed = true;
      }
      const tx = {
        async query(sql, values) {
          const result = await client.query(sql, [...values]);
          if (sql.startsWith("INSERT INTO rms_recipe.recipe_measurement_content")) {
            assert.equal(result.rowCount, 1);
            appended = true;
            const proof = await client.query(
              "SELECT count(*)::int AS count FROM rms_recipe.recipe_measurement_content WHERE recipe_version_id=$1",
              [input.candidate.snapshot.versionReference],
            );
            assert.equal(proof.rows[0].count, 1);
            if (mode === "append") {
              reached = true;
              throw new Error("synthetic post-append failure");
            }
            if (mode === "query") {
              reached = true;
              tx.query = async () => ({ rows: [] });
            }
            if (mode === "reentry") {
              reached = true;
              await own
                .codeAvailable({
                  brandReference: id(2),
                  stableCode: "SYNTHETIC_UNUSED",
                  excludingRecipeReference: null,
                })
                .catch(() => undefined);
            }
          }
          return result;
        },
      };
      const runner = {
        async run(work) {
          const result = await work(tx);
          if (appended && mode === "duplicate") {
            reached = true;
            await work(tx);
          }
          if (appended && mode === "result") {
            reached = true;
            return { substituted: true };
          }
          return result;
        },
      };
      const service = createRecipeMeasurementDraftService({
        authorization: {
          async authorize(request) {
            if (revoked) return null;
            return {
              tenantContext,
              permission: permission("recipe.manage"),
              costReviewPermission: null,
              foodSafetyReviewPermission: null,
              draftAuthorActorReference: id(3),
              costReviewerActorReference: null,
              foodSafetyReviewerActorReference: null,
              publicationEvidence: null,
              audit: {
                ...audit,
                auditId: next(),
                targetId: request.recipeReference,
                correlationId: request.operationReference,
                actionCode: "RECIPE_" + request.action.toUpperCase(),
                occurredAt: request.observedAt,
              },
            };
          },
        },
        references: {
          hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
          equals: (a, b) => a === b,
        },
        facts: {
          async validate() {
            if (mode === "cas") {
              const changed = await client.query(
                "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE recipe_id=$1 AND brand_id=$2",
                [root, id(2)],
              );
              assert.equal(changed.rowCount, 1);
              reached = true;
            }
            return {
              referencesValid: true,
              mappingsComplete: true,
              allergenEvidenceVerified: true,
              costEvidenceVerified: true,
              graphSnapshots: [],
            };
          },
        },
        repositoryForContent: (c) =>
          (own = createPostgresRecipeMeasurementDraftStore(runner, id(2), next, c)),
      });
      return service.execute(input);
    }).catch((error) => {
      if (mode) {
        assert(armed && reached, "actual late probe must be armed and reached");
        if (mode !== "cas") assert(appended, "actual V2 append must precede refusal");
        assert.equal(
          error.code,
          mode === "cas" ? "RECIPE_VERSION_CONFLICT" : "RECIPE_DEPENDENCY_UNAVAILABLE",
        );
      }
      throw error;
    });
    return result;
  }
  assert.equal((await execute(first)).status, "Applied");
  assert.equal((await execute(second)).status, "Applied");
  const physical = await admin.query(
    "SELECT v.snapshot_json,m.content_json,m.content_digest FROM rms_recipe.recipe_version v JOIN rms_recipe.recipe_measurement_content m USING(recipe_version_id,recipe_id,brand_id) WHERE v.recipe_id=$1 ORDER BY v.version_number",
    [root],
  );
  assert.equal(physical.rowCount, 2);
  assert.deepEqual(
    physical.rows.map((r) => r.content_json),
    [first.candidate, second.candidate],
  );
  for (const r of physical.rows) {
    assert.deepEqual(r.snapshot_json, r.content_json.snapshot);
    assert.equal(r.content_digest, r.snapshot_json.snapshotDigest);
  }
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) AS events",
    [root],
  );
  assert.deepEqual(counts.rows, [{ audits: 2, events: 2 }]);
  const baseline = await state();
  const recovered = await execute(first);
  assert.equal(recovered.status, "AlreadyApplied");
  assert.deepEqual(recovered.content, first.candidate);
  assert.equal(recovered.aggregate.aggregateVersion, 1);
  assert.deepEqual(await state(), baseline);
  const raw = {
    ...first.candidate,
    measurements: first.candidate.measurements.map((r) => ({
      ...r,
      usageUnitCode: "G",
      targetUnitCode: "G",
    })),
  };
  const altered = requireRecipeMeasurementContentDigest({
    ...raw,
    snapshot: { ...raw.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
  });
  await assert.rejects(execute({ ...first, candidate: altered }), {
    code: "RECIPE_IDEMPOTENCY_CONFLICT",
  });
  revoked = true;
  await assert.rejects(execute(first), { code: "RECIPE_PERMISSION_DENIED" });
  revoked = false;
  await assert.rejects(execute({ ...first, action: "Publish" }), {
    code: "RECIPE_DEPENDENCY_UNAVAILABLE",
  });
  const replacement = () => ({
    action: "ReplaceDraft",
    operationReference: next(),
    expectedAggregateVersion: 2,
    candidate: content({
      ...second.candidate.snapshot,
      versionReference: next(),
      aggregateVersion: 3,
      versionNumber: 3,
    }),
    occurredAt: at,
  });
  await assert.rejects(execute({ ...replacement(), expectedAggregateVersion: 1 }), {
    code: "RECIPE_VERSION_CONFLICT",
  });
  assert.deepEqual(await state(), baseline);
  for (const mode of ["append", "query", "reentry", "duplicate", "result", "cas"]) {
    await assert.rejects(execute(replacement(), mode));
    assert.deepEqual(await state(), baseline);
  }
  await transaction(async (client) => {
    assert.equal(
      (
        await client.query(
          "UPDATE rms_recipe.recipe_measurement_content SET content_digest=$1 WHERE recipe_version_id=$2",
          ["sha256:" + "f".repeat(64), firstContent.snapshot.versionReference],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "DELETE FROM rms_recipe.recipe_measurement_content WHERE recipe_version_id=$1",
          [firstContent.snapshot.versionReference],
        )
      ).rowCount,
      0,
    );
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(59999)]);
    assert.equal(
      (await client.query("SELECT * FROM rms_recipe.recipe_measurement_content")).rowCount,
      0,
    );
  });
  assert.deepEqual(await state(), baseline);
  await assert.rejects(admin.query("TRUNCATE rms_recipe.recipe_measurement_content"), {
    code: "55000",
  });
  await assert.rejects(
    transaction(async (client) => {
      const raw = {
        ...firstContent,
        snapshot: { ...firstContent.snapshot, displayNameCode: "SYNTHETIC_MISMATCH" },
      };
      await client.query(
        "INSERT INTO rms_recipe.recipe_measurement_content VALUES($1,$2,$3,$4,$5)",
        [
          raw.snapshot.versionReference,
          root,
          id(2),
          raw.snapshot.snapshotDigest,
          JSON.stringify(raw),
        ],
      );
    }),
    { code: "55000" },
  );
  await assert.rejects(
    transaction(async (client) => {
      const tx = { query: (sql, values) => client.query(sql, [...values]) };
      const own = createPostgresRecipeMeasurementDraftStore(
        { run: (work) => work(tx) },
        id(2),
        next,
        firstContent,
      );
      await own.resolveMeasurementOperation(id(93));
    }),
    { code: "RECIPE_DEPENDENCY_UNAVAILABLE" },
  );
  // Deliberately invalid new V2 attachment to an existing legacy core. No history UPDATE.
  await assert.rejects(
    transaction(async (client) => {
      const raw = {
        profile: "RecipeMeasurementContentV2",
        snapshot: published,
        measurements: firstContent.measurements,
      };
      await client.query(
        "INSERT INTO rms_recipe.recipe_measurement_content VALUES($1,$2,$3,$4,$5)",
        [
          published.versionReference,
          published.recipeReference,
          id(2),
          published.snapshotDigest,
          JSON.stringify(raw),
        ],
      );
      const tx = { query: (sql, values) => client.query(sql, [...values]) };
      await createPostgresRecipeMeasurementDraftStore(
        { run: (work) => work(tx) },
        id(2),
        next,
        firstContent,
      ).resolveMeasurementOperation(id(93));
    }),
    { code: "RECIPE_DEPENDENCY_UNAVAILABLE" },
  );
  assert.deepEqual(await state(), baseline);
}
