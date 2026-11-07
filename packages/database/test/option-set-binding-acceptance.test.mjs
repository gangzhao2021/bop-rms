import { exerciseOptionSetPublicationResolution } from "../test-support/option-set-publication-resolution.mjs";
import { exerciseOptionSetAuthoringResolution } from "../test-support/option-set-authoring-resolution.mjs";
import { exerciseOptionSetAuthoringRuntimeHttp } from "../test-support/option-set-authoring-runtime-http.mjs";
import { exerciseOptionSetFullEdit } from "../test-support/option-set-full-edit.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseOptionSetReviewRelease } from "../test-support/option-set-review-release.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f6000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-01T14:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic" });

async function prove(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const role = `wp1022_${context.runId}`;
  try {
    await admin.query(
      `INSERT INTO rms_catalog.option_set
       (option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'MILK','Draft',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.option_set_version
       (option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,display_style,minimum_selection,maximum_selection,
        allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'SingleChoice',1,1,false,1,1,$5,$5)`,
      [id(4), id(1), id(2), names, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.option
       (option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,
        localized_names_json,localized_descriptions_json,sort_order,default_eligible,
        created_at,created_by_actor_id)
       VALUES
       ($1,$2,$3,$4,'WHOLE','Draft',$5::jsonb,'{}'::jsonb,0,true,$6,$7),
       ($8,$2,$3,$4,'OAT','Draft',$5::jsonb,'{}'::jsonb,1,true,$6,$7)`,
      [id(5), id(4), id(1), id(2), names, at, id(3), id(6)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.option_conflict (option_id,conflict_option_id,option_set_id,brand_id)
       VALUES ($1,$2,$3,$4)`,
      [id(5), id(6), id(1), id(2)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.option_conflict (option_id,conflict_option_id,option_set_id,brand_id)
         VALUES ($1,$1,$2,$3)`,
        [id(5), id(1), id(2)],
      ),
      /option_conflict_not_self/u,
    );

    await admin.query(
      `INSERT INTO rms_catalog.product
       (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LATTE','PreparedFood','Draft',1,$3,$4,$3)`,
      [id(10), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_version
       (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
      [id(11), id(10), id(2), names, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sku
       (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,
        variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,'LATTE-EACH','Draft',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)`,
      [id(12), id(10), id(2), id(11), names, `sha256:${"a".repeat(64)}`, at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_option_binding
       (binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,
        purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed)
       VALUES ($1,$2,$3,$4,$5,$6,'MILK',0,1,1,false)`,
      [id(13), id(11), id(10), id(2), id(1), id(4)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_option_binding_option
       (binding_id,product_id,brand_id,option_id,option_set_id,default_quantity)
       VALUES ($1,$2,$3,$4,$5,1)`,
      [id(13), id(10), id(2), id(5), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_option_binding_sku_scope
       (binding_id,product_id,brand_id,sku_id,scope_kind)
       VALUES ($1,$2,$3,$4,'Include')`,
      [id(13), id(10), id(2), id(12)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.product_option_binding
         (binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,
          purpose,sort_order,store_override_allowed)
         VALUES ($1,$2,$3,$4,$5,$6,'MILK',1,false)`,
        [id(14), id(11), id(10), id(2), id(1), id(4)],
      ),
      /product_option_binding_purpose_unique/u,
    );

    // The new owning operation trigger requires explicit scope even for this
    // isolated legacy admin fixture. LOCAL settings clear before the RLS probe.
    await admin.query("BEGIN");
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [id(80), id(2)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.option_set_operation_record
       (operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at)
       VALUES ($1,$2,$3,'Create',$4,1,$5)`,
      [id(20), id(2), id(1), `sha256:${"b".repeat(64)}`, at],
    );
    await admin.query("COMMIT");
    await admin.query(
      `UPDATE rms_catalog.option_set_operation_record SET result_aggregate_version=2 WHERE operation_id=$1`,
      [id(20)],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT result_aggregate_version FROM rms_catalog.option_set_operation_record WHERE operation_id=$1",
          [id(20)],
        )
      ).rows[0].result_aggregate_version,
      1,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.option_set")).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.option_set")).rowCount, 1);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.product_option_binding")).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Option Set, Option and Product Binding persistence boundaries", async () => {
  await withIsolatedDatabase({ caseId: "option_set", root }, prove);
}, 120_000);

it("records actual Option Set reviewed content and Publishing-linked sealed release atomically", async () => {
  await withIsolatedDatabase({ caseId: "option_review", root }, exerciseOptionSetReviewRelease);
}, 120_000);

it("persists a near-one-MiB actual Draft through its bounded Frozen envelope and Publishing-linked release", async () => {
  await withIsolatedDatabase({ caseId: "option_near_limit", root }, (context) =>
    exerciseOptionSetReviewRelease(context, { nearLimit: true }),
  );
}, 120_000);

it("persists ordinary Option Edit server identities and Archive history with exact replay and late rollback", async () => {
  await withIsolatedDatabase({ caseId: "option_full_edit", root }, exerciseOptionSetFullEdit);
});

it("resolves actual Option authoring originals and permanently fences absence under real operation contention", async () => {
  await withIsolatedDatabase(
    { caseId: "option_authoring", root },
    exerciseOptionSetAuthoringResolution,
  );
}, 120_000);

it("composes real Option authoring HTTP with encrypted Session, current IAM and Feature admission", async () => {
  await withIsolatedDatabase(
    { caseId: "option_http", root },
    exerciseOptionSetAuthoringRuntimeHttp,
  );
}, 120_000);

it("resolves genuine Option publication terminals and fences absent originals under real contention", async () => {
  await withIsolatedDatabase(
    { caseId: "option_pub_resolve", root },
    exerciseOptionSetPublicationResolution,
  );
}, 120_000);

// Independent whole Product publication journey; the old authoring/history case
// retains its default profile and all original assertions.
// This two-publication journey has a case-only 180s runner budget. The ordinary
// request's five-second lease and every existing case/config budget are unchanged.
it("composes real Product CurrentPublished Option publication with encrypted Session, current IAM and independent approval", async () => {
  await withIsolatedDatabase({ caseId: "product_option_pub", root }, (context) =>
    exerciseOptionSetAuthoringRuntimeHttp(context, {
      workflow: "ProductCurrentPublishedPublication",
    }),
  );
}, 180_000);

it("composes ordinary Option Price publication with encrypted Session, current IAM and independent approval", async () => {
  await withIsolatedDatabase({ caseId: "option_price_http", root }, (context) =>
    exerciseOptionSetAuthoringRuntimeHttp(context, { workflow: "OptionPricePublication" }),
  );
}, 120_000);
