import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const id = (n) => "018fb100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tenant = id(1),
  brand = id(2),
  product = id(3),
  version = id(4),
  actor = id(5);
const at = "2026-11-04T16:00:00.000Z";

/**
 * WP-2423: a saved dish must not fail at COMMIT once a long-lived connection has switched the
 * guard to a generic plan (forced here), and a Frozen version without content is still refused.
 */
it("the API role changes a draft product version under a generic plan", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_frozen_guard" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_fg_" + context.runId,
      worker = "wp2423_fg_w_" + context.runId;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      await admin.query(
        "INSERT INTO rms_catalog.product (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'DISH','PreparedFood','Active',1,$3,$4,$3)",
        [product, brand, at, actor],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [version, product, brand, JSON.stringify({ "en-CA": "Synthetic" }), at],
      );
      await admin.query("BEGIN");
      await admin.query("SET LOCAL plan_cache_mode = force_generic_plan");
      await admin.query("SET LOCAL ROLE " + api);
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [tenant, brand],
      );
      const changed = await admin.query(
        "UPDATE rms_catalog.product_version SET updated_at=$2 WHERE product_version_id=$1",
        [version, "2026-11-04T16:01:00.000Z"],
      );
      assert.equal(changed.rowCount, 1);
      await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
      await admin.query("ROLLBACK");

      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_catalog.product_version SET status='Frozen' WHERE product_version_id=$1",
        [version],
      );
      await assert.rejects(
        admin.query("SET CONSTRAINTS ALL IMMEDIATE"),
        /PRODUCT_PUBLICATION_CONTENT_MISSING/u,
      );
      await admin.query("ROLLBACK");
    } finally {
      await admin.end();
    }
  });
});
