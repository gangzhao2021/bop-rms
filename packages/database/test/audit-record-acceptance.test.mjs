import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
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
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(
      `GRANT SELECT, INSERT ON TABLE public.wp0042_probe, platform_audit.audit_record TO ${role}`,
    );
    const security = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='platform_audit.audit_record'::regclass`,
    );
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
    const publicAcl = await client.query(`SELECT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS privilege
      WHERE relation.oid = 'platform_audit.audit_record'::regclass
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
    await appendAuditRecordInTransaction(client, input(id("6")));
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("1")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    await client.query("INSERT INTO public.wp0042_probe VALUES ($1)", [id("7")]);
    await assert.rejects(appendAuditRecordInTransaction(client, input(id("6"))), /duplicate key/u);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SELECT set_config('bop.brand_id',$1,true)", [id("1")]);
    await client.query("SELECT set_config('bop.store_id',$1,true)", [id("2")]);
    await appendAuditRecordInTransaction(client, input(id("8"), { correctsAuditId: id("6") }));
    await client.query("COMMIT");
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
      (SELECT count(*)::int FROM platform_audit.audit_record) audit_count`);
    assert.deepEqual(counts.rows, [{ probe_count: 1, audit_count: 2 }]);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end();
  }
}

it("proves WP-0042 append-only, correction, RLS, ACL and transaction behavior", async () => {
  await withIsolatedDatabase({ caseId: "audit_record", root }, prove);
}, 180_000);
