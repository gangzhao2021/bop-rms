import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  appendAuditRecordInTransaction,
  computeAuditRecordHash,
} from "../../bop/audit/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit) => `018f1f48-7b5d-7cc${digit}-8a1b-123456789abc`;
const input = (auditId, override = {}) => ({
  auditId,
  brandId: id("1"),
  storeId: id("2"),
  actor: { type: "System" },
  actionCode: "SYNTHETIC_CHANGED",
  targetType: "SyntheticTarget",
  targetId: id("3"),
  beforeSummary: { state: "before" },
  afterSummary: { state: "after" },
  reasonCode: "SYNTHETIC_ACCEPTANCE",
  correlationId: id("4"),
  occurredAt: "2026-07-27T12:00:00.000Z",
  sourceChannel: "SYSTEM",
  dataClassification: "Internal",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
  ...override,
});

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp0042_${context.runId}`;
  await client.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`CREATE TABLE public.wp0042_probe (probe_id uuid PRIMARY KEY)`);
    await client.query(`GRANT USAGE ON SCHEMA public, platform_audit, platform_helpers TO ${role}`);
    await client.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
         platform_helpers.is_uuid_v7(uuid),
         platform_helpers.current_brand_id(),
         platform_helpers.current_store_id()
       TO ${role}`,
    );
    await client.query(
      `GRANT SELECT, INSERT ON TABLE public.wp0042_probe, platform_audit.audit_record TO ${role}`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE ON TABLE platform_audit.audit_chain_head TO ${role}`,
    );
    const security = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE oid IN (
         'platform_audit.audit_record'::regclass,
         'platform_audit.audit_chain_head'::regclass
       )
       ORDER BY relname`,
    );
    assert.deepEqual(security.rows, [
      { relname: "audit_chain_head", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "audit_record", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const publicAcl = await client.query(`SELECT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS privilege
      WHERE relation.oid IN (
          'platform_audit.audit_record'::regclass,
          'platform_audit.audit_chain_head'::regclass
        )
        AND privilege.grantee = 0
    ) AS unsafe`);
    assert.deepEqual(publicAcl.rows, [{ unsafe: false }]);
    await client.query(`SET ROLE ${role}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("9")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    await assert.rejects(
      appendAuditRecordInTransaction(client, input(id("0"))),
      /row-level security policy/u,
    );
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("1")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    await client.query("INSERT INTO public.wp0042_probe VALUES ($1)", [id("5")]);
    const first = await appendAuditRecordInTransaction(client, input(id("6")));
    await client.query("COMMIT");
    assert.equal(first.sequence, 1);
    assert.equal(first.previousHash, null);
    assert.equal(first.recordHash, computeAuditRecordHash(first));
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("1")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    await client.query("INSERT INTO public.wp0042_probe VALUES ($1)", [id("7")]);
    await assert.rejects(appendAuditRecordInTransaction(client, input(id("6"))), /duplicate key/u);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("1")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    const correction = await appendAuditRecordInTransaction(
      client,
      input(id("8"), { correctsAuditId: id("6") }),
    );
    await client.query("COMMIT");
    assert.equal(correction.sequence, 2);
    assert.equal(correction.previousHash, first.recordHash);
    assert.equal(correction.recordHash, computeAuditRecordHash(correction));
    await assert.rejects(
      client.query("UPDATE platform_audit.audit_record SET reason_code='OTHER'"),
      /permission denied/u,
    );
    await assert.rejects(
      client.query("DELETE FROM platform_audit.audit_record"),
      /permission denied/u,
    );
    await client.query("RESET ROLE");
    const counts = await client.query(`SELECT
      (SELECT count(*)::int FROM public.wp0042_probe) probe_count,
      (SELECT count(*)::int FROM platform_audit.audit_record) audit_count,
      (SELECT count(*)::int FROM platform_audit.audit_chain_head) head_count`);
    assert.deepEqual(counts.rows, [{ probe_count: 1, audit_count: 2, head_count: 1 }]);
    const chain = await client.query(`SELECT
      chain_version,
      chain_sequence::int,
      CASE
        WHEN previous_record_hash IS NULL THEN NULL
        ELSE encode(previous_record_hash, 'hex')
      END AS previous_hash,
      encode(record_hash, 'hex') AS record_hash,
      to_char(
        recorded_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS recorded_at
      FROM platform_audit.audit_record
      ORDER BY chain_sequence`);
    assert.deepEqual(chain.rows, [
      {
        chain_version: "AUDIT_CHAIN_V1",
        chain_sequence: 1,
        previous_hash: null,
        record_hash: first.recordHash,
        recorded_at: first.recordedAt,
      },
      {
        chain_version: "AUDIT_CHAIN_V1",
        chain_sequence: 2,
        previous_hash: first.recordHash,
        record_hash: correction.recordHash,
        recorded_at: correction.recordedAt,
      },
    ]);
    const head = await client.query(`SELECT
      next_sequence::int,
      encode(last_record_hash, 'hex') AS last_record_hash
      FROM platform_audit.audit_chain_head`);
    assert.deepEqual(head.rows, [{ next_sequence: 3, last_record_hash: correction.recordHash }]);

    const appendCommitted = async (recordInput) => {
      const concurrent = new Client(context.clientConfig);
      await concurrent.connect();
      try {
        await concurrent.query(`SET ROLE ${role}`);
        await concurrent.query("BEGIN");
        await concurrent.query("SELECT set_config('bop.brand_id',$1,true)", [recordInput.brandId]);
        await concurrent.query("SELECT set_config('bop.store_id',$1,true)", [
          recordInput.storeId ?? "",
        ]);
        const appended = await appendAuditRecordInTransaction(concurrent, recordInput);
        await concurrent.query("COMMIT");
        return appended;
      } catch (error) {
        await concurrent.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await concurrent.query("RESET ROLE").catch(() => undefined);
        await concurrent.end();
      }
    };
    const concurrent = await Promise.all([
      appendCommitted(input(id("a"))),
      appendCommitted(input(id("b"))),
      appendCommitted(input(id("d"), { storeId: id("c") })),
    ]);
    const samePartition = concurrent
      .filter((record) => record.content.storeId === id("2"))
      .sort((left, right) => left.sequence - right.sequence);
    const otherPartition = concurrent.find((record) => record.content.storeId === id("c"));
    assert.deepEqual(
      samePartition.map((record) => record.sequence),
      [3, 4],
    );
    assert.equal(samePartition[0].previousHash, correction.recordHash);
    assert.equal(samePartition[1].previousHash, samePartition[0].recordHash);
    assert.equal(otherPartition?.sequence, 1);
    assert.equal(otherPartition?.previousHash, null);

    const finalHeads = await client.query(`SELECT
      store_id::text,
      next_sequence::int,
      encode(last_record_hash, 'hex') AS last_record_hash
      FROM platform_audit.audit_chain_head
      ORDER BY store_id`);
    assert.deepEqual(finalHeads.rows, [
      {
        store_id: id("2"),
        next_sequence: 5,
        last_record_hash: samePartition[1].recordHash,
      },
      {
        store_id: id("c"),
        next_sequence: 2,
        last_record_hash: otherPartition?.recordHash,
      },
    ]);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end();
  }
}

it("proves WP-0042 append-only plus WP-0046 chain, head, RLS, ACL and rollback behavior", async () => {
  await withIsolatedDatabase({ caseId: "audit_record", root }, prove);
}, 180_000);
