import {
  createPostgresPaymentTerminalSource,
  createPostgresPaymentTerminalStore,
  createPaymentTerminalService,
  createPostgresPaymentCompensationIdentityReader,
} from "../../rms/payment/src/index.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a006-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const occurredAt = "2026-08-03T18:00:00.000Z";

async function insertSource(client, offset, eventType) {
  const value = {
    intent: id(offset + 1),
    brand: id(2),
    store: id(3),
    operation: id(offset + 4),
    order: id(offset + 5),
    batch: id(offset + 6),
    submission: id(offset + 7),
    session: id(offset + 8),
    cart: id(offset + 9),
    quote: id(offset + 10),
    preparation: id(offset + 11),
    capacity: id(offset + 12),
    attempt: id(offset + 20),
    observation: id(offset + 21),
    receipt: id(offset + 22),
    account: id(30),
    event: `evt_SYNTHETIC${offset.toString().padStart(8, "0")}`,
  };
  await client.query(
    `INSERT INTO rms_payment.payment_intent
     (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,
      submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,
      capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,
      tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,
      creation_status,prepared_at,capacity_expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,1200,50,1250,'CAD',
      'OnlineCard','Automatic',1,'ProviderCreatePending','2026-08-03T17:59:00.000Z',
      '2026-08-03T18:30:00.000Z',$15)`,
    [
      value.intent,
      value.brand,
      value.store,
      value.operation,
      value.order,
      value.batch,
      value.submission,
      value.session,
      value.cart,
      value.quote,
      value.preparation,
      value.capacity,
      sha("a"),
      sha("b"),
      occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_attempt
     (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,
      provider_environment,provider_idempotency_digest,created_at)
     VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)`,
    [value.attempt, value.brand, value.store, value.intent, sha("c"), occurredAt],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_provider_observation
     (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
      observation_kind,normalized_status,provider_intent_reference,
      provider_transaction_reference,requested_minor,authorized_minor,captured_minor,
      refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at)
     VALUES ($1,$2,$3,$4,$5,'Snapshot',$6,$7,$8,1250,1250,$9,0,'CAD',$10,$11,$11)`,
    [
      value.observation,
      value.brand,
      value.store,
      value.intent,
      value.attempt,
      eventType === "payment_intent.succeeded" ? "Captured" : "Failed",
      `pi_SYNTHETIC_${offset}`,
      eventType === "payment_intent.succeeded" ? `ch_SYNTHETIC_${offset}` : null,
      eventType === "payment_intent.succeeded" ? 1250 : 0,
      sha("d"),
      occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.provider_webhook_record
     (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,
      provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,
      evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
     VALUES ($1,$2,$3,'Stripe','Test',$4,$5,$6,'2026-08-03T17:55:00.000Z',$7,
      '2026-08-03T17:59:59.000Z',$8,$7,'2026-09-02T18:00:00.000Z',
      '2026-11-01T18:00:00.000Z')`,
    [
      value.receipt,
      value.brand,
      value.store,
      value.account,
      value.event,
      eventType,
      occurredAt,
      sha("e"),
    ],
  );
  return value;
}

async function insertFact(client, value, outcome, transaction, event) {
  await client.query(
    `INSERT INTO rms_payment.payment_terminal_fact
     (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
      webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,
      provider_intent_reference,
      provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,
      failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook',$12,$13,$14,$15,$16,
      $17,$17,$18,$19,$20)`,
    [
      transaction,
      value.brand,
      value.store,
      value.intent,
      value.attempt,
      value.order,
      value.receipt,
      value.event,
      value.account,
      `pi_SYNTHETIC_${outcome === "Succeeded" ? 100 : 200}`,
      value.observation,
      outcome,
      outcome === "Succeeded" ? 1250 : null,
      outcome === "Succeeded" ? "CAD" : null,
      outcome === "Failed" ? "Declined" : null,
      outcome === "Failed" ? "NewOperation" : null,
      occurredAt,
      sha("f"),
      event,
      value.receipt,
    ],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relforcerowsecurity FROM pg_class
       WHERE oid='rms_payment.payment_terminal_fact'::regclass`,
    );
    assert.equal(forced.rows[0].relforcerowsecurity, true);

    const success = await insertSource(client, 100, "payment_intent.succeeded");
    const terminalSource = createPostgresPaymentTerminalSource(
      {
        async run(action) {
          await client.query("BEGIN");
          try {
            const result = await action(client);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      },
      {
        brandReference: success.brand,
        storeReference: success.store,
        providerAccountReference: success.account,
        environment: "Test",
      },
    );
    const observed = {
      observationReference: success.observation,
      causationReference: success.receipt,
      webhookReceiptReference: success.receipt,
      providerEventReference: success.event,
      providerAccountReference: success.account,
      providerIntentReference: "pi_SYNTHETIC_100",
      environment: "Test",
      paymentIntentReference: success.intent,
      paymentAttemptReference: success.attempt,
      brandReference: success.brand,
      storeReference: success.store,
      source: "VerifiedWebhook",
      status: "Captured",
      amount: { amountMinor: 1250n, currencyCode: "CAD" },
      failureReason: null,
      retryDisposition: null,
      occurredAt,
      evidenceDigest: sha("d"),
    };
    const resolved = await terminalSource.resolve(observed);
    assert.equal(resolved.orderReference, success.order);
    assert.equal(resolved.paymentOperationReference, success.operation);
    assert.equal(resolved.expectedAmount.amountMinor, 1250n);
    assert.equal(
      await terminalSource.resolve({
        ...observed,
        amount: { amountMinor: 1251n, currencyCode: "CAD" },
      }),
      null,
    );
    for (const mismatch of [
      { storeReference: id(999) },
      { brandReference: id(999) },
      { providerAccountReference: id(999) },
      { environment: "Live" },
      { observationReference: id(999) },
      { paymentAttemptReference: id(999) },
      { providerIntentReference: "pi_SYNTHETIC_OTHER" },
      { evidenceDigest: sha("a") },
      { occurredAt: "2026-08-03T18:00:00.001Z" },
      { webhookReceiptReference: id(999), causationReference: id(999) },
      { providerEventReference: "evt_SYNTHETICOTHER" },
    ])
      assert.equal(await terminalSource.resolve({ ...observed, ...mismatch }), null);
    assert.deepEqual(
      await terminalSource.resolve({
        ...observed,
        source: "ProviderRetrieval",
        causationReference: id(998),
        webhookReceiptReference: null,
        providerEventReference: null,
      }),
      resolved,
    );
    await insertFact(client, success, "Succeeded", id(140), id(141));
    const failed = await insertSource(client, 200, "payment_intent.payment_failed");
    await insertFact(client, failed, "Failed", id(240), id(241));

    const stored = await client.query(
      `SELECT terminal_outcome,amount_minor::text,currency_code,failure_reason,retry_disposition
       FROM rms_payment.payment_terminal_fact ORDER BY terminal_outcome`,
    );
    assert.deepEqual(stored.rows, [
      {
        terminal_outcome: "Failed",
        amount_minor: null,
        currency_code: null,
        failure_reason: "Declined",
        retry_disposition: "NewOperation",
      },
      {
        terminal_outcome: "Succeeded",
        amount_minor: "1250",
        currency_code: "CAD",
        failure_reason: null,
        retry_disposition: null,
      },
    ]);

    await assert.rejects(
      insertFact(client, success, "Succeeded", id(142), id(143)),
      /payment_terminal_fact_(?:intent|attempt|observation|receipt)_terminal_unique|payment_terminal_fact_intent_terminal_unique/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_terminal_fact
         (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
          webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,
          provider_intent_reference,
          provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,
          occurred_at,recorded_at,evidence_digest,event_id,causation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test','pi_SYNTHETIC_100',$10,'VerifiedWebhook',
          'Succeeded',1249,'CAD',$11,$11,$12,$13,$7)`,
        [
          id(144),
          success.brand,
          success.store,
          success.intent,
          success.attempt,
          success.order,
          success.receipt,
          success.event,
          success.account,
          success.observation,
          occurredAt,
          sha("f"),
          id(145),
        ],
      ),
      /payment_terminal_fact_/u,
    );

    await client.query(
      `UPDATE rms_payment.payment_terminal_fact SET amount_minor=9999
       WHERE payment_transaction_id=$1`,
      [id(140)],
    );
    await client.query(
      `DELETE FROM rms_payment.payment_terminal_fact WHERE payment_transaction_id=$1`,
      [id(140)],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT amount_minor::text FROM rms_payment.payment_terminal_fact
           WHERE payment_transaction_id=$1`,
          [id(140)],
        )
      ).rows,
      [{ amount_minor: "1250" }],
    );

    const grants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment' AND table_name='payment_terminal_fact'
         AND grantee='PUBLIC'`,
    );
    assert.equal(grants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("persists one append-only Store-scoped Payment terminal fact", async () => {
  await withIsolatedDatabase({ caseId: "payment_terminal", root }, prove);
}, 180_000);

it("atomically commits actual Payment terminal service, Audit and Outbox with replay and rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_terminal", root }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_terminal_" + env.runId;
    let failAudit = false,
      failOutbox = false,
      lose = false,
      sequence = 100000;
    const scope = {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(30),
      environment: "Test",
    };
    const runner = {
      async run(action) {
        const client = new Client(env.clientConfig);
        await client.connect();
        let committed = false,
          wrote = false;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          const result = await action({
            async query(sql, values) {
              if (sql.startsWith("INSERT INTO rms_payment.payment_terminal_fact")) wrote = true;
              if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
                throw Error("synthetic Audit failure");
              if (failOutbox && sql.startsWith("INSERT INTO platform_eventing.outbox_event"))
                throw Error("synthetic Outbox failure");
              return client.query(sql, [...values]);
            },
          });
          await client.query("COMMIT");
          committed = true;
          if (lose && wrote) {
            lose = false;
            throw Error("synthetic lost commit acknowledgement");
          }
          return result;
        } catch (error) {
          if (!committed) await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    const store = createPostgresPaymentTerminalStore(runner, scope);
    const service = createPaymentTerminalService({
      source: createPostgresPaymentTerminalSource(runner, scope),
      repository: store,
      clock: { now: () => occurredAt },
      references: { generate: () => id(++sequence) },
      audit: {
        create: async ({ fact, correlationReference }) => ({
          auditId: id(++sequence),
          brandId: fact.brandReference,
          storeId: fact.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_TERMINAL_RECORDED",
          targetType: "PaymentIntent",
          targetId: fact.paymentIntentReference,
          afterSummary: { outcome: fact.outcome },
          reasonCode: fact.outcome === "Succeeded" ? "PAYMENT_CAPTURED" : "PAYMENT_FAILED",
          correlationId: correlationReference,
          occurredAt: fact.recordedAt,
          sourceChannel:
            fact.source === "VerifiedWebhook" ? "PROVIDER_WEBHOOK" : "PAYMENT_RECONCILIATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      },
    });
    const observed = (v, offset, failed = false) => ({
      observationReference: v.observation,
      causationReference: v.receipt,
      webhookReceiptReference: v.receipt,
      providerEventReference: v.event,
      providerAccountReference: v.account,
      providerIntentReference: "pi_SYNTHETIC_" + offset,
      environment: "Test",
      paymentIntentReference: v.intent,
      paymentAttemptReference: v.attempt,
      brandReference: v.brand,
      storeReference: v.store,
      source: "VerifiedWebhook",
      status: failed ? "Failed" : "Captured",
      amount: failed ? null : { amountMinor: 1250n, currencyCode: "CAD" },
      failureReason: failed ? "Declined" : null,
      retryDisposition: failed ? "NewOperation" : null,
      occurredAt,
      evidenceDigest: sha("d"),
    });
    const counts = async (intent) => ({
      fact: (
        await admin.query(
          "SELECT count(*)::int AS n FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1",
          [intent],
        )
      ).rows[0].n,
      audit: (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE target_id=$1",
          [intent],
        )
      ).rows[0].n,
      event: (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE aggregate_id=$1",
          [intent],
        )
      ).rows[0].n,
    });
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_provider_observation,rms_payment.provider_webhook_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_terminal_fact,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const a = await insertSource(admin, 1000, "payment_intent.succeeded");
      const original = observed(a, 1000);
      const results = await Promise.all([service.record(original), service.record(original)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["AlreadyCommitted", "Created"]);
      assert.deepEqual(results[0].fact, results[1].fact);
      assert.deepEqual(await store.read(a.intent), results[0].fact);
      const identityRequest = {
        brandReference: a.brand,
        storeReference: a.store,
        orderReference: a.order,
        paymentIntentReference: a.intent,
        paymentAttemptReference: a.attempt,
        paymentTransactionReference: results[0].fact.paymentTransactionReference,
      };
      const identityReader = createPostgresPaymentCompensationIdentityReader({
        transactions: runner,
        scope,
        authorize: async () => true,
      });
      const identity = await identityReader(identityRequest);
      assert.ok(identity);
      assert.equal(identity.environment, "Test");
      assert.equal(identity.identityVersion, 1);
      assert.match(identity.identityDigest, /^sha256:[a-f0-9]{64}$/u);
      assert.deepEqual(await identityReader(identityRequest), identity);
      for (const field of [
        "orderReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "paymentTransactionReference",
      ])
        assert.equal(await identityReader({ ...identityRequest, [field]: id(99991) }), null);
      await assert.rejects(identityReader({ ...identityRequest, storeReference: id(99991) }), {
        code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
      });
      for (const limit of [0, 1]) {
        let count = 0;
        const denied = createPostgresPaymentCompensationIdentityReader({
          transactions: runner,
          scope,
          authorize: async () => ++count <= limit,
        });
        await assert.rejects(denied(identityRequest), {
          code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
        });
      }

      assert.deepEqual(await counts(a.intent), { fact: 1, audit: 1, event: 1 });
      await assert.rejects(
        service.record({
          ...original,
          source: "ProviderRetrieval",
          causationReference: id(99990),
          webhookReceiptReference: null,
          providerEventReference: null,
        }),
        { code: "PAYMENT_TERMINAL_OUTCOME_CONFLICT" },
      );
      assert.deepEqual(await counts(a.intent), { fact: 1, audit: 1, event: 1 });
      assert.equal(
        await createPostgresPaymentTerminalStore(runner, {
          ...scope,
          storeReference: id(99999),
        }).read(a.intent),
        null,
      );
      for (const [offset, failAt] of [
        [2000, "audit"],
        [3000, "outbox"],
      ]) {
        const value = await insertSource(admin, offset, "payment_intent.succeeded");
        failAudit = failAt === "audit";
        failOutbox = failAt === "outbox";
        await assert.rejects(service.record(observed(value, offset)), {
          code: "PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE",
        });
        assert.deepEqual(await counts(value.intent), { fact: 0, audit: 0, event: 0 });
        failAudit = false;
        failOutbox = false;
        assert.equal((await service.record(observed(value, offset))).status, "Created");
        assert.deepEqual(await counts(value.intent), { fact: 1, audit: 1, event: 1 });
      }
      const lost = await insertSource(admin, 4000, "payment_intent.succeeded");
      lose = true;
      await assert.rejects(service.record(observed(lost, 4000)), {
        code: "PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE",
      });
      const saved = await store.read(lost.intent);
      const recovered = await service.record(observed(lost, 4000));
      assert.equal(recovered.status, "AlreadyCommitted");
      assert.deepEqual(recovered.fact, saved);
      assert.deepEqual(await counts(lost.intent), { fact: 1, audit: 1, event: 1 });
      const failed = await insertSource(admin, 5000, "payment_intent.payment_failed");
      const failure = await service.record(observed(failed, 5000, true));
      assert.equal(failure.fact.event.eventType, "PaymentFailed");
      assert.equal(failure.fact.amount, null);
      assert.deepEqual(await counts(failed.intent), { fact: 1, audit: 1, event: 1 });
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
}, 180_000);
