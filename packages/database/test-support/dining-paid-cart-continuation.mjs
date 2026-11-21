import { createSubmissionPricingFixture } from "./submission-pricing-fixture.mjs";
import { createPersistentAdditionalDiningPreparation } from "../../../apps/api/src/customer-additional-dining-preparation.ts";
import { createPostgresConfiguredPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import {
  createPostgresConfiguredCartQuoteStore,
  createPostgresDiningOrderPreparationSource,
} from "../../rms/ordering/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCustomerDiningCheckoutIdentity } from "../../../apps/api/src/customer-dining-checkout-composition.ts";
import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  createDiningCartItemService,
  createPostgresDiningCartCommandQueryStore,
  createPostgresBoundCartItemOperationStore,
  createPostgresCartItemCommandStore,
  createPostgresCartQueryStore,
} from "../../rms/ordering/src/index.ts";

/** Continue the paid Initial journey on its existing Cart and Dining session. */
export async function exerciseDiningPaidCartContinuation({
  admin,
  runner,
  roles,
  f,
  cart,
  scope,
  ownerScope,
  id,
  initialOrder,
  initialQuote,
}) {
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.cart_operation_record TO " + roles[2]);
  await admin.query("GRANT INSERT,UPDATE ON rms_ordering.cart_line TO " + roles[2]);
  const now = f.options.preparation.now;
  const transactions = runner(roles[2]);
  const carts = createPostgresCartQueryStore(transactions, scope);
  const emptied = await carts.load(cart.cartReference);
  assert(emptied);
  assert.equal(emptied.items.length, 0);
  assert.equal(emptied.diningSessionReference, cart.diningSessionReference);
  let sequence = 870000;
  const references = {
    generate: () => id(++sequence),
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  };
  const service = createDiningCartItemService({
    scope,
    now,
    sessions: createCustomerDiningCheckoutIdentity(f.options.preparation, scope, now),
    participation: createDiningCartParticipationQuery({
      scope,
      now,
      repository: createPostgresDiningParticipationStore(runner(roles[1]), ownerScope),
    }),
    references,
    catalog: f.options.checkout.catalog,
    repository: (bound) => ({
      load: createPostgresDiningCartCommandQueryStore(transactions, bound).load,
      resolveOperation: createPostgresBoundCartItemOperationStore(transactions, bound)
        .resolveOperation,
      commit: createPostgresCartItemCommandStore(transactions, scope, references).commit,
    }),
    audit: (input) => ({
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CART_ITEM_" + input.action.toUpperCase(),
      targetType: "OrderingCart",
      targetId: input.cartReference,
      reasonCode: "AUTHORIZED_CART_MUTATION",
      correlationId: input.operationReference,
      occurredAt: input.observedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
  const item = cart.items[0];
  const input = {
    sessionCredential: f.orderInput.sessionCredential,
    csrfCredential: f.orderInput.csrfCredential,
    cartReference: cart.cartReference,
    expectedAggregateVersion: emptied.aggregateVersion,
    sellableReference: item.sellableReference,
    quantity: item.quantity,
    optionSelections: item.optionSelections,
    customerNote: null,
    operationReference: id(++sequence),
  };
  const added = await service.add(input);
  assert.equal(added.status, "Applied");
  assert.equal(added.aggregateVersion, emptied.aggregateVersion + 1);
  assert.deepEqual(await service.add(input), { ...added, status: "AlreadyApplied" });
  const current = await carts.load(cart.cartReference);
  assert(current);
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].cartItemReference, added.cartItemReference);
  assert.equal(current.diningSessionReference, cart.diningSessionReference);
  assert.equal(current.aggregateVersion, added.aggregateVersion);
  if (initialQuote.quoteVersion !== 2) return current;
  const quotedAt = now();
  const pricing = initialOrder.items[0].pricing;
  const nextQuote = await createSubmissionPricingFixture(
    current,
    { ...pricing, quoteReference: id(++sequence), quotedAt },
    initialQuote.quoteExpiresAt,
    { admin, readerTransactions: runner(roles[7]), configured: true, reusePolicies: true },
  );
  await createPostgresConfiguredPriceQuoteStore(runner(roles[6]), scope, {
    generateReference: () => id(++sequence),
  }).append({
    quote: nextQuote,
    audit: {
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PRICING_QUOTE_CREATE",
      targetType: "PricingPriceQuote",
      targetId: nextQuote.quoteReference,
      reasonCode: "AUTHORIZED_CART_QUOTE",
      correlationId: id(++sequence),
      occurredAt: quotedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const operationReference = id(++sequence);
  const attachment = {
    ...initialQuote,
    cartVersion: current.aggregateVersion,
    quoteReference: nextQuote.quoteReference,
    operationReference,
    operationIntentHash: references.hashIntent(
      "AttachQuote:" +
        JSON.stringify({
          cartReference: current.cartReference,
          expectedCartVersion: current.aggregateVersion,
          operationReference,
          requestedAt: quotedAt,
        }),
    ),
    attachedAt: quotedAt,
    idempotencyExpiresAt: new Date(Date.parse(quotedAt) + 86400000).toISOString(),
    quoteCreatedAt: nextQuote.createdAt,
    quoteExpiresAt: nextQuote.expiresAt,
    quoteInputDigest: nextQuote.inputDigest,
    lines: nextQuote.lines.map((line) => ({
      lineReference: line.lineReference,
      sellableReference: line.sellableReference,
      productVersionReference: line.productVersionReference,
      menuVersionReference: line.menuVersionReference,
      quantity: line.quantity,
    })),
    subtotal: nextQuote.subtotal,
    discount: nextQuote.discount,
    tax: nextQuote.tax,
    fee: nextQuote.fee,
    total: nextQuote.total,
  };
  await createPostgresConfiguredCartQuoteStore(transactions, scope, references).attach({
    attachment,
    expectedCartVersion: current.aggregateVersion,
    audit: {
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CART_ATTACH_QUOTE",
      targetType: "OrderingCart",
      targetId: current.cartReference,
      reasonCode: "AUTHORIZED_CART_QUOTE",
      correlationId: operationReference,
      occurredAt: quotedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const source = createPostgresDiningOrderPreparationSource({
    ...scope,
    authorize: async () => true,
  });
  const orderReference = initialOrder.order.orderReference;
  const parent = await transactions.run((transaction) =>
    source.resolve({
      ...scope,
      transaction,
      diningSessionReference: current.diningSessionReference,
      guestSessionReference: f.identityRecord.session.sessionReference,
      orderReference,
      observedAt: now(),
    }),
  );
  assert(parent);
  assert(parent.orderVersion > 1);
  const preparation = createPersistentAdditionalDiningPreparation({
    transactions,
    authorizeOrder: async () => true,
    preparation: {
      ...f.options.preparation,
      references: { generate: () => id(++sequence) },
      dining: {
        ...f.options.preparation.dining,
        audit: {
          create: async (request) => ({
            ...(await f.options.preparation.dining.audit.create(request)),
            auditId: id(++sequence),
            correlationId: id(++sequence),
          }),
        },
      },
    },
  });
  const prepareInput = {
    sessionCredential: input.sessionCredential,
    csrfCredential: input.csrfCredential,
    orderReference,
    expectedOrderVersion: parent.orderVersion,
    intent: {
      submissionReference: id(++sequence),
      cartReference: current.cartReference,
      cartVersion: current.aggregateVersion,
      quoteReference: nextQuote.quoteReference,
      sourceValidUntil: nextQuote.expiresAt,
    },
  };
  const prepared = await preparation.prepareForOrdering(prepareInput);
  assert.equal(prepared.record.orderReference, orderReference);
  assert.equal(prepared.record.diningSessionReference, current.diningSessionReference);
  assert.notEqual(
    prepared.record.orderBatchReference,
    initialOrder.order.batches[0].orderBatchReference,
  );
  assert.equal(prepared.record.cartVersion, current.aggregateVersion);
  assert.equal(prepared.record.quoteReference, nextQuote.quoteReference);
  const replay = await preparation.prepareForOrdering(prepareInput);
  assert.deepEqual(replay.record, prepared.record);
  return { cart: current, quote: nextQuote, attachment, preparation: prepared, parent };
}
