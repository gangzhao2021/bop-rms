import {
  createPostgresOrdinaryRefundWorkSource,
  createPostgresOrdinaryRefundSendRuntime,
  createPostgresOrdinaryRefundReconciliationRuntime,
} from "@rms/payment";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { createRefundReceiptIssuance } from "./refund-receipt-issuance.js";

type Send = Parameters<typeof createPostgresOrdinaryRefundSendRuntime>[0];
type Discovery = ReturnType<typeof createPostgresOrdinaryRefundWorkSource>;
type Candidate = Awaited<ReturnType<Discovery>>["candidates"][number];
type Receipt = Parameters<typeof createRefundReceiptIssuance>[0];

/** Ports for the ordinary-refund Worker. All SQL remains in public owners.
 * Provider sends occur only through the committed dispatch journal. Receipt
 * issuance reads complete current owner coverage, never the Provider response. */
export function createOrdinaryRefundProcessing(options: {
  payment: Send & {
    provider: Send["provider"] &
      Parameters<typeof createPostgresOrdinaryRefundReconciliationRuntime>[0]["provider"];
  };
  authorizeDiscovery: Parameters<typeof createPostgresOrdinaryRefundWorkSource>[0]["authorize"];
  dispatchIdentities(candidate: Candidate): Promise<{
    dispatchReference: string;
    auditReference: string;
    approvalReference: string | null;
  }>;
  dispatchAudit: {
    reasonCode: string;
    retentionPolicyCode: string;
    retentionPolicyVersion: number;
  };
  receipt: Receipt;
  now(): string;
  receiptFreshAfter(observedAt: string): string;
}) {
  const payment = options.payment;
  const scope = {
    ...payment.dispatch.scope,
    providerAccountReference: payment.dispatch.providerAccountReference,
    environment: payment.dispatch.environment,
  };
  for (const key of [
    "tenantReference",
    "brandReference",
    "storeReference",
    "providerAccountReference",
    "environment",
  ] as const) {
    if (scope[key] !== options.receipt.scope[key])
      throw new Error("ORDINARY_REFUND_PROCESSING_SCOPE_MISMATCH");
  }
  const discover = createPostgresOrdinaryRefundWorkSource({
    scope,
    authorize: options.authorizeDiscovery,
  });
  const send = createPostgresOrdinaryRefundSendRuntime(payment);
  const reconcile = createPostgresOrdinaryRefundReconciliationRuntime({
    scope,
    providerAccountReference: payment.dispatch.providerAccountReference,
    environment: payment.dispatch.environment,
    authorize: payment.authorizeRecovery,
    transactions: payment.transactions,
    provider: payment.provider,
  });
  const receipt = createRefundReceiptIssuance(options.receipt);
  const candidate = (value: Candidate) => {
    const raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "requestReference",
      "workKind",
    ]);
    if (raw.workKind !== "Dispatch" && raw.workKind !== "Reconcile")
      throw new Error("ORDINARY_REFUND_WORK_INVALID");
    return {
      operationReference: String(
        parseOpaqueUuidV7(raw.operationReference, "ACTOR_REFERENCE_INVALID"),
      ),
      orderReference: String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID")),
      requestReference: String(parseOpaqueUuidV7(raw.requestReference, "ACTOR_REFERENCE_INVALID")),
      workKind: raw.workKind,
    };
  };
  return Object.freeze({
    discover: (input: Parameters<Discovery>[1]) =>
      payment.transactions.run((tx) => discover(tx, input)),
    async dispatch(value: Candidate) {
      const work = candidate(value);
      if (work.workKind !== "Dispatch") throw new Error("ORDINARY_REFUND_WORK_INVALID");
      const identities = readClosedRecord(await options.dispatchIdentities(value), [
        "dispatchReference",
        "auditReference",
        "approvalReference",
      ]);
      return send(
        {
          operationReference: work.operationReference,
          orderReference: work.orderReference,
          requestReference: work.requestReference,
          ...identities,
        },
        options.dispatchAudit,
      );
    },
    async reconcile(value: Candidate) {
      const work = candidate(value);
      if (work.workKind !== "Reconcile") throw new Error("ORDINARY_REFUND_WORK_INVALID");
      // Fresh identities per lookup job; retain them for retries of that job.
      const identities = readClosedRecord(payment.generateObservationIdentity(), [
        "observationReference",
        "auditReference",
      ]);
      return reconcile({
        orderReference: work.orderReference,
        operationReference: work.operationReference,
        ...identities,
      });
    },
    async afterReconcile(value: Candidate) {
      const work = candidate(value);
      if (work.workKind !== "Reconcile") throw new Error("ORDINARY_REFUND_WORK_INVALID");
      const observedAt = options.now();
      await payment.transactions.run((tx) =>
        receipt(tx, {
          orderReference: work.orderReference,
          observedAt,
          freshAfter: options.receiptFreshAfter(observedAt),
        }),
      );
    },
  });
}
