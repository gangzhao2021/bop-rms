import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9e30-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T12:00:00.000Z";
const expires = "2026-11-15T12:00:00.000Z";
const digest = `sha256:${"b".repeat(64)}`;

async function insertClient(admin, brand, client, credential, offset) {
  await admin.query(
    `INSERT INTO bop_identity.api_client(
      api_client_id,brand_id,store_id,name_code,owner_reference,environment,lifecycle,
      aggregate_version,current_access_version,current_credential_reference,
      current_credential_version,credential_status,last_used_at,audit_summary_reference,
      created_by_reference,created_at,updated_at,data_classification
    ) VALUES($1,$2,NULL,$3,$4,'Sandbox','Active',1,1,$5,1,'Active',NULL,$6,$7,$8,$8,
      'CredentialMetadata')`,
    [
      client,
      brand,
      `CLIENT_${offset}`,
      id(offset + 1),
      credential,
      id(offset + 2),
      id(offset + 3),
      at,
    ],
  );
  await admin.query(
    `INSERT INTO bop_identity.api_client_access_version(
      access_version_id,brand_id,store_id,api_client_id,access_version,requested_scope_codes,
      requested_grant_codes,grant_set_reference,approval_evidence_reference,recorded_at,
      data_classification
    ) VALUES($1,$2,NULL,$3,1,ARRAY['ORDERS.READ'],ARRAY['ORDER.EXPORT.READ'],$4,$5,$6,
      'Confidential')`,
    [id(offset + 4), brand, client, id(offset + 5), id(offset + 6), at],
  );
  await admin.query(
    `INSERT INTO bop_identity.api_client_credential_metadata(
      credential_metadata_id,brand_id,store_id,api_client_id,credential_reference,
      credential_version,status,issued_at,expires_at,revoked_at,supersedes_credential_reference,
      recorded_at,data_classification
    ) VALUES($1,$2,NULL,$3,$4,1,'Active',$5,$6,NULL,NULL,$5,'CredentialMetadata')`,
    [id(offset + 7), brand, client, credential, at, expires],
  );
  await admin.query(
    `INSERT INTO bop_identity.api_client_operation(
      operation_id,brand_id,store_id,api_client_id,command_type,intent_digest,aggregate_version,
      actor_reference,purpose_code,audit_reference,occurred_at,data_classification
    ) VALUES($1,$2,NULL,$3,'ActivateApiClient',$4,1,$5,'SECURITY.ADMINISTRATION',$6,$7,
      'CredentialMetadata')`,
    [id(offset + 8), brand, client, digest, id(offset + 3), id(offset + 2), at],
  );
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2183_${context.runId}`;
  await admin.connect();
  try {
    await insertClient(admin, id(1), id(10), id(11), 20);
    await insertClient(admin, id(2), id(12), id(13), 40);
    await assert.rejects(
      admin.query(
        `UPDATE bop_identity.api_client_access_version
         SET requested_scope_codes=ARRAY['ALL'] WHERE api_client_id=$1`,
        [id(10)],
      ),
      /API Client history is append-only/u,
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_identity.api_client SET aggregate_version=3,updated_at=$1
         WHERE api_client_id=$2`,
        [at, id(10)],
      ),
      /API Client identity or revision is invalid/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_identity,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_identity.api_client,bop_identity.api_client_access_version,
       bop_identity.api_client_credential_metadata,bop_identity.api_client_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM bop_identity.api_client`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(1)]);
    assert.equal((await admin.query(`SELECT * FROM bop_identity.api_client`)).rowCount, 1);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_identity.api_client_credential_metadata`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_identity.api_client_operation`)).rowCount,
      1,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces API Client revision, append-only metadata and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "api_client", root }, prove);
}, 120_000);
