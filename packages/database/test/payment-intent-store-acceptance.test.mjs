import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { createHash } from "node:crypto";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresPaymentIntentCreationStore,
  createPostgresAdmittedPaymentIntentCreationStore,
  createPaymentIntentCreationService,
  parsePaymentIntentCreationRecord,
} from "../../rms/payment/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (c) => "sha256:" + c.repeat(64);
it("claims actual Payment Intent/Attempt/Audit once and recovers normalized observations", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_payment_store" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_payment_store_" + env.runId;
    const scope = { brandReference: id(1), storeReference: id(2) };
    const at = new Date(Date.now() - 1000).toISOString();
    let now = at,
      sequence = 10000,
      active = 0,
      lose = false,
      failAudit = false,
      serviceAuthorized = true,
      revokeAfterCommit = false,
      expireAfterAudit = false,
      ownerDeadline = null;
    const runner = {
      async run(action) {
        const client = new Client(env.clientConfig);
        await client.connect();
        active++;
        let committed = false,
          wrote = false;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          const value = await action({
            query: async (sql, values) => {
              if (sql.startsWith("INSERT INTO rms_payment.")) wrote = true;
              if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
                throw new Error("synthetic Audit failure");
              const result = await client.query(sql, [...values]);
              if (expireAfterAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
                now = ownerDeadline;
              return result;
            },
          });
          await client.query("COMMIT");
          committed = true;
          if (revokeAfterCommit && wrote) {
            revokeAfterCommit = false;
            serviceAuthorized = false;
          }
          const context = await client.query(
            "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
          );
          assert([null, ""].includes(context.rows[0].brand));
          assert([null, ""].includes(context.rows[0].store));
          if (lose && wrote) {
            lose = false;
            throw new Error("synthetic lost acknowledgement");
          }
          return value;
        } catch (error) {
          if (!committed) await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      },
    };
    let admissionCalls = 0,
      admissionDenied = false,
      expireDuringAdmission = false;
    const store = createPostgresAdmittedPaymentIntentCreationStore(
      runner,
      scope,
      {
        now: () => now,
        generateObservationReference: () => id(++sequence),
      },
      {
        async admit(tx, record) {
          admissionCalls++;
          const rows = await tx.query(
            "SELECT count(*)::int AS n FROM rms_payment.payment_intent WHERE payment_operation_id=$1",
            [record.intent.paymentOperationReference],
          );
          assert.equal(rows.rows[0].n, 0, "admission must precede new Payment writes");
          if (admissionDenied) {
            await appendAuditRecordInTransaction(tx, {
              ...fixture(900).audit,
              actionCode: "SYNTHETIC_ADMISSION",
              auditId: id(9999),
            });
            return false;
          }
          if (expireDuringAdmission) now = record.intent.preparation.capacityExpiresAt;
          // Simulate another owner clearing Store context; Payment must restore its own scope.
          await tx.query("SELECT set_config('bop.store_id','',true)", []);
          return ownerDeadline === null ? true : { validUntil: ownerDeadline };
        },
      },
    );
    const fixture = (n, createdAt = at) => {
      const money = (v) => ({ amountMinor: v, currencyCode: "CAD" });
      const record = parsePaymentIntentCreationRecord({
        intent: {
          paymentIntentReference: id(n + 1),
          paymentOperationReference: id(n + 2),
          intentDigest: sha("a"),
          preparation: {
            preparationReference: id(n + 3),
            orderReference: id(n + 4),
            orderBatchReference: id(n + 5),
            submissionReference: id(n + 6),
            sourceCartReference: id(n + 7),
            sourceCartVersion: 1,
            ...scope,
            guestSessionReference: id(n + 8),
            quoteReference: id(n + 9),
            capacityAllocationReference: id(n + 10),
            readiness: "PaymentPending",
            transactionBoundary: "OrderSubmissionPaymentPreparation",
            orderAllocation: money(9007199254740993n),
            tip: money(175n),
            total: money(9007199254741168n),
            committedAt: createdAt,
            capacityExpiresAt: new Date(Date.parse(createdAt) + 1800000).toISOString(),
            sourceDigest: sha("b"),
          },
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          aggregateVersion: 1,
          creationStatus: "ProviderCreatePending",
          createdAt,
        },
        attempt: {
          paymentAttemptReference: id(n + 11),
          paymentIntentReference: id(n + 1),
          attemptNumber: 1,
          provider: "Stripe",
          providerEnvironment: "Test",
          providerIdempotencyDigest: sha("c"),
          createdAt,
        },
        providerOutcome: null,
      });
      return {
        record,
        audit: {
          auditId: id(n + 12),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_INTENT_CREATE",
          targetType: "PaymentIntent",
          targetId: record.intent.paymentIntentReference,
          reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
          occurredAt: createdAt,
          correlationId: id(n + 13),
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        },
      };
    };
    const outcome = (record) => ({
      kind: "Failure",
      context: {
        provider: "Stripe",
        environment: "Test",
        ...scope,
        paymentAttemptReference: record.attempt.paymentAttemptReference,
        operationReference: record.intent.paymentOperationReference,
      },
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "CREATE_RESULT_UNKNOWN",
    });
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent) AS intents,(SELECT count(*)::int FROM rms_payment.payment_attempt) AS attempts,(SELECT count(*)::int FROM rms_payment.payment_intent_operation_record) AS operations,(SELECT count(*)::int FROM platform_audit.audit_record) AS audits,(SELECT count(*)::int FROM rms_payment.payment_provider_observation) AS observations",
        )
      ).rows[0];
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_intent_operation_record,rms_payment.payment_provider_observation,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      admissionDenied = true;
      await assert.rejects(store.claim(fixture(900)), { code: "PAYMENT_INTENT_PERMISSION_DENIED" });
      admissionDenied = false;
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE audit_id=$1",
            [id(9999)],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(await store.resolveOperation(id(902)), null);
      expireDuringAdmission = true;
      await assert.rejects(store.claim(fixture(950)), {
        code: "PAYMENT_INTENT_PREPARATION_EXPIRED",
      });
      expireDuringAdmission = false;
      now = at;
      assert.equal(await store.resolveOperation(id(952)), null);
      ownerDeadline = new Date(Date.parse(at) + 1).toISOString();
      await assert.rejects(store.claim(fixture(1000)), {
        code: "PAYMENT_INTENT_PREPARATION_EXPIRED",
      });
      assert.equal(await store.resolveOperation(id(1002)), null);
      ownerDeadline = new Date(Date.parse(at) + 60000).toISOString();
      expireAfterAudit = true;
      const deadlineFixture = fixture(1100);
      await assert.rejects(store.claim(deadlineFixture), {
        code: "PAYMENT_INTENT_PREPARATION_EXPIRED",
      });
      expireAfterAudit = false;
      now = at;
      for (const [table, column, reference] of [
        [
          "payment_intent",
          "payment_intent_id",
          deadlineFixture.record.intent.paymentIntentReference,
        ],
        [
          "payment_attempt",
          "payment_attempt_id",
          deadlineFixture.record.attempt.paymentAttemptReference,
        ],
        [
          "payment_intent_operation_record",
          "payment_operation_id",
          deadlineFixture.record.intent.paymentOperationReference,
        ],
      ]) {
        const result = await admin.query(
          "SELECT count(*)::int AS n FROM rms_payment." + table + " WHERE " + column + "=$1",
          [reference],
        );
        assert.equal(result.rows[0].n, 0);
      }
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE audit_id=$1",
            [deadlineFixture.audit.auditId],
          )
        ).rows[0].n,
        0,
      );
      ownerDeadline = null;

      const f = fixture(100);
      // Receipt enumeration and new intent creation must share the Order fence.
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReceiptOrder:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            f.record.intent.preparation.orderReference,
        ]);
        let blockedAdmissionReached = false;
        const blocked = createPostgresAdmittedPaymentIntentCreationStore(
          {
            run: (work) =>
              runner.run(async (tx) => {
                await tx.query("SET LOCAL lock_timeout='100ms'", []);
                return work(tx);
              }),
          },
          scope,
          { now: () => now, generateObservationReference: () => id(++sequence) },
          {
            admit: async () => {
              blockedAdmissionReached = true;
              throw new Error("receipt fence must precede admission");
            },
          },
        );
        await assert.rejects(blocked.claim(f), { code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
        assert.equal(blockedAdmissionReached, false);
        assert.equal((await counts()).intents, 0);
      } finally {
        await admin.query("ROLLBACK");
      }

      const rival = {
        record: {
          ...f.record,
          intent: { ...f.record.intent, paymentIntentReference: id(500) },
          attempt: {
            ...f.record.attempt,
            paymentAttemptReference: id(501),
            paymentIntentReference: id(500),
            providerIdempotencyDigest: sha("d"),
          },
        },
        audit: { ...f.audit, auditId: id(502), targetId: id(500) },
      };
      const results = await Promise.all([store.claim(f), store.claim(rival)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["Claimed", "Existing"]);
      assert.deepEqual(results[0].record, results[1].record);
      ownerDeadline = at;
      const checksBeforeExpiredRecovery = admissionCalls;
      assert.equal((await store.claim(f)).status, "Existing");
      assert.equal(admissionCalls, checksBeforeExpiredRecovery);
      ownerDeadline = null;
      const original = results[0].record;
      assert.equal(original.intent.preparation.total.amountMinor, 9007199254741168n);
      assert.deepEqual(await counts(), {
        intents: 1,
        attempts: 1,
        operations: 1,
        audits: 1,
        observations: 0,
      });
      await assert.rejects(
        store.claim({
          ...f,
          record: { ...f.record, intent: { ...f.record.intent, intentDigest: sha("f") } },
        }),
      );
      failAudit = true;
      await assert.rejects(store.claim(fixture(200)));
      failAudit = false;
      assert.deepEqual(await counts(), {
        intents: 1,
        attempts: 1,
        operations: 1,
        audits: 1,
        observations: 0,
      });
      assert.equal(await store.resolveOperation(id(202)), null);
      lose = true;
      const second = fixture(300);
      await assert.rejects(store.claim(second), { code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await store.resolveOperation(id(302)), second.record);
      const admissionsBeforeRecovery = admissionCalls;
      admissionDenied = true;
      assert.equal((await store.claim(second)).status, "Existing");
      admissionDenied = false;
      assert.equal(admissionCalls, admissionsBeforeRecovery);
      const unknown = { ...original, providerOutcome: outcome(original) };
      lose = true;
      await assert.rejects(store.recordObservation({ record: unknown }), {
        code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(
        await store.resolveOperation(original.intent.paymentOperationReference),
        unknown,
      );
      assert.deepEqual(await store.recordObservation({ record: unknown }), unknown);
      await assert.rejects(
        store.recordObservation({
          record: {
            ...unknown,
            providerOutcome: {
              ...unknown.providerOutcome,
              code: "Declined",
              retryDisposition: "Never",
            },
          },
        }),
      );
      const snapshot = {
        ...second.record,
        providerOutcome: {
          kind: "Snapshot",
          context: outcome(second.record).context,
          providerIntentReference: "pi_SYNTHETIC_WP2402",
          providerTransactionReference: null,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          status: "RequiresCustomerAction",
          requestedAmount: second.record.intent.preparation.total,
          authorizedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          capturedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          refundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          observedAt: at,
          evidenceDigest: sha("e"),
        },
      };
      assert.deepEqual(await store.recordObservation({ record: snapshot }), snapshot);
      assert.deepEqual(await store.resolveOperation(id(302)), snapshot);
      assert.deepEqual(await counts(), {
        intents: 2,
        attempts: 2,
        operations: 2,
        audits: 2,
        observations: 2,
      });
      const other = createPostgresPaymentIntentCreationStore(
        runner,
        { ...scope, storeReference: id(999) },
        { now: () => now, generateObservationReference: () => id(++sequence) },
      );
      assert.equal(await other.resolveOperation(id(302)), null);
      await assert.rejects(other.claim(second), { code: "PAYMENT_INTENT_PERMISSION_DENIED" });
      const expired = fixture(400, new Date(Date.parse(at) - 1800000).toISOString());
      await assert.rejects(store.claim(expired), { code: "PAYMENT_INTENT_PREPARATION_EXPIRED" });
      let providerCalls = 0;
      const serviceFor = (f) => {
        const p = f.record.intent.preparation;
        return createPaymentIntentCreationService({
          providerEnvironment: "Test",
          clock: { now: () => now },
          authorization: {
            authorize: async () =>
              serviceAuthorized
                ? {
                    action: "CreatePaymentIntent",
                    guestSessionReference: p.guestSessionReference,
                    ...scope,
                  }
                : null,
          },
          killSwitch: {
            evaluate: async (request) =>
              Object.freeze({
                effectiveControl: Object.freeze({
                  controlId: id(9900),
                  version: 1,
                  scope: Object.freeze({ kind: "Store", ...scope }),
                }),
                backendExecution: "Allow",
                frontendVisibility: "Show",
                reason: "KILL_INACTIVE",
                killMode: "BlockNew",
                inFlightPolicy: "AllowToComplete",
                record: Object.freeze({
                  key: "payment.provider.admission",
                  kind: "KillSwitch",
                  version: 1,
                  scopeKind: "Store",
                  backendExecution: "Allow",
                  frontendVisibility: "Show",
                  reason: "KILL_INACTIVE",
                  killMode: "BlockNew",
                  evaluatedAt: request.evaluatedAt,
                }),
              }),
          },
          ordering: { preparePayment: async () => p },
          audit: {
            create: async (request) => ({ ...f.audit, targetId: request.paymentIntentReference }),
          },
          references: {
            generate: () => id(++sequence),
            hash: (text) => "sha256:" + createHash("sha256").update(text).digest("hex"),
            equals: (a, b) => a === b,
            providerIdempotencyKey: (input) =>
              "BOP:" +
              input.environment +
              ":" +
              input.paymentOperationReference +
              ":" +
              input.paymentAttemptReference,
          },
          repository: store,
          provider: {
            createIntent: async (request) => {
              const persisted = await store.resolveOperation(request.context.operationReference);
              assert(persisted);
              assert.equal(persisted.providerOutcome, null);
              assert.equal(
                persisted.attempt.paymentAttemptReference,
                request.context.paymentAttemptReference,
              );
              providerCalls++;
              return outcome(persisted);
            },
          },
        });
      };
      const commandFor = (f) => ({
        paymentOperationReference: f.record.intent.paymentOperationReference,
        submissionReference: f.record.intent.preparation.submissionReference,
        cartReference: f.record.intent.preparation.sourceCartReference,
        expectedCartVersion: 1,
        quoteReference: f.record.intent.preparation.quoteReference,
        tipSelectionReference: null,
        requestedAt: at,
      });
      const lostServiceFixture = fixture(600),
        lostService = serviceFor(lostServiceFixture);
      lose = true;
      await assert.rejects(lostService.create(commandFor(lostServiceFixture)));
      assert.equal(providerCalls, 0);
      assert.equal((await lostService.create(commandFor(lostServiceFixture))).status, "Processing");
      assert.equal(providerCalls, 0);
      const liveServiceFixture = fixture(700),
        liveService = serviceFor(liveServiceFixture);
      const created = await liveService.create(commandFor(liveServiceFixture));
      assert.equal(created.status, "Created");
      assert.equal(providerCalls, 1);
      assert.equal(created.record.providerOutcome.code, "Unknown");
      assert.equal(
        (await liveService.create(commandFor(liveServiceFixture))).status,
        "AlreadyCreated",
      );
      assert.equal(providerCalls, 1);
      const revokedFixture = fixture(800),
        revokedService = serviceFor(revokedFixture);
      revokeAfterCommit = true;
      await assert.rejects(revokedService.create(commandFor(revokedFixture)), {
        code: "PAYMENT_INTENT_PERMISSION_DENIED",
      });
      assert.equal(providerCalls, 1);
      const retained = await store.resolveOperation(
        revokedFixture.record.intent.paymentOperationReference,
      );
      assert(retained);
      assert.equal(retained.providerOutcome, null);
      serviceAuthorized = true;
      assert.equal((await revokedService.create(commandFor(revokedFixture))).status, "Processing");
      assert.equal(providerCalls, 1);
      now = original.intent.preparation.capacityExpiresAt;
      assert.equal((await store.claim(f)).status, "Existing");
      assert.deepEqual(await counts(), {
        intents: 5,
        attempts: 5,
        operations: 5,
        audits: 5,
        observations: 3,
      });
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 180000);
