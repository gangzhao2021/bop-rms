import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit) => `018f3f7a-8b1c-7a11-8d01-00000000000${digit}`;

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp0101_${context.runId}`;
  await client.connect();
  try {
    await client.query(
      `INSERT INTO bop_tenant.brand
        VALUES ($1,'NORTH','Synthetic North','en-CA','CAD','Active',1,now(),now())`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO bop_tenant.store
        VALUES ($1,$2,'TORONTO_1','Synthetic Toronto','America/Toronto','en-CA','CAD','Active',1,now(),now())`,
      [id(2), id(1)],
    );
    await client.query(
      `INSERT INTO bop_operating_entity.operating_entity
        VALUES ($1,'LegalEntity','Synthetic Ontario Incorporated',NULL,'CA-ON',
          NULL,NULL,NULL,NULL,$2,'Active',1,now(),now())`,
      [id(3), id(4)],
    );
    await client.query(
      `INSERT INTO bop_operating_entity.brand_operating_entity_assignment
        VALUES ($1,$2,$3,'SalesReceiptIssuer','Active',now(),NULL,1,now(),now())`,
      [id(5), id(1), id(3)],
    );
    await client.query(
      `INSERT INTO bop_operating_entity.store_operating_entity_assignment
        VALUES ($1,$2,$3,$4,'SalesReceiptIssuer','Active',now(),NULL,1,now(),now())`,
      [id(6), id(1), id(2), id(3)],
    );

    await assert.rejects(
      client.query(
        `INSERT INTO bop_tenant.brand
          VALUES ($1,'BAD','Bad','en-CA','USD','Active',1,now(),now())`,
        [id(7)],
      ),
      /check constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_operating_entity.store_operating_entity_assignment
          VALUES ($1,$2,$3,$4,'Employer','Active',now(),now(),1,now(),now())`,
        [id(7), id(1), id(2), id(3)],
      ),
      /check constraint/u,
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(
      `GRANT USAGE ON SCHEMA bop_tenant, bop_operating_entity, platform_helpers TO ${role}`,
    );
    await client.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA bop_tenant, bop_operating_entity TO ${role}`,
    );
    const rls = await client.query(
      `SELECT count(*)::int AS count FROM pg_class
       WHERE oid IN (
        'bop_tenant.brand'::regclass,
        'bop_tenant.store'::regclass,
        'bop_operating_entity.operating_entity'::regclass,
        'bop_operating_entity.brand_operating_entity_assignment'::regclass,
        'bop_operating_entity.store_operating_entity_assignment'::regclass
       ) AND relrowsecurity AND relforcerowsecurity`,
    );
    assert.deepEqual(rls.rows, [{ count: 5 }]);
    const publicAcl = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_class AS relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.relnamespace IN (
         'bop_tenant'::regnamespace, 'bop_operating_entity'::regnamespace
       ) AND privilege.grantee = 0`,
    );
    assert.deepEqual(publicAcl.rows, [{ count: 0 }]);

    await client.query(`SET ROLE ${role}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(1)]);
    await client.query("SELECT set_config('bop.store_id','',true)");
    assert.equal((await client.query("SELECT * FROM bop_tenant.brand")).rowCount, 1);
    assert.equal((await client.query("SELECT * FROM bop_tenant.store")).rowCount, 0);
    assert.equal(
      (await client.query("SELECT * FROM bop_operating_entity.operating_entity")).rowCount,
      1,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(1)]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id(2)]);
    assert.equal((await client.query("SELECT * FROM bop_tenant.brand")).rowCount, 0);
    assert.equal((await client.query("SELECT * FROM bop_tenant.store")).rowCount, 1);
    assert.equal(
      (await client.query("SELECT * FROM bop_operating_entity.store_operating_entity_assignment"))
        .rowCount,
      1,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_tenant.store
          VALUES ($1,$2,'DENIED','Denied','America/Toronto','en-CA','CAD','Draft',1,now(),now())`,
        [id(8), id(1)],
      ),
      /permission denied/u,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(9)]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id(2)]);
    assert.equal((await client.query("SELECT * FROM bop_tenant.store")).rowCount, 0);
    assert.equal(
      (await client.query("SELECT * FROM bop_operating_entity.operating_entity")).rowCount,
      0,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves organization constraints, forced RLS, least privilege and fail-closed scope", async () => {
  await withIsolatedDatabase({ caseId: "organization", root }, prove);
});
