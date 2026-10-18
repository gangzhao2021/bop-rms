import assert from "node:assert/strict";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import { createCustomerConfiguredDiningSessionValidation } from "../../../apps/api/src/customer-dining-session-validation.ts";
import { createCustomerDiningCheckoutDetailsComposition } from "../../../apps/api/src/customer-checkout-details-composition.ts";
import { createCustomerAdditionalDiningSessionTipSelection } from "../../../apps/api/src/customer-session-tip-selection.ts";
import { createCustomerAdditionalDiningSessionClock } from "../../../apps/api/src/customer-additional-dining-session-clock.ts";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../../apps/api/src/customer-additional-dining-history-authorization.ts";
import { createCustomerAdditionalDiningSessionSubmission } from "../../../apps/api/src/customer-additional-dining-session-submission.ts";
import {
  createPostgresCheckoutSessionAllocationStore,
  createPostgresCheckoutDetailsStore,
  createPostgresConfiguredCartQuoteStore,
  createPostgresCartQueryStore,
  createPostgresDiningOrderPreparationSource,
} from "../../rms/ordering/src/index.ts";

/** Same real Initial Order; only Store/policy/Provider fixtures remain synthetic. */
export async function exerciseDiningSecondBatchSubmission({
  admin,
  runner,
  roles,
  f,
  scope,
  ownerScope,
  id,
  continuation,
  sessionAccessOptions,
  initialOrder,
  stock,
  workflow,
  orderSourceOptions,
}) {
  const { cart, attachment, preparation, parent } = continuation;
  const owner = preparation.record;
  let stage = "append";
  let sqlFailure = "none";
  let lastTable = "none";
  const transactions = {
    run: (work) =>
      runner(roles[2]).run((tx) =>
        work({
          query: async (sql, values) => {
            const table = /(?:FROM|INTO|UPDATE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1];
            if (table) lastTable = table;
            try {
              return await tx.query(sql, values);
            } catch (error) {
              sqlFailure = /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown";
              throw error;
            }
          },
        }),
      ),
  };
  const now = f.options.preparation.now;
  const credentials = {
    sessionCredential: f.orderInput.sessionCredential,
    csrfCredential: f.orderInput.csrfCredential,
  };
  let sequence = 880000;
  const reference = () => id(++sequence);
  const audit = (actionCode, targetType, targetId, occurredAt, reasonCode) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    reasonCode,
    correlationId: reference(),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const request = {
    createOperationReference: reference(),
    cartReference: cart.cartReference,
    cartVersion: cart.aggregateVersion,
    quoteReference: attachment.quoteReference,
    quoteVersion: 2,
  };
  const access = createCustomerCheckoutSessionAuthorization(sessionAccessOptions, {
    ...credentials,
    cartReference: cart.cartReference,
  });
  const authority = await access.authorize(request, sessionAccessOptions.now());
  assert(authority);
  const allocationAudit = (record) =>
    audit(
      "ORDERING_CHECKOUT_SESSION_ALLOCATE",
      "CheckoutSession",
      record.checkoutSessionReference,
      record.allocatedAt,
      "AUTHORIZED_CHECKOUT_CREATE",
    );
  await createPostgresCheckoutSessionAllocationStore(transactions, scope, {
    authorize: access.authorizeInTransaction,
    audit: allocationAudit,
  }).allocate(
    {
      ...scope,
      ...request,
      guestSessionReference: owner.guestSessionReference,
      checkoutSessionReference: reference(),
      submissionReference: owner.submissionReference,
      paymentOperationReference: owner.paymentOperationReference,
      allocatedAt: now(),
    },
    authority,
  );
  const quotes = createPostgresConfiguredCartQuoteStore(transactions, scope, {
    hashIntent: f.options.checkout.references.hashIntent,
    equals: (a, b) => a === b,
  });
  const checkout = {
    ...f.options.checkout,
    repository: {
      loadCart: createPostgresCartQueryStore(transactions, scope).load,
      loadQuote: (cartReference) =>
        quotes.loadLatest({
          cartReference,
          cartVersion: cart.aggregateVersion,
          observedAt: now(),
        }),
    },
  };
  const creator = createCustomerCheckoutSessionComposition({
    ...sessionAccessOptions,
    quoteVersion: 2,
    nextReference: reference,
    allocationAudit,
    audit: (record) =>
      audit(
        "ORDERING_CHECKOUT_SESSION_CREATE",
        "CheckoutSession",
        record.checkoutSessionReference,
        record.createdAt,
        "AUTHORIZED_CHECKOUT_CREATE",
      ),
    validate: createCustomerConfiguredDiningSessionValidation({
      preparation: f.options.preparation,
      checkout,
    }),
  });
  const envelope = { ...credentials, command: request };
  const created = await creator.create(envelope);
  assert.equal(created.status, "Created");
  assert.equal(created.session.submissionReference, owner.submissionReference);
  assert.deepEqual((await creator.create(envelope)).session, created.session);
  const policies = {
    current: async (input) => ({
      ...scope,
      orderType: "DineIn",
      checkedAt: input.observedAt,
      validUntil: attachment.quoteExpiresAt,
      required: [],
    }),
  };
  const details = createCustomerDiningCheckoutDetailsComposition({
    scope,
    quoteVersion: 2,
    cartTransactions: transactions,
    detailsTransactions: transactions,
    identity: f.options.preparation,
    now,
    policies,
    audit: async (input) =>
      audit(
        "ORDERING_CHECKOUT_DETAILS_SAVE",
        "CheckoutDetails",
        input.detailsReference,
        input.observedAt,
        "AUTHORIZED_CHECKOUT_UPDATE",
      ),
  });
  const priorDetails = await createPostgresCheckoutDetailsStore(transactions, scope).loadLatest(
    cart.cartReference,
    owner.guestSessionReference,
  );
  assert(priorDetails);
  const saved = await details.save({
    ...credentials,
    command: {
      operationReference: reference(),
      detailsReference: priorDetails.detailsReference,
      expectedVersion: priorDetails.detailsVersion,
      cartReference: cart.cartReference,
      cartVersion: cart.aggregateVersion,
      quoteReference: attachment.quoteReference,
      quoteVersion: 2,
      pickupContact: null,
      receipt: { choice: "InSession", email: null },
      policies: [],
    },
  });
  assert.equal(saved.status, "Saved");
  assert.equal(saved.snapshot.detailsVersion, priorDetails.detailsVersion + 1);
  await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_tip_selection TO " + roles[2]);
  const tipOptions = {
    preparation: f.options.preparation,
    transactions,
    authorizeOrder: async () => true,
    quoteVersion: 2,
    tip: {
      audit: {
        create: async (record) =>
          audit(
            "PAYMENT_TIP_SELECT",
            "PaymentTipSelection",
            record.selectionReference,
            record.selectedAt,
            "AUTHORIZED_PAYMENT_TIP_SELECT",
          ),
      },
    },
  };
  const tips = createCustomerAdditionalDiningSessionTipSelection(sessionAccessOptions, tipOptions, {
    orderReference: owner.orderReference,
    expectedOrderVersion: parent.orderVersion,
  });
  const tip = await tips.select({
    ...credentials,
    checkoutSessionReference: created.session.checkoutSessionReference,
    selectionReference: reference(),
    tip: { amountMinor: 0n, currencyCode: "CAD" },
  });
  f.setTime(new Date().toISOString());
  const evidence = created.session.validation;
  const loaded = await f.options.ordering.source.load({ evidence });
  assert(now() > evidence.validatedAt);
  const parents = createPostgresDiningOrderPreparationSource({
    ...scope,
    // Synthetic fixture authority; actual Guest/current Dining authorization remains in submission.
    authorize: async (_tx, input) =>
      String(input.guestSessionReference) === String(owner.guestSessionReference),
  });
  const currentParent = await transactions.run((transaction) =>
    parents.resolveAdditionalParent({
      transaction,
      ...scope,
      orderReference: owner.orderReference,
      diningSessionReference: cart.diningSessionReference,
      guestSessionReference: owner.guestSessionReference,
      observedAt: now(),
    }),
  );
  assert(currentParent);
  assert.equal(currentParent.orderVersion, parent.orderVersion);
  assert.equal(currentParent.originalOrderCreatedAt, initialOrder.createdAt);
  assert.equal(currentParent.nextBatchSequence, 2);
  await admin.query("GRANT INSERT ON rms_ordering.additional_dining_batch_record TO " + roles[2]);
  await admin.query("GRANT SELECT,INSERT ON rms_dining.dining_checkout_commitment TO " + roles[2]);
  // PostgreSQL requires UPDATE privilege to acquire the owner's row locks.
  await admin.query("GRANT UPDATE(table_id) ON rms_dining.dining_table TO " + roles[2]);
  await admin.query("GRANT UPDATE(session_id) ON rms_dining.dining_session TO " + roles[2]);
  await admin.query("GRANT UPDATE(participant_id) ON rms_dining.dining_participant TO " + roles[2]);
  const runtimeOptions = {
    ...scope,
    transactions,
    identity: () => f.options.preparation,
    currentPolicies: async (_tx, input) => policies.current(input),
    audit: async () =>
      audit(
        "ORDERING_ADDITIONAL_BATCH_SUBMIT",
        "OrderingOrderBatch",
        owner.orderBatchReference,
        now(),
        "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
      ),
    eventReference: reference,
    inventory: {
      scope: ownerScope,
      stockSiteReference: stock.stockSiteReference,
      workflow,
      authorize: async (_tx, input) => input.actorReference === owner.guestSessionReference,
      resolveExpiryCutoff: stock.resolveExpiryCutoff,
      generateReference: reference,
      audit: {
        reasonCode: "SYNTHETIC_SUBMISSION",
        sourceChannel: "CUSTOMER_PWA",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      },
    },
    diningSealAudit: async (record) => {
      stage = "dining-seal";
      return audit(
        "DINING_CHECKOUT_SEAL",
        "DiningCheckoutCommitment",
        record.commitmentReference,
        record.paymentRequestedAt,
        "AUTHORIZED_DINING_CHECKOUT",
      );
    },
    validateCurrent: async (_tx, candidate, link, context) => {
      stage = "current-assertions";
      assert.equal(candidate.orderReference, owner.orderReference);
      assert.equal(candidate.batchSequence, currentParent.nextBatchSequence);
      assert.equal(candidate.batch.sourceCartReference, cart.cartReference);
      assert.equal(candidate.items.length, loaded.lines.length);
      assert.deepEqual(link, preparation.link);
      assert.equal(context.cart.aggregateVersion, cart.aggregateVersion);
      stage = "inventory";
    },
  };
  const authorizeHistory = createCustomerAdditionalDiningHistoryAuthorization(
    { scope: ownerScope, identity: () => f.options.preparation },
    credentials,
  );
  const submission = createCustomerAdditionalDiningSessionSubmission({
    access: sessionAccessOptions,
    runtime: runtimeOptions,
    source: orderSourceOptions,
    historyAuthorization: authorizeHistory,
    parent: {
      orderReference: currentParent.orderReference,
      originalOrderCreatedAt: currentParent.originalOrderCreatedAt,
      expectedOrderVersion: currentParent.orderVersion,
      batchSequence: currentParent.nextBatchSequence,
    },
    nextItemReference: reference,
  });
  const submitInput = {
    ...credentials,
    checkoutSessionReference: created.session.checkoutSessionReference,
    tipSelectionReference: tip.record.selectionReference,
  };
  let submitted;
  try {
    submitted = await submission.create(submitInput);
  } catch (error) {
    throw new Error(
      "second batch failed at " + stage + "; table " + lastTable + "; SQLSTATE " + sqlFailure,
      {
        cause: error,
      },
    );
  }
  assert.equal(submitted.status, "Created");
  const replay = await submission.create(submitInput);
  assert.equal(replay.status, "AlreadyCreated");
  assert.deepEqual(replay.record, submitted.record);
  const snapshot = submitted.record;
  const cleared = await createPostgresCartQueryStore(transactions, scope).load(cart.cartReference);
  assert.equal(cleared.items.length, 0);
  assert.equal(cleared.aggregateVersion, cart.aggregateVersion + 1);
  const finals = await admin.query(
    "SELECT count(*)::int AS n,count(DISTINCT submission_id)::int AS submissions FROM rms_inventory.submission_final_validation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND order_id=$4",
    [ownerScope.tenantReference, scope.brandReference, scope.storeReference, owner.orderReference],
  );
  assert.deepEqual(finals.rows[0], { n: 2, submissions: 2 });
  const clock = createCustomerAdditionalDiningSessionClock({
    access: sessionAccessOptions,
    scope: ownerScope,
    transactions,
    authorizeHistory,
    now,
  });
  return {
    submitted,
    snapshot,
    tip,
    checkout: created.session,
    sessionPayment: {
      access: sessionAccessOptions,
      orders: { create: submission.create, preparePaymentClock: clock.preparePaymentClock },
      tips,
      input: {
        ...submitInput,
        selectionReference: tip.record.selectionReference,
        tip: tip.record.tip,
      },
    },
  };
}
