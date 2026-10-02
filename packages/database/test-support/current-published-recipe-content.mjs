import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createCurrentPublishedRecipeContentSource,
  currentPublishedRecipeContentFields,
} from "../../rms/recipe/src/index.ts";
/** Actual isolated owning writer fixture. Scope/field permission remains synthetic. */
export async function exerciseCurrentPublishedRecipeContent({
  admin,
  context,
  role,
  published,
  publicationEvidence,
  id,
  at,
}) {
  const tables = [
    "rms_recipe.recipe",
    "rms_recipe.recipe_version",
    "rms_recipe.recipe_ingredient_requirement",
    "rms_recipe.recipe_allergen_evidence",
    "rms_recipe.recipe_preparation_step",
    "rms_recipe.recipe_scope_binding",
    "rms_recipe.recipe_review_record",
    "rms_recipe.recipe_operation_record",
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
  const baseline = await state();
  const input = {
    request: {
      purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(40000),
      catalogIntentDigest: "sha256:" + "a".repeat(64),
    },
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 20000).toISOString(),
    activationAt: new Date(Date.parse(at) + 3600000).toISOString(),
    recipeVersions: [{ recipeReference: id(60), versionReference: id(90) }],
  };
  async function run(probe = null, selector = input) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    let reached = false,
      entered = false,
      armed = false,
      allowed = true,
      clock = at;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
      const tx = { query: async (sql, values) => client.query(sql, [...values]) };
      const source = createCurrentPublishedRecipeContentSource({
        tenantReference: id(40001),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => clock },
        transactions: { run: async (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes(actual, fields) {
            assert.equal(actual, tx);
            assert.deepEqual(fields.requiredFields, currentPublishedRecipeContentFields);
            assert.equal(fields.permission, "recipe.manage");
            assert.equal(fields.requiredScope, "FullBrandScope");
            if (!allowed) {
              reached = armed;
              throw new Error("synthetic current content permission revoked");
            }
          },
        },
      });
      const result = await source.withCurrentContent(selector, async (content) => {
        entered = true;
        assert.deepEqual(content.contents[0].snapshot, published);
        assert.equal(content.contents[0].publicationOperationReference, id(93));
        assert.equal(
          content.contents[0].publicationEvidenceDigest,
          "sha256:" + sha256Hex(canonicalizeRfc8785(publicationEvidence)),
        );
        assert.equal(content.childReferences, "NotEvaluated");
        assert.equal(content.eligibility, "NotEvaluated");
        const { digest, ...body } = content;
        assert.equal(digest, "sha256:" + sha256Hex(canonicalizeRfc8785(body)));
        if (probe) {
          await client.query(
            "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
            [id(2), id(1)],
          );
          armed = true;
          if (probe === "fields") allowed = false;
          if (probe === "root") {
            await client.query(
              "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
              [id(2), id(60)],
            );
            reached = true;
          }
          if (probe === "expiry") {
            clock = new Date(Date.parse(at) + 5000).toISOString();
            reached = true;
          }
          if (probe === "query") {
            tx.query = async () => ({ rows: [] });
            reached = true;
          }
        }
        return "read";
      });
      assert.equal(probe, null);
      assert.equal(result, "read");
      await client.query("COMMIT");
      return { entered, reached };
    } catch (error) {
      await client.query("ROLLBACK");
      assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
      if (probe) {
        assert(entered && armed && reached, "intended late probe must be reached");
        return { entered, reached };
      }
      assert.equal(entered, false);
      return { entered, reached };
    } finally {
      await client.end();
    }
  }
  assert.equal((await run()).entered, true);
  assert.deepEqual(await state(), baseline);
  for (const selector of [
    { ...input, recipeVersions: [{ recipeReference: id(60), versionReference: id(99) }] },
    { ...input, activationAt: "2026-07-01T00:00:00.000Z" },
    { ...input, recipeVersions: [{ recipeReference: id(1), versionReference: id(4) }] },
  ]) {
    assert.equal((await run(null, selector)).entered, false);
    assert.deepEqual(await state(), baseline);
  }
  for (const probe of ["fields", "root", "expiry", "query"]) {
    await run(probe);
    assert.deepEqual(await state(), baseline);
  }
}
