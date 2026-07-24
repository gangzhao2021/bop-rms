import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  ConsumerTransactionRollback,
  appendEventInTransaction,
  consumeEventInTransaction,
} from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandA = "018f1f48-7b5d-7c01-8a1b-123456789abc";
const brandB = "018f1f48-7b5d-7c02-8a1b-123456789abc";
const storeA = "018f1f48-7b5d-7c03-8a1b-123456789abc";
const storeB = "018f1f48-7b5d-7c04-8a1b-123456789abc";
const correlation = "018f1f48-7b5d-7c05-8a1b-123456789abc";
const aggregate = "018f1f48-7b5d-7c06-8a1b-123456789abc";
const secretSentinel = "secret-canary-never-persist";
let sequence = 0x100;

function nextId() {
  sequence += 1;
  return `018f1f48-7b5d-7${sequence.toString(16).padStart(3, "0")}-8a1b-123456789abc`;
}

function event(eventId = nextId(), overrides = {}) {
  return {
    eventId,
    eventType: "SyntheticChanged",
    schemaVersion: 1,
    occurredAt: "2026-07-23T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brandA,
    storeId: storeA,
    aggregateType: "Synthetic",
    aggregateId: aggregate,
    aggregateVersion: 1n,
    correlationId: correlation,
    actor: { type: "System" },
    payload: { secret: secretSentinel },
    redactionClassification: "credential",
    replayMetadata: {},
    ...overrides,
  };
}

function registration(consumerName, handler, overrides = {}) {
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
    ...overrides,
  };
}

async function setContext(client, scope = { brandId: brandA, storeId: storeA }) {
  await client.query("SELECT set_config('bop.brand_id', $1, true)", [scope.brandId]);
  await client.query("SELECT set_config('bop.store_id', $1, true)", [scope.storeId ?? ""]);
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
}

async function execute(
  client,
  envelope,
  {
    consumerName = "synthetic.projector:v1",
    context = { brandId: envelope.tenantId, storeId: envelope.storeId },
    failureStage,
    ordering = "none",
    tenantScope = envelope.storeId ? "store" : "brand",
  } = {},
) {
  const outboxId = nextId();
  await client.query("BEGIN");
  try {
    await setContext(client, context);
    const transaction =
      failureStage === "before_complete"
        ? {
            query: async (sql, values) => {
              if (sql.startsWith("UPDATE platform_eventing.consumer_inbox"))
                throw new Error("SYNTHETIC_BEFORE_COMPLETE");
              return await client.query(sql, values);
            },
          }
        : client;
    const result = await consumeEventInTransaction(
      transaction,
      registration(
        consumerName,
        async ({ transaction: handlerTransaction }) => {
          if (failureStage === "before_handler") throw new Error("SYNTHETIC_BEFORE_HANDLER");
          if (ordering === "aggregate" && envelope.aggregateVersion > 1n)
            return { status: "retry_required", errorCode: "AGGREGATE_ORDER_GAP" };
          await handlerTransaction.query(
            "INSERT INTO public.wp0032_effect (consumer_name, event_id) VALUES ($1, $2)",
            [consumerName, envelope.eventId],
          );
          if (failureStage === "during_side_effect")
            throw new Error("SYNTHETIC_DURING_SIDE_EFFECT");
          await appendEventInTransaction(
            handlerTransaction,
            event(outboxId, {
              eventType: "SyntheticProjected",
              aggregateVersion: envelope.aggregateVersion + 1n,
              tenantId: envelope.tenantId,
              storeId: envelope.storeId,
              payload: { synthetic: true },
              redactionClassification: "none",
            }),
          );
          if (failureStage === "after_outbox") throw new Error("SYNTHETIC_AFTER_OUTBOX");
          return undefined;
        },
        { ordering, tenantScope },
      ),
      envelope,
    );
    if (failureStage === "after_complete_before_commit")
      throw new Error("SYNTHETIC_AFTER_COMPLETE");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ConsumerTransactionRollback) return error.outcome;
    throw error;
  }
}

async function counts(admin, eventId) {
  const result = await admin.query(
    `SELECT
      (SELECT count(*)::integer FROM platform_eventing.consumer_inbox WHERE event_id = $1) AS inbox,
      (SELECT count(*)::integer FROM public.wp0032_effect WHERE event_id = $1) AS effect`,
    [eventId],
  );
  return result.rows[0];
}

async function outboxCount(admin) {
  const result = await admin.query(
    "SELECT count(*)::integer AS count FROM platform_eventing.outbox_event",
  );
  return result.rows[0].count;
}

