import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  appendEventInTransaction,
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
} from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandA = "018f1f48-7b5d-7cc1-8a1b-123456789abc";
const brandB = "018f1f48-7b5d-7cc2-8a1b-123456789abc";
const storeA = "018f1f48-7b5d-7cc3-8a1b-123456789abc";
const aggregateA = "018f1f48-7b5d-7cc4-8a1b-123456789abc";
const aggregateB = "018f1f48-7b5d-7cc5-8a1b-123456789abc";
const correlationId = "018f1f48-7b5d-7cc6-8a1b-123456789abc";
const eventId = (suffix) => `018f1f48-7b5d-7d${suffix.padStart(2, "0")}-8a1b-123456789abc`;
const leaseId = (suffix) => `018f1f48-7b5d-7e${suffix.padStart(2, "0")}-8a1b-123456789abc`;

function event(id, overrides = {}) {
  return {
    eventId: id,
    eventType: "SyntheticChanged",
    schemaVersion: 1,
    occurredAt: "2026-07-23T12:00:00.000Z",
    producerModule: "@bop/eventing",
    tenantId: brandA,
    aggregateType: "SyntheticAggregate",
    aggregateId: aggregateA,
    aggregateVersion: 1n,
    correlationId,
    actor: { type: "System" },
    payload: {},
    redactionClassification: "none",
    replayMetadata: {},
    ...overrides,
  };
}

