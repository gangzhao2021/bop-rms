import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPostgresPaymentCompensationSource } from "../../rms/payment/src/index.ts";
import { paymentCompensationSourceSnapshotContent } from "../../rms/payment/src/application/paid-without-fulfillable-order.ts";
export async function exerciseCompensationSource({ admin, runner, role, scope, fact }) {
  await admin.query(
    "GRANT SELECT ON rms_payment.ordinary_refund_request,rms_payment.payment_compensation_refund,rms_payment.payment_compensation_action_history TO " +
      role,
  );
  const request = {
    brandReference: fact.brandReference,
    storeReference: fact.storeReference,
    orderReference: fact.orderReference,
    paymentTransactionReference: fact.paymentTransactionReference,
    paymentIntentReference: fact.paymentIntentReference,
    paymentAttemptReference: fact.paymentAttemptReference,
  };
  const now = new Date().toISOString();
  const owner = (extra = {}) =>
    createPostgresPaymentCompensationSource({
      tenantReference: scope.brandReference,
      transactions: runner,
      scope,
      clock: { now: () => now },
      authorize: async () => true,
      // Explicit synthetic other-owner fixture; no production zero default.
      otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
      ...extra,
    });
  const source = owner();
  const identity = await source.resolveIdentity(request);
  assert.ok(identity);
  const input = {
    ...request,
    environment: identity.environment,
    identityVersion: identity.identityVersion,
    identityDigest: identity.identityDigest,
  };
  const result = await source.resolve(input);
  assert.ok(result);
  assert.deepEqual(result.capturedAmount, fact.amount);
  assert.equal(result.confirmedRefundedAmount.amountMinor, 0n);
  assert.equal(result.pendingRefundClaimedAmount.amountMinor, 0n);
  assert.equal(result.terminalEvidenceDigest, fact.evidenceDigest);
  assert.equal(result.originalPaymentMethod, "OnlineCard");
  assert.deepEqual(await source.resolve(input), result);
  assert.equal(
    result.sourceSnapshotDigest,
    "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify(paymentCompensationSourceSnapshotContent(result), (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
          ),
        )
        .digest("hex"),
  );
  assert.equal(await source.resolve({ ...input, identityVersion: 2 }), null);
  assert.equal(
    await source.resolve({ ...input, identityDigest: "sha256:" + "f".repeat(64) }),
    null,
  );
  const partial = await owner({
    otherRefunds: async () => ({ confirmedMinor: 1n, pendingMinor: 2n, version: 2 }),
  }).resolve(input);
  assert.equal(partial.confirmedRefundedAmount.amountMinor, 1n);
  assert.equal(partial.pendingRefundClaimedAmount.amountMinor, 2n);
  assert.ok(partial.sourceVersion > result.sourceVersion);
  await assert.rejects(
    owner({
      otherRefunds: async () => ({
        confirmedMinor: fact.amount.amountMinor,
        pendingMinor: 1n,
        version: 2,
      }),
    }).resolve(input),
  );
  await assert.rejects(
    owner({
      otherRefunds: async () => {
        throw Error("synthetic source unavailable");
      },
    }).resolve(input),
  );
  await assert.rejects(owner({ authorize: async () => false }).resolve(input), {
    code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
  });
  let allowed = true;
  await assert.rejects(
    owner({
      authorize: async () => allowed,
      otherRefunds: async () => {
        allowed = false;
        return { confirmedMinor: 0n, pendingMinor: 0n, version: 1 };
      },
    }).resolve(input),
    { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
  );
}
