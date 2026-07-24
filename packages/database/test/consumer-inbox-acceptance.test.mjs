import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  appendEventInTransaction,
  consumeEventInTransaction,
} from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brand = "018f1f48-7b5d-7cc1-8a1b-123456789abc";
const store = "018f1f48-7b5d-7cc2-8a1b-123456789abc";
const correlation = "018f1f48-7b5d-7cc3-8a1b-123456789abc";
const aggregate = "018f1f48-7b5d-7cc4-8a1b-123456789abc";
const consumerName = "synthetic.projector:v1";

function event(eventId, overrides = {}) {
  return {
    eventId,
    eventType: "SyntheticChanged",
    schemaVersion: 1,
    occurredAt: "2026-07-23T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brand,
    storeId: store,
    aggregateType: "Synthetic",
    aggregateId: aggregate,
    aggregateVersion: 1n,
    correlationId: correlation,
    actor: { type: "System" },
    payload: { synthetic: true },
    redactionClassification: "none",
    replayMetadata: {},
    ...overrides,
  };
}

function registration(handler) {
  return {
    consumerName,
    consumerVersion: 1,
    eventType: "SyntheticChanged",
    schemaVersions: [1],
    ownerModule: "@bop/eventing",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "synthetic-effect",
    replaySafe: true,
    handler,
  };
}

async function context(client) {
  await client.query("SELECT set_config('bop.brand_id', $1, true)", [brand]);
  await client.query("SELECT set_config('bop.store_id', $1, true)", [store]);
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
}

async function process(client, envelope, fail = false) {
  await client.query("BEGIN");
  try {
    await context(client);
    const result = await consumeEventInTransaction(
      client,
      registration(async ({ transaction }) => {
        await transaction.query(
          "INSERT INTO public.wp0032_effect (consumer_name, event_id) VALUES ($1, $2)",
          [consumerName, envelope.eventId],
        );
        await appendEventInTransaction(
          transaction,
          event("018f1f48-7b5d-7dd1-8a1b-123456789abc", {
            eventType: "SyntheticProjected",
            aggregateVersion: 2n,
          }),
        );
        if (fail) throw new Error("SYNTHETIC_FAILURE");
      }),
      envelope,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function prove(contextInfo) {
  const admin = new Client(contextInfo.clientConfig);
  const first = new Client(contextInfo.clientConfig);
  const second = new Client(contextInfo.clientConfig);
  const role = `bop_wp0032_${contextInfo.runId}`;
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE TABLE public.wp0032_effect (
      consumer_name text NOT NULL,
      event_id uuid NOT NULL,
      PRIMARY KEY (consumer_name, event_id)
    )`);
    await admin.query(
      `GRANT USAGE ON SCHEMA public, platform_eventing, platform_helpers TO ${role}`,
    );
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION
      platform_helpers.is_uuid_v7(uuid),
      platform_helpers.current_brand_id(),
      platform_helpers.current_store_id()
      TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON TABLE
      public.wp0032_effect,
      platform_eventing.consumer_inbox,
      platform_eventing.outbox_event
      TO ${role}`);
    await Promise.all([first.query(`SET ROLE ${role}`), second.query(`SET ROLE ${role}`)]);

    await first.query("BEGIN");
    await assert.rejects(
      consumeEventInTransaction(
        first,
        registration(async () => undefined),
        event("018f1f48-7b5d-7dd2-8a1b-123456789abc"),
      ),
      /row-level security/u,
    );
    await first.query("ROLLBACK");

    const failedId = "018f1f48-7b5d-7dd3-8a1b-123456789abc";
    await assert.rejects(process(first, event(failedId), true), /SYNTHETIC_FAILURE/u);
    const afterFailure = await admin.query(
      `SELECT
      (SELECT count(*)::integer FROM platform_eventing.consumer_inbox WHERE event_id = $1) AS inbox,
      (SELECT count(*)::integer FROM public.wp0032_effect WHERE event_id = $1) AS effect`,
      [failedId],
    );
    assert.deepEqual(afterFailure.rows, [{ inbox: 0, effect: 0 }]);

    const concurrentId = "018f1f48-7b5d-7dd4-8a1b-123456789abc";
    const results = await Promise.all([
      process(first, event(concurrentId)),
      process(second, event(concurrentId)),
    ]);
    assert.deepEqual(
      new Set(results.map((item) => item.status)),
      new Set(["processed", "duplicate_completed"]),
    );
    assert.deepEqual(await process(first, event(concurrentId)), {
      status: "duplicate_completed",
    });
    const final = await admin.query(
      `SELECT
      (SELECT count(*)::integer FROM platform_eventing.consumer_inbox WHERE event_id = $1) AS inbox,
      (SELECT count(*)::integer FROM public.wp0032_effect WHERE event_id = $1) AS effect,
      (SELECT status FROM platform_eventing.consumer_inbox WHERE event_id = $1) AS status,
      (SELECT attempt_count FROM platform_eventing.consumer_inbox WHERE event_id = $1) AS attempt`,
      [concurrentId],
    );
    assert.deepEqual(final.rows, [{ inbox: 1, effect: 1, status: "completed", attempt: 1 }]);

    const security = await admin.query(`SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'platform_eventing.consumer_inbox'::regclass`);
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  } finally {
    await Promise.all([
      first.query("RESET ROLE").catch(() => undefined),
      second.query("RESET ROLE").catch(() => undefined),
    ]);
    await Promise.all([first.end(), second.end()]);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("proves WP-0032 transactional idempotency, rollback, concurrency, and RLS", async () => {
  await withIsolatedDatabase({ caseId: "consumer_inbox", root }, prove);
}, 180_000);
