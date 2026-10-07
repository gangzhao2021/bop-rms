import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  permissionCatalogDigest,
  permissionCatalogInstallationCodes,
  storePermissionCatalogVersion,
  synchronizePermissionCatalog,
} from "../../bop/permission/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01909a05-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** WP-2423 / DEC-PERM-CATALOG: release-time Store permission catalog installation. */
it("installs the Store permission catalog once, insert-only, audited and separately approved", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_perm_catalog" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_catalog_" + context.runId;
    let sequence = 1000;
    const next = () => id(++sequence);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_permission,platform_audit,platform_helpers TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON bop_permission.permission_definition,bop_permission.permission_catalog_revision,platform_audit.platform_actor_audit_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO " + role,
      );
      // A code defined before the first installation (here a legacy code) is kept, not duplicated.
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,'kitchen.operate','Active',1,$2,$2)",
        [id(1), "2026-10-01T00:00:00.000Z"],
      );
      const transaction = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const value = await work(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const operator = id(2),
        approver = id(3);
      const input = (overrides = {}) => ({
        operationReference: id(10),
        operatorReference: operator,
        approvedByReference: approver,
        approvalEvidenceReference: id(11),
        auditReference: id(12),
        occurredAt: "2026-10-07T12:00:00.000Z",
        nextPermissionReference: next,
        ...overrides,
      });
      await assert.rejects(
        transaction((tx) =>
          synchronizePermissionCatalog(tx, input({ approvedByReference: operator })),
        ),
        { code: "PERMISSION_CATALOG_INPUT_INVALID" },
      );
      const codes = permissionCatalogInstallationCodes();
      const applied = await transaction((tx) => synchronizePermissionCatalog(tx, input()));
      assert.equal(applied.status, "Applied");
      assert.equal(applied.definitionCount, codes.length);
      assert.equal(applied.addedCount, codes.length - 1);
      const defined = (
        await admin.query(
          "SELECT action_code FROM bop_permission.permission_definition WHERE lifecycle='Active' ORDER BY action_code",
        )
      ).rows.map((row) => row.action_code);
      assert.deepEqual(
        defined,
        [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT permission_id::text id FROM bop_permission.permission_definition WHERE action_code='kitchen.operate'",
          )
        ).rows[0].id,
        id(1),
      );
      // Re-running the same release is a no-op; nothing is added or audited twice.
      const again = await transaction((tx) =>
        synchronizePermissionCatalog(
          tx,
          input({ operationReference: id(20), auditReference: id(21) }),
        ),
      );
      assert.deepEqual(
        { status: again.status, added: again.addedCount, digest: again.catalogDigest },
        { status: "AlreadyApplied", added: codes.length - 1, digest: permissionCatalogDigest() },
      );
      const audit = await admin.query(
        "SELECT actor_id::text actor,action_code,target_type,'sha256:'||encode(intent_digest,'hex') digest FROM platform_audit.platform_actor_audit_record WHERE purpose_code='PERMISSION_CATALOG'",
      );
      assert.deepEqual(audit.rows, [
        {
          actor: operator,
          action_code: "PERMISSION_CATALOG_INSTALLED",
          target_type: "PermissionCatalogRevision",
          digest: permissionCatalogDigest(),
        },
      ]);
      const revision = (
        await admin.query(
          "SELECT catalog_version,operator_id::text operator,approved_by::text approver,added_count FROM bop_permission.permission_catalog_revision",
        )
      ).rows;
      assert.deepEqual(revision, [
        {
          catalog_version: storePermissionCatalogVersion,
          operator,
          approver,
          added_count: codes.length - 1,
        },
      ]);
      // History is append-only, even for the database owner.
      await assert.rejects(
        admin.query("UPDATE bop_permission.permission_catalog_revision SET added_count=0"),
        /append-only/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM bop_permission.permission_catalog_revision"),
        /append-only/u,
      );
      // The database also refuses a self-approved revision written around the synchronizer.
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_permission.permission_catalog_revision VALUES(99,$1,$2,$3,$3,$4,$5,1,0,now()::timestamptz(3),'ConfigurationMetadata')",
          [permissionCatalogDigest(), id(30), operator, id(31), id(32)],
        ),
        /permission_catalog_revision_separation/u,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});

it("refuses to revive a retired code through a catalog installation", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_perm_retired" }, async (context) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,'kitchen.operate','Retired',2,$2,$2)",
        [id(1), "2026-10-01T00:00:00.000Z"],
      );
      await client.query("BEGIN");
      await assert.rejects(
        synchronizePermissionCatalog(client, {
          operationReference: id(10),
          operatorReference: id(2),
          approvedByReference: id(3),
          approvalEvidenceReference: id(11),
          auditReference: id(12),
          occurredAt: "2026-10-07T12:00:00.000Z",
          nextPermissionReference: () => id(99),
        }),
        { code: "PERMISSION_CATALOG_RETIRED_CODE" },
      );
      await client.query("ROLLBACK");
      assert.equal(
        (await client.query("SELECT count(*)::int n FROM bop_permission.permission_definition"))
          .rows[0].n,
        1,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});
