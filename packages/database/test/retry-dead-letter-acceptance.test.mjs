import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  appendEventInTransaction,
  applyDeadLetterCommand,
  claimConsumerRetryBatch,
  claimOutboxBatch,
  completeConsumerRetry,
  markOutboxFailed,
  markOutboxPublished,
  recordConsumerFailureDecision,
  recordOutboxFailureDecision,
  resolveDeadLetter,
  resolveRetry,
  scheduleParkedOutboxBatch,
} from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const brandA = "018f1f48-7b5d-7001-8a1b-123456789abc";
const brandB = "018f1f48-7b5d-7002-8a1b-123456789abc";
const storeA = "018f1f48-7b5d-7003-8a1b-123456789abc";
const storeB = "018f1f48-7b5d-7007-8a1b-123456789abc";
const aggregateA = "018f1f48-7b5d-7004-8a1b-123456789abc";
const correlationId = "018f1f48-7b5d-7005-8a1b-123456789abc";
const actorId = "018f1f48-7b5d-7006-8a1b-123456789abc";
const secretSentinel = "wp0033-secret-payment-health-canary";
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
    occurredAt: new Date().toISOString(),
    producerModule: "@bop/eventing",
    tenantId: brandA,
    aggregateType: "SyntheticAggregate",
    aggregateId: aggregateA,
    aggregateVersion: 1n,
    correlationId,
    actor: { type: "System" },
    payload: { secret: secretSentinel },
    redactionClassification: "credential",
    replayMetadata: {},
    ...overrides,
  };
}

async function inScope(client, scope, action) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [scope.brandId]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [scope.storeId ?? ""]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function seed(client, envelope) {
  return await inScope(
    client,
    {
      brandId: envelope.tenantId,
      ...(envelope.storeId ? { storeId: envelope.storeId } : {}),
    },
    (transaction) => appendEventInTransaction(transaction, envelope),
  );
}

