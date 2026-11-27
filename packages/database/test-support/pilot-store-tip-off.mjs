import assert from "node:assert/strict";
import {
  createMerchantStoreFeatures,
  readStoreTipChoices,
  tipRefusal,
} from "../../../apps/api/dist/merchant-store-features.js";
import {
  createPostgresPaymentTipSelectionStore,
  PaymentTipSelectionError,
} from "../../rms/payment/src/index.ts";
import { readPublishedStoreTipOff } from "../../rms/store/src/index.ts";

/**
 * Runs on a Store whose published configuration has Tip Off and that never touched the Store
 * features tip switch: Stores 2 and 3 on v15. A Store with nothing published says nothing.
 */
export async function exercisePilotStoreTipOff(context) {
  const { admin, scope, store, next, now, transactions, listen, session, id } = context;
  const here = { brandReference: scope.brandReference, storeReference: store };
  const settings = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM rms_payment.store_tip_setting WHERE brand_id=$1 AND store_id=$2",
          [scope.brandReference, store],
        )
      ).rows[0].n,
    );
  assert.equal(await settings(), 0);

  // 1. What guests' quotes, the counter and table checkout read: off, and nothing but "no tip".
  const choices = await transactions.run((tx) => readStoreTipChoices(tx, here));
  assert.equal(choices.enabled, false);
  assert.equal(tipRefusal(choices, { kind: "Percent", percent: 15 }), "TipsOff");
  assert.equal(tipRefusal(choices, { kind: "Amount", amountMinor: "139" }), "TipsOff");
  assert.equal(tipRefusal(choices, { kind: "None" }), null);

  // 2. As it was before this configuration was published: a payment recorded after an outage.
  const before = await transactions.run((tx) =>
    readPublishedStoreTipOff(tx, here, "2020-01-01T00:00:00.000Z"),
  );
  assert.equal(before, false);

  // 3. A guest's screen that still offers a tip can't add one; no tip goes through this check.
  const tips = createPostgresPaymentTipSelectionStore(transactions, here, { now }, (tx) =>
    readPublishedStoreTipOff(tx, here),
  );
  const record = {
    selectionReference: next(),
    paymentOperationReference: next(),
    submissionReference: next(),
    cartReference: next(),
    cartVersion: 1,
    quoteReference: next(),
    guestSessionReference: next(),
    brandReference: scope.brandReference,
    storeReference: store,
    tip: { amountMinor: 139n, currencyCode: "CAD" },
    selectedAt: now(),
  };
  const audit = {
    auditId: next(),
    brandId: scope.brandReference,
    storeId: store,
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
  };
  await assert.rejects(tips.append({ record, audit }), (error) => {
    assert.ok(error instanceof PaymentTipSelectionError, String(error?.message));
    assert.equal(error.code, "PAYMENT_TIP_TURNED_OFF");
    return true;
  });

  // 4. Another Store with nothing published: the Store features setting still rules.
  const other = { brandReference: scope.brandReference, storeReference: id(0x9e77) };
  assert.equal((await transactions.run((tx) => readStoreTipChoices(tx, other))).enabled, true);

  // 5. Who opens Store features is told why, and nothing was written to the tip setting.
  await listen(
    session,
    async (send) => {
      const opened = await send("store/features", { action: "Read" });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.tips.offInStoreSetup, true);
      assert.equal(opened.body.tips.enabled, true);
    },
    (persistence, authentication) => ({
      storeFeatures: createMerchantStoreFeatures({ persistence, authentication, now }),
    }),
  );
  assert.equal(await settings(), 0);
}
