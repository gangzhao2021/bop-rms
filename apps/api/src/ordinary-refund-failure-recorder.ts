import { appendAuditRecordInTransaction } from "@bop/audit";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import type { createOrdinaryRefundProcessing } from "./ordinary-refund-processing.js";

type Processing = ReturnType<typeof createOrdinaryRefundProcessing>;
type Candidate = Parameters<Processing["dispatch"]>[0];
type TransactionRunner = Parameters<
  typeof createOrdinaryRefundProcessing
>[0]["payment"]["transactions"];
type Transaction = Parameters<Parameters<TransactionRunner["run"]>[0]>[0];

/** Durable operational evidence only; it never changes financial outcome or authorizes retry. */
export function createOrdinaryRefundFailureRecorder(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  transactions: TransactionRunner;
  authorize(transaction: Transaction, scope: Readonly<typeof options.scope>): Promise<boolean>;
  newAuditReference(): string;
  now(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const uuid = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  const scope = Object.freeze({
    tenantReference: uuid(options.scope.tenantReference),
    brandReference: uuid(options.scope.brandReference),
    storeReference: uuid(options.scope.storeReference),
  });
  return async (value: Candidate, code: "ORDINARY_REFUND_EXECUTION_FAILED"): Promise<void> => {
    const candidate = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "requestReference",
      "workKind",
    ]);
    const workKind = candidate.workKind;
    const operation = uuid(candidate.operationReference);
    uuid(candidate.orderReference);
    uuid(candidate.requestReference);
    if (
      code !== "ORDINARY_REFUND_EXECUTION_FAILED" ||
      (workKind !== "Dispatch" && workKind !== "Reconcile")
    )
      throw new Error("ORDINARY_REFUND_FAILURE_INPUT_INVALID");
    const auditId = uuid(options.newAuditReference());
    await options.transactions.run(async (transaction) => {
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const authorize = async () => {
        if (!(await options.authorize(transaction, scope)))
          throw new Error("ORDINARY_REFUND_FAILURE_DENIED");
      };
      await authorize();
      await appendAuditRecordInTransaction(transaction, {
        auditId,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_ORDINARY_REFUND_EXECUTION_FAILED",
        targetType: "OrdinaryRefundOperation",
        targetId: operation,
        afterSummary: { workKind },
        reasonCode: code,
        correlationId: auditId,
        occurredAt: options.now(),
        sourceChannel: "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: options.retentionPolicyCode,
        retentionPolicyVersion: options.retentionPolicyVersion,
      });
      await authorize();
    });
  };
}
