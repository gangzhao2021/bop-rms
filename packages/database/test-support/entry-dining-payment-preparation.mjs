import assert from "node:assert/strict";
import { createCustomerDiningSessionTipSelection } from "../../../apps/api/src/customer-session-tip-selection.ts";
import { createPostgresPaymentTipSelectionStore } from "../../rms/payment/src/index.ts";

/** Actual Entry Order and original session identities; synthetic explicit zero tip. */
export async function exerciseEntryDiningPaymentPreparation({
  admin,
  role,
  run,
  scope,
  commitment,
  checkout,
  order,
  oldCookie,
  reference,
}) {
  await admin.query("GRANT USAGE ON SCHEMA rms_payment TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_tip_selection TO " + role);
  const now = commitment.allocated.options.now;
  const repository = createPostgresPaymentTipSelectionStore({ run }, scope, { now });
  const tips = createCustomerDiningSessionTipSelection(commitment.allocated.options, {
    submission: order.options,
    tip: {
      repository,
      audit: {
        create: async (record) => ({
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_TIP_SELECT",
          targetType: "PaymentTipSelection",
          targetId: record.selectionReference,
          reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
          correlationId: record.submissionReference,
          occurredAt: record.selectedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
  });
  const input = {
    ...order.input,
    selectionReference: reference(),
    tip: { amountMinor: 0n, currencyCode: "CAD" },
  };
  const selected = await tips.select(input);
  assert.equal(selected.status, "Created");
  assert.deepEqual(selected.session, checkout.session);
  assert.equal(
    selected.record.paymentOperationReference,
    checkout.session.paymentOperationReference,
  );
  assert.equal(selected.record.submissionReference, order.record.submissionReference);
  const recovered = await tips.select(input);
  assert.equal(recovered.status, "Existing");
  assert.deepEqual(recovered.record, selected.record);
  await assert.rejects(tips.select({ ...input, tip: { amountMinor: 1n, currencyCode: "CAD" } }));
  const sealed = await order.service.preparePaymentClock(order.input);
  assert.deepEqual(sealed.order, order.record);
  assert.equal(sealed.clock.state, "PaymentPending");
  assert.equal(sealed.clock.paymentOperationReference, checkout.session.paymentOperationReference);
  assert.equal(sealed.clock.submissionReference, order.record.submissionReference);
  assert.equal(
    Date.parse(sealed.clock.capacityExpiresAt) - Date.parse(sealed.clock.paymentRequestedAt),
    30 * 60 * 1000,
  );
  const replay = await order.service.preparePaymentClock(order.input);
  assert.deepEqual(replay.clock, sealed.clock);
  await assert.rejects(
    order.service.preparePaymentClock({
      ...order.input,
      sessionCredential: oldCookie.split("=")[1],
    }),
  );
  await assert.rejects(
    tips.select({
      ...input,
      sessionCredential: oldCookie.split("=")[1],
    }),
  );
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_payment.payment_tip_selection) tips,(SELECT count(*)::int FROM rms_dining.dining_checkout_commitment) commitments",
  );
  assert.deepEqual(counts.rows[0], { tips: 1, commitments: 2 });
  return { tips, input, selected: selected.record, clock: sealed.clock };
}
