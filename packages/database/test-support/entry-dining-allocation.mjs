import assert from "node:assert/strict";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { createPostgresDiningGuestBindingStore } from "../../rms/dining/src/index.ts";
import { createPostgresCheckoutSessionAllocationStore } from "../../rms/ordering/src/index.ts";

/** Current database-clock allocation over the actual Entry Guest/Cart; not a CheckoutSession completion. */
export async function allocateEntryDiningCheckout({
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
}) {
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.checkout_session_allocation TO " + role);
  const options = entryDiningCheckoutAccessOptions({ run, scope, session, contexts });
  const identityScope = options.scope;
  const now = options.now;
  const access = createCustomerCheckoutSessionAuthorization(options, {
    sessionCredential: cookie.split("=")[1],
    csrfCredential: csrfToken,
    cartReference: quote.cartReference,
  });
  const request = {
    createOperationReference: reference(),
    cartReference: quote.cartReference,
    cartVersion: quote.cartVersion,
    quoteReference: quote.quoteReference,
    quoteVersion: 1,
  };
  const authority = await access.authorize(request, now());
  assert(authority, "current Entry Guest must authorize allocation");
  const proposal = {
    ...identityScope,
    ...request,
    guestSessionReference: authority.guestSessionReference,
    checkoutSessionReference: reference(),
    submissionReference: reference(),
    paymentOperationReference: reference(),
    allocatedAt: now(),
  };
  const store = createPostgresCheckoutSessionAllocationStore({ run }, identityScope, {
    authorize: access.authorizeInTransaction,
    audit: (record) => ({
      auditId: reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CHECKOUT_SESSION_ALLOCATE",
      reasonCode: "AUTHORIZED_CHECKOUT_CREATE",
      targetType: "CheckoutSession",
      targetId: record.checkoutSessionReference,
      occurredAt: record.allocatedAt,
      correlationId: record.createOperationReference,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "SYNTHETIC_RETENTION",
      retentionPolicyVersion: 1,
    }),
  });
  const allocation = await store.allocate(proposal, authority);
  assert.equal(allocation.guestSessionReference, quote.guestSessionReference);
  assert.equal(allocation.cartReference, quote.cartReference);
  assert.equal(allocation.cartVersion, quote.cartVersion);
  assert.equal(allocation.quoteReference, quote.quoteReference);
  const replay = await store.allocate(
    {
      ...proposal,
      checkoutSessionReference: reference(),
      submissionReference: reference(),
      paymentOperationReference: reference(),
      allocatedAt: now(),
    },
    authority,
  );
  assert.deepEqual(replay, allocation);
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) allocations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_CHECKOUT_SESSION_ALLOCATE') audits",
  );
  assert.deepEqual(counts.rows[0], { allocations: 1, audits: 1 });
  return { allocation, request, options };
}

export function entryDiningCheckoutAccessOptions({ run, scope, session, contexts }) {
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  let applicationTime;
  const now = () => (applicationTime = new Date().toISOString());
  const transactions = {
    run: (work) =>
      run(async (tx) => {
        let clockBoundary;
        try {
          return await work({
            ...tx,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.includes("clock_timestamp()") && result.rows?.[0]?.observed_at) {
                const databaseTime = Date.parse(result.rows[0].observed_at);
                clockBoundary = {
                  databaseAfterApplicationMs: databaseTime - Date.parse(applicationTime),
                  responseAfterDatabaseMs: Date.now() - databaseTime,
                };
              }
              return result;
            },
          });
        } catch (error) {
          if (error?.code === "PERMISSION_DENIED" && clockBoundary)
            throw new Error("Entry checkout clock boundary " + JSON.stringify(clockBoundary), {
              cause: error,
            });
          throw error;
        }
      }),
  };
  return {
    scope: identityScope,
    transactions,
    credentials: session.credentials,
    now,
    binding: (tx) =>
      createCustomerDiningSessionBinding({
        scope: identityScope,
        binding: session.binding,
        contexts,
        now,
        repository: createPostgresDiningGuestBindingStore({ run: (work) => work(tx) }, scope),
      }),
  };
}
