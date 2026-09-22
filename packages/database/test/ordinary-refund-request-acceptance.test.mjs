import { exerciseOrdinaryRefundOperationIsolation } from "../test-support/ordinary-refund-operation-acceptance.mjs";
import { exerciseOrdinaryRefundApprovalIsolation } from "../test-support/ordinary-refund-approval-acceptance.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresOrdinaryRefundEscalationSource,
  createPostgresOrdinaryRefundRequestStore,
  createPostgresOrdinaryRefundRequestPositionSource as createPostgresOrdinaryRefundPositionSource,
  createPostgresOrdinaryRefundExecutionBalanceSource,
} from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-request-store.ts";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "../../rms/payment/src/tests/ordinary-refund-request.fixture.ts";

it("serializes durable ordinary claims, preserves replay, excludes occupied balances and enforces RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_refund_req" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    try {
      const role = "wp2402_refund_request_actor";
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_payment.ordinary_refund_request TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const f = ordinaryRefundRequestFixture(new Date(Date.now() - 1000).toISOString());
      const scope = {
        tenantReference: f.tenantReference,
        brandReference: f.brandReference,
        storeReference: f.storeReference,
      };
      const run = async (work) => {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const value = await work(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      // Captured/Pricing/current capability are synthetic owner adapter facts here.
      // This test proves storage transactions/RLS, not actual capture composition.
      const store = (extra = {}) =>
        createPostgresOrdinaryRefundRequestStore({
          scope,
          authorize: async () => true,
          validateSources: async (_tx, { request }) =>
            request.payments.map((payment) => ({
              paymentAttemptReference: payment.paymentAttemptReference,
              capturedAmountMinor: 15000n,
              otherOccupiedAmountMinor: 1000n,
            })),
          ...extra,
        });
      const audit = (r) => ({
        auditId: r.auditReference,
        brandId: r.brandReference,
        storeId: r.storeReference,
        actor: { type: "User", reference: r.actorReference },
        actionCode: "PAYMENT_ORDINARY_REFUND_REQUESTED",
        targetType: "PaymentRefundRequest",
        targetId: r.requestReference,
        reasonCode: r.reasonCode,
        correlationId: r.operationReference,
        occurredAt: r.requestedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const commit = (r = f, target = store()) => run((tx) => target.record(tx, r, audit(r)));
      const position = (extra = {}, query = {}) =>
        run((tx) =>
          createPostgresOrdinaryRefundPositionSource({
            // Storage fixture has synthetic capture ports; actual recovery is covered
            // by the Additional writer journey. This fixture models pending claims.
            readOutcome: async () => null,
            scope,
            authorize: async () => true,
            ...extra,
          })(tx, {
            orderReference: f.orderReference,
            paymentTransactionReference: f.payments[0].paymentTransactionReference,
            paymentIntentReference: f.payments[0].paymentIntentReference,
            paymentAttemptReference: f.payments[0].paymentAttemptReference,
            observedAt: f.requestedAt,
            ...query,
          }),
        );
      assert.equal((await position()).pendingMinor, 0n);
      const pair = await Promise.all([commit(), commit()]);
      assert.deepEqual(pair.map((r) => r.status).sort(), ["AlreadyCommitted", "Created"]);
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_request) AS claims," +
              "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_REQUESTED') AS audits",
          )
        ).rows[0];
      assert.deepEqual(await counts(), { claims: 1, audits: 1 });
      await exerciseOrdinaryRefundOperationIsolation({
        admin,
        run,
        role,
        scope,
        request: f,
        audit: audit(f),
      });
      const approvalChecks = await exerciseOrdinaryRefundApprovalIsolation({
        admin,
        run,
        role,
        scope,
        request: f,
        audit: audit(f),
      });
      await assert.rejects(commit({ ...f, reasonCode: "CHANGED" }));
      await assert.rejects(
        run((tx) => store().record(tx, f, { ...audit(f), reasonCode: "WRONG_REASON" })),
        /ORDINARY_REFUND_AUDIT_INVALID/,
      );
      await assert.rejects(commit(f, store({ authorize: async () => false })));
      await assert.rejects(commit({ ...f, tenantReference: id(99) }));
      const next = (n, ordinal = 2) => ({
        ...f,
        expectedClaimVersion: 1,
        requestReference: id(n),
        operationReference: id(n + 1),
        auditReference: id(n + 2),
        payments: f.payments.map((p) => ({
          ...p,
          items: p.items.map((item) => ({ ...item, refundUnitOrdinals: [ordinal] })),
        })),
      });
      await assert.rejects(commit(next(30, 1)), /ORDINARY_REFUND_REQUEST_CONFLICT/);
      await assert.rejects(
        commit(
          next(30),
          store({
            validateSources: async () => [
              {
                paymentAttemptReference: f.payments[0].paymentAttemptReference,
                capturedAmountMinor: 15000n,
                otherOccupiedAmountMinor: 4000n,
              },
            ],
          }),
        ),
        /ORDINARY_REFUND_BALANCE_EXCEEDED/,
      );
      const raced = await Promise.allSettled([commit(next(30)), commit(next(40, 3))]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
      assert.deepEqual(await counts(), { claims: 2, audits: 2 });
      await approvalChecks.assertClaimChangeRejected();
      // Actual two-request cumulative threshold; capture/date owner ports are synthetic.
      const escalation = (extra = {}) =>
        createPostgresOrdinaryRefundEscalationSource({
          scope,
          authorize: async () => true,
          captures: async (_tx, input) => {
            assert.equal(input.history.length, 0);
            return [
              {
                paymentAttemptReference: f.payments[0].paymentAttemptReference,
                firstCapturedAt: f.requestedAt,
              },
            ];
          },
          businessDate: async () => "2026-09-13",
          ...extra,
        });
      const escalationQuery = {
        orderReference: f.orderReference,
        requestReference: f.requestReference,
      };
      const resolveEscalation = (target = escalation()) => run((tx) => target(tx, escalationQuery));
      const actualEscalation = await resolveEscalation();
      assert.equal(actualEscalation.claimVersion, 2);
      assert.equal(actualEscalation.decision.cumulativeOrdinaryAmountMinor, 12000n);
      assert.equal(actualEscalation.decision.requiresIndependentApproval, true);
      assert.deepEqual(actualEscalation.decision.reasons, ["OrderOrdinaryTotalAboveCad100"]);
      await assert.rejects(resolveEscalation(escalation({ captures: async () => [] })));
      await assert.rejects(resolveEscalation(escalation({ businessDate: async () => "invalid" })));
      await assert.rejects(resolveEscalation(escalation({ authorize: async () => false })));
      let escalationAuthReads = 0;
      await assert.rejects(
        resolveEscalation(escalation({ authorize: async () => ++escalationAuthReads === 1 })),
      );
      assert.equal(escalationAuthReads, 2);

      const executionQuery = {
        orderReference: f.orderReference,
        requestReference: f.requestReference,
      };
      const executionSource = (extra = {}, otherOccupiedAmountMinor = 1000n) =>
        createPostgresOrdinaryRefundExecutionBalanceSource({
          scope,
          authorize: async () => true,
          validateSources: async (_tx, input) => {
            assert.equal(input.request.requestReference, f.requestReference);
            // First request's original Pricing input excludes the later request.
            assert.equal(input.history.length, 0);
            return [
              {
                paymentAttemptReference: f.payments[0].paymentAttemptReference,
                capturedAmountMinor: 15000n,
                otherOccupiedAmountMinor,
              },
            ];
          },
          ...extra,
        });
      const execution = await run((tx) => executionSource()(tx, executionQuery));
      assert.equal(execution.claimVersion, 2);
      assert.equal(execution.positions[0].requestAmountMinor, 6000n);
      assert.equal(execution.positions[0].occupiedAmountMinor, 13000n);
      assert.equal(execution.positions[0].unoccupiedAmountMinor, 2000n);
      await assert.rejects(
        run((tx) => executionSource({}, 4000n)(tx, executionQuery)),
        /ORDINARY_REFUND_BALANCE_EXCEEDED/,
      );
      await assert.rejects(
        run((tx) =>
          executionSource({
            authorize: async () => false,
          })(tx, executionQuery),
        ),
        /ORDINARY_REFUND_PERMISSION_DENIED/,
      );
      let executionAuthorizations = 0;
      await assert.rejects(
        run((tx) =>
          executionSource({
            authorize: async () => ++executionAuthorizations === 1,
          })(tx, executionQuery),
        ),
        /ORDINARY_REFUND_PERMISSION_DENIED/,
      );
      assert.equal(executionAuthorizations, 2);
      await assert.rejects(
        run((tx) =>
          executionSource()(tx, {
            ...executionQuery,
            requestReference: id(98),
          }),
        ),
      );

      const occupied = await position();
      assert.equal(occupied.pendingMinor, 12000n);
      assert.equal(occupied.confirmedMinor, 0n);
      assert.equal(occupied.version, 3);
      const tomorrow = await position(
        {},
        { observedAt: new Date(Date.parse(f.requestedAt) + 86400000).toISOString() },
      );
      assert.equal(tomorrow.pendingMinor, occupied.pendingMinor);
      assert.equal(tomorrow.snapshotDigest, occupied.snapshotDigest);
      await assert.rejects(position({ scope: { ...scope, tenantReference: id(99) } }));
      await assert.rejects(position({}, { paymentTransactionReference: id(99) }));
      let reads = 0;
      await assert.rejects(
        position({ authorize: async () => ++reads === 1 }),
        /ORDINARY_REFUND_PERMISSION_DENIED/,
      );
      const retry = { ...next(50, 4), expectedClaimVersion: 2 };
      await assert.rejects(commit(retry), /ORDINARY_REFUND_BALANCE_EXCEEDED/);
      // Audit failure must rollback even when caller catches and commits transaction.
      const zeroOther = store({
        validateSources: async () => [
          {
            paymentAttemptReference: f.payments[0].paymentAttemptReference,
            capturedAmountMinor: 30000n,
            otherOccupiedAmountMinor: 0n,
          },
        ],
      });
      await run(async (tx) => {
        const proxy = {
          query: async (sql, params) => {
            if (sql.includes("INSERT INTO platform_audit.audit_record"))
              throw Error("synthetic Audit failure");
            return tx.query(sql, params);
          },
        };
        await assert.rejects(
          zeroOther.record(proxy, retry, audit(retry)),
          /synthetic Audit failure/,
        );
      });
      assert.deepEqual(await counts(), { claims: 2, audits: 2 });
      await run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [f.brandReference, id(99)],
        );
        assert.equal(
          (await tx.query("SELECT * FROM rms_payment.ordinary_refund_request")).rows.length,
          0,
        );
      });
      await run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [f.brandReference, f.storeReference],
        );
        assert.equal(
          (await tx.query("UPDATE rms_payment.ordinary_refund_request SET amount_minor=1"))
            .rowCount,
          0,
        );
        assert.equal(
          (await tx.query("DELETE FROM rms_payment.ordinary_refund_request")).rowCount,
          0,
        );
      });
      await assert.rejects(
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [f.brandReference, f.storeReference],
          );
          await tx.query(
            "INSERT INTO rms_payment.ordinary_refund_request " +
              "SELECT tenant_id,brand_id,$1::text::platform_helpers.uuid_v7,order_id,request_id,operation_id,actor_id,audit_id,claim_version,amount_minor,requested_at," +
              "jsonb_set(record_json,'{storeReference}',to_jsonb($1::text)) " +
              "FROM rms_payment.ordinary_refund_request LIMIT 1",
            [id(99)],
          );
        }),
        (error) => error.code === "42501",
      );
      assert.deepEqual(await counts(), { claims: 2, audits: 2 });
    } finally {
      await admin.end();
    }
  });
});
