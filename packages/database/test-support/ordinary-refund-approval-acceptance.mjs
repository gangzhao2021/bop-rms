import { createPostgresCurrentWorkforceMfaSource } from "../../bop/identity/src/index.ts";
import assert from "node:assert/strict";
import { createPostgresOrdinaryRefundApprovalSource } from "../../rms/payment/src/infrastructure/ordinary-refund-approval-source.ts";
import {
  assertCurrentOrdinaryRefundApprovalAuthority,
  createPostgresOrdinaryRefundApprovalReader,
  createPostgresOrdinaryRefundApprovalValidationSource,
  createPostgresOrdinaryRefundApprovalStore,
} from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-approval-store.ts";

export async function exerciseOrdinaryRefundApprovalIsolation({
  admin,
  run,
  role,
  scope,
  request,
  audit,
}) {
  const id = (n) => "01909977-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_payment.ordinary_refund_approval TO " + role,
  );
  const at = new Date().toISOString();
  await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + role);
  await admin.query("GRANT SELECT,UPDATE(version) ON bop_identity.workforce_mfa_status TO " + role);
  for (const actor of [request.actorReference, id(2)]) {
    await admin.query(
      "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
      [actor, id(20), at],
    );
  }
  // Synthetic Provider evidence seeded only in the isolated database.
  const mfaSource = createPostgresCurrentWorkforceMfaSource({
    authorize: async (_tx, actor) => [request.actorReference, id(2)].includes(actor),
  });
  const options = {
    scope,
    authorize: async () => true,
    authority: async (tx, query) => {
      const mfa = await mfaSource(tx, {
        actorReference: query.actorReference,
        observedAt: query.observedAt,
      });
      return {
        ...query,
        active: true,
        allowed: true,
        recentMfaAt: mfa.status === "TotpVerified" ? mfa.verifiedAt : null,
        role: query.permissionCode === "payment.refund.request" ? "Manager" : "Finance",
      };
    },
  };
  await run(async (tx) => {
    await mfaSource(tx, { actorReference: id(2), observedAt: at });
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        admin.query(
          "UPDATE bop_identity.workforce_mfa_status SET version=version+1 WHERE actor_id=$1",
          [id(2)],
        ),
        (error) => error.code === "55P03",
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });
  const prepared = await run((tx) =>
    createPostgresOrdinaryRefundApprovalSource(options)(tx, {
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      approvalReference: id(1),
      approverReference: id(2),
      observedAt: at,
    }),
  );
  const input = { ...prepared, operationReference: id(3), auditReference: id(4) };
  const approvalAudit = {
    ...audit,
    auditId: id(4),
    actor: { type: "User", reference: id(2) },
    actionCode: "PAYMENT_ORDINARY_REFUND_APPROVED",
    targetType: "PaymentRefundApproval",
    targetId: id(1),
    correlationId: id(3),
    occurredAt: at,
  };
  const store = createPostgresOrdinaryRefundApprovalStore(options);
  const pair = await Promise.all([
    run((tx) => store.record(tx, input, approvalAudit)),
    run((tx) => store.record(tx, input, approvalAudit)),
  ]);
  assert.deepEqual(pair.map((item) => item.status).sort(), ["AlreadyCommitted", "Created"]);
  const reader = createPostgresOrdinaryRefundApprovalReader({
    scope,
    authorize: async () => true,
  });
  const readQuery = {
    orderReference: request.orderReference,
    approvalReference: id(1),
    observedAt: at,
  };
  assert.deepEqual(await run((tx) => reader(tx, readQuery)), input);
  assert.equal(await run((tx) => reader(tx, { ...readQuery, approvalReference: id(90) })), null);
  assert.equal(await run((tx) => reader(tx, { ...readQuery, orderReference: id(91) })), null);
  await assert.rejects(
    run((tx) =>
      createPostgresOrdinaryRefundApprovalReader({
        scope: { ...scope, tenantReference: id(92) },
        authorize: async () => true,
      })(tx, readQuery),
    ),
  );
  let reads = 0;
  await assert.rejects(
    run((tx) =>
      createPostgresOrdinaryRefundApprovalReader({
        scope,
        authorize: async () => ++reads === 1,
      })(tx, readQuery),
    ),
  );
  assert.equal(reads, 2);
  const validate = createPostgresOrdinaryRefundApprovalValidationSource(options);
  const validationQuery = {
    orderReference: request.orderReference,
    requestReference: request.requestReference,
    approvalReference: id(1),
  };
  assert.deepEqual(await run((tx) => validate(tx, validationQuery)), {
    approvalReference: id(1),
    requestReference: request.requestReference,
    claimVersion: 1,
  });
  await assert.rejects(run((tx) => validate(tx, { ...validationQuery, requestReference: id(93) })));
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_approval) AS approvals," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_APPROVED') AS audits",
      )
    ).rows[0];
  assert.deepEqual(await counts(), { approvals: 1, audits: 1 });
  await run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (await tx.query("UPDATE rms_payment.ordinary_refund_approval SET claim_version=2")).rowCount,
      0,
    );
    assert.equal((await tx.query("DELETE FROM rms_payment.ordinary_refund_approval")).rowCount, 0);
  });
  await run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      id(99),
    ]);
    assert.equal(
      (await tx.query("SELECT approval_id FROM rms_payment.ordinary_refund_approval")).rows.length,
      0,
    );
  });
  const copied = await admin.query("SELECT * FROM rms_payment.ordinary_refund_approval");
  const row = copied.rows[0];
  assert.ok(row);
  await assert.rejects(
    run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, id(99)],
      );
      await tx.query(
        "INSERT INTO rms_payment.ordinary_refund_approval SELECT * FROM jsonb_populate_record(NULL::rms_payment.ordinary_refund_approval,$1::jsonb)",
        [JSON.stringify(row)],
      );
    }),
    (error) => error.code === "42501",
  );
  assert.deepEqual(await counts(), { approvals: 1, audits: 1 });
  await admin.query(
    "UPDATE bop_identity.workforce_mfa_status SET status='ResetRequired',verified_at=NULL,reset_at=$2,version=version+1 WHERE actor_id=$1",
    [id(2), new Date().toISOString()],
  );
  await assert.rejects(run((tx) => validate(tx, validationQuery)));
  await assert.rejects(
    run((tx) =>
      createPostgresOrdinaryRefundApprovalSource(options)(tx, {
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        approvalReference: id(30),
        approverReference: id(2),
        observedAt: new Date().toISOString(),
      }),
    ),
  );
  assert.deepEqual(await counts(), { approvals: 1, audits: 1 });
  return {
    async assertClaimChangeRejected() {
      // Restore this isolated fixture's verified MFA so denial is attributable
      // to changed claims, not the earlier reset scenario.
      await admin.query(
        "UPDATE bop_identity.workforce_mfa_status SET status='TotpVerified',verified_at=$2,reset_at=NULL,version=version+1 WHERE actor_id=$1",
        [id(2), at],
      );
      await run((tx) =>
        assertCurrentOrdinaryRefundApprovalAuthority(tx, prepared.approval, options.authority),
      );
      await assert.rejects(run((tx) => validate(tx, validationQuery)));
      assert.deepEqual(await counts(), { approvals: 1, audits: 1 });
    },
  };
}
