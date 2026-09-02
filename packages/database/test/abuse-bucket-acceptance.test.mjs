import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const digest = (value) => createHash("sha256").update(`synthetic:${value}`).digest();

async function consume(context, role, key, observedAt, bucketClass = "PICKUP_PROOF_FAILURE") {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    const result = await client.query(
      `SELECT * FROM security.consume_abuse_budget($1,$2,$3,$4,$5,$6)`,
      [bucketClass, digest(key), "2026-08-12T12:00:00.000Z", 600, 5, observedAt],
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp2048_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA security TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION security.consume_abuse_budget(
        text,bytea,timestamp with time zone,integer,integer,timestamp with time zone
      ) TO ${role}`,
    );

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        consume(context, role, "same-fulfillment-device-ip", `2026-08-12T12:0${index}:00.000Z`),
      ),
    );
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 5);
    assert.equal(attempts.filter((attempt) => !attempt.allowed).length, 3);
    assert(
      attempts.filter((attempt) => !attempt.allowed).every((attempt) => attempt.remaining === 0),
    );
    assert(
      attempts
        .filter((attempt) => !attempt.allowed)
        .every((attempt) => attempt.retry_after_seconds > 0),
    );

    const independent = await consume(
      context,
      role,
      "different-order-contact-ip",
      "2026-08-12T12:01:00.000Z",
      "ORDER_RESUME",
    );
    assert.deepEqual(independent, { allowed: true, remaining: 4, retry_after_seconds: 0 });

    await assert.rejects(
      admin.query(`SET ROLE ${role}; SELECT count(*) FROM security.abuse_bucket`),
      /permission denied/u,
    );
    await admin.query("RESET ROLE");
    const stored = await admin.query(
      `SELECT bucket_class,octet_length(key_hash)::integer AS hash_bytes,attempt_count,limit_count
       FROM security.abuse_bucket ORDER BY bucket_class`,
    );
    assert.deepEqual(stored.rows, [
      { bucket_class: "ORDER_RESUME", hash_bytes: 32, attempt_count: 1, limit_count: 5 },
      { bucket_class: "PICKUP_PROOF_FAILURE", hash_bytes: 32, attempt_count: 8, limit_count: 5 },
    ]);
    assert.equal(
      (
        await admin.query(
          `SELECT security.delete_expired_abuse_buckets('2026-08-13T12:00:00.000Z') AS deleted`,
        )
      ).rows[0].deleted,
      2,
    );
    assert.equal(
      (await admin.query(`SELECT count(*)::integer AS count FROM security.abuse_bucket`)).rows[0]
        .count,
      0,
    );
  } finally {
    await admin.query(
      `REVOKE EXECUTE ON FUNCTION security.consume_abuse_budget(
        text,bytea,timestamp with time zone,integer,integer,timestamp with time zone
      ) FROM ${role}`,
    );
    await admin.query(`REVOKE USAGE ON SCHEMA security FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}

it("atomically limits public capability attempts without storing raw scope identifiers", async () => {
  await withIsolatedDatabase({ caseId: "abuse_bucket", root }, prove);
});
