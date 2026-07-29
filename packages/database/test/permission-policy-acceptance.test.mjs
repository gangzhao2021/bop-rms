import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit) => `018f5f9a-ad3e-7a11-8d01-0000000000${digit.padStart(2, "0")}`;

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp0105_${context.runId}`;
  await client.connect();
  try {
    assert.equal(
      (await client.query("SELECT * FROM bop_permission.permission_definition")).rowCount,
      0,
    );
    await client.query(
      `INSERT INTO bop_permission.policy_state
        (brand_id,snapshot_id,version,updated_at)
       VALUES ($1,$2,1,now())`,
      [id("01"), id("02")],
    );
    await client.query(
      `INSERT INTO bop_permission.permission_definition
        (permission_id,action_code,lifecycle,version,created_at,updated_at)
       VALUES ($1,'synthetic.resource.update','Active',1,now(),now())`,
      [id("03")],
    );
    await client.query(
      `INSERT INTO bop_permission.role
        (role_id,brand_id,store_id,role_code,lifecycle,effective_from,effective_until,
         version,created_at,updated_at)
       VALUES
        ($1,$2,NULL,'synthetic_manager','Active',now(),NULL,1,now(),now()),
        ($3,$2,$4,'synthetic_operator','Active',now(),NULL,1,now(),now())`,
      [id("04"), id("01"), id("05"), id("06")],
    );
    await client.query(
      `INSERT INTO bop_permission.role_assignment
        (assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,
         lifecycle,effective_from,effective_until,version,created_at,updated_at)
       VALUES
        ($1,$2,$3,NULL,$4,$5,NULL,'Active',now(),NULL,1,now(),now()),
        ($6,$7,$3,$8,$4,$5,$9,'Active',now(),NULL,1,now(),now())`,
      [id("07"), id("04"), id("08"), id("09"), id("01"), id("10"), id("05"), id("11"), id("06")],
    );
    await client.query(
      `INSERT INTO bop_permission.permission_grant
        (grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,
         effective_until,version,created_at,updated_at)
       VALUES
        ($1,$2,$3,$4,NULL,'Active',now(),NULL,1,now(),now()),
        ($5,$6,$3,$4,$7,'Active',now(),NULL,1,now(),now())`,
      [id("12"), id("04"), id("03"), id("01"), id("13"), id("05"), id("06")],
    );
    await client.query(
      `INSERT INTO bop_permission.permission_override
        (override_id,permission_id,actor_id,brand_id,store_id,effect,lifecycle,
         reason_reference,correlation_reference,effective_from,effective_until,
         version,created_at,updated_at)
       VALUES
        ($1,$2,$3,$4,NULL,'Allow','Active',$5,$6,now(),NULL,1,now(),now()),
        ($7,$2,$3,$4,$8,'Deny','Active',$5,$6,now(),NULL,1,now(),now())`,
      [id("14"), id("03"), id("09"), id("01"), id("15"), id("16"), id("17"), id("06")],
    );

    await assert.rejects(
      client.query(
        `INSERT INTO bop_permission.permission_definition
          (permission_id,action_code,lifecycle,version,created_at,updated_at)
         VALUES ($1,'synthetic.*','Active',1,now(),now())`,
        [id("18")],
      ),
      /check constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_permission.role_assignment
          (assignment_id,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,
           lifecycle,effective_from,effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,'Active',now(),NULL,1,now(),now())`,
        [id("18"), id("05"), id("08"), id("09"), id("01"), id("06")],
      ),
      /check constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_permission.permission_grant
          (grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,
           effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,NULL,'Active',now(),NULL,1,now(),now())`,
        [id("18"), id("04"), id("03"), id("01")],
      ),
      /unique constraint/u,
    );

    const foreignKeys = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace AS source_schema ON source_schema.oid = relation.relnamespace
       JOIN pg_class AS target ON target.oid = constraint_record.confrelid
       JOIN pg_namespace AS target_schema ON target_schema.oid = target.relnamespace
       WHERE constraint_record.contype = 'f'
         AND source_schema.nspname = 'bop_permission'
         AND target_schema.nspname <> 'bop_permission'`,
    );
    assert.deepEqual(foreignKeys.rows, [{ count: 0 }]);

    await client.query("BEGIN");
    const advanced = await client.query(
      `UPDATE bop_permission.policy_state
       SET snapshot_id = $1, version = version + 1, updated_at = now()
       WHERE brand_id = $2 AND version = 1`,
      [id("19"), id("01")],
    );
    assert.equal(advanced.rowCount, 1);
    const conflict = await client.query(
      `UPDATE bop_permission.policy_state
       SET snapshot_id = $1, version = version + 1, updated_at = now()
       WHERE brand_id = $2 AND version = 1`,
      [id("20"), id("01")],
    );
    assert.equal(conflict.rowCount, 0);
    await client.query("ROLLBACK");
    assert.deepEqual(
      (
        await client.query(
          "SELECT snapshot_id,version::int FROM bop_permission.policy_state WHERE brand_id = $1",
          [id("01")],
        )
      ).rows,
      [{ snapshot_id: id("02"), version: 1 }],
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA bop_permission, platform_helpers TO ${role}`);
    await client.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA bop_permission TO ${role}`);

    const rls = await client.query(
      `SELECT count(*)::int AS count FROM pg_class
       WHERE oid IN (
         'bop_permission.policy_state'::regclass,
         'bop_permission.role'::regclass,
         'bop_permission.role_assignment'::regclass,
         'bop_permission.permission_grant'::regclass,
         'bop_permission.permission_override'::regclass
       ) AND relrowsecurity AND relforcerowsecurity`,
    );
    assert.deepEqual(rls.rows, [{ count: 5 }]);
    const publicAcl = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_class AS relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.relnamespace = 'bop_permission'::regnamespace
         AND privilege.grantee = 0`,
    );
    assert.deepEqual(publicAcl.rows, [{ count: 0 }]);

    await client.query(`SET ROLE ${role}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("01")]);
    await client.query("SELECT set_config('bop.store_id','',true)");
    assert.equal((await client.query("SELECT * FROM bop_permission.policy_state")).rowCount, 1);
    assert.equal(
      (await client.query("SELECT * FROM bop_permission.permission_definition")).rowCount,
      1,
    );
    assert.equal((await client.query("SELECT * FROM bop_permission.role")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_permission.role_assignment")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_permission.permission_grant")).rowCount, 1);
    assert.equal(
      (await client.query("SELECT * FROM bop_permission.permission_override")).rowCount,
      1,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("01")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("06")]);
    assert.equal((await client.query("SELECT * FROM bop_permission.role")).rowCount, 2);
    assert.equal((await client.query("SELECT * FROM bop_permission.role_assignment")).rowCount, 2);
    assert.equal((await client.query("SELECT * FROM bop_permission.permission_grant")).rowCount, 2);
    assert.equal(
      (await client.query("SELECT * FROM bop_permission.permission_override")).rowCount,
      2,
    );
    await assert.rejects(
      client.query(
        `UPDATE bop_permission.permission_override
         SET lifecycle = 'Revoked', version = version + 1
         WHERE override_id = $1`,
        [id("17")],
      ),
      /permission denied/u,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("21")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("06")]);
    assert.equal((await client.query("SELECT * FROM bop_permission.policy_state")).rowCount, 0);
    assert.equal((await client.query("SELECT * FROM bop_permission.role")).rowCount, 0);
    assert.equal(
      (await client.query("SELECT * FROM bop_permission.permission_override")).rowCount,
      0,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves Permission policy constraints, policy versioning, RLS and least privilege", async () => {
  await withIsolatedDatabase({ caseId: "permission_policy", root }, prove);
});
