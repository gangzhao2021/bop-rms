import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { appendEventInTransaction } from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandA = "018f1f48-7b5d-7cc1-8a1b-123456789abc";
const brandB = "018f1f48-7b5d-7cc2-8a1b-123456789abc";
const storeA = "018f1f48-7b5d-7cc3-8a1b-123456789abc";
const storeB = "018f1f48-7b5d-7cc4-8a1b-123456789abc";
const aggregateId = "018f1f48-7b5d-7cc5-8a1b-123456789abc";
const correlationId = "018f1f48-7b5d-7cc6-8a1b-123456789abc";

function event(eventId, overrides = {}) {
  return {
    eventId,
    eventType: "SyntheticChanged",
    schemaVersion: 1,
    occurredAt: "2026-07-23T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brandA,
    storeId: storeA,
    aggregateType: "SyntheticAggregate",
    aggregateId,
    aggregateVersion: 1n,
    correlationId,
    actor: { type: "System" },
    payload: { aggregateId },
    redactionClassification: "none",
    replayMetadata: { source: "synthetic-acceptance" },
    ...overrides,
  };
}

async function expectPolicyDenial(client, envelope) {
  await client.query("BEGIN");
  try {
    await appendEventInTransaction(client, envelope);
    assert.fail("RLS unexpectedly accepted the Outbox insert");
  } catch (error) {
    assert.match(error.message, /row-level security policy/u);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function proveOutbox(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp0030_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE TABLE public.wp0030_business_probe (
      probe_id uuid PRIMARY KEY,
      brand_id uuid NOT NULL,
      value text NOT NULL
    )`);
    await admin.query(
      `GRANT USAGE ON SCHEMA public, platform_eventing, platform_helpers TO ${role}`,
    );
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.is_uuid_v7(uuid),
        platform_helpers.current_brand_id(),
        platform_helpers.current_store_id()
      TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT, INSERT ON TABLE public.wp0030_business_probe, platform_eventing.outbox_event TO ${role}`,
    );

    const columns = await admin.query(`SELECT column_name, data_type, domain_schema, domain_name
      FROM information_schema.columns
      WHERE table_schema = 'platform_eventing'
        AND table_name = 'outbox_event'
      ORDER BY ordinal_position`);
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        "event_id",
        "event_type",
        "schema_version",
        "producer_module",
        "brand_id",
        "store_id",
        "aggregate_type",
        "aggregate_id",
        "aggregate_version",
        "correlation_id",
        "causation_id",
        "actor_type",
        "actor_id",
        "payload_json",
        "redaction_classification",
        "replay_metadata_json",
        "occurred_at",
        "recorded_at",
        "available_at",
        "published_at",
        "attempt_count",
        "last_error_code",
        "lease_token",
        "lease_owner",
        "lease_expires_at",
        "ordering_released_at",
      ],
    );
    for (const name of [
      "event_id",
      "brand_id",
      "store_id",
      "aggregate_id",
      "correlation_id",
      "causation_id",
      "actor_id",
    ]) {
      const column = columns.rows.find((row) => row.column_name === name);
      assert.deepEqual(
        { domain_name: column.domain_name, domain_schema: column.domain_schema },
        { domain_name: "uuid_v7", domain_schema: "platform_helpers" },
      );
    }

    const security = await admin.query(`SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'platform_eventing.outbox_event'::regclass`);
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await admin.query(`SELECT policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'platform_eventing'
        AND tablename = 'outbox_event'`);
    assert.equal(policies.rows.length, 1);
    assert.equal(policies.rows[0].policyname, "outbox_event_tenant_scope");
    assert.match(policies.rows[0].qual, /current_brand_id/u);
    assert.match(policies.rows[0].with_check, /current_store_id/u);
    const indexes = await admin.query(`SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'platform_eventing'
        AND tablename = 'outbox_event'
      ORDER BY indexname`);
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      [
        "outbox_event_aggregate_order_idx",
        "outbox_event_correlation_idx",
        "outbox_event_dispatch_claim_idx",
        "outbox_event_pkey",
        "outbox_event_publishable_idx",
      ],
    );
    const publicPrivilege = await admin.query(`SELECT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS privilege
      WHERE relation.oid = 'platform_eventing.outbox_event'::regclass
        AND privilege.grantee = 0
    ) AS unsafe`);
    assert.deepEqual(publicPrivilege.rows, [{ unsafe: false }]);

    await admin.query(`SET ROLE ${role}`);
    await expectPolicyDenial(admin, event("018f1f48-7b5d-7cd0-8a1b-123456789abc"));

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id', $1, true)", [brandA]);
    await admin.query("SELECT set_config('bop.store_id', $1, true)", [storeA]);
    await admin.query(
      "INSERT INTO public.wp0030_business_probe (probe_id, brand_id, value) VALUES ($1, $2, $3)",
      [aggregateId, brandA, "committed"],
    );
    const committedEventId = "018f1f48-7b5d-7cd1-8a1b-123456789abc";
    await appendEventInTransaction(admin, event(committedEventId));
    await admin.query("COMMIT");

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id', $1, true)", [brandA]);
    await admin.query("SELECT set_config('bop.store_id', $1, true)", [storeA]);
    const rolledBackProbe = "018f1f48-7b5d-7cd2-8a1b-123456789abc";
    await admin.query(
      "INSERT INTO public.wp0030_business_probe (probe_id, brand_id, value) VALUES ($1, $2, $3)",
      [rolledBackProbe, brandA, "must-roll-back"],
    );
    await assert.rejects(
      appendEventInTransaction(admin, event(committedEventId)),
      /duplicate key value/u,
    );
    await admin.query("ROLLBACK");

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id', $1, true)", [brandA]);
    await admin.query("SELECT set_config('bop.store_id', $1, true)", [storeA]);
    await assert.rejects(
      appendEventInTransaction(
        admin,
        event("018f1f48-7b5d-7cd3-8a1b-123456789abc", { tenantId: brandB }),
      ),
      /row-level security policy/u,
    );
    await admin.query("ROLLBACK");

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id', $1, true)", [brandA]);
    await admin.query("SELECT set_config('bop.store_id', $1, true)", [storeA]);
    await assert.rejects(
      appendEventInTransaction(
        admin,
        event("018f1f48-7b5d-7cd4-8a1b-123456789abc", { storeId: storeB }),
      ),
      /row-level security policy/u,
    );
    await admin.query("ROLLBACK");

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id', $1, true)", [brandA]);
    await admin.query("SELECT set_config('bop.store_id', $1, true)", [storeA]);
    const visible = await admin.query(`SELECT event_id::text
      FROM platform_eventing.outbox_event
      ORDER BY event_id`);
    assert.deepEqual(visible.rows, [{ event_id: committedEventId }]);
    await admin.query("COMMIT");
    await admin.query("RESET ROLE");

    const facts = await admin.query(
      `SELECT
      (SELECT count(*)::integer FROM public.wp0030_business_probe) AS business_count,
      (SELECT count(*)::integer FROM platform_eventing.outbox_event) AS event_count,
      EXISTS (
        SELECT 1
        FROM public.wp0030_business_probe
        WHERE probe_id = $1
      ) AS rolled_back_probe_exists`,
      [rolledBackProbe],
    );
    assert.deepEqual(facts.rows, [
      {
        business_count: 1,
        event_count: 1,
        rolled_back_probe_exists: false,
      },
    ]);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("proves the WP-0030 Outbox schema, RLS and transaction contract", async () => {
  await withIsolatedDatabase({ caseId: "outbox", root }, proveOutbox);
}, 180_000);
