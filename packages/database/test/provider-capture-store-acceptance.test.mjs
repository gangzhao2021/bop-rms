import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { createInternalSimulatedProvider } from "../../../tooling/environment/pilot-payment-provider.mjs";
import { createInternalProviderCaptureReview } from "../../../tooling/environment/pilot-provider-capture-review.mjs";
import { createInternalReconciliationProjection } from "../../../tooling/environment/pilot-reconciliation-projection.mjs";
import { createInternalDailySettlementSource } from "../../../tooling/environment/pilot-daily-settlement-source.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPaymentReconciliationService,
  createPostgresPaymentReconciliationDaySource,
  createPostgresPaymentReconciliationExceptionDetailReader,
  createPostgresPaymentReconciliationRepository,
  createPostgresProviderCaptureExceptionStore,
  createPostgresUnmatchedCaptureRefundStore,
} from "../../rms/payment/src/index.ts";
// WP-2423: the closed business day under test (the Store configuration window is not under test).
const settlementDay = vi.hoisted(() => ({ current: null }));
vi.mock("../../../tooling/environment/pilot-settlement-window.mjs", () => ({
  createInternalClosedSettlementWindow: () => async () => settlementDay.current,
}));
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
      // WP-2423 pilot ACL addition (Owner standing approval 2026-10-14): the exception source reads
      // how a business day's difference was resolved; the settlement run records it.
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_reconciliation_resolution TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.unmatched_capture_refund_request,rms_payment.unmatched_capture_refund_approval,rms_payment.unmatched_capture_refund_outcome TO " +
          role,
      );
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
        // WP-2423 P6: a manager requests, a different person approves, the Provider refunds.
        const exception = (
          await admin.query(
            "SELECT reconciliation_exception_id::text AS id FROM rms_payment.provider_capture_exception_evidence WHERE original_attempt_id=$1",
            [id(501)],
          )
        ).rows[0].id;
        const manager = id(601),
          owner2 = id(602);
        let refundAuthorized = true;
        const refunds = createPostgresUnmatchedCaptureRefundStore({
          brandReference: id(2),
          storeReference: id(3),
          authorize: async () => refundAuthorized,
        });
        const openedAt = Date.parse(
          (
            await admin.query(
              "SELECT opened_at FROM rms_payment.payment_reconciliation_exception WHERE reconciliation_exception_id=$1",
              [exception],
            )
          ).rows[0].opened_at.toISOString(),
        );
        const at = (offset) => new Date(openedAt + 1 + offset / 1000).toISOString();
        const refundCounts = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_payment.unmatched_capture_refund_request) AS requests,(SELECT count(*)::int FROM rms_payment.unmatched_capture_refund_approval) AS approvals,(SELECT count(*)::int FROM rms_payment.unmatched_capture_refund_outcome) AS outcomes,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_type='UnmatchedCaptureRefund') AS audit",
            )
          ).rows[0];
        assert.equal((await run((tx) => refunds.read(tx, exception))).status, "Unrefunded");
        const requestInput = {
          exceptionReference: exception,
          actorReference: manager,
          refundReference: id(610),
          idempotencyReference: id(611),
          auditReference: id(612),
          requestedAt: at(0),
        };
        refundAuthorized = false;
        await assert.rejects(run((tx) => refunds.request(tx, requestInput)));
        refundAuthorized = true;
        await assert.rejects(
          run((tx) =>
            refunds.request(tx, {
              ...requestInput,
              requestedAt: new Date(openedAt - 1).toISOString(),
            }),
          ),
          (error) => error.code === "UNMATCHED_REFUND_STATE_CONFLICT",
        );
        refundAuthorized = true;
        const requested = await run((tx) => refunds.request(tx, requestInput));
        assert.equal(requested.status, "Requested");
        assert.equal(requested.amountMinor, "2260");
        // The same request repeated is a no-op; another request for the same charge conflicts.
        assert.equal((await run((tx) => refunds.request(tx, requestInput))).status, "Requested");
        await assert.rejects(
          run((tx) =>
            refunds.request(tx, {
              ...requestInput,
              refundReference: id(613),
              idempotencyReference: id(614),
              auditReference: id(615),
            }),
          ),
          (error) => error.code === "UNMATCHED_REFUND_STATE_CONFLICT",
        );
        const approveInput = {
          exceptionReference: exception,
          actorReference: owner2,
          operationReference: id(620),
          idempotencyReference: id(621),
          auditReference: id(622),
          approvedAt: at(1000),
        };
        await assert.rejects(
          run((tx) => refunds.approve(tx, { ...approveInput, actorReference: manager })),
          (error) => error.code === "UNMATCHED_REFUND_SAME_APPROVER",
        );
        // The database holds separation of duties even if the writer were bypassed.
        await assert.rejects(
          run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(2), id(3)],
            );
            await tx.query(
              "INSERT INTO rms_payment.unmatched_capture_refund_approval VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                id(610),
                id(2),
                id(3),
                manager,
                at(1000),
                id(630),
                "unmatched-capture-refund:" + id(630),
                id(631),
                id(632),
              ],
            );
          }),
          (error) => error.code === "23514",
        );
        const approved = await run((tx) => refunds.approve(tx, approveInput));
        assert.equal(approved.status, "Approved");
        const providerRequest = refunds.providerRequest(approved);
        assert.equal(providerRequest.idempotencyKey, "unmatched-capture-refund:" + id(620));
        assert.equal(providerRequest.context.paymentAttemptReference, id(501));
        // The Provider times refunds to the second: refund on a later second than the charge so
        // the two fall on different business days below (WP-2423 v15 Oct 9 shape).
        await sleep(1100);
        const observation = await simulator.adapter.refundPayment(providerRequest);
        // A lost response is recovered with the same fixed key: the same Provider refund.
        const replay = await simulator.adapter.refundPayment(providerRequest);
        assert.equal(replay.providerRefundReference, observation.providerRefundReference);
        const outcome = {
          providerRefundReference: observation.providerRefundReference,
          providerIntentReference: observation.providerIntentReference,
          amountMinor: observation.amount.amountMinor,
          status: observation.status,
          createdAt: observation.createdAt,
          // WP-2423 (2026-10-17): the refund result is observed 1.5 s after the Provider created
          // it, so a business day can end between the two (the across-midnight case below).
          observedAt: new Date(
            Math.max(Date.parse(observation.observedAt), Date.parse(observation.createdAt) + 1500),
          ).toISOString(),
          evidenceDigest: observation.evidenceDigest,
          idempotencyKey: providerRequest.idempotencyKey,
        };
        // A creation time not on a whole second, or after the observation, is refused.
        for (const createdAt of [
          new Date(Date.parse(observation.createdAt) + 1).toISOString(),
          new Date(Date.parse(outcome.observedAt) + 1000).toISOString(),
        ])
          await assert.rejects(
            run((tx) =>
              refunds.recordOutcome(tx, {
                exceptionReference: exception,
                observation: { ...outcome, createdAt },
                auditReference: id(642),
                recordedAt: at(2000),
              }),
            ),
            (error) => error.code === "UNMATCHED_REFUND_STATE_CONFLICT",
          );
        await assert.rejects(
          run((tx) =>
            refunds.recordOutcome(tx, {
              exceptionReference: exception,
              observation: { ...outcome, amountMinor: 2259n },
              auditReference: id(640),
              recordedAt: at(2000),
            }),
          ),
        );
        const refunded = await run((tx) =>
          refunds.recordOutcome(tx, {
            exceptionReference: exception,
            observation: outcome,
            auditReference: id(641),
            recordedAt: at(2000),
          }),
        );
        assert.equal(refunded.status, "Refunded");
        assert.deepEqual(await refundCounts(), {
          requests: 1,
          approvals: 1,
          outcomes: 1,
          audit: 3,
        });
        await assert.rejects(
          run((tx) =>
            tx.query("UPDATE rms_payment.unmatched_capture_refund_request SET amount_minor=1"),
          ),
        );
        // Another Store sees none of it.
        await run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(999)],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_payment.unmatched_capture_refund_outcome",
              )
            ).rows[0].n,
            0,
          );
        });
        // The confirmed refund resolves the exception; the other stays open.
        assert.deepEqual(await project(), { projectedCount: 2, scanComplete: true });
        const latest = await admin.query(
          "SELECT DISTINCT ON (source_id) source_id::text AS id,record_json FROM platform_projection.order_exception_source ORDER BY source_id,source_version DESC",
        );
        for (const { id: source, record_json: record } of latest.rows) {
          assert.equal(record.sourceStatus, source === exception ? "Final" : "Open");
          assert.equal(record.resolutionEvidenceReference, source === exception ? id(610) : null);
        }

        // WP-2423 v15 (business day Oct 9): the Provider took the unmatched charge on one day and
        // refunded it (staff-approved above) on a later day. The refund day's settlement used to
        // count our refunds without it ($0.00 against the Provider's $22.60): a false difference.
        // The day-end source now counts unmatched captures and their refunds from the Payment owner.
        await admin.query(
          "GRANT SELECT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_terminal_fact,rms_payment.ordinary_refund_request,rms_payment.ordinary_refund_observation,rms_payment.payment_compensation_refund,rms_payment.payment_compensation_action_history,rms_payment.payment_reconciliation_run TO " +
            role,
        );
        await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA rms_payment TO " + role);
        await admin.query(
          "GRANT INSERT ON rms_payment.payment_reconciliation_run,rms_payment.payment_reconciliation_record TO " +
            role,
        );
        const listed = await run((tx) =>
          refunds.list(tx, { afterExceptionReference: null, limit: 100 }),
        );
        const charge = listed.states.find(
          (state) => state.reconciliationExceptionReference === exception,
        );
        assert.equal(listed.states.length, 2);
        assert.equal(charge.status, "Refunded");
        const refund = await simulator.adapter.lookupRefund(providerRequest);
        assert.ok(charge.capturedAt < refund.createdAt, charge.capturedAt + " " + refund.createdAt);
        assert.ok(refund.createdAt <= charge.outcome.providerObservedAt);
        // WP-2423 (2026-10-17): the Provider's creation time is kept with the confirmed refund.
        assert.equal(charge.outcome.providerCreatedAt, refund.createdAt);
        assert.equal(observation.createdAt, refund.createdAt);
        const refundDayStart = new Date(Date.parse(charge.capturedAt) + 1).toISOString();
        await sleep(5);
        const closedAt = new Date().toISOString();
        const days = {
          capture: {
            businessDate: "2026-10-08",
            startsAt: new Date(Date.parse(charge.capturedAt) - 60_000).toISOString(),
            endsAt: refundDayStart,
          },
          refund: { businessDate: "2026-10-09", startsAt: refundDayStart, endsAt: closedAt },
        };
        const prepare = createInternalDailySettlementSource({
          resources,
          simulator,
          providerAccountReference: id(4),
          active: async () => true,
        });
        settlementDay.current = days.refund;
        const refundDay = await prepare();
        assert.equal(refundDay.candidate.providerCapturedAmount.amountMinor, 0n);
        assert.equal(refundDay.candidate.providerRefundedAmount.amountMinor, 2260n);
        assert.equal(refundDay.candidate.internalRefundedAmount.amountMinor, 2260n);
        assert.equal(refundDay.candidate.internalCapturedAmount.amountMinor, 0n);
        // Across midnight: a business day ends after the Provider created the refund but before
        // its result was observed. Day-end settlement counts it in the day it was created (as the
        // Provider statement does), and the kept creation time puts it on the same day for the
        // Settlement page (state.outcome.providerCreatedAt), not the observation's next day.
        const midnight = new Date(Date.parse(refund.createdAt) + 1).toISOString();
        assert.ok(midnight <= charge.outcome.providerObservedAt);
        settlementDay.current = {
          businessDate: "2026-10-09",
          startsAt: refundDayStart,
          endsAt: midnight,
        };
        const beforeMidnight = await prepare();
        assert.equal(beforeMidnight.candidate.providerRefundedAmount.amountMinor, 2260n);
        assert.equal(beforeMidnight.candidate.internalRefundedAmount.amountMinor, 2260n);
        settlementDay.current = {
          businessDate: "2026-10-10",
          startsAt: midnight,
          endsAt: closedAt,
        };
        const afterMidnight = await prepare();
        assert.equal(afterMidnight.candidate.providerRefundedAmount.amountMinor, 0n);
        assert.equal(afterMidnight.candidate.internalRefundedAmount.amountMinor, 0n);
        assert.ok(charge.outcome.providerCreatedAt < midnight);
        assert.ok(charge.outcome.providerObservedAt >= midnight);
        settlementDay.current = days.capture;
        const captureDay = await prepare();
        assert.equal(captureDay.candidate.providerCapturedAmount.amountMinor, 2260n);
        assert.equal(captureDay.candidate.internalCapturedAmount.amountMinor, 2260n);
        assert.equal(captureDay.candidate.providerRefundedAmount.amountMinor, 0n);
        assert.equal(captureDay.candidate.internalRefundedAmount.amountMinor, 0n);

        // The day as v15 recorded it before the fix, then re-checked with the corrected evidence.
        const repository = createPostgresPaymentReconciliationRepository({
          scope: { brandReference: id(2), storeReference: id(3) },
          transactions: { run },
          authorize: async () => true,
          resolutions: { nextReference: () => id(++sequence) },
        });
        const settle = (runReference, candidate, scheduledAt = new Date().toISOString()) => {
          return createPaymentReconciliationService({
            authorization: { authorize: async () => true },
            lease: { claim: async () => true, release: async () => undefined },
            repository,
            candidates: {
              claimOperational: async () => [],
              claimDailySettlement: async () => [candidate],
            },
            provider: { retrieveIntent: async () => assert.fail("no Provider call") },
            observations: { record: async () => assert.fail("no observation") },
            terminal: {
              occurrence: async () => assert.fail("no terminal"),
              record: async () => assert.fail("no terminal"),
            },
            references: {
              generate: () => id(++sequence),
              exceptionFor: ({ reason }) => id(reason === "RefundMismatch" ? 900 : 901),
            },
            clock: { now: () => new Date().toISOString() },
          }).run({
            runReference,
            brandReference: id(2),
            storeReference: id(3),
            actorReference: null,
            mode: "DailySettlement",
            purpose: "ReconcilePayments",
            scheduledAt,
            cutoffAt: scheduledAt,
            maxCandidates: 1,
          });
        };
        const before = await settle(id(800), {
          ...refundDay.candidate,
          settlementReference: "simset_20261009_" + "c".repeat(64),
          internalRefundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
        });
        assert.equal(before.result.checks[0].outcome, "Difference");
        assert.equal(before.result.checks[0].differenceReason, "RefundMismatch");
        const exceptionState = async () => {
          const reader = createInternalReconciliationProjection(resources);
          assert.deepEqual(await reader(), { projectedCount: 3, scanComplete: true });
          return (
            await admin.query(
              "SELECT DISTINCT ON (source_id) record_json FROM platform_projection.order_exception_source WHERE source_id=$1 ORDER BY source_id,source_version DESC",
              [id(900)],
            )
          ).rows[0].record_json;
        };
        assert.equal((await exceptionState()).sourceStatus, "Open");
        // A Difference check can never resolve it, even written past the owner writer.
        await assert.rejects(
          run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(2), id(3)],
            );
            await tx.query(
              "INSERT INTO rms_payment.payment_reconciliation_resolution VALUES ($1,$2,$3,$4,'MatchedOnRecheck',$5,$6,$7,$8)",
              [
                id(900),
                id(2),
                id(3),
                refundDay.candidate.candidateReference,
                id(800),
                before.result.checks[0].checkReference,
                before.result.checks[0].checkedAt,
                id(950),
              ],
            );
          }),
          (error) => error.code === "23514",
        );
        const after = await settle(id(801), refundDay.candidate);
        assert.equal(after.status, "Created");
        assert.equal(after.result.checks[0].outcome, "Matched");
        const resolutions = await admin.query(
          "SELECT s.reconciliation_exception_id::text AS exception,s.reconciliation_check_id::text AS check_id,s.resolution,a.action_code,a.target_id::text AS target FROM rms_payment.payment_reconciliation_resolution s JOIN platform_audit.audit_record a ON a.audit_id=s.audit_id",
        );
        assert.deepEqual(resolutions.rows, [
          {
            exception: id(900),
            check_id: after.result.checks[0].checkReference,
            resolution: "MatchedOnRecheck",
            action_code: "PAYMENT_RECONCILIATION_DIFFERENCE_RESOLVED",
            target: id(900),
          },
        ]);
        // The same run again changes nothing; history stays append-only.
        assert.equal(
          (await settle(id(801), refundDay.candidate, after.result.run.scheduledAt)).status,
          "Duplicate",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_payment.payment_reconciliation_resolution",
            )
          ).rows[0].n,
          1,
        );
        await assert.rejects(
          run((tx) =>
            tx.query(
              "UPDATE rms_payment.payment_reconciliation_resolution SET resolution='MatchedOnRecheck'",
            ),
          ),
        );
        const resolved = await exceptionState();
        assert.equal(resolved.sourceStatus, "Final");
        assert.equal(resolved.resolutionEvidenceReference, after.result.checks[0].checkReference);
        // The day-end page reads the first check and the re-check (the day's current result).
        const day = await run((tx) =>
          createPostgresPaymentReconciliationDaySource({
            scope: { brandReference: id(2), storeReference: id(3) },
            authorize: async () => true,
          })(tx, {
            startsAt: days.refund.startsAt,
            endsAt: days.refund.endsAt,
            settlementRunReference: id(800),
            recheckRunReferences: [id(801), id(802)],
          }),
        );
        assert.equal(day.settlement.checks[0].outcome, "Difference");
        assert.equal(day.settlement.recheck.check.outcome, "Matched");
        assert.equal(day.settlement.recheck.run.runReference, id(801));
        assert.equal(day.settlement.recheck.count, 1);
        assert.deepEqual(day.settlement.additionalChecks, []);
        // WP-2423: the Exceptions card reads what the difference is about and how it was resolved.
        const details = await run((tx) =>
          createPostgresPaymentReconciliationExceptionDetailReader({
            scope: { brandReference: id(2), storeReference: id(3) },
            authorize: async () => true,
          })(tx, [id(900)]),
        );
        assert.deepEqual(details.get(id(900)), {
          exceptionReference: id(900),
          kind: "BusinessDayTotals",
          openingCheck: {
            runReference: id(800),
            checkedAt: before.result.checks[0].checkedAt,
            differenceReason: "RefundMismatch",
            internalCapturedMinor: "0",
            providerCapturedMinor: "0",
            internalRefundedMinor: "0",
            providerRefundedMinor: "2260",
          },
          resolution: {
            resolvedAt: after.result.checks[0].checkedAt,
            runReference: id(801),
          },
        });
        // v15 Sep 20: the capture day was settled twice at close — first by a run outside the
        // day's schedule, then by the scheduled run. The earlier one is history, never read as a
        // later check of the day (that read failed and the page said the records could not be read).
        const duplicate = await settle(id(810), captureDay.candidate);
        await sleep(5);
        const scheduled = await settle(id(811), captureDay.candidate);
        assert.equal(duplicate.result.checks[0].outcome, "Matched");
        assert.equal(scheduled.result.checks[0].outcome, "Matched");
        assert.ok(duplicate.result.checks[0].checkedAt < scheduled.result.checks[0].checkedAt);
        const twice = await run((tx) =>
          createPostgresPaymentReconciliationDaySource({
            scope: { brandReference: id(2), storeReference: id(3) },
            authorize: async () => true,
          })(tx, {
            startsAt: days.capture.startsAt,
            endsAt: days.capture.endsAt,
            settlementRunReference: id(811),
            recheckRunReferences: [id(812), id(813)],
          }),
        );
        assert.equal(twice.settlement.run.runReference, id(811));
        assert.equal(twice.settlement.checks[0].outcome, "Matched");
        assert.equal(twice.settlement.recheck, null);
        assert.deepEqual(
          twice.settlement.additionalChecks.map((check) => [check.runReference, check.outcome]),
          [[id(810), "Matched"]],
        );
        // Another Store sees no resolution.
        await run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(999)],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_payment.payment_reconciliation_resolution",
              )
            ).rows[0].n,
            0,
          );
        });
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
