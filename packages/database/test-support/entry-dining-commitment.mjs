import { allocateEntryDiningCheckout } from "./entry-dining-allocation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCustomerDiningCheckoutComposition } from "../../../apps/api/src/customer-dining-checkout-composition.ts";
import { createPostgresDiningCheckoutCommitmentStore } from "../../rms/dining/src/index.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Real Entry/Cart/Quote into owner Dining commitment. No payment clock or order is invented. */
export async function exerciseEntryDiningCommitment({
  currentClock = false,
  admin,
  role,
  run,
  scope,
  session,
  contexts,
  current,
  at,
  quote,
  cookie,
  csrfToken,
  guest,
  oldCookie,
}) {
  await admin.query("GRANT SELECT,INSERT ON rms_dining.dining_checkout_commitment TO " + role);
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  let sequence = 980000;
  const reference = () => id(++sequence);
  const repository = createPostgresDiningCheckoutCommitmentStore({ run }, scope, { now: () => at });
  const preparation = {
    scope: identityScope,
    session,
    contexts,
    now: () => at,
    dining: {
      current,
      repository,
      hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
      audit: {
        create: async ({ record, observedAt }) => ({
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "DINING_CHECKOUT_PREPARE",
          targetType: "DiningCheckoutCommitment",
          targetId: record.commitmentReference,
          occurredAt: observedAt,
          reasonCode: "AUTHORIZED_DINING_CHECKOUT",
          correlationId: record.submissionReference,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
  };
  const checkout = createCustomerDiningCheckoutComposition(preparation);
  const allocated = currentClock
    ? await allocateEntryDiningCheckout({
        admin,
        role,
        run,
        scope,
        session,
        contexts,
        quote,
        cookie,
        csrfToken,
        reference,
      })
    : null;
  const input = {
    sessionCredential: cookie.split("=")[1],
    csrfCredential: csrfToken,
    intent: {
      commitmentReference: reference(),
      cartReference: quote.cartReference,
      cartVersion: quote.cartVersion,
      quoteReference: quote.quoteReference,
      submissionReference: allocated?.allocation.submissionReference ?? reference(),
      orderReference: reference(),
      orderBatchReference: reference(),
      paymentOperationReference: allocated?.allocation.paymentOperationReference ?? reference(),
      sourceValidUntil: quote.quoteExpiresAt,
    },
  };
  assert.equal(quote.guestSessionReference, guest.sessionReference);
  const before = await admin.query(
    "SELECT count(*)::int n FROM rms_dining.dining_checkout_commitment",
  );
  const created = await checkout.prepareForOrdering(input);
  assert.equal(created.status, "Created");
  assert.equal(created.record.guestSessionReference, guest.sessionReference);
  assert.equal(created.record.diningSessionReference, guest.diningSessionReference);
  assert.equal(created.record.participantReference, guest.diningParticipantReference);
  assert.equal(created.record.cartReference, quote.cartReference);
  assert.equal(created.record.cartVersion, quote.cartVersion);
  assert.equal(created.record.quoteReference, quote.quoteReference);
  assert.equal(created.record.state, "Prepared");
  const replay = await checkout.prepareForOrdering(input);
  assert.equal(replay.status, "Existing");
  assert.deepEqual(replay.record, created.record);
  assert.deepEqual(replay.link, created.link);
  assert.deepEqual(
    await repository.loadSubmission(input.intent.submissionReference),
    created.record,
  );
  await assert.rejects(
    checkout.prepareForOrdering({
      ...input,
      sessionCredential: oldCookie.split("=")[1],
    }),
    { code: "GUEST_SESSION_UNAVAILABLE" },
  );
  const after = await admin.query(
    "SELECT count(*)::int n FROM rms_dining.dining_checkout_commitment",
  );
  assert.equal(after.rows[0].n, before.rows[0].n + 1);
  return {
    allocated,
    checkout,
    input,
    record: created.record,
    link: created.link,
    preparation: {
      ...preparation,
      submissions: repository,
      references: {
        generate: (purpose) =>
          purpose === "PaymentOperation" ? input.intent.paymentOperationReference : reference(),
      },
    },
  };
}