function retryResolution(code, attempt = 1, random = 0) {
  const now = new Date();
  return resolveRetry({
    actualAttemptNumber: attempt,
    firstAttemptAt: new Date(now.getTime() - 1_000).toISOString(),
    now: now.toISOString(),
    path: code.startsWith("TRANSPORT") ? "outbox" : "consumer",
    random,
    safeCode: code,
  });
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const first = new Client(context.clientConfig);
  const second = new Client(context.clientConfig);
  const role = `bop_wp0033_${context.runId}`;
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  try {
    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA platform_eventing, platform_helpers TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION
      platform_helpers.is_uuid_v7(uuid),
      platform_helpers.current_brand_id(),
      platform_helpers.current_store_id()
      TO ${role}`);
    await admin.query(`GRANT SELECT ON TABLE
      platform_eventing.outbox_event,
      platform_eventing.delivery_attempt,
      platform_eventing.consumer_retry_schedule,
      platform_eventing.dead_letter_item,
      platform_eventing.dead_letter_action
      TO ${role}`);
    await admin.query(`GRANT INSERT ON TABLE
      platform_eventing.delivery_attempt,
      platform_eventing.consumer_retry_schedule,
      platform_eventing.dead_letter_item,
      platform_eventing.dead_letter_action
      TO ${role}`);
    await admin.query(`GRANT UPDATE (
      available_at,
      last_error_code,
      ordering_released_at,
      lease_token,
      lease_owner,
      lease_expires_at,
      attempt_count,
      published_at
    ) ON TABLE platform_eventing.outbox_event TO ${role}`);
    await admin.query(`GRANT UPDATE ON TABLE
      platform_eventing.consumer_retry_schedule,
      platform_eventing.dead_letter_item
      TO ${role}`);
    await Promise.all([first.query(`SET ROLE ${role}`), second.query(`SET ROLE ${role}`)]);

    const acl = await admin.query(
      `SELECT
        rol.rolsuper,
        rol.rolbypassrls,
        has_table_privilege($1, 'platform_eventing.delivery_attempt', 'UPDATE,DELETE') AS attempt_mutation,
        has_table_privilege($1, 'platform_eventing.dead_letter_action', 'UPDATE,DELETE') AS action_mutation,
        has_table_privilege('public', 'platform_eventing.dead_letter_item', 'SELECT,INSERT,UPDATE,DELETE') AS public_access
       FROM pg_roles AS rol
       WHERE rol.rolname = $1`,
      [role],
    );
    assert.deepEqual(acl.rows, [
      {
        rolsuper: false,
        rolbypassrls: false,
        attempt_mutation: false,
        action_mutation: false,
        public_access: false,
      },
    ]);

    assert.deepEqual(
      (
        await first.query(
          "SELECT count(*)::integer AS count FROM platform_eventing.dead_letter_item",
        )
      ).rows,
      [{ count: 0 }],
    );

    const retryEvent = event(nextId(), { aggregateId: nextId() });
    await seed(admin, retryEvent);
    const claimed = await inScope(first, { brandId: brandA }, (transaction) =>
      claimOutboxBatch(transaction, {
        batchSize: 1,
        leaseDurationSeconds: 30,
        leaseOwner: "retry_acceptance",
        leaseToken: nextId(),
      }),
    );
    assert.equal(claimed.length, 1);
    await inScope(first, { brandId: brandA }, (transaction) =>
      markOutboxFailed(transaction, {
        eventId: retryEvent.eventId,
        leaseToken: claimed[0].leaseToken,
        errorCode: "TRANSPORT_TIMEOUT",
      }),
    );
    const outboxRetryInput = {
      attemptId: nextId(),
      attemptNumber: 1,
      brandId: brandA,
      eventId: retryEvent.eventId,
      idempotencyKey: nextId(),
      safeCode: "TRANSPORT_TIMEOUT",
      resolution: retryResolution("TRANSPORT_TIMEOUT", 1, 0.999),
      deadLetterId: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordOutboxFailureDecision(transaction, outboxRetryInput),
      ),
      { status: "applied" },
    );
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        claimOutboxBatch(transaction, {
          batchSize: 1,
          leaseDurationSeconds: 30,
          leaseOwner: "retry_acceptance",
          leaseToken: nextId(),
        }),
      ),
      [],
    );
    await admin.query(
      "UPDATE platform_eventing.outbox_event SET available_at = statement_timestamp() WHERE event_id = $1",
      [retryEvent.eventId],
    );
    assert.equal(
      (
        await inScope(first, { brandId: brandA }, (transaction) =>
          claimOutboxBatch(transaction, {
            batchSize: 1,
            leaseDurationSeconds: 30,
            leaseOwner: "retry_acceptance",
            leaseToken: nextId(),
          }),
        )
      )[0].attemptCount,
      2,
    );

    const concurrentParked = [
      event(nextId(), { aggregateId: nextId() }),
      event(nextId(), { aggregateId: nextId() }),
    ];
    for (const parked of concurrentParked) await seed(admin, parked);
    await admin.query(
      `UPDATE platform_eventing.outbox_event
       SET attempt_count = 1, last_error_code = 'TRANSPORT_TIMEOUT'
       WHERE event_id = ANY($1::uuid[])`,
      [concurrentParked.map((item) => item.eventId)],
    );
    const schedulerNow = new Date(Date.now() + 1_000).toISOString();
    const schedule = (client) =>
      inScope(client, { brandId: brandA }, (transaction) =>
        scheduleParkedOutboxBatch(transaction, {
          batchSize: 25,
          now: schedulerNow,
          random: () => 0,
          identities: () => ({
            attemptId: nextId(),
            deadLetterId: nextId(),
            idempotencyKey: nextId(),
          }),
        }),
      );
    const schedulerResults = await Promise.all([schedule(first), schedule(second)]);
    assert.equal(schedulerResults.flat().length, 2);
    assert.equal(
      (
        await admin.query(
          `SELECT count(DISTINCT event_id)::integer AS count
           FROM platform_eventing.delivery_attempt
           WHERE event_id = ANY($1::uuid[])`,
          [concurrentParked.map((item) => item.eventId)],
        )
      ).rows[0].count,
      2,
    );
    await admin.query(
      `UPDATE platform_eventing.outbox_event
       SET published_at = statement_timestamp()
       WHERE event_id = ANY($1::uuid[])`,
      [concurrentParked.map((item) => item.eventId)],
    );

    const operatorRetryEvent = event(nextId(), { aggregateId: nextId() });
    await seed(admin, operatorRetryEvent);
    await admin.query(
      `UPDATE platform_eventing.outbox_event
       SET attempt_count = 1, last_error_code = 'TRANSPORT_REJECTED'
       WHERE event_id = $1`,
      [operatorRetryEvent.eventId],
    );
    const operatorRetryDecision = {
      attemptId: nextId(),
      attemptNumber: 1,
      brandId: brandA,
      eventId: operatorRetryEvent.eventId,
      idempotencyKey: nextId(),
      safeCode: "TRANSPORT_REJECTED",
      resolution: retryResolution("TRANSPORT_REJECTED"),
      deadLetterId: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordOutboxFailureDecision(transaction, operatorRetryDecision),
      ),
      { status: "applied", deadLetterId: operatorRetryDecision.deadLetterId },
    );
    const retryCommand = {
      deadLetterId: operatorRetryDecision.deadLetterId,
      brandId: brandA,
      actorId,
      permission: "EVENTING_DEAD_LETTER_RETRY",
      purpose: "RELIABILITY_RECOVERY",
      reason: "TRANSIENT_RECOVERED",
      expectedVersion: 0n,
      idempotencyKey: nextId(),
      actionId: nextId(),
    };
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        applyDeadLetterCommand(transaction, "retry", retryCommand),
      ),
      "applied",
    );
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        applyDeadLetterCommand(transaction, "retry", retryCommand),
      ),
      "already_applied",
    );
    const operatorRetryClaim = await inScope(first, { brandId: brandA }, (transaction) =>
      claimOutboxBatch(transaction, {
        batchSize: 1,
        leaseDurationSeconds: 30,
        leaseOwner: "retry_acceptance",
        leaseToken: nextId(),
      }),
    );
    assert.equal(operatorRetryClaim[0].envelope.eventId, operatorRetryEvent.eventId);
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        markOutboxPublished(transaction, {
          eventId: operatorRetryEvent.eventId,
          leaseToken: operatorRetryClaim[0].leaseToken,
        }),
      ),
      "completed",
    );
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        resolveDeadLetter(transaction, "retry_completed", {
          ...retryCommand,
          expectedVersion: 1n,
          idempotencyKey: nextId(),
          actionId: nextId(),
        }),
      ),
      "applied",
    );

    const consumerEvent = event(nextId(), { aggregateId: nextId() });
    await seed(admin, consumerEvent);
    const consumerInput = {
      attemptId: nextId(),
      scheduleId: nextId(),
      attemptNumber: 1,
      brandId: brandA,
      eventId: consumerEvent.eventId,
      consumerName: "synthetic.projector:v1",
      idempotencyKey: nextId(),
      safeCode: "CONSUMER_TEMPORARY_FAILURE",
      resolution: retryResolution("CONSUMER_TEMPORARY_FAILURE"),
      deadLetterId: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordConsumerFailureDecision(transaction, consumerInput),
      ),
      { status: "applied" },
    );
    await admin.query(
      "UPDATE platform_eventing.outbox_event SET published_at = statement_timestamp() WHERE event_id = $1",
      [consumerEvent.eventId],
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT count(*)::integer AS count FROM platform_eventing.consumer_inbox WHERE event_id = $1",
          [consumerEvent.eventId],
        )
      ).rows,
      [{ count: 0 }],
    );
    const leaseTokenA = nextId();
    const leaseTokenB = nextId();
    const now = new Date().toISOString();
    const [consumerClaimA, consumerClaimB] = await Promise.all([
      inScope(first, { brandId: brandA }, (transaction) =>
        claimConsumerRetryBatch(transaction, {
          batchSize: 25,
          leaseDurationSeconds: 30,
          leaseOwner: "retry_worker_a",
          leaseToken: leaseTokenA,
          now,
        }),
      ),
      inScope(second, { brandId: brandA }, (transaction) =>
        claimConsumerRetryBatch(transaction, {
          batchSize: 25,
          leaseDurationSeconds: 30,
          leaseOwner: "retry_worker_b",
          leaseToken: leaseTokenB,
          now,
        }),
      ),
    ]);
    const consumerClaims = [...consumerClaimA, ...consumerClaimB];
    assert.equal(consumerClaims.length, 1);
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        completeConsumerRetry(transaction, {
          scheduleId: consumerClaims[0].scheduleId,
          leaseToken: consumerClaims[0].leaseToken,
          expectedVersion: consumerClaims[0].version,
          outcome: "completed",
        }),
      ),
      "completed",
    );

    const expiredEventId = nextId();
    const expiredScheduleId = nextId();
    const expiredInput = {
      attemptId: nextId(),
      scheduleId: expiredScheduleId,
      attemptNumber: 1,
      brandId: brandA,
      eventId: expiredEventId,
      consumerName: "synthetic.projector:v1",
      idempotencyKey: nextId(),
      safeCode: "CONSUMER_TEMPORARY_FAILURE",
      resolution: retryResolution("CONSUMER_TEMPORARY_FAILURE"),
      deadLetterId: nextId(),
    };
    await inScope(first, { brandId: brandA }, (transaction) =>
      recordConsumerFailureDecision(transaction, expiredInput),
    );
    await admin.query(
      `UPDATE platform_eventing.consumer_retry_schedule
       SET available_at = statement_timestamp() - interval '2 seconds',
           deadline_at = statement_timestamp() - interval '1 second'
       WHERE schedule_id = $1`,
      [expiredScheduleId],
    );
    const expiredClaims = await inScope(first, { brandId: brandA }, (transaction) =>
      claimConsumerRetryBatch(transaction, {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: "retry_worker_expiry",
        leaseToken: nextId(),
        now: new Date().toISOString(),
      }),
    );
    assert.equal(expiredClaims.length, 1);
    const expiryNow = new Date();
    const exhaustedInput = {
      ...expiredInput,
      attemptId: nextId(),
      idempotencyKey: nextId(),
      deadLetterId: nextId(),
      resolution: resolveRetry({
        actualAttemptNumber: expiredClaims[0].attemptCount,
        firstAttemptAt: new Date(expiryNow.getTime() - 86_400_001).toISOString(),
        now: expiryNow.toISOString(),
        path: "consumer",
        random: 0,
        safeCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordConsumerFailureDecision(transaction, exhaustedInput),
      ),
      { status: "applied", deadLetterId: exhaustedInput.deadLetterId },
    );

    const storeConsumerInput = {
      ...consumerInput,
      attemptId: nextId(),
      scheduleId: nextId(),
      eventId: nextId(),
      storeId: storeA,
      idempotencyKey: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA, storeId: storeA }, (transaction) =>
        recordConsumerFailureDecision(transaction, storeConsumerInput),
      ),
      { status: "applied" },
    );
    assert.equal(
      await inScope(first, { brandId: brandA }, async (transaction) => {
        const result = await transaction.query(
          "SELECT count(*)::integer AS count FROM platform_eventing.delivery_attempt WHERE event_id = $1",
          [storeConsumerInput.eventId],
        );
        return result.rows[0].count;
      }),
      0,
    );
    await assert.rejects(
      inScope(first, { brandId: brandA, storeId: storeB }, (transaction) =>
        recordConsumerFailureDecision(transaction, {
          ...storeConsumerInput,
          attemptId: nextId(),
          scheduleId: nextId(),
          eventId: nextId(),
          idempotencyKey: nextId(),
        }),
      ),
      /row-level security/u,
    );

    const unknownInput = {
      ...consumerInput,
      attemptId: nextId(),
      scheduleId: nextId(),
      eventId: nextId(),
      idempotencyKey: nextId(),
      safeCode: "COMMIT_OUTCOME_UNKNOWN",
      resolution: retryResolution("COMMIT_OUTCOME_UNKNOWN"),
      deadLetterId: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordConsumerFailureDecision(transaction, unknownInput),
      ),
      { status: "applied" },
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::integer AS count FROM platform_eventing.consumer_retry_schedule WHERE event_id = $1",
          [unknownInput.eventId],
        )
      ).rows[0].count,
      1,
    );

    const validationInput = {
      ...consumerInput,
      attemptId: nextId(),
      scheduleId: nextId(),
      attemptNumber: 0,
      eventId: nextId(),
      idempotencyKey: nextId(),
      safeCode: "EVENT_SCHEMA_VERSION_UNSUPPORTED",
      resolution: retryResolution("EVENT_SCHEMA_VERSION_UNSUPPORTED", 0),
      deadLetterId: nextId(),
    };
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordConsumerFailureDecision(transaction, validationInput),
      ),
      { status: "applied", deadLetterId: validationInput.deadLetterId },
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT
            (SELECT attempt_number FROM platform_eventing.delivery_attempt WHERE event_id = $1) AS attempt_number,
            (SELECT count(*)::integer FROM platform_eventing.consumer_retry_schedule WHERE event_id = $1) AS schedule_count`,
          [validationInput.eventId],
        )
      ).rows,
      [{ attempt_number: 0, schedule_count: 0 }],
    );

    const head = event(nextId(), { aggregateVersion: 10n });
    const tail = event(nextId(), { aggregateVersion: 11n });
    await seed(admin, head);
    await seed(admin, tail);
    await admin.query(
      `UPDATE platform_eventing.outbox_event
       SET attempt_count = 8, last_error_code = 'TRANSPORT_UNAVAILABLE'
       WHERE event_id = $1`,
      [head.eventId],
    );
    const terminalInput = {
      attemptId: nextId(),
      attemptNumber: 8,
      brandId: brandA,
      eventId: head.eventId,
      idempotencyKey: nextId(),
      safeCode: "TRANSPORT_UNAVAILABLE",
      resolution: retryResolution("TRANSPORT_UNAVAILABLE", 8),
      deadLetterId: nextId(),
    };
    const terminal = await inScope(first, { brandId: brandA }, (transaction) =>
      recordOutboxFailureDecision(transaction, terminalInput),
    );
    assert.deepEqual(terminal, {
      status: "applied",
      deadLetterId: terminalInput.deadLetterId,
    });
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        recordOutboxFailureDecision(transaction, terminalInput),
      ),
      { status: "already_applied", deadLetterId: terminalInput.deadLetterId },
    );
    await assert.rejects(
      inScope(first, { brandId: brandB }, (transaction) =>
        transaction.query(
          `INSERT INTO platform_eventing.dead_letter_action (
            action_id, dead_letter_id, brand_id, store_id, action, actor_id,
            permission_code, purpose_code, reason_code, expected_version, idempotency_key
          ) VALUES (
            $1, $2, $3, NULL, 'retry', $4,
            'EVENTING_DEAD_LETTER_RETRY', 'RELIABILITY_RECOVERY',
            'TRANSIENT_RECOVERED', 0, $5
          )`,
          [nextId(), terminalInput.deadLetterId, brandB, actorId, nextId()],
        ),
      ),
      /foreign key/u,
    );
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        claimOutboxBatch(transaction, {
          batchSize: 25,
          leaseDurationSeconds: 30,
          leaseOwner: "retry_acceptance",
          leaseToken: nextId(),
        }),
      ),
      [],
    );

    const discardCommand = {
      deadLetterId: terminalInput.deadLetterId,
      brandId: brandA,
      actorId,
      permission: "EVENTING_DEAD_LETTER_DISCARD",
      purpose: "RELIABILITY_RECOVERY",
      reason: "AUTHORIZED_DISCARD",
      expectedVersion: 0n,
      idempotencyKey: nextId(),
      actionId: nextId(),
    };
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        applyDeadLetterCommand(transaction, "discard", discardCommand),
      ),
      "applied",
    );
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        applyDeadLetterCommand(transaction, "discard", discardCommand),
      ),
      "already_applied",
    );
    assert.deepEqual(
      await inScope(first, { brandId: brandA }, (transaction) =>
        claimOutboxBatch(transaction, {
          batchSize: 25,
          leaseDurationSeconds: 30,
          leaseOwner: "retry_acceptance",
          leaseToken: nextId(),
        }),
      ),
      [],
    );
    const releaseCommand = {
      ...discardCommand,
      reason: "ORDERING_RELEASE",
      expectedVersion: 1n,
      idempotencyKey: nextId(),
      actionId: nextId(),
    };
    assert.equal(
      await inScope(first, { brandId: brandA }, (transaction) =>
        resolveDeadLetter(transaction, "discard_released", releaseCommand),
      ),
      "applied",
    );
    const released = await inScope(first, { brandId: brandA }, (transaction) =>
      claimOutboxBatch(transaction, {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: "retry_acceptance",
        leaseToken: nextId(),
      }),
    );
    assert.deepEqual(
      released.map((item) => item.envelope.eventId),
      [tail.eventId],
    );

    assert.equal(
      await inScope(first, { brandId: brandB }, (transaction) =>
        recordOutboxFailureDecision(transaction, {
          ...terminalInput,
          brandId: brandB,
          attemptId: nextId(),
          idempotencyKey: nextId(),
        }),
      ).then((result) => result.status),
      "conflict",
    );

    const metadata = await admin.query(`SELECT
      (SELECT string_agg(to_jsonb(attempt.*)::text, '') FROM platform_eventing.delivery_attempt AS attempt) ||
      (SELECT string_agg(to_jsonb(dead_item.*)::text, '') FROM platform_eventing.dead_letter_item AS dead_item) ||
      (SELECT string_agg(to_jsonb(dead_action.*)::text, '') FROM platform_eventing.dead_letter_action AS dead_action)
      AS text`);
    assert(!metadata.rows[0].text.includes(secretSentinel));
    const columns = await admin.query(`SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'platform_eventing'
        AND table_name IN (
          'delivery_attempt',
          'consumer_retry_schedule',
          'dead_letter_item',
          'dead_letter_action'
        )`);
    assert(
      columns.rows.every(
        (row) =>
          !/(payload|result|exception|provider|payment|health|allergy|credential)/u.test(
            row.column_name,
          ),
      ),
    );
    const rls = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid IN (
        'platform_eventing.delivery_attempt'::regclass,
        'platform_eventing.consumer_retry_schedule'::regclass,
        'platform_eventing.dead_letter_item'::regclass,
        'platform_eventing.dead_letter_action'::regclass
      )
      ORDER BY relname`);
    assert(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  } finally {
    await Promise.all([
      first.query("ROLLBACK").catch(() => undefined),
      second.query("ROLLBACK").catch(() => undefined),
      first.query("RESET ROLE").catch(() => undefined),
      second.query("RESET ROLE").catch(() => undefined),
    ]);
    await Promise.all([first.end(), second.end()]);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("proves the complete WP-0033 retry and dead-letter acceptance matrix", async () => {
  await withIsolatedDatabase({ caseId: "retry_dead_letter", root }, prove);
}, 180_000);
