import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (suffix) => `018f8f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const hash = (byte) => Buffer.alloc(32, byte);
const cipher = (byte) => Buffer.alloc(64, byte);

async function prove(context) {
  const client = new Client(context.clientConfig);
  const deniedRole = `bop_wp0108_${context.runId}`;
  await client.connect();
  try {
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'bop_identity' ORDER BY table_name`,
    );
    assert.deepEqual(inventory.rows, [
      { table_name: "api_client" },
      { table_name: "api_client_access_version" },
      { table_name: "api_client_credential_metadata" },
      { table_name: "api_client_operation" },
      { table_name: "authentication_session" },
      { table_name: "guest_binding_preparation" },
      { table_name: "guest_session" },
      { table_name: "guest_session_operation" },
      { table_name: "oidc_authorization_transaction" },
      { table_name: "session_revocation_request" },
      { table_name: "workforce_invitation" },
      { table_name: "workforce_mfa_status" },
      { table_name: "workforce_recovery_case" },
    ]);

    await client.query(
      `INSERT INTO bop_identity.workforce_invitation
       (invitation_id,actor_id,inviter_actor_id,membership_id,store_assignment_ids,
        email_digest,selector_hash,status,created_at,expires_at,version)
       VALUES ($1,$2,$3,$4,ARRAY[$5]::uuid[],$6,$7,'Pending',now(),
        now() + interval '24 hours',1)`,
      [id("1"), id("2"), id("3"), id("4"), id("5"), hash(1), hash(2)],
    );
    const accepted = await client.query(
      `UPDATE bop_identity.workforce_invitation
       SET status='Accepted', consumed_at=now(), provider_evidence_id=$2, version=version+1
       WHERE selector_hash=$1 AND email_digest=$3 AND status='Pending'
         AND expires_at > now() AND version=1
       RETURNING version`,
      [hash(2), id("6"), hash(1)],
    );
    assert.deepEqual(accepted.rows, [{ version: 2 }]);
    assert.equal(
      (
        await client.query(
          `UPDATE bop_identity.workforce_invitation SET consumed_at=now()
           WHERE selector_hash=$1 AND status='Pending' RETURNING version`,
          [hash(2)],
        )
      ).rowCount,
      0,
    );

    await client.query(
      `INSERT INTO bop_identity.workforce_mfa_status
       (actor_id,status,provider_evidence_id,verified_at,reset_at,version)
       VALUES ($1,'TotpVerified',$2,now(),NULL,1)`,
      [id("2"), id("7")],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.workforce_mfa_status
         (actor_id,status,provider_evidence_id,verified_at,reset_at,version)
         VALUES ($1,'Required',$2,now(),NULL,1)`,
        [id("8"), id("9")],
      ),
      /check constraint/u,
    );

    await client.query(
      `INSERT INTO bop_identity.workforce_recovery_case
       (recovery_id,target_actor_id,requested_by_actor_id,approver_actor_ids,
        required_approval_count,purpose_code,proof_evidence_id,status,created_at,expires_at,version)
       VALUES ($1,$2,$3,ARRAY[$4,$5]::uuid[],2,'ACCOUNT_RECOVERY',$6,'Approved',
        now(),now() + interval '24 hours',1)`,
      [id("10"), id("2"), id("3"), id("11"), id("12"), id("13")],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.workforce_recovery_case
         (recovery_id,target_actor_id,requested_by_actor_id,approver_actor_ids,
          required_approval_count,purpose_code,proof_evidence_id,status,created_at,expires_at,version)
         VALUES ($1,$2,$3,ARRAY[$5]::uuid[],1,'ACCOUNT_RECOVERY',$4,'Approved',
          now(),now() + interval '24 hours',1)`,
        [id("14"), id("2"), id("3"), id("15"), id("2")],
      ),
      /check constraint/u,
    );

    await client.query(
      `INSERT INTO bop_identity.authentication_session
       (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,
        encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,
        created_at,last_seen_at,idle_expires_at,absolute_expires_at,version)
       VALUES ($1,$2,$3,$4,'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM',
        'synthetic-key','synthetic:session',now(),now(),now(),now()+interval '30 minutes',
        now()+interval '12 hours',1)`,
      [id("16"), id("2"), hash(3), hash(4), cipher(5)],
    );
    await client.query("BEGIN");
    const revoked = await client.query(
      `UPDATE bop_identity.authentication_session
       SET status='Revoked',revocation_reason='Recovery',revoked_at=now(),version=version+1
       WHERE actor_id=$1 AND status='Active' AND created_at <= now()
       RETURNING session_id`,
      [id("2")],
    );
    assert.deepEqual(revoked.rows, [{ session_id: id("16") }]);
    await client.query(
      `INSERT INTO bop_identity.session_revocation_request
       (idempotency_id,actor_id,reason,purpose_code,correlation_id,source_evidence_id,
        cutoff_at,completed_at,revoked_session_ids,version)
       VALUES ($1,$2,'Recovery','ACCOUNT_RECOVERY',$3,$4,now(),now(),ARRAY[$5]::uuid[],1)`,
      [id("17"), id("2"), id("18"), id("13"), id("16")],
    );
    await client.query("COMMIT");
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.session_revocation_request
         (idempotency_id,actor_id,reason,purpose_code,correlation_id,source_evidence_id,
          cutoff_at,completed_at,revoked_session_ids,version)
         VALUES ($1,$2,'Recovery','ACCOUNT_RECOVERY',$3,$4,now(),now(),'{}'::uuid[],1)`,
        [id("17"), id("2"), id("18"), id("13")],
      ),
      /unique constraint/u,
    );

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='bop_identity' ORDER BY table_name,ordinal_position`,
    );
    const names = columns.rows.map(({ column_name }) => column_name);
    for (const prohibited of [
      "email",
      "totp_seed",
      "totp_code",
      "temporary_password",
      "recovery_proof",
      "provider_payload",
    ])
      assert(!names.includes(prohibited));

    const acl = await client.query(
      `SELECT count(*)::int AS count FROM pg_class AS relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.relnamespace='bop_identity'::regnamespace AND privilege.grantee=0`,
    );
    assert.deepEqual(acl.rows, [{ count: 0 }]);
    const dynamic = await client.query(
      `SELECT
         (SELECT count(*)::int FROM pg_proc
          WHERE pronamespace='bop_identity'::regnamespace) AS functions,
         (SELECT count(*)::int FROM pg_trigger
          WHERE tgrelid IN (
            'bop_identity.workforce_invitation'::regclass,
            'bop_identity.workforce_mfa_status'::regclass,
            'bop_identity.workforce_recovery_case'::regclass,
            'bop_identity.session_revocation_request'::regclass
          ) AND NOT tgisinternal) AS triggers`,
    );
    assert.deepEqual(dynamic.rows, [{ functions: 4, triggers: 0 }]);

    await client.query(
      `CREATE ROLE ${deniedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await client.query(`SET ROLE ${deniedRole}`);
    await assert.rejects(
      client.query("SELECT count(*) FROM bop_identity.workforce_invitation"),
      /permission denied/u,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${deniedRole}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves workforce identity security constraints, idempotency and least privilege", async () => {
  await withIsolatedDatabase({ caseId: "workforce_security", root }, prove);
});
