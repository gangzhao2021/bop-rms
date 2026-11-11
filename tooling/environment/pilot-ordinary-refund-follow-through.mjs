import { createOrdinaryRefundProcessing } from "../../apps/api/dist/ordinary-refund-processing.js";
import { hasDigitalReceipt } from "../../apps/api/dist/refund-receipt-issuance.js";
import { createOrdinaryRefundFailureRecorder } from "../../apps/api/dist/ordinary-refund-failure-recorder.js";
import { createMerchantOrdinaryRefundRuntimeOptions } from "../../apps/api/dist/merchant-ordinary-refund-operation.js";
import { createOrdinaryRefundWorkload } from "../../apps/worker/dist/ordinary-refund-workload.js";
import { supervisedCycleFailures } from "../../apps/worker/dist/outbox-workload.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
} from "../../packages/bop/identity/src/index.ts";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
  parseBrandReference,
  parseStoreReference,
} from "../../packages/bop/tenant/src/index.ts";
import { listOrdinaryRefundApprovalReferences } from "../../packages/rms/payment/src/index.ts";
import { notAfterDatabaseNow } from "./pilot-database-clock.mjs";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";

const refundPermissions = [
  "payment.refund.request",
  "payment.refund.approve",
  "payment.refund.execute",
];
const denied = () => {
  throw new Error("INTERNAL_REFUND_FOLLOW_THROUGH_DENIED");
};

/**
 * WP-2423 M16 (DEC-OWNER-DEFAULTS-2026-11-06 item 3, Owner default "the system sends it at once
 * after approval"): workforce facts for a refund a person already prepared, with no session. The
 * recorded requester, approver and executor are each resolved through their owners for that
 * person: an active Workforce actor whose Membership, Store assignment, Permission and MFA are then
 * read by the workforce authority source. This is the deliberate amendment to "execution is never
 * resolved for anyone but the signed-in actor" (pilot-refund-workforce.mjs): the system finishes
 * what the executor already authorized; it never prepares a refund itself.
 */
export function createFollowThroughWorkforceContext({ scope, now, validUntil }) {
  return async (tx, query) => {
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (query[key] !== scope[key]) denied();
    if (!refundPermissions.includes(query.permissionCode)) denied();
    const observedAt = parseCanonicalInstant(query.observedAt);
    if (!(await notAfterDatabaseNow(tx, observedAt)) || now() >= validUntil()) denied();
    const organizations = createPostgresMerchantOrganizationSource(tx, {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      observedAt,
    });
    const brand = await organizations.getBrand(parseBrandReference(scope.brandReference));
    const store = await organizations.getStore(parseStoreReference(scope.storeReference));
    if (!brand || !store) denied();
    const actor = createIdentityActor({
      actorType: "User",
      actorReference: query.actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    });
    return {
      tenantReference: scope.tenantReference,
      context: createTenantContext(actor, brand, store, observedAt),
    };
  };
}

/**
 * WP-2423 M16: the follow-through for one Store, with no session: discovery of refunds a person
 * prepared, their dispatch (requester, approval and executor re-checked through their owners),
 * the result check and the refund receipt. `active` gates every owner callback.
 */
