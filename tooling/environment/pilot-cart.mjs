import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../packages/bop/audit/src/index.ts";
export function createInternalTestCart(resources, configuration) {
  const { scope, transactions, credentials, publicProfile } = resources;
  const reference = credentials.reference;
  const values = {
    policyVersionReference: configuration.policyVersionReference,
    idleTimeoutSeconds: configuration.idleTimeoutSeconds,
    absoluteTimeoutSeconds: configuration.absoluteTimeoutSeconds,
    validFrom: publicProfile.binding.validFrom,
    validUntil: publicProfile.binding.validUntil,
  };
  const policy = { ...values, policyDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(values)) };
  const audit = (action, targetType, targetId, record) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: action,
    targetType,
    targetId,
    occurredAt: record.occurredAt,
    correlationId: record.operationReference,
    reasonCode: "AUTHORIZED_CART_BINDING",
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return {
    cartTransactions: transactions,
    cartBinding: {
      orderingTransactions: transactions,
      identityAudit: {
        append: (tx, record) =>
          appendAuditRecordInTransaction(
            tx,
            audit(
              "IDENTITY_GUEST_BINDING_" + record.action.toUpperCase(),
              "GuestBindingPreparation",
              record.operationReference,
              record,
            ),
          ),
      },
      ordering: {
        policy,
        sourceChannel: "Qr",
        generateReference: reference,
        audit: (record) =>
          audit(
            "ORDERING_CART_BINDING_" + record.action.toUpperCase(),
            "OrderingCart",
            record.cartReference,
            record,
          ),
      },
      recovery: credentials.binding,
      preparationLifetimeSeconds: 300,
    },
  };
}