async function inScope(client, scope, action) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [scope.brandId]);
    if (scope.storeId)
      await client.query("SELECT set_config('bop.store_id', $1, true)", [scope.storeId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seed(admin, envelope) {
  await inScope(
    admin,
    { brandId: envelope.tenantId, ...(envelope.storeId ? { storeId: envelope.storeId } : {}) },
    (transaction) => appendEventInTransaction(transaction, envelope),
  );
}

async function claim(client, scope, token, batchSize = 25, leaseDurationSeconds = 30) {
  return await inScope(client, scope, (transaction) =>
    claimOutboxBatch(transaction, {
      batchSize,
      leaseDurationSeconds,
      leaseOwner: "synthetic_worker",
      leaseToken: token,
    }),
  );
}

async function proveDispatcher(context) {
  const admin = new Client(context.clientConfig);
  const workerA = new Client(context.clientConfig);
  const workerB = new Client(context.clientConfig);
  const role = `bop_wp0031_${context.runId}`;
  await Promise.all([admin.connect(), workerA.connect(), workerB.connect()]);
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA platform_eventing, platform_helpers TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.is_uuid_v7(uuid),
        platform_helpers.current_brand_id(),
        platform_helpers.current_store_id()
      TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON TABLE platform_eventing.outbox_event TO ${role}`);
    await admin.query(`GRANT UPDATE (
      published_at,
      attempt_count,
      last_error_code,
      lease_token,
      lease_owner,
      lease_expires_at
    ) ON TABLE platform_eventing.outbox_event TO ${role}`);

    const columns = await admin.query(`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'platform_eventing'
        AND table_name = 'outbox_event'
      ORDER BY ordinal_position`);
    assert.deepEqual(columns.rows.slice(-4), [
      { column_name: "lease_token" },
      { column_name: "lease_owner" },
      { column_name: "lease_expires_at" },
      { column_name: "ordering_released_at" },
    ]);
    const constraints = await admin.query(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'platform_eventing.outbox_event'::regclass
        AND conname = 'outbox_event_lease_shape_check'`);
    assert.match(constraints.rows[0].definition, /lease_owner/u);
    const claimIndex = await admin.query(`SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'platform_eventing'
        AND indexname = 'outbox_event_dispatch_claim_idx'`);
    assert.match(claimIndex.rows[0].indexdef, /last_error_code IS NULL/u);

    const roleFacts = await admin.query(
      `SELECT
        rolowner.rolsuper,
        rolowner.rolbypassrls,
        has_table_privilege($1, 'platform_eventing.outbox_event', 'DELETE') AS can_delete,
        has_table_privilege($1, 'platform_eventing.outbox_event', 'INSERT') AS can_insert,
        has_column_privilege($1, 'platform_eventing.outbox_event', 'payload_json', 'UPDATE') AS can_update_payload,
        has_column_privilege($1, 'platform_eventing.outbox_event', 'lease_token', 'UPDATE') AS can_update_lease
      FROM pg_roles AS rolowner
      WHERE rolowner.rolname = $1`,
      [role],
    );
    assert.deepEqual(roleFacts.rows, [
      {
        rolsuper: false,
        rolbypassrls: false,
        can_delete: false,
        can_insert: false,
        can_update_payload: false,
        can_update_lease: true,
      },
    ]);

    for (const worker of [workerA, workerB]) await worker.query(`SET ROLE ${role}`);

    await seed(admin, event(eventId("1"), { aggregateVersion: 1n }));
    await seed(admin, event(eventId("2"), { aggregateVersion: 2n }));
    await seed(admin, event(eventId("3"), { aggregateId: aggregateB, aggregateVersion: 1n }));
    await seed(admin, event(eventId("4"), { tenantId: brandB }));
    await seed(admin, event(eventId("5"), { storeId: storeA, aggregateId: aggregateB }));

    const [first, second] = await Promise.all([
      claim(workerA, { brandId: brandA }, leaseId("1"), 1),
      claim(workerB, { brandId: brandA }, leaseId("2"), 1),
    ]);
    const concurrentlyClaimed = [...first, ...second].map((item) => item.envelope.eventId);
    assert.equal(new Set(concurrentlyClaimed).size, concurrentlyClaimed.length);
    assert.equal(concurrentlyClaimed.length, 2);
    assert(concurrentlyClaimed.includes(eventId("1")));
    assert(concurrentlyClaimed.includes(eventId("3")));
    assert(!concurrentlyClaimed.includes(eventId("2")));

    for (const item of [...first, ...second])
      await inScope(workerA, { brandId: brandA }, (transaction) =>
        markOutboxPublished(transaction, {
          eventId: item.envelope.eventId,
          leaseToken: item.leaseToken,
        }),
      );

    const nextAggregate = await claim(workerA, { brandId: brandA }, leaseId("3"), 25);
    assert.deepEqual(
      nextAggregate.map((item) => item.envelope.eventId),
      [eventId("2")],
    );
    assert.equal(nextAggregate[0].attemptCount, 1);

    await inScope(workerA, { brandId: brandA }, (transaction) =>
      markOutboxFailed(transaction, {
        errorCode: "TRANSPORT_REJECTED",
        eventId: eventId("2"),
        leaseToken: leaseId("3"),
      }),
    );
    assert.deepEqual(await claim(workerA, { brandId: brandA }, leaseId("4")), []);

    const brandBClaim = await claim(workerA, { brandId: brandB }, leaseId("5"));
    assert.deepEqual(
      brandBClaim.map((item) => ({
        eventId: item.envelope.eventId,
        tenantId: item.envelope.tenantId,
      })),
      [{ eventId: eventId("4"), tenantId: brandB }],
    );
    assert.deepEqual(await claim(workerA, { brandId: brandA }, leaseId("6")), []);
    const storeClaim = await claim(workerA, { brandId: brandA, storeId: storeA }, leaseId("7"));
    assert.deepEqual(
      storeClaim.map((item) => item.envelope.eventId),
      [eventId("5")],
    );

    await seed(admin, event(eventId("6"), { aggregateId: "018f1f48-7b5d-7cc7-8a1b-123456789abc" }));
    const crashed = await claim(workerA, { brandId: brandA }, leaseId("8"), 1, 1);
    assert.deepEqual(
      crashed.map((item) => item.envelope.eventId),
      [eventId("6")],
    );
    await admin.query(
      `UPDATE platform_eventing.outbox_event
      SET lease_expires_at = statement_timestamp() - interval '1 second'
      WHERE event_id = $1`,
      [eventId("6")],
    );
    const recovered = await claim(workerB, { brandId: brandA }, leaseId("9"), 1, 30);
    assert.equal(recovered[0].attemptCount, 2);
    const stale = await inScope(workerA, { brandId: brandA }, (transaction) =>
      markOutboxPublished(transaction, {
        eventId: eventId("6"),
        leaseToken: leaseId("8"),
      }),
    );
    assert.equal(stale, "lost_lease");
    const recoveredCompletion = await inScope(workerB, { brandId: brandA }, (transaction) =>
      markOutboxPublished(transaction, {
        eventId: eventId("6"),
        leaseToken: leaseId("9"),
      }),
    );
    assert.equal(recoveredCompletion, "completed");

    const duplicateWindowDeliveries = [eventId("6"), eventId("6")];
    assert.equal(duplicateWindowDeliveries.length, 2);
    assert.equal(new Set(duplicateWindowDeliveries).size, 1);
    const retained = await admin.query(
      `SELECT count(*)::integer AS count, published_at IS NOT NULL AS published
      FROM platform_eventing.outbox_event
      WHERE event_id = $1
      GROUP BY published_at`,
      [eventId("6")],
    );
    assert.deepEqual(retained.rows, [{ count: 1, published: true }]);

    await workerA.query("RESET ROLE");
    const missingContext = await workerA.query(
      "SELECT count(*)::integer AS count FROM platform_eventing.outbox_event",
    );
    assert(missingContext.rows[0].count > 0);
    await workerA.query(`SET ROLE ${role}`);
    const resetContext = await workerA.query(
      "SELECT count(*)::integer AS count FROM platform_eventing.outbox_event",
    );
    assert.deepEqual(resetContext.rows, [{ count: 0 }]);
  } finally {
    for (const client of [workerA, workerB]) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
    }
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await Promise.all([admin.end(), workerA.end(), workerB.end()]);
  }
}

it("proves the WP-0031 leased dispatcher concurrency, fencing, ordering and RLS contract", async () => {
  await withIsolatedDatabase({ caseId: "dispatcher", root }, proveDispatcher);
}, 180_000);