export function createOrdinaryRefundFollowThrough({
  scope,
  transactions,
  now,
  validUntil,
  reference: ref,
  active,
  store,
  providerAccountReference,
  environment,
  provider,
  loadRoleMapping,
  /** Refreshes the order's Provider observations before its refund receipt (pilot: simulator). */
  refreshObservations = async () => undefined,
  /** Receipt coverage is fresh after this instant (default: the refresh just made). */
  receiptFreshAfter = null,
}) {
  let refreshedFrom = null;
  const inScope = (query) =>
    ["tenantReference", "brandReference", "storeReference"].every(
      (key) => query?.[key] === undefined || query[key] === scope[key],
    );
  const authorize = async (_tx, query) => active() && inScope(query);
  const resolveContext = createFollowThroughWorkforceContext({ scope, now, validUntil });
  const dispatch = createMerchantOrdinaryRefundRuntimeOptions({
    scope,
    providerAccountReference,
    environment,
    authorize,
    workforce: {
      resolveContext,
      resolveRoleMapping: async (tx, query) => {
        if (!inScope(query) || !(await notAfterDatabaseNow(tx, query.observedAt))) denied();
        return loadRoleMapping();
      },
      stepUp: true,
      soleOperator: true,
    },
    store: { ...scope, ...store, authorize: (tx, at) => notAfterDatabaseNow(tx, at) },
  });
  const receiptAuthorize = async (_tx, query) =>
    active() &&
    query.brandReference === scope.brandReference &&
    query.storeReference === scope.storeReference;
  const processing = createOrdinaryRefundProcessing({
    payment: {
      dispatch,
      transactions,
      provider,
      authorizeRecovery: authorize,
      generateObservationIdentity: () => ({
        observationReference: ref(),
        auditReference: ref(),
      }),
    },
    authorizeDiscovery: authorize,
    dispatchIdentities: async (candidate) => ({
      dispatchReference: ref(),
      auditReference: ref(),
      // The request's latest approval, when it needed one (re-checked at dispatch).
      approvalReference:
        (
          await transactions.run((tx) =>
            listOrdinaryRefundApprovalReferences(tx, scope, {
              orderReference: candidate.orderReference,
              requestReference: candidate.requestReference,
            }),
          )
        )[0] ?? null,
    }),
    dispatchAudit: {
      // WP-2423 M16: the system finishing a refund a person prepared.
      reasonCode: "REFUND_REQUEST_EXECUTION",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
    receipt: {
      scope: { ...scope, providerAccountReference, environment },
      authorize: receiptAuthorize,
      authorizeSources: receiptAuthorize,
      authorizeOrder: receiptAuthorize,
      identities: () => ({ recordReference: ref(), operationReference: ref() }),
      audit: async (record, operationReference) => ({
        auditId: ref(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DIGITAL_RECEIPT_APPEND",
        targetType: "DigitalReceipt",
        targetId: record.recordReference,
        reasonCode: "INTERNAL_TEST_REFUND_RECEIPT",
        correlationId: operationReference,
        occurredAt: record.recordedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
    now,
    receiptFreshAfter: (observedAt) =>
      receiptFreshAfter !== null ? receiptFreshAfter(observedAt) : (refreshedFrom ?? observedAt),
  });
  const recordFailure = createOrdinaryRefundFailureRecorder({
    scope,
    transactions,
    authorize: async () => active(),
    newAuditReference: ref,
    now,
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  // The refund receipt, for an order that has a digital receipt (a counter order keeps the
  // machine's slip), after a fresh look at its payments.
  const receipt = async (candidate, result) => {
    const has = await transactions.run((tx) =>
      hasDigitalReceipt(tx, {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        orderReference: candidate.orderReference,
        authorize: async () => active(),
      }),
    );
    if (!has) return;
    refreshedFrom = now();
    await refreshObservations(candidate.orderReference);
    await processing.afterReconcile({ ...candidate, workKind: "Reconcile" }, result);
  };
  const reconciled = new Set(["AlreadyCommitted", "AlreadyConfirmed"]);
  return Object.freeze({
    discover: processing.discover,
    // Sent once (the dispatch journal), then its result is checked and the receipt issued, as
    // after a person's Send.
    async dispatch(candidate) {
      const sent = await processing.dispatch(candidate);
      const check = { ...candidate, workKind: "Reconcile" };
      await receipt(check, await processing.reconcile(check));
      return sent;
    },
    reconcile: processing.reconcile,
    // A result this pass established gets its receipt; one already known was handled then.
    async afterReconcile(candidate, result) {
      if (!reconciled.has(result?.status)) await receipt(candidate, result);
    },
    recordFailure,
  });
}

/**
 * WP-2423 M16: the business worker sends ordinary refunds that were prepared but not sent (the
 * browser was closed, or the send after an approval failed), and checks the result of refunds sent
 * and not confirmed yet, issuing the refund receipt. It never prepares, so a request nobody with
 * `payment.refund.execute` prepared (a cashier's) is never sent by the system. A dispatch is
 * journaled once per operation (1400_017), so a second run or a person's Send never sends twice.
 * A failure is recorded (Audit) and the refund stays listed as not sent for staff.
 */
export function createInternalOrdinaryRefundFollowThroughWorkload(
  resources,
  onSnapshot,
  {
    providerAccountReference,
    provider,
    loadRoleMapping,
    refreshObservations = async () => undefined,
    pollIntervalMs = 30000,
  },
) {
  const followThrough = createOrdinaryRefundFollowThrough({
    scope: Object.freeze({
      tenantReference: resources.publicProfile.binding.tenantReference,
      brandReference: resources.scope.brandReference,
      storeReference: resources.scope.storeReference,
    }),
    transactions: resources.transactions,
    now: () => resources.now(),
    validUntil: () => resources.publicProfile.binding.validUntil,
    reference: () => resources.credentials.reference(),
    active: () => isPilotRuntime() && resources.now() < resources.publicProfile.binding.validUntil,
    store: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: resources.operating.requiredLiveGateRequirementCodes,
      requiredValidationCheckCodes: resources.operating.requiredValidationCheckCodes,
      timeZone: resources.operating.timeZone,
    },
    providerAccountReference,
    environment: pilotProviderEnvironment(),
    provider,
    loadRoleMapping,
    refreshObservations: (orderReference) => refreshObservations(resources, orderReference),
  });
  return createOrdinaryRefundWorkload({
    ...followThrough,
    pageSize: 20,
    pollIntervalMs,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
