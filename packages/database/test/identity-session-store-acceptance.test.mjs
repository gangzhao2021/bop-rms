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
  const deniedRole = `bop_wp0107_${context.runId}`;
  await client.connect();
  try {
    const inventory = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'bop_identity'
       ORDER BY table_name`,
    );
    assert.deepEqual(inventory.rows, [
      { table_name: "authentication_session" },
      { table_name: "guest_session" },
      { table_name: "oidc_authorization_transaction" },
      { table_name: "session_revocation_request" },
      { table_name: "workforce_invitation" },
      { table_name: "workforce_mfa_status" },
      { table_name: "workforce_recovery_case" },
    ]);

    await client.query(
      `INSERT INTO bop_identity.oidc_authorization_transaction
        (transaction_id,state_selector_hash,auth_cookie_selector_hash,encrypted_secret,
         cipher_algorithm,key_reference,encryption_context,redirect_uri,post_login_path,
         created_at,expires_at,consumed_at,version)
       VALUES ($1,$2,$3,$4,'SYNTHETIC_AES_256_GCM','synthetic-key','synthetic:oidc',
         'https://merchant.invalid/auth/callback','/orders',now(),now() + interval '10 minutes',
         NULL,1)`,
      [id("1"), hash(1), hash(2), cipher(3)],
    );
    const consumed = await client.query(
      `UPDATE bop_identity.oidc_authorization_transaction
       SET consumed_at = now(), version = version + 1
       WHERE state_selector_hash = $1
         AND auth_cookie_selector_hash = $2
         AND consumed_at IS NULL
         AND expires_at > now()
         AND version = 1
       RETURNING version`,
      [hash(1), hash(2)],
    );
    assert.deepEqual(consumed.rows, [{ version: 2 }]);
    assert.equal(
      (
        await client.query(
          `UPDATE bop_identity.oidc_authorization_transaction
           SET consumed_at = now(), version = version + 1
           WHERE state_selector_hash = $1 AND consumed_at IS NULL
           RETURNING version`,
          [hash(1)],
        )
      ).rowCount,
      0,
    );

    await client.query(
      `INSERT INTO bop_identity.authentication_session
        (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,
         encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,
         created_at,last_seen_at,idle_expires_at,absolute_expires_at,rotated_from_session_id,
         revocation_reason,revoked_at,version)
       VALUES ($1,$2,$3,$4,'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM',
         'synthetic-key','synthetic:session',now(),now(),now(),now() + interval '30 minutes',
         now() + interval '12 hours',NULL,NULL,NULL,1)`,
      [id("2"), id("3"), hash(4), hash(5), cipher(6)],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.authentication_session
          (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,
           encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,
           created_at,last_seen_at,idle_expires_at,absolute_expires_at,version)
         VALUES ($1,$2,$3,$4,'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM',
           'synthetic-key','synthetic:session',now(),now(),now(),now() + interval '30 minutes',
           now() + interval '12 hours',1)`,
        [id("4"), id("3"), hash(4), hash(7), cipher(8)],
      ),
      /unique constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.oidc_authorization_transaction
          (transaction_id,state_selector_hash,auth_cookie_selector_hash,encrypted_secret,
           cipher_algorithm,key_reference,encryption_context,redirect_uri,post_login_path,
           created_at,expires_at,version)
         VALUES ($1,$2,$3,$4,'SYNTHETIC_AES_256_GCM','synthetic-key','synthetic:oidc',
           'https://merchant.invalid/auth/callback','//evil.invalid',now(),
           now() + interval '10 minutes',1)`,
        [id("5"), hash(9), hash(10), cipher(11)],
      ),
      /check constraint/u,
    );

    await client.query(
      `INSERT INTO bop_identity.guest_session
        (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,
         operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,
         qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,
         absolute_expires_at,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DineIn','en-CA',$10,3,'ContextOnly','Active',
         '2026-07-29T12:00:00.000Z','2026-07-29T12:00:00.000Z',
         '2026-07-29T16:00:00.000Z','2026-07-30T12:00:00.000Z',1)`,
      [
        id("20"),
        hash(20),
        hash(21),
        id("21"),
        hash(22),
        id("22"),
        id("23"),
        id("24"),
        id("25"),
        id("26"),
      ],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.guest_session
          (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,
           operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,
           qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,
           absolute_expires_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,'Pickup','en-CA',$9,1,'ContextOnly','Active',
           now(),now(),now() + interval '4 hours',now() + interval '24 hours',1)`,
        [id("27"), hash(20), hash(28), id("28"), hash(29), id("22"), id("23"), id("24"), id("26")],
      ),
      /unique constraint/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO bop_identity.guest_session
          (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,
           operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,
           qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,
           absolute_expires_at,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pickup','en-CA',$10,1,'ContextOnly','Active',
           now(),now(),now() + interval '4 hours',now() + interval '24 hours',1)`,
        [
          id("29"),
          hash(30),
          hash(31),
          id("30"),
          hash(32),
          id("22"),
          id("23"),
          id("24"),
          id("25"),
          id("26"),
        ],
      ),
      /check constraint/u,
    );

    const guestColumns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'bop_identity' AND table_name = 'guest_session'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      guestColumns.rows.map(({ column_name }) => column_name),
      [
        "guest_session_id",
        "session_selector_hash",
        "csrf_selector_hash",
        "operation_id",
        "operation_intent_hash",
        "brand_id",
        "store_id",
        "public_store_id",
        "public_table_id",
        "channel",
        "locale",
        "qr_id",
        "qr_revocation_version",
        "dining_state",
        "status",
        "created_at",
        "last_seen_at",
        "idle_expires_at",
        "absolute_expires_at",
        "order_closed_at",
        "closure_expires_at",
        "rotated_from_guest_session_id",
        "revocation_reason",
        "revoked_at",
        "version",
      ],
    );
    const guestRls = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE oid = 'bop_identity.guest_session'::regclass`,
    );
    assert.deepEqual(guestRls.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
    const guestPolicy = await client.query(
      `SELECT qual, with_check
       FROM pg_policies
       WHERE schemaname = 'bop_identity' AND tablename = 'guest_session'`,
    );
    assert.equal(guestPolicy.rowCount, 1);
    assert.match(guestPolicy.rows[0].qual, /current_brand_id/u);
    assert.match(guestPolicy.rows[0].qual, /current_store_id/u);
    await assert.rejects(
      client.query(
        `UPDATE bop_identity.authentication_session
         SET status = 'Revoked', version = version + 1
         WHERE session_id = $1`,
        [id("2")],
      ),
      /check constraint/u,
    );

    const columns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'bop_identity'
       ORDER BY table_name, ordinal_position`,
    );
    const columnNames = columns.rows.map(({ column_name }) => column_name);
    for (const prohibited of [
      "cookie",
      "csrf_token",
      "authorization_code",
      "state",
      "nonce",
      "pkce_verifier",
      "access_token",
      "refresh_token",
      "id_token",
      "provider_subject",
      "email",
      "phone",
    ]) {
      assert(!columnNames.includes(prohibited));
    }

    const acl = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_class AS relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       WHERE relation.relnamespace = 'bop_identity'::regnamespace
         AND privilege.grantee = 0`,
    );
    assert.deepEqual(acl.rows, [{ count: 0 }]);
    const rls = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_class
       WHERE relnamespace = 'bop_identity'::regnamespace AND relrowsecurity`,
    );
    assert.deepEqual(rls.rows, [{ count: 1 }]);
    const dynamicObjects = await client.query(
      `SELECT
         (SELECT count(*)::int FROM pg_proc
          WHERE pronamespace = 'bop_identity'::regnamespace) AS functions,
         (SELECT count(*)::int FROM pg_trigger
          WHERE tgrelid IN (
            'bop_identity.authentication_session'::regclass,
            'bop_identity.oidc_authorization_transaction'::regclass,
            'bop_identity.guest_session'::regclass
          ) AND NOT tgisinternal) AS triggers`,
    );
    assert.deepEqual(dynamicObjects.rows, [{ functions: 0, triggers: 0 }]);

    await client.query(
      `CREATE ROLE ${deniedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await client.query(`SET ROLE ${deniedRole}`);
    await assert.rejects(
      client.query("SELECT count(*) FROM bop_identity.authentication_session"),
      /permission denied/u,
    );
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${deniedRole}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves Identity session constraints, one-time consume and least privilege", async () => {
  await withIsolatedDatabase({ caseId: "identity_session", root }, prove);
});
