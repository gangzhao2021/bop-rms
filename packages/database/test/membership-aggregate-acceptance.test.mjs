import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit) => `018f3f7a-8b1c-7a11-8d01-0000000000${digit.padStart(2, "0")}`;

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp0102_${context.runId}`;
  await client.connect();
  try {
    await client.query(
      `INSERT INTO bop_membership.membership
        (membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,
         effective_from,effective_until,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'Active',now(),NULL,1,now(),now())`,
      [id("01"), id("02"), id("03"), id("04")],
    );
    await client.query(
      `INSERT INTO bop_membership.store_assignment
        (assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,
         effective_from,effective_until,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'Active',now(),NULL,1,now(),now())`,
      [id("05"), id("01"), id("02"), id("03"), id("06")],
    );

    await assert.rejects(
      client.query(
        `INSERT INTO bop_membership.membership
          (membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,
           effective_from,effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,NULL,'Active',now(),NULL,1,now(),now())`,
        [id("07"), id("02"), id("03")],
      ),
      /check constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_membership.store_assignment
          (assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,
           effective_from,effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'Active',now(),now(),1,now(),now())`,
        [id("08"), id("01"), id("02"), id("03"), id("06")],
      ),
      /check constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_membership.store_assignment
          (assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,
           effective_from,effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'Active',now(),NULL,1,now(),now())`,
        [id("09"), id("01"), id("02"), id("10"), id("06")],
      ),
      /foreign key constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_membership.store_assignment
          (assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,
           effective_from,effective_until,version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'Active',now(),NULL,1,now(),now())`,
        [id("12"), id("01"), id("13"), id("03"), id("06")],
      ),
      /foreign key constraint/u,
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA bop_membership, platform_helpers TO ${role}`);
    await client.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA bop_membership TO ${role}`);

    const rls = await client.query(
      `SELECT count(*)::int AS count FROM pg_class
       WHERE oid IN (
         'bop_membership.membership'::regclass,
         'bop_membership.store_assignment'::regclass
       ) AND relrowsecurity AND relforcerowsecurity`,
    );
    assert.deepEqual(rls.rows, [{ count: 2 }]);
    const publicAcl = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_class AS relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.relnamespace = 'bop_membership'::regnamespace
         AND privilege.grantee = 0`,
    );
    assert.deepEqual(publicAcl.rows, [{ count: 0 }]);

    await client.query(`SET ROLE ${role}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("03")]);
    await client.query("SELECT set_config('bop.store_id','',true)");
    assert.equal((await client.query("SELECT * FROM bop_membership.membership")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_membership.store_assignment")).rowCount, 0);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("03")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("06")]);
    assert.equal((await client.query("SELECT * FROM bop_membership.membership")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_membership.store_assignment")).rowCount, 1);
    await assert.rejects(
      client.query(
        `UPDATE bop_membership.membership SET lifecycle = 'Suspended'
         WHERE membership_id = $1`,
        [id("01")],
      ),
      /permission denied/u,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("10")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("06")]);
    assert.equal((await client.query("SELECT * FROM bop_membership.membership")).rowCount, 0);
    assert.equal((await client.query("SELECT * FROM bop_membership.store_assignment")).rowCount, 0);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("03")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("11")]);
    assert.equal((await client.query("SELECT * FROM bop_membership.membership")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_membership.store_assignment")).rowCount, 0);
    await client.query("ROLLBACK");
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves Membership constraints, forced RLS and least privilege", async () => {
  await withIsolatedDatabase({ caseId: "membership", root }, prove);
});
