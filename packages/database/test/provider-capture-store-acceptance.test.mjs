import process from "node:process";
import path from "node:path";
import { createInternalSimulatedProvider } from "../../../tooling/environment/pilot-payment-provider.mjs";
import { createInternalProviderCaptureReview } from "../../../tooling/environment/pilot-provider-capture-review.mjs";
import { createInternalReconciliationProjection } from "../../../tooling/environment/pilot-reconciliation-projection.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPostgresProviderCaptureExceptionStore } from "../../rms/payment/src/index.ts";
const { Client } = pg,
  id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("atomically records unlinked capture evidence with Audit, concurrent replay and scoped access", async () => {
  await withIsolatedDatabase({ caseId: "provider_cap_store" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "provider_cap_" + env.runId;
    let roleCreated = false,
      failAudit = false,
      revokeAfterAudit = false,
      authorized = true,
      sequence = 1000;
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
      observedAt = new Date(Date.now() - 1000).toISOString();
    const request = (n) => ({
      candidateReference: id(n),
      exceptionReference: id(n + 1),
      evidence: {
        brandReference: id(2),
        storeReference: id(3),
        providerAccountReference: id(4),
        environment: "Test",
        providerIntentReference: "pi_demo" + n,
        providerTransactionReference: "ch_demo" + n,
        paymentOperationReference: id(n + 2),
        paymentAttemptReference: id(n + 3),
        amount: { amountMinor: 2260n, currencyCode: "CAD" },
        occurredAt: "2026-09-20T03:35:37.236Z",
        observedAt,
        evidenceDigest: "sha256:" + "a".repeat(64),
      },
    });
    const owner = createPostgresProviderCaptureExceptionStore({
      scope,
      providerAccountReference: id(4),
      environment: "Test",
      authorize: async () => authorized,
      verifyEvidence: async () => true,
      audit: async (input) => ({
        auditId: id(++sequence),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "System" },
        actionCode: "PAYMENT_PROVIDER_CAPTURE_UNMATCHED",
        targetType: "PaymentReconciliationException",
        targetId: input.exceptionReference,
        correlationId: input.candidateReference,
        occurredAt: input.evidence.observedAt,
        reasonCode: "PROVIDER_CAPTURE_WITHOUT_INTERNAL_OPERATION",
        sourceChannel: "INTERNAL_TEST",
        dataClassification: "Restricted",
        retentionPolicyCode: "PAYMENT_AUDIT",
        retentionPolicyVersion: 1,
      }),
    });
    async function run(work) {
      const client = new Client(env.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await work({
          query: async (sql, values = []) => {
            if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              await client.query("SELECT 1/0");
            const result = await client.query(sql, [...values]);
            if (revokeAfterAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              authorized = false;
            return result;
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    async function counts() {
      const result = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.provider_capture_exception_evidence) AS evidence,(SELECT count(*)::int FROM rms_payment.payment_reconciliation_exception) AS exceptions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_PROVIDER_CAPTURE_UNMATCHED') AS audit",
      );
      return result.rows[0];
    }
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_intent_operation_record,rms_payment.payment_provider_observation TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.provider_capture_exception_evidence,rms_payment.payment_reconciliation_exception,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      failAudit = true;
      await assert.rejects(run((tx) => owner.record(tx, request(100))));
      assert.deepEqual(await counts(), { evidence: 0, exceptions: 0, audit: 0 });
      failAudit = false;
      const concurrent = await Promise.all([
        run((tx) => owner.record(tx, request(100))),
        run((tx) => owner.record(tx, request(100))),
      ]);
      assert.deepEqual(concurrent.map((v) => v.status).sort(), ["AlreadyRecorded", "Created"]);
      assert.deepEqual(await counts(), { evidence: 1, exceptions: 1, audit: 1 });
      const bad = request(100);
      bad.evidence.amount.amountMinor = 2261n;
      await assert.rejects(run((tx) => owner.record(tx, bad)));
      assert.deepEqual(await counts(), { evidence: 1, exceptions: 1, audit: 1 });
      revokeAfterAudit = true;
      await assert.rejects(run((tx) => owner.record(tx, request(200))));
      assert.deepEqual(await counts(), { evidence: 1, exceptions: 1, audit: 1 });
      revokeAfterAudit = false;
      authorized = true;
      for (const [brand, store, expected] of [
        [id(2), id(3), 1],
        [id(2), id(999), 0],
        [id(999), id(3), 0],
      ])
        await run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_payment.provider_capture_exception_evidence",
              )
            ).rows[0].n,
            expected,
          );
        });
      await assert.rejects(
        run((tx) =>
          tx.query("UPDATE rms_payment.provider_capture_exception_evidence SET amount_minor=1"),
        ),
        (error) => error.code === "42501",
      );
      await admin.query("GRANT USAGE ON SCHEMA platform_projection TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON platform_projection.order_exception_source TO " + role,
      );
      await admin.query("GRANT SELECT ON rms_payment.payment_reconciliation_record TO " + role);
      const previousEnvironment = process.env.NODE_ENV;
      let simulator;
      try {
        process.env.NODE_ENV = "development";
        const binding = { ...scope, validUntil: new Date(Date.now() + 3600000).toISOString() },
          profile = { environment: "InternalTest", database: env.databaseName, binding };
        simulator = await createInternalSimulatedProvider(
          { provision: true },
          {
            path: path.join(env.fixtureRoot, "provider-capture.sqlite"),
            loadProfile: async () => profile,
            expectedDatabaseName: env.databaseName,
          },
        );
        const context = {
          provider: "Stripe",
          environment: "Test",
          brandReference: id(2),
          storeReference: id(3),
          paymentAttemptReference: id(501),
          operationReference: id(502),
        };
        const snapshot = await simulator.adapter.createIntent({
          operation: "CreateIntent",
          purpose: "CreatePaymentIntent",
          context,
          idempotencyKey: "capture-review:" + id(502),
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          amount: { amountMinor: 2260n, currencyCode: "CAD" },
        });
        await simulator.simulateCapture(
          {
            operation: "RetrieveIntent",
            purpose: "RetrievePaymentIntent",
            context,
            providerIntentReference: snapshot.providerIntentReference,
          },
          "SIMULATE_CAPTURE",
        );
        const resources = {
          scope,
          publicProfile: profile,
          now: () => new Date().toISOString(),
          credentials: { reference: () => id(++sequence) },
          transactions: { run },
        };
        const review = () =>
          createInternalProviderCaptureReview({
            resources,
            simulator,
            providerAccountReference: id(4),
          });
        assert.deepEqual(await review()(), {
          scannedCount: 1,
          created: 1,
          alreadyRecorded: 0,
          operationPresent: 0,
          scanComplete: true,
        });
        assert.deepEqual(await counts(), { evidence: 2, exceptions: 2, audit: 2 });
        assert.deepEqual(await review()(), {
          scannedCount: 1,
          created: 0,
          alreadyRecorded: 1,
          operationPresent: 0,
          scanComplete: true,
        });
        assert.deepEqual(await counts(), { evidence: 2, exceptions: 2, audit: 2 });
        const project = createInternalReconciliationProjection(resources);
        assert.deepEqual(await project(), { projectedCount: 2, scanComplete: true });
        const projected = await admin.query(
          "SELECT record_json FROM platform_projection.order_exception_source ORDER BY source_id",
        );
        assert.equal(projected.rows.length, 2);
        for (const { record_json: record } of projected.rows) {
          assert.equal(record.kind, "PaymentReconciliationDifference");
          assert.equal(record.sourceStatus, "Open");
          assert.equal(record.orderReference, null);
          assert.equal(record.paymentReference, null);
        }
        assert.deepEqual(await project(), { projectedCount: 2, scanComplete: true });
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM platform_projection.order_exception_source",
            )
          ).rows[0].n,
          2,
        );
      } finally {
        simulator?.close();
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
      }
    } finally {
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}, 180000);