async function expectPolicyDenial(client, envelope, context) {
  await client.query("BEGIN");
  try {
    if (context) await setContext(client, context);
    await assert.rejects(
      consumeEventInTransaction(
        client,
        registration("synthetic.projector:v1", async () => undefined),
        envelope,
      ),
      /row-level security|invalid input syntax/u,
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectScopeRejection(client, envelope, context) {
  await client.query("BEGIN");
  try {
    await setContext(client, context);
    assert.deepEqual(
      await consumeEventInTransaction(
        client,
        registration("synthetic.projector:v1", async () => undefined),
        envelope,
      ),
      { status: "rejected", errorCode: "TENANT_SCOPE_DENIED" },
    );
  } finally {
    await client.query("ROLLBACK");
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

    await expectPolicyDenial(first, event());
    await expectPolicyDenial(first, event(), { brandId: "invalid", storeId: storeA });
    await expectPolicyDenial(first, event(), { brandId: brandB, storeId: storeA });
    await expectPolicyDenial(first, event(), { brandId: brandA, storeId: storeB });
    await expectPolicyDenial(first, event(), { brandId: brandA });
    await expectScopeRejection(first, event(nextId(), { storeId: undefined }), {
      brandId: brandA,
      storeId: storeA,
    });

    const brandWide = event(nextId(), { storeId: undefined });
    assert.deepEqual(
      await execute(first, brandWide, {
        consumerName: "synthetic.brand-projector:v1",
        context: { brandId: brandA },
        tenantScope: "brand",
      }),
      { status: "processed" },
    );

    for (const failureStage of [
      "before_handler",
      "during_side_effect",
      "after_outbox",
      "before_complete",
      "after_complete_before_commit",
    ]) {
      const failed = event();
      const beforeOutbox = await outboxCount(admin);
      await assert.rejects(execute(first, failed, { failureStage }), /SYNTHETIC_/u);
      assert.deepEqual(await counts(admin, failed.eventId), { inbox: 0, effect: 0 });
      assert.equal(await outboxCount(admin), beforeOutbox);
      assert.deepEqual(await execute(first, failed), { status: "processed" });
      assert.deepEqual(await counts(admin, failed.eventId), { inbox: 1, effect: 1 });
    }

    const concurrent = event();
    const concurrentResults = await Promise.all([
      execute(first, concurrent),
      execute(second, concurrent),
    ]);
    assert.deepEqual(
      new Set(concurrentResults.map((item) => item.status)),
      new Set(["processed", "duplicate_completed"]),
    );
    assert.deepEqual(await execute(first, concurrent), { status: "duplicate_completed" });
    assert.deepEqual(await counts(admin, concurrent.eventId), { inbox: 1, effect: 1 });

    const shared = event();
    assert.deepEqual(
      await execute(first, shared, { consumerName: "synthetic.first-projector:v1" }),
      { status: "processed" },
    );
    assert.deepEqual(
      await execute(first, shared, { consumerName: "synthetic.second-projector:v1" }),
      { status: "processed" },
    );
    assert.deepEqual(await counts(admin, shared.eventId), { inbox: 2, effect: 2 });

    const distinctA = event();
    const distinctB = event();
    assert.equal((await execute(first, distinctA)).status, "processed");
    assert.equal((await execute(first, distinctB)).status, "processed");

    const gap = event(nextId(), { aggregateVersion: 2n });
    assert.deepEqual(await execute(first, gap, { ordering: "aggregate" }), {
      status: "retry_required",
      errorCode: "AGGREGATE_ORDER_GAP",
    });
    assert.deepEqual(await counts(admin, gap.eventId), { inbox: 0, effect: 0 });
    const expected = event(nextId(), { aggregateVersion: 1n });
    assert.equal((await execute(first, expected, { ordering: "aggregate" })).status, "processed");

    const crashEvent = event();
    const beforeCrashOutbox = await outboxCount(admin);
    const crashed = new Client(contextInfo.clientConfig);
    await crashed.connect();
    await crashed.query(`SET ROLE ${role}`);
    await crashed.query("BEGIN");
    await setContext(crashed);
    await consumeEventInTransaction(
      crashed,
      registration("synthetic.crash-projector:v1", async ({ transaction }) => {
        await transaction.query(
          "INSERT INTO public.wp0032_effect (consumer_name, event_id) VALUES ($1, $2)",
          ["synthetic.crash-projector:v1", crashEvent.eventId],
        );
        await appendEventInTransaction(
          transaction,
          event(nextId(), {
            eventType: "SyntheticProjected",
            payload: { synthetic: true },
            redactionClassification: "none",
          }),
        );
      }),
      crashEvent,
    );
    await crashed.end();
    assert.deepEqual(await counts(admin, crashEvent.eventId), { inbox: 0, effect: 0 });
    assert.equal(await outboxCount(admin), beforeCrashOutbox);
    assert.equal(
      (
        await execute(first, crashEvent, {
          consumerName: "synthetic.crash-projector:v1",
        })
      ).status,
      "processed",
    );

    const lostAck = event();
    assert.equal((await execute(first, lostAck)).status, "processed");
    assert.deepEqual(await execute(first, lostAck), { status: "duplicate_completed" });
    assert.deepEqual(await counts(admin, lostAck.eventId), { inbox: 1, effect: 1 });

    const conflicting = event();
    assert.equal((await execute(first, conflicting)).status, "processed");
    await first.query("BEGIN");
    await setContext(first, { brandId: brandB, storeId: storeB });
    assert.deepEqual(
      await consumeEventInTransaction(
        first,
        registration("synthetic.projector:v1", async () => {
          throw new Error("handler must not run");
        }),
        event(conflicting.eventId, { tenantId: brandB, storeId: storeB }),
      ),
      { status: "rejected", errorCode: "TENANT_SCOPE_DENIED" },
    );
    await first.query("ROLLBACK");

    const storedColumns = await admin.query(`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'platform_eventing' AND table_name = 'consumer_inbox'`);
    assert(!storedColumns.rows.some((row) => row.column_name.includes("payload")));
    const storedText = await admin.query(
      `SELECT string_agg(row_to_json(inbox)::text, '') AS text
       FROM platform_eventing.consumer_inbox AS inbox`,
    );
    assert(!storedText.rows[0].text.includes(secretSentinel));

    const security = await admin.query(`SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'platform_eventing.consumer_inbox'::regclass`);
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
    const publicAcl = await admin.query(`SELECT has_table_privilege(
      'public', 'platform_eventing.consumer_inbox', 'SELECT,INSERT,UPDATE,DELETE'
    ) AS unsafe`);
    assert.deepEqual(publicAcl.rows, [{ unsafe: false }]);
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

it("proves the complete WP-0032 Consumer Inbox acceptance matrix", async () => {
  await withIsolatedDatabase({ caseId: "consumer_inbox", root }, prove);
}, 180_000);
