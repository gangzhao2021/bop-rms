import { exerciseBrandLifecycle } from "../test-support/brand-lifecycle-persistence.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createPostgresReceiptStoreIdentitySource } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9e80-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z",
  later = "2026-08-15T15:00:00.000Z",
  digest = `sha256:${"d".repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2191_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_tenant.brand VALUES($1,'NORTH','Synthetic North','en-CA','CAD','Active',1,$2,$2)`,
      [id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.store VALUES($1,$2,'TORONTO_1','Synthetic Toronto','America/Toronto','en-CA','CAD','Active',1,$3,$3)`,
      [id(2), id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_configuration_version(configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification)VALUES($1,$2,1,'Published','en-CA',ARRAY['en-CA','fr-CA'],$3,$4,$5,ARRAY['DISPLAY.THEME'],ARRAY['SECURITY.REAUTH'],$6,NULL,NULL,'INITIAL_CONFIGURATION',$7,$8,$9,$10,$6,$6,'ConfigurationMetadata')`,
      [id(10), id(1), id(11), id(12), id(13), at, id(20), id(21), id(22), id(23)],
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_store_membership_record(membership_record_id,brand_id,store_id,action,effective_at,brand_version,actor_reference,approval_evidence_reference,operation_reference,recorded_at,data_classification)VALUES($1,$2,$3,'Added',$4,1,$5,$6,$7,$4,'ConfigurationMetadata')`,
      [id(14), id(1), id(2), at, id(20), id(22), id(24)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO bop_tenant.brand_store_membership_record(membership_record_id,brand_id,store_id,action,effective_at,brand_version,actor_reference,approval_evidence_reference,operation_reference,recorded_at,data_classification)VALUES($1,$2,$3,'Added',$4,1,$5,$6,$7,$4,'ConfigurationMetadata')`,
        [id(15), id(1), id(2), later, id(20), id(22), id(25)],
      ),
      /membership sequence is invalid/u,
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_admin_operation(operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification)VALUES($1,$2,'PublishConfiguration',$3,1,$4,'BRAND.ADMINISTRATION',$5,$6,'ConfigurationMetadata')`,
      [id(16), id(1), digest, id(21), id(26), at],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT artifact_snapshot_json FROM bop_tenant.brand_admin_operation WHERE operation_id=$1",
          [id(16)],
        )
      ).rows[0].artifact_snapshot_json,
      null,
    );
    // Storage/compatibility fixture only: this does not execute an activation command.
    const snapshot = {
      brandReference: id(1),
      code: "NORTH",
      displayName: "Synthetic North",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    const appendSnapshot = (operation, artifact) =>
      admin.query(
        "INSERT INTO bop_tenant.brand_admin_operation(operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification,artifact_snapshot_json) VALUES($1,$2,'ActivateBrand',$3,1,$4,'BRAND.ADMINISTRATION',$5,$6,'ConfigurationMetadata',$7)",
        [operation, id(1), digest, id(21), id(27), at, JSON.stringify(artifact)],
      );
    for (const invalid of [[], {}, { brandReference: null }, { brandReference: id(99) }])
      await assert.rejects(appendSnapshot(id(17), invalid), (error) => error.code === "23514");
    await appendSnapshot(id(17), snapshot);
    await assert.rejects(
      admin.query(
        "UPDATE bop_tenant.brand_admin_operation SET artifact_snapshot_json=$1 WHERE operation_id=$2",
        [JSON.stringify({ ...snapshot, displayName: "changed" }), id(17)],
      ),
      /history is append-only/u,
    );
    await admin.query("DELETE FROM bop_tenant.brand_admin_operation WHERE operation_id=$1", [
      id(17),
    ]);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT artifact_snapshot_json FROM bop_tenant.brand_admin_operation WHERE operation_id=$1",
          [id(17)],
        )
      ).rows[0].artifact_snapshot_json,
      snapshot,
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_tenant.brand_configuration_version SET reason_code='CHANGED' WHERE configuration_version_id=$1`,
        [id(10)],
      ),
      /history is append-only/u,
    );
    await assert.rejects(
      admin.query(`UPDATE bop_tenant.brand SET version=3,updated_at=$1 WHERE brand_id=$2`, [
        later,
        id(1),
      ]),
      /identity or revision is invalid/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_tenant,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_tenant.brand_configuration_version,bop_tenant.brand_store_membership_record,bop_tenant.brand_admin_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_configuration_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id','',false)`,
      [id(1)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_configuration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_store_membership_record`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM bop_tenant.brand_admin_operation`)).rowCount, 0);
    await admin.query("RESET ROLE");
    await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.store TO " + role);
    const transaction = { query: (sql, values) => admin.query(sql, [...values]) };
    const source = (storeReference = id(2), allowed = true, brandReference = id(1)) =>
      createPostgresReceiptStoreIdentitySource({
        brandReference,
        storeReference,
        authorize: async (_tx, request) => allowed && request.purpose === "ReceiptIssuance",
      });
    const resolve = async (
      evaluatedAt = at,
      storeReference = id(2),
      allowed = true,
      brandReference = id(1),
    ) => {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        return await source(storeReference, allowed, brandReference).resolve({
          transaction,
          evaluatedAt,
        });
      } finally {
        await admin.query("ROLLBACK");
      }
    };
    const original = await resolve();
    assert.deepEqual(original, {
      brandReference: id(1),
      storeReference: id(2),
      purpose: "ReceiptIssuance",
      evaluatedAt: at,
      storeVersion: 1,
      storeDisplayName: "Synthetic Toronto",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
    });
    assert.equal(await resolve(at, id(99)), null);
    assert.equal(await resolve(at, id(2), true, id(99)), null);
    assert.equal(await resolve("2026-08-15T13:59:59.999Z"), null);
    await assert.rejects(resolve(at, id(2), false), { code: "RECEIPT_STORE_PERMISSION_DENIED" });
    const editor = new Client(context.clientConfig);
    await editor.connect();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      assert.ok(await source().resolve({ transaction, evaluatedAt: at }));
      await editor.query("BEGIN");
      await editor.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        editor.query(
          "UPDATE bop_tenant.store SET display_name='Synthetic renamed',version=2,updated_at=$1 WHERE store_id=$2",
          [later, id(2)],
        ),
        (error) => error.code === "55P03",
      );
    } finally {
      await editor.query("ROLLBACK");
      await editor.end();
      await admin.query("ROLLBACK");
    }
    await admin.query(
      "UPDATE bop_tenant.store SET display_name='Synthetic renamed',version=2,updated_at=$1 WHERE store_id=$2",
      [later, id(2)],
    );
    assert.equal((await resolve(later)).storeDisplayName, "Synthetic renamed");
    assert.equal((await resolve(later)).storeVersion, 2);
    assert.equal(original.storeDisplayName, "Synthetic Toronto");
    assert.equal(await resolve(at), null);
    await admin.query(
      "UPDATE bop_tenant.store SET lifecycle='Suspended',version=3,updated_at=$1 WHERE store_id=$2",
      [later, id(2)],
    );
    assert.equal(await resolve(later), null);
    await exerciseBrandLifecycle({ context, admin, role, id, at });
  } finally {
    try {
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    } finally {
      await admin.end();
    }
  }
}
it("enforces immutable Brand configuration, membership sequence, revision and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "brand_admin", root }, prove);
}, 120_000);
