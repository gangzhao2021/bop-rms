import { createInternalCompensationReceiptRecovery } from "./pilot-compensation-receipt.mjs";
import { createInternalReconciliationProjection } from "./pilot-reconciliation-projection.mjs";
import { createInternalReconciliationExceptions } from "./pilot-reconciliation-exceptions.mjs";
import { createInternalCompensationProjectionRecovery } from "./pilot-compensation-projection-recovery.mjs";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import { createPaymentCompensationDispositionEvidence } from "../../apps/api/dist/payment-compensation-disposition-evidence.js";
import { createInternalCompensationProjection } from "./pilot-compensation-projection.mjs";
import process from "node:process";
import console from "node:console";
import { createPaymentCompensationComposition } from "../../apps/api/dist/payment-compensation-composition.js";
import {
  createPostgresPaymentCompensationOperationsStore,
  parsePaidWithoutFulfillableOrderDisposition,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { createInternalCompensationCandidates } from "./pilot-compensation-candidates.mjs";
import { createInternalCompensationIdentity } from "./pilot-compensation-identity.mjs";
/** Local OnlineCard worker binding. Named-actor writes belong to the merchant command. */
export function createInternalCompensationService({
  resources,
  providerAccountReference,
  createSimulatedProvider,
  additionalRefundOwners,
}) {
  const deny = () => {
    throw new Error("INTERNAL_COMPENSATION_CONFIGURATION_UNAVAILABLE");
  };
  const reportedFailures = new Set();
  const binding = resources.publicProfile.binding;
  if (
    process.env.NODE_ENV !== "development" ||
    !Array.isArray(additionalRefundOwners) ||
    additionalRefundOwners.length !== 0 ||
    typeof createSimulatedProvider !== "function"
  )
    return deny();
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(resources.scope.brandReference)),
    storeReference: String(parsePaymentReference(resources.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(providerAccountReference)),
    environment: "Test",
  });
  const tenantReference = String(parsePaymentReference(binding.tenantReference)),
    validUntil = parseCanonicalInstant(binding.validUntil);
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return deny();
  const active = () =>
    process.env.NODE_ENV === "development" && parseCanonicalInstant(resources.now()) < validUntil;
  if (!active()) return deny();
  const candidates = createInternalCompensationCandidates(resources);
  const dispositionEvidence = createPaymentCompensationDispositionEvidence({
    scope,
    now: resources.now,
    authorize: async () => active(),
  });
  const project = createInternalCompensationProjection({
    resources,
    scope,
    tenantReference,
    authorize: dispositionEvidence,
  });

  const receipt = createInternalCompensationReceiptRecovery({
    resources,
    scope,
    tenantReference,
    createSimulatedProvider,
  });

  const provider = Object.fromEntries(
    ["retrieveIntent", "refundPayment"].map((method) => [
      method,
      async (request) => {
        if (
          !active() ||
          request.context.environment !== "Test" ||
          request.context.brandReference !== scope.brandReference ||
          request.context.storeReference !== scope.storeReference
        )
          return deny();
        const simulator = await createSimulatedProvider();
        try {
          return await simulator.adapter[method](request);
        } finally {
          simulator.close();
        }
      },
    ]),
  );
  return Object.freeze({
    discover: candidates.discover,
    readReconciliationExceptions: createInternalReconciliationExceptions(resources),
    recoverReconciliationProjectionPage: createInternalReconciliationProjection(resources),
    recoverProjectionPage: createInternalCompensationProjectionRecovery({
      resources,
      scope,
      tenantReference,
      active,
      afterProject: receipt,
    }),
    async afterExecute(value) {
      const disposition = parsePaidWithoutFulfillableOrderDisposition(value);
      const identity = createInternalCompensationIdentity(disposition, resources.now);
      const result = await project(disposition, identity.identities.case);
      await receipt(disposition, identity.identities.case);
      return result;
    },
    async recordFailure(value, code) {
      if (code !== "COMPENSATION_EXECUTION_FAILED" || !active()) return deny();
      const disposition = parsePaidWithoutFulfillableOrderDisposition(value);
      const identity = createInternalCompensationIdentity(disposition, resources.now);
      return resources.transactions.run(async (tx) => {
        if (!(await dispositionEvidence(tx, disposition))) return deny();
        const occurredAt = resources.now();
        await appendAuditRecordInTransaction(tx, {
          auditId: resources.credentials.reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_COMPENSATION_EXECUTION_FAILED",
          targetType: "PaymentCompensationCase",
          targetId: identity.identities.case,
          reasonCode: code,
          correlationId: identity.identities.case,
          occurredAt,
          sourceChannel: "PAYMENT_COMPENSATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        });
        if (!(await dispositionEvidence(tx, disposition))) return deny();
      });
    },
    async execute(value) {
      if (!active()) return deny();
      const disposition = parsePaidWithoutFulfillableOrderDisposition(value);
      if (
        disposition.brandReference !== scope.brandReference ||
        disposition.storeReference !== scope.storeReference
      )
        return deny();
      const identity = createInternalCompensationIdentity(disposition, resources.now);
      const operations = {
        authorize: async (_tx, access) =>
          active() &&
          access.action === "Read" &&
          access.actorReference === null &&
          access.brandReference === scope.brandReference &&
          access.storeReference === scope.storeReference &&
          access.caseReference === identity.identities.case &&
          access.purpose === "ReconcilePaidWithoutFulfillableOrder",
        validateEvidence: async () => false,
      };
      const receipts = createPostgresPaymentCompensationOperationsStore({
        ...operations,
        scope,
        transactions: resources.transactions,
      });
      const runtime = await createPaymentCompensationComposition({
        disposition,
        tenantReference,
        transactions: resources.transactions,
        scope,
        clock: { now: resources.now },
        references: identity.references,
        audit: identity.audit,
        provider,
        authorize: async () => active(),
        otherRefunds: async () => {
          if (!active()) return deny();
          return { confirmedMinor: 0n, pendingMinor: 0n, version: 1 };
        },
        lease: {
          leaseDurationMs: 30000,
          newFenceReference: () => resources.credentials.reference(),
        },
        newObservationReference: () => resources.credentials.reference(),
        operations,
        authorizeOperations: async (receipt) => {
          if (!active() || receipt.compensationCaseReference !== identity.identities.case)
            return false;
          const stored = await receipts.resolve({
            compensationCaseReference: identity.identities.case,
          });
          return stored !== null && JSON.stringify(stored) === JSON.stringify(receipt) && active();
        },
      });
      try {
        return await runtime.execute(disposition);
      } catch (error) {
        const code = [
          "PAYMENT_COMPENSATION_INPUT_INVALID",
          "PAYMENT_COMPENSATION_PERMISSION_DENIED",
          "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
          "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
          "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
          "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
        ].includes(error?.code)
          ? error.code
          : "PAYMENT_COMPENSATION_UNAVAILABLE";
        if (!reportedFailures.has(code)) {
          reportedFailures.add(code);
          console.error(code);
        }
        throw error;
      }
    },
  });
}
