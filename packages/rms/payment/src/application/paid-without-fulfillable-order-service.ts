import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { createMoney, parseCurrencyCode } from "@rms/pricing";

import type { PaymentProviderSnapshot } from "../contracts/payment-provider-adapter.js";
import {
  createRefundPaymentRequest,
  createRetrieveIntentRequest,
  parsePaymentProviderOutcome,
  parsePaymentReference,
  parseProviderIdempotencyKey,
} from "./payment-provider-adapter.js";
import { parsePaymentDigest, parsePaymentInstant } from "./payment-intent-creation.js";
import {
  createPaymentRefundedEnvelope,
  parsePaymentRefundedEnvelope,
} from "./payment-refunded-event.js";
import {
  createPaidWithoutFulfillableExceptionSource,
  paidWithoutFulfillableOrderJobName,
  paymentCompensationSourceSnapshotContent,
  parsePaidWithoutFulfillableOrderDisposition,
  parsePaymentCompensationActionReceipt,
  parsePaymentCompensationCase,
  parsePaymentCompensationIdentitySource,
  parsePaymentCompensationLeaseReceipt,
  parsePaymentCompensationOperationRecord,
  parsePaymentCompensationResult,
  parsePaymentCompensationSource,
  parsePaymentInteracInPersonClaimReceipt,
  parsePaymentInteracInPersonEvidence,
  parsePaymentOperationsReconciliationReceipt,
  parsePaymentProviderConfirmedRefundFact,
  PaymentCompensationError,
  type PaidWithoutFulfillableOrderDisposition,
  type PaymentCompensationActionReceipt,
  type PaymentCompensationCase,
  type PaymentCompensationIdentitySource,
  type PaymentCompensationLeaseReceipt,
  type PaymentCompensationOperationRecord,
  type PaymentCompensationResult,
  type PaymentCompensationSource,
  type PaymentOperationsReconciliationReceipt,
  type PaymentProviderConfirmedRefundFact,
} from "./paid-without-fulfillable-order.js";
import type { PaidWithoutFulfillableOrderPorts } from "./ports/paid-without-fulfillable-order-ports.js";

function fail(code: ConstructorParameters<typeof PaymentCompensationError>[0]): never {
  throw new PaymentCompensationError(code);
}

function dependency(error?: unknown): never {
  if (error instanceof PaymentCompensationError) throw error;
  return fail("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? String(item) : item,
  );
}

function digest(ports: PaidWithoutFulfillableOrderPorts, value: string) {
  try {
    return parsePaymentDigest(ports.references.hash(value));
  } catch {
    return dependency();
  }
}

function equalDigest(
  ports: PaidWithoutFulfillableOrderPorts,
  left: string,
  right: string,
): boolean {
  try {
    return ports.references.equals(left, right) === true;
  } catch {
    return dependency();
  }
}

function requestDigest(
  ports: PaidWithoutFulfillableOrderPorts,
  disposition: PaidWithoutFulfillableOrderDisposition,
  identity: PaymentCompensationIdentitySource,
) {
  return digest(
    ports,
    fingerprint({
      jobName: paidWithoutFulfillableOrderJobName,
      disposition,
      identityVersion: identity.identityVersion,
      environment: identity.environment,
      identityDigest: identity.identityDigest,
    }),
  );
}

function identityBinding(identity: PaymentCompensationIdentitySource): string {
  return fingerprint({
    brandReference: identity.brandReference,
    storeReference: identity.storeReference,
    orderReference: identity.orderReference,
    paymentTransactionReference: identity.paymentTransactionReference,
    paymentIntentReference: identity.paymentIntentReference,
    paymentAttemptReference: identity.paymentAttemptReference,
    environment: identity.environment,
    identityVersion: identity.identityVersion,
  });
}

function sameDisposition(
  left: PaidWithoutFulfillableOrderDisposition,
  right: PaidWithoutFulfillableOrderDisposition,
): boolean {
  return fingerprint(left) === fingerprint(right);
}

function verifyReplay(
  value: unknown,
  disposition: PaidWithoutFulfillableOrderDisposition,
  expectedDigest: string,
  identity: PaymentCompensationIdentitySource,
  operationReference: string,
  ports: PaidWithoutFulfillableOrderPorts,
): PaymentCompensationOperationRecord {
  let record;
  try {
    record = parsePaymentCompensationOperationRecord(value);
  } catch {
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  }
  if (
    !sameDisposition(record.disposition, disposition) ||
    !equalDigest(ports, record.requestDigest, expectedDigest) ||
    !equalDigest(ports, record.resultDigest, digest(ports, fingerprint(record.result)))
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  let caseReference, refundReference, eventReference;
  try {
    caseReference = parsePaymentReference(
      ports.references.caseFor({
        environment: identity.environment,
        paymentTransactionReference: disposition.paymentTransactionReference,
        paymentAttemptReference: disposition.paymentAttemptReference,
        orderReference: disposition.orderReference,
        reason: "PaidWithoutFulfillableOrder",
        purpose: "CompensatePaidWithoutFulfillableOrder",
      }),
    );
    refundReference = parsePaymentReference(
      ports.references.refundFor({
        compensationCaseReference: caseReference,
        paymentTransactionReference: disposition.paymentTransactionReference,
      }),
    );
    eventReference = parsePaymentReference(ports.references.eventFor({ refundReference }));
  } catch {
    return dependency();
  }
  const result = record.result;
  if (
    result.operationReference !== operationReference ||
    result.caseReference !== caseReference ||
    result.exceptionSource.exceptionReference !== caseReference ||
    String(result.exceptionSource.brandReference) !== String(disposition.brandReference) ||
    String(result.exceptionSource.storeReference) !== String(disposition.storeReference) ||
    String(result.exceptionSource.orderReference) !== String(disposition.orderReference) ||
    String(result.exceptionSource.paymentIntentReference) !==
      String(disposition.paymentIntentReference) ||
    String(result.exceptionSource.paymentAttemptReference) !==
      String(disposition.paymentAttemptReference) ||
    (result.refundReference !== null && result.refundReference !== refundReference) ||
    (result.eventReference !== null && result.eventReference !== eventReference)
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  return record;
}

function sourceUnavailable(): never {
  return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
}

function strictObject(value: unknown, fields: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return dependency();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return dependency();
  }
}

function verifyAudit(
  value: AppendAuditRecordInput,
  expected: {
    readonly actionCode: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly correlationId: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly occurredAt: string;
  },
) {
  try {
    const raw = strictObject(value, [
      "auditId",
      "brandId",
      "storeId",
      "actor",
      "actionCode",
      "targetType",
      "targetId",
      "reasonCode",
      "correlationId",
      "occurredAt",
      "sourceChannel",
      "dataClassification",
      "retentionPolicyCode",
      "retentionPolicyVersion",
    ]);
    const actor = strictObject(raw.actor, ["type"]);
    if (actor.type !== "System") return dependency();
    const audit = validateAuditRecord(
      Object.freeze({
        ...raw,
        actor: Object.freeze({ type: "System" as const }),
      }) as unknown as AppendAuditRecordInput,
      Date.parse(expected.occurredAt),
    );
    if (
      audit.brandId !== expected.brandReference ||
      audit.storeId !== expected.storeReference ||
      audit.actor.type !== "System" ||
      audit.actionCode !== expected.actionCode ||
      audit.targetType !== expected.targetType ||
      audit.targetId !== expected.targetId ||
      audit.beforeSummary !== undefined ||
      audit.afterSummary !== undefined ||
      audit.reasonCode !== "PAID_WITHOUT_FULFILLABLE_ORDER" ||
      audit.correlationId !== expected.correlationId ||
      audit.occurredAt !== expected.occurredAt ||
      audit.sourceChannel !== "PAYMENT_COMPENSATION" ||
      audit.dataClassification !== "Restricted"
    )
      return dependency();
    return audit;
  } catch {
    return dependency();
  }
}

function stableReferences(
  ports: PaidWithoutFulfillableOrderPorts,
  disposition: PaidWithoutFulfillableOrderDisposition,
  identity: PaymentCompensationIdentitySource,
) {
  try {
    const caseReference = parsePaymentReference(
      ports.references.caseFor({
        environment: identity.environment,
        paymentTransactionReference: disposition.paymentTransactionReference,
        paymentAttemptReference: disposition.paymentAttemptReference,
        orderReference: disposition.orderReference,
        reason: "PaidWithoutFulfillableOrder",
        purpose: "CompensatePaidWithoutFulfillableOrder",
      }),
    );
    const actionReference = parsePaymentReference(
      ports.references.actionFor({
        environment: identity.environment,
        compensationCaseReference: caseReference,
        paymentTransactionReference: disposition.paymentTransactionReference,
        paymentAttemptReference: disposition.paymentAttemptReference,
        purpose: "RefundPaidWithoutFulfillableOrder",
      }),
    );
    const refundReference = parsePaymentReference(
      ports.references.refundFor({
        compensationCaseReference: caseReference,
        paymentTransactionReference: disposition.paymentTransactionReference,
      }),
    );
    const eventReference = parsePaymentReference(ports.references.eventFor({ refundReference }));
    return Object.freeze({ caseReference, actionReference, refundReference, eventReference });
  } catch {
    return dependency();
  }
}

function verifySource(
  value: unknown,
  disposition: PaidWithoutFulfillableOrderDisposition,
  identity: PaymentCompensationIdentitySource,
  now: string,
  ports: PaidWithoutFulfillableOrderPorts,
): PaymentCompensationSource {
  let source;
  try {
    source = parsePaymentCompensationSource(value);
  } catch {
    return sourceUnavailable();
  }
  if (
    source.brandReference !== String(disposition.brandReference) ||
    source.storeReference !== String(disposition.storeReference) ||
    source.orderReference !== String(disposition.orderReference) ||
    source.paymentTransactionReference !== String(disposition.paymentTransactionReference) ||
    source.paymentIntentReference !== String(disposition.paymentIntentReference) ||
    source.paymentAttemptReference !== String(disposition.paymentAttemptReference) ||
    source.environment !== identity.environment ||
    source.identityVersion !== identity.identityVersion ||
    !equalDigest(ports, source.identityDigest, identity.identityDigest) ||
    !equalDigest(
      ports,
      source.sourceSnapshotDigest,
      digest(ports, fingerprint(paymentCompensationSourceSnapshotContent(source))),
    ) ||
    source.confirmedRefundedAmount.amountMinor + source.pendingRefundClaimedAmount.amountMinor >
      source.capturedAmount.amountMinor ||
    Date.parse(source.terminalOccurredAt) > Date.parse(disposition.evaluatedAt) ||
    Date.parse(disposition.evaluatedAt) > Date.parse(now) ||
    Date.parse(source.lastProviderObservedAt) > Date.parse(now)
  )
    return sourceUnavailable();
  return source;
}

function verifyCaseIdentity(
  value: unknown,
  expected: {
    readonly caseReference: string;
    readonly operationReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly identity: PaymentCompensationIdentitySource;
    readonly source: PaymentCompensationSource;
    readonly now: string;
  },
): PaymentCompensationCase {
  let record;
  try {
    record = parsePaymentCompensationCase(value);
  } catch {
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  }
  if (
    record.caseReference !== expected.caseReference ||
    record.operationReference !== expected.operationReference ||
    record.dispositionReference !== String(expected.disposition.dispositionReference) ||
    record.brandReference !== String(expected.disposition.brandReference) ||
    record.storeReference !== String(expected.disposition.storeReference) ||
    record.orderReference !== String(expected.disposition.orderReference) ||
    record.paymentTransactionReference !==
      String(expected.disposition.paymentTransactionReference) ||
    record.paymentIntentReference !== String(expected.disposition.paymentIntentReference) ||
    record.paymentAttemptReference !== String(expected.disposition.paymentAttemptReference) ||
    record.environment !== expected.identity.environment ||
    record.originalPaymentMethod !== expected.source.originalPaymentMethod ||
    record.dispositionDigest !== String(expected.disposition.sourceDigest) ||
    record.terminalEvidenceDigest !== expected.source.terminalEvidenceDigest ||
    expected.source.sourceVersion < record.sourceVersion ||
    (expected.source.sourceVersion === record.sourceVersion &&
      record.sourceSnapshotDigest !== expected.source.sourceSnapshotDigest) ||
    record.reason !== "PaidWithoutFulfillableOrder" ||
    record.severity !== "Critical"
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  if (
    Date.parse(record.openedAt) > Date.parse(expected.now) ||
    Date.parse(record.updatedAt) > Date.parse(expected.now)
  )
    return sourceUnavailable();
  return record;
}

async function resolveCase(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly caseReference: string;
    readonly operationReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly identity: PaymentCompensationIdentitySource;
    readonly source: PaymentCompensationSource;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly now: string;
  },
) {
  let existing;
  try {
    existing = await ports.cases.resolve({ caseReference: input.caseReference });
  } catch {
    return dependency();
  }
  if (existing !== null) return verifyCaseIdentity(existing, input);
  const candidate = parsePaymentCompensationCase({
    caseReference: input.caseReference,
    operationReference: input.operationReference,
    dispositionReference: input.disposition.dispositionReference,
    brandReference: input.disposition.brandReference,
    storeReference: input.disposition.storeReference,
    orderReference: input.disposition.orderReference,
    paymentTransactionReference: input.disposition.paymentTransactionReference,
    paymentIntentReference: input.disposition.paymentIntentReference,
    paymentAttemptReference: input.disposition.paymentAttemptReference,
    environment: input.identity.environment,
    originalPaymentMethod: input.source.originalPaymentMethod,
    reason: "PaidWithoutFulfillableOrder",
    dispositionDigest: input.disposition.sourceDigest,
    terminalEvidenceDigest: input.source.terminalEvidenceDigest,
    sourceVersion: input.source.sourceVersion,
    sourceSnapshotDigest: input.source.sourceSnapshotDigest,
    severity: "Critical",
    state: "Open",
    refundDisposition: "NotStarted",
    operationsDisposition: "Pending",
    refundReference: null,
    refundCompositionDigest: null,
    refundEvidenceDigest: null,
    refundConfirmedAt: null,
    operationsReceiptReference: null,
    operationsReceiptDigest: null,
    operationsRefundEvidenceDigest: null,
    operationsReconciledAt: null,
    openedAt: input.now,
    updatedAt: input.now,
    closedAt: null,
    version: 1,
  });
  let rawAudit;
  try {
    rawAudit = await ports.audit.createCase({
      caseReference: input.caseReference,
      brandReference: input.disposition.brandReference,
      storeReference: input.disposition.storeReference,
      paymentTransactionReference: input.disposition.paymentTransactionReference,
      occurredAt: input.now,
    });
  } catch {
    return dependency();
  }
  const audit = verifyAudit(rawAudit, {
    actionCode: "PAYMENT_COMPENSATION_CASE_OPENED",
    targetType: "PaymentCompensationCase",
    targetId: input.caseReference,
    correlationId: input.caseReference,
    brandReference: input.disposition.brandReference,
    storeReference: input.disposition.storeReference,
    occurredAt: input.now,
  });
  let ensured;
  try {
    ensured = await ports.cases.ensure({
      record: candidate,
      audit,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  if (
    ensured.status !== "Created" &&
    ensured.status !== "Existing" &&
    ensured.status !== "Conflict"
  )
    return dependency();
  if (ensured.status === "Conflict") return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  const parsed = verifyCaseIdentity(ensured.record, input);
  if (ensured.status === "Created" && fingerprint(parsed) !== fingerprint(candidate))
    return dependency();
  return parsed;
}

function providerContext(source: PaymentCompensationSource, operationReference: string) {
  return {
    provider: "Stripe" as const,
    environment: source.environment,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    paymentAttemptReference: source.paymentAttemptReference,
    operationReference: parsePaymentReference(operationReference),
  };
}

async function retrieveProvider(
  ports: PaidWithoutFulfillableOrderPorts,
  source: PaymentCompensationSource,
  actionReference: string,
  lowerBound: string,
  expiresAt: string,
): Promise<PaymentProviderSnapshot | null> {
  let value;
  try {
    value = await ports.provider.retrieveIntent(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: providerContext(source, actionReference),
        providerIntentReference: source.providerIntentReference,
      }),
    );
  } catch {
    return dependency();
  }
  let outcome;
  try {
    outcome = parsePaymentProviderOutcome(value);
  } catch {
    return sourceUnavailable();
  }
  if (
    outcome.context.environment !== source.environment ||
    outcome.context.brandReference !== source.brandReference ||
    outcome.context.storeReference !== source.storeReference ||
    outcome.context.paymentAttemptReference !== source.paymentAttemptReference ||
    outcome.context.operationReference !== actionReference
  )
    return sourceUnavailable();
  if (outcome.kind === "Failure") return null;
  if (
    outcome.providerIntentReference !== source.providerIntentReference ||
    outcome.paymentMethod !== source.originalPaymentMethod ||
    outcome.captureMode !== source.captureMode ||
    outcome.requestedAmount.amountMinor !== source.requestedAmount.amountMinor ||
    Date.parse(outcome.observedAt) < Date.parse(source.lastProviderObservedAt) ||
    Date.parse(outcome.observedAt) < Date.parse(lowerBound) ||
    Date.parse(outcome.observedAt) > Date.parse(expiresAt)
  )
    return sourceUnavailable();
  if (outcome.status !== "Captured") return null;
  if (
    outcome.capturedAmount.amountMinor !== source.capturedAmount.amountMinor ||
    outcome.refundedAmount.amountMinor < source.confirmedRefundedAmount.amountMinor ||
    outcome.refundedAmount.amountMinor > source.capturedAmount.amountMinor
  )
    return sourceUnavailable();
  return outcome;
}

function actionDigestValue(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly actionReference: string;
    readonly caseReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly source: PaymentCompensationSource;
    readonly terminalEvidenceDigest: string;
    readonly sourceVersion: number;
    readonly sourceSnapshotDigest: string;
    readonly providerObservationDigest: string;
    readonly amountMinor: bigint;
    readonly interacEvidenceDigest: string | null;
  },
) {
  return digest(
    ports,
    fingerprint({
      actionReference: input.actionReference,
      caseReference: input.caseReference,
      dispositionDigest: input.disposition.sourceDigest,
      source: {
        sourceReference: input.source.sourceReference,
        identityVersion: input.source.identityVersion,
        identityDigest: input.source.identityDigest,
        brandReference: input.source.brandReference,
        storeReference: input.source.storeReference,
        orderReference: input.source.orderReference,
        paymentTransactionReference: input.source.paymentTransactionReference,
        paymentIntentReference: input.source.paymentIntentReference,
        paymentAttemptReference: input.source.paymentAttemptReference,
        providerAccountReference: input.source.providerAccountReference,
        providerIntentReference: input.source.providerIntentReference,
        environment: input.source.environment,
        originalPaymentMethod: input.source.originalPaymentMethod,
        captureMode: input.source.captureMode,
        requestedAmount: input.source.requestedAmount,
        capturedAmount: input.source.capturedAmount,
        terminalOccurredAt: input.source.terminalOccurredAt,
      },
      terminalEvidenceDigest: input.terminalEvidenceDigest,
      sourceVersion: input.sourceVersion,
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      providerObservationDigest: input.providerObservationDigest,
      amountMinor: input.amountMinor,
      currencyCode: "CAD",
      interacEvidenceDigest: input.interacEvidenceDigest,
    }),
  );
}

function verifyAction(
  value: unknown,
  expected: {
    readonly actionReference: string;
    readonly caseReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly source: PaymentCompensationSource;
    readonly observation: PaymentProviderSnapshot;
    readonly amountMinor: bigint;
    readonly now: string;
  },
  ports: PaidWithoutFulfillableOrderPorts,
) {
  let action;
  try {
    action = parsePaymentCompensationActionReceipt(value);
  } catch {
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  }
  const expectedDigest = actionDigestValue(ports, {
    ...expected,
    amountMinor: action.amount.amountMinor,
    terminalEvidenceDigest: action.terminalEvidenceDigest,
    sourceVersion: action.sourceVersion,
    sourceSnapshotDigest: action.sourceSnapshotDigest,
    providerObservationDigest: action.providerObservationDigest,
    interacEvidenceDigest: action.interacEvidenceDigest,
  });
  let expectedKey;
  try {
    expectedKey = parseProviderIdempotencyKey(
      ports.references.providerIdempotencyKey({
        environment: expected.source.environment,
        compensationCaseReference: expected.caseReference,
        paymentTransactionReference: expected.source.paymentTransactionReference,
        paymentAttemptReference: expected.source.paymentAttemptReference,
        actionReference: expected.actionReference,
        purpose: "RefundPaidWithoutFulfillableOrder",
        amountMinor: action.amount.amountMinor,
        currencyCode: "CAD",
        actionDigest: expectedDigest,
      }),
    );
  } catch {
    return dependency();
  }
  if (
    action.actionReference !== expected.actionReference ||
    action.compensationCaseReference !== expected.caseReference ||
    action.brandReference !== expected.source.brandReference ||
    action.storeReference !== expected.source.storeReference ||
    action.paymentTransactionReference !== expected.source.paymentTransactionReference ||
    action.paymentAttemptReference !== expected.source.paymentAttemptReference ||
    action.originalPaymentMethod !== expected.source.originalPaymentMethod ||
    action.dispositionDigest !== String(expected.disposition.sourceDigest) ||
    action.terminalEvidenceDigest !== expected.source.terminalEvidenceDigest ||
    expected.source.sourceVersion < action.sourceVersion ||
    (expected.source.sourceVersion === action.sourceVersion &&
      action.sourceSnapshotDigest !== expected.source.sourceSnapshotDigest) ||
    action.amount.amountMinor > expected.source.capturedAmount.amountMinor ||
    (expected.source.pendingRefundClaimedAmount.amountMinor > 0n &&
      action.amount.amountMinor !== expected.source.pendingRefundClaimedAmount.amountMinor) ||
    !equalDigest(ports, action.actionDigest, expectedDigest) ||
    action.providerIdempotencyKey !== expectedKey ||
    Date.parse(action.claimedAt) < Date.parse(expected.disposition.evaluatedAt) ||
    Date.parse(action.claimedAt) > Date.parse(expected.now)
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  if (
    expected.source.originalPaymentMethod === "TerminalInterac"
      ? action.interacEvidenceReference === null || action.interacEvidenceDigest === null
      : action.interacEvidenceReference !== null || action.interacEvidenceDigest !== null
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  return action;
}

async function claimInteracEvidence(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly actionReference: string;
    readonly caseReference: string;
    readonly source: PaymentCompensationSource;
    readonly amountMinor: bigint;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly now: string;
  },
) {
  let raw;
  try {
    raw = await ports.interac.resolve({
      compensationCaseReference: input.caseReference,
      brandReference: input.source.brandReference,
      storeReference: input.source.storeReference,
      paymentTransactionReference: input.source.paymentTransactionReference,
      paymentAttemptReference: input.source.paymentAttemptReference,
    });
  } catch {
    return dependency();
  }
  if (raw === null) return null;
  let evidence;
  try {
    evidence = parsePaymentInteracInPersonEvidence(raw);
  } catch {
    return null;
  }
  if (
    evidence.compensationCaseReference !== input.caseReference ||
    evidence.brandReference !== input.source.brandReference ||
    evidence.storeReference !== input.source.storeReference ||
    evidence.paymentTransactionReference !== input.source.paymentTransactionReference ||
    evidence.paymentAttemptReference !== input.source.paymentAttemptReference ||
    evidence.amount.amountMinor !== input.amountMinor ||
    Date.parse(evidence.issuedAt) > Date.parse(input.now)
  )
    return null;
  const verifyClaim = (value: unknown, expectedDisposition: "Claimed" | "Existing") => {
    let claimed;
    try {
      claimed = parsePaymentInteracInPersonClaimReceipt(value);
    } catch {
      return dependency();
    }
    const claimedEvidence = parsePaymentInteracInPersonEvidence({
      evidenceReference: claimed.evidenceReference,
      compensationCaseReference: claimed.compensationCaseReference,
      brandReference: claimed.brandReference,
      storeReference: claimed.storeReference,
      paymentTransactionReference: claimed.paymentTransactionReference,
      paymentAttemptReference: claimed.paymentAttemptReference,
      staffActorReference: claimed.staffActorReference,
      readerReference: claimed.readerReference,
      terminalLocationReference: claimed.terminalLocationReference,
      amount: claimed.amount,
      approval: claimed.approval,
      issuedAt: claimed.issuedAt,
      expiresAt: claimed.expiresAt,
      evidenceDigest: claimed.evidenceDigest,
    });
    if (
      fingerprint(claimedEvidence) !== fingerprint(evidence) ||
      claimed.actionReference !== input.actionReference ||
      claimed.claimDisposition !== expectedDisposition ||
      claimed.status !== "Claimed" ||
      Date.parse(claimed.claimedAt) > Date.parse(input.now) ||
      (expectedDisposition === "Claimed" && claimed.claimedAt !== input.now)
    )
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return claimed;
  };
  let existing;
  try {
    existing = await ports.interac.resolveClaim({
      actionReference: input.actionReference,
      evidenceReference: evidence.evidenceReference,
    });
  } catch {
    return dependency();
  }
  if (existing !== null) return verifyClaim(existing, "Existing");
  if (Date.parse(evidence.expiresAt) <= Date.parse(input.now)) return null;
  let authorized;
  try {
    authorized = await ports.authorization.authorizeInterac(evidence);
  } catch {
    return dependency();
  }
  if (authorized !== true) return null;
  let claimed;
  try {
    claimed = await ports.interac.claim({
      evidence,
      actionReference: input.actionReference,
      claimedAt: input.now,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  return verifyClaim(claimed, "Claimed");
}

async function resolveOrClaimAction(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly actionReference: string;
    readonly caseReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly source: PaymentCompensationSource;
    readonly observation: PaymentProviderSnapshot;
    readonly amountMinor: bigint;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly now: string;
  },
): Promise<PaymentCompensationActionReceipt | null> {
  let existing;
  try {
    existing = await ports.actions.resolve({ actionReference: input.actionReference });
  } catch {
    return dependency();
  }
  if (existing !== null) {
    const verified = verifyAction(existing, input, ports);
    if (input.source.originalPaymentMethod === "TerminalInterac") {
      if (verified.interacEvidenceReference === null || verified.interacEvidenceDigest === null)
        return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      let rawClaim;
      try {
        rawClaim = await ports.interac.resolveClaim({
          actionReference: verified.actionReference,
          evidenceReference: verified.interacEvidenceReference,
        });
      } catch {
        return dependency();
      }
      if (rawClaim === null) return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      let interacClaim;
      try {
        interacClaim = parsePaymentInteracInPersonClaimReceipt(rawClaim);
      } catch {
        return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      }
      if (
        interacClaim.claimDisposition !== "Existing" ||
        interacClaim.status !== "Claimed" ||
        interacClaim.actionReference !== verified.actionReference ||
        verified.interacEvidenceReference !== interacClaim.evidenceReference ||
        !equalDigest(ports, verified.interacEvidenceDigest, interacClaim.evidenceDigest) ||
        interacClaim.compensationCaseReference !== input.caseReference ||
        interacClaim.brandReference !== input.source.brandReference ||
        interacClaim.storeReference !== input.source.storeReference ||
        interacClaim.paymentTransactionReference !== input.source.paymentTransactionReference ||
        interacClaim.paymentAttemptReference !== input.source.paymentAttemptReference ||
        interacClaim.amount.amountMinor !== verified.amount.amountMinor ||
        interacClaim.amount.currencyCode !== "CAD" ||
        Date.parse(interacClaim.claimedAt) > Date.parse(verified.claimedAt) ||
        Date.parse(interacClaim.claimedAt) > Date.parse(input.now)
      )
        return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    }
    return verified;
  }
  if (input.source.pendingRefundClaimedAmount.amountMinor > 0n) return null;

  const interacEvidence =
    input.source.originalPaymentMethod === "TerminalInterac"
      ? await claimInteracEvidence(ports, input)
      : null;
  if (input.source.originalPaymentMethod === "TerminalInterac" && interacEvidence === null)
    return null;
  const actionDigest = actionDigestValue(ports, {
    ...input,
    terminalEvidenceDigest: input.source.terminalEvidenceDigest,
    sourceVersion: input.source.sourceVersion,
    sourceSnapshotDigest: input.source.sourceSnapshotDigest,
    providerObservationDigest: input.observation.evidenceDigest,
    interacEvidenceDigest: interacEvidence?.evidenceDigest ?? null,
  });
  let providerIdempotencyKey;
  try {
    providerIdempotencyKey = parseProviderIdempotencyKey(
      ports.references.providerIdempotencyKey({
        environment: input.source.environment,
        compensationCaseReference: input.caseReference,
        paymentTransactionReference: input.source.paymentTransactionReference,
        paymentAttemptReference: input.source.paymentAttemptReference,
        actionReference: input.actionReference,
        purpose: "RefundPaidWithoutFulfillableOrder",
        amountMinor: input.amountMinor,
        currencyCode: "CAD",
        actionDigest,
      }),
    );
  } catch {
    return dependency();
  }
  const receipt = parsePaymentCompensationActionReceipt({
    actionReference: input.actionReference,
    compensationCaseReference: input.caseReference,
    brandReference: input.source.brandReference,
    storeReference: input.source.storeReference,
    paymentTransactionReference: input.source.paymentTransactionReference,
    paymentAttemptReference: input.source.paymentAttemptReference,
    originalPaymentMethod: input.source.originalPaymentMethod,
    amount: createMoney({
      amountMinor: input.amountMinor,
      currencyCode: parseCurrencyCode("CAD"),
    }),
    interacEvidenceReference: interacEvidence?.evidenceReference ?? null,
    interacEvidenceDigest: interacEvidence?.evidenceDigest ?? null,
    dispositionDigest: input.disposition.sourceDigest,
    terminalEvidenceDigest: input.source.terminalEvidenceDigest,
    sourceVersion: input.source.sourceVersion,
    sourceSnapshotDigest: input.source.sourceSnapshotDigest,
    providerObservationDigest: input.observation.evidenceDigest,
    actionDigest,
    providerIdempotencyKey,
    claimedAt: input.now,
    claimDisposition: "Claimed",
    phase: "Claimed",
  });
  let rawAudit;
  try {
    rawAudit = await ports.audit.createAction({
      actionReference: input.actionReference,
      caseReference: input.caseReference,
      brandReference: input.source.brandReference,
      storeReference: input.source.storeReference,
      paymentTransactionReference: input.source.paymentTransactionReference,
      occurredAt: input.now,
    });
  } catch {
    return dependency();
  }
  const audit = verifyAudit(rawAudit, {
    actionCode: "PAYMENT_COMPENSATION_REFUND_CLAIMED",
    targetType: "PaymentCompensationAction",
    targetId: input.actionReference,
    correlationId: input.caseReference,
    brandReference: input.source.brandReference,
    storeReference: input.source.storeReference,
    occurredAt: input.now,
  });
  let claimed;
  try {
    claimed = await ports.actions.claim({
      receipt,
      audit,
      interacEvidence,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  const verified = verifyAction(claimed, input, ports);
  if (verified.claimDisposition === "Claimed") {
    if (fingerprint(verified) !== fingerprint(receipt))
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  } else if (
    verified.phase !== "Claimed" ||
    Date.parse(verified.claimedAt) < Date.parse(input.disposition.evaluatedAt) ||
    Date.parse(verified.claimedAt) > Date.parse(input.now) ||
    fingerprint({ ...verified, claimDisposition: "Claimed", claimedAt: receipt.claimedAt }) !==
      fingerprint(receipt)
  ) {
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  }
  if (
    interacEvidence !== null &&
    Date.parse(interacEvidence.claimedAt) > Date.parse(verified.claimedAt)
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  return verified;
}

function verifyRefundComposition(
  value: unknown,
  expected: {
    readonly refundReference: string;
    readonly eventReference: string;
    readonly caseReference: string;
    readonly source: PaymentCompensationSource;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly trustedThrough: string;
  },
  ports: PaidWithoutFulfillableOrderPorts,
) {
  const raw = strictObject(value, ["fact", "event"]);
  let fact, event;
  try {
    fact = parsePaymentProviderConfirmedRefundFact(raw.fact);
    event = parsePaymentRefundedEnvelope(raw.event);
  } catch {
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  }
  let causationReference;
  try {
    causationReference = parsePaymentReference(
      ports.references.causationFor({
        compensationCaseReference: expected.caseReference,
        paymentAttemptReference: expected.source.paymentAttemptReference,
        source: fact.source,
      }),
    );
  } catch {
    return dependency();
  }
  if (
    fact.refundReference !== expected.refundReference ||
    fact.eventReference !== expected.eventReference ||
    fact.compensationCaseReference !== expected.caseReference ||
    fact.paymentTransactionReference !== expected.source.paymentTransactionReference ||
    fact.paymentIntentReference !== expected.source.paymentIntentReference ||
    fact.paymentAttemptReference !== expected.source.paymentAttemptReference ||
    fact.orderReference !== expected.source.orderReference ||
    fact.brandReference !== expected.source.brandReference ||
    fact.storeReference !== expected.source.storeReference ||
    fact.originalPaymentMethod !== expected.source.originalPaymentMethod ||
    fact.amount.amountMinor !== expected.source.capturedAmount.amountMinor ||
    fact.amount.currencyCode !== "CAD" ||
    Date.parse(fact.providerConfirmedAt) < Date.parse(expected.source.terminalOccurredAt) ||
    Date.parse(fact.recordedAt) < Date.parse(fact.providerConfirmedAt) ||
    (fact.source === "ProviderRetrieval" && fact.providerConfirmedAt !== fact.recordedAt) ||
    fact.causationReference !== causationReference ||
    Date.parse(fact.recordedAt) > Date.parse(expected.trustedThrough) ||
    event.eventId !== expected.eventReference ||
    event.eventId !== fact.eventReference ||
    event.occurredAt !== fact.providerConfirmedAt ||
    event.tenantId !== expected.source.brandReference ||
    event.storeId !== expected.source.storeReference ||
    event.aggregateType !== "PaymentTransaction" ||
    event.aggregateId !== expected.source.paymentTransactionReference ||
    event.aggregateVersion !== 1n ||
    event.correlationId !== expected.caseReference ||
    event.causationId !== fact.causationReference ||
    event.payload.refundReference !== expected.refundReference ||
    event.payload.compensationCaseReference !== expected.caseReference ||
    event.payload.paymentTransactionReference !== expected.source.paymentTransactionReference ||
    event.payload.paymentIntentReference !== expected.source.paymentIntentReference ||
    event.payload.paymentAttemptReference !== expected.source.paymentAttemptReference ||
    event.payload.orderReference !== expected.source.orderReference ||
    event.payload.amountMinor !== expected.source.capturedAmount.amountMinor.toString() ||
    event.payload.currencyCode !== "CAD" ||
    event.payload.refundKind !== "PaidWithoutFulfillableOrderCompensation" ||
    event.payload.providerConfirmedAt !== fact.providerConfirmedAt ||
    String(fact.brandReference) !== String(expected.disposition.brandReference) ||
    String(fact.storeReference) !== String(expected.disposition.storeReference) ||
    String(fact.orderReference) !== String(expected.disposition.orderReference) ||
    String(fact.paymentTransactionReference) !==
      String(expected.disposition.paymentTransactionReference) ||
    String(fact.paymentIntentReference) !== String(expected.disposition.paymentIntentReference) ||
    String(fact.paymentAttemptReference) !== String(expected.disposition.paymentAttemptReference)
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  return Object.freeze({ fact, event });
}

async function resolveRefundComposition(
  ports: PaidWithoutFulfillableOrderPorts,
  input: Parameters<typeof verifyRefundComposition>[1],
) {
  let existing;
  try {
    existing = await ports.refunds.resolve({
      compensationCaseReference: input.caseReference,
    });
  } catch {
    return dependency();
  }
  return existing === null ? null : verifyRefundComposition(existing, input, ports);
}

async function ensureRefund(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly refundReference: string;
    readonly eventReference: string;
    readonly caseReference: string;
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly source: PaymentCompensationSource;
    readonly truth: PaymentProviderSnapshot;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly trustedThrough: string;
  },
) {
  const existing = await resolveRefundComposition(ports, input);
  if (existing !== null) return existing;
  if (
    input.truth.status !== "Captured" ||
    input.truth.refundedAmount.amountMinor !== input.source.capturedAmount.amountMinor
  )
    return sourceUnavailable();
  let causationReference;
  try {
    causationReference = parsePaymentReference(
      ports.references.causationFor({
        compensationCaseReference: input.caseReference,
        paymentAttemptReference: input.source.paymentAttemptReference,
        source: "ProviderRetrieval",
      }),
    );
  } catch {
    return dependency();
  }
  const fact = parsePaymentProviderConfirmedRefundFact({
    refundReference: input.refundReference,
    eventReference: input.eventReference,
    compensationCaseReference: input.caseReference,
    paymentTransactionReference: input.source.paymentTransactionReference,
    paymentIntentReference: input.source.paymentIntentReference,
    paymentAttemptReference: input.source.paymentAttemptReference,
    orderReference: input.source.orderReference,
    brandReference: input.source.brandReference,
    storeReference: input.source.storeReference,
    originalPaymentMethod: input.source.originalPaymentMethod,
    amount: input.source.capturedAmount,
    source: "ProviderRetrieval",
    providerConfirmedAt: input.truth.observedAt,
    recordedAt: input.truth.observedAt,
    evidenceDigest: input.truth.evidenceDigest,
    causationReference,
  });
  const event = createPaymentRefundedEnvelope({ fact });
  let rawAudit;
  try {
    rawAudit = await ports.audit.createRefund({
      refundReference: input.refundReference,
      caseReference: input.caseReference,
      brandReference: input.source.brandReference,
      storeReference: input.source.storeReference,
      occurredAt: input.truth.observedAt,
    });
  } catch {
    return dependency();
  }
  const audit = verifyAudit(rawAudit, {
    actionCode: "PAYMENT_COMPENSATION_REFUND_CONFIRMED",
    targetType: "PaymentRefund",
    targetId: input.refundReference,
    correlationId: input.caseReference,
    brandReference: input.source.brandReference,
    storeReference: input.source.storeReference,
    occurredAt: input.truth.observedAt,
  });
  let recorded;
  try {
    recorded = await ports.refunds.record({
      fact,
      event,
      audit,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  if (
    recorded.status !== "Created" &&
    recorded.status !== "Duplicate" &&
    recorded.status !== "Conflict"
  )
    return dependency();
  if (recorded.status === "Conflict") return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  const composition = verifyRefundComposition(recorded.receipt, input, ports);
  if (
    fingerprint(composition.fact) !== fingerprint(fact) ||
    fingerprint(composition.event) !== fingerprint(event)
  )
    return recorded.status === "Duplicate"
      ? fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT")
      : dependency();
  return composition;
}

async function resolveOperations(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly caseReference: string;
    readonly refundReference: string;
    readonly source: PaymentCompensationSource;
    readonly current: PaymentCompensationCase;
    readonly refundFact: PaymentProviderConfirmedRefundFact | null;
    readonly now: string;
  },
): Promise<PaymentOperationsReconciliationReceipt | null> {
  let raw;
  try {
    raw = await ports.operations.resolve({
      compensationCaseReference: input.caseReference,
    });
  } catch {
    return dependency();
  }
  if (raw === null)
    return input.current.operationsDisposition === "Reconciled" ? sourceUnavailable() : null;
  let receipt;
  try {
    receipt = parsePaymentOperationsReconciliationReceipt(raw);
  } catch {
    return sourceUnavailable();
  }
  if (
    receipt.compensationCaseReference !== input.caseReference ||
    receipt.refundReference !== input.refundReference ||
    receipt.brandReference !== input.source.brandReference ||
    receipt.storeReference !== input.source.storeReference ||
    Date.parse(receipt.reconciledAt) < Date.parse(input.current.openedAt) ||
    Date.parse(receipt.reconciledAt) > Date.parse(input.now) ||
    (input.refundFact !== null && receipt.refundEvidenceDigest !== input.refundFact.evidenceDigest)
  )
    return sourceUnavailable();
  if (
    input.current.operationsDisposition === "Reconciled" &&
    (input.current.operationsReceiptReference !== receipt.receiptReference ||
      input.current.operationsReceiptDigest !== digest(ports, fingerprint(receipt)) ||
      input.current.operationsRefundEvidenceDigest !== receipt.refundEvidenceDigest ||
      input.current.operationsReconciledAt !== receipt.reconciledAt)
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  let authorized;
  try {
    authorized = await ports.authorization.authorizeOperations(receipt);
  } catch {
    return dependency();
  }
  if (authorized !== true) return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  return receipt;
}

async function reconcileCase(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly current: PaymentCompensationCase;
    readonly refundDisposition:
      | "InPersonActionRequired"
      | "RefundPending"
      | "ReconciliationRequired"
      | "AwaitingProviderConfirmation"
      | "ProviderConfirmed";
    readonly refundComposition: ReturnType<typeof verifyRefundComposition> | null;
    readonly operations: PaymentOperationsReconciliationReceipt | null;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly now: string;
  },
) {
  const refund = input.refundComposition?.fact ?? null;
  const refundConfirmed =
    input.current.refundDisposition === "ProviderConfirmed" || refund !== null;
  const operationsReconciled =
    input.current.operationsDisposition === "Reconciled" || input.operations !== null;
  const refundReference = refund?.refundReference ?? input.current.refundReference;
  const refundCompositionDigest =
    input.refundComposition === null
      ? input.current.refundCompositionDigest
      : digest(ports, fingerprint(input.refundComposition));
  const refundEvidenceDigest = refund?.evidenceDigest ?? input.current.refundEvidenceDigest;
  const refundConfirmedAt = refund?.providerConfirmedAt ?? input.current.refundConfirmedAt;
  const operationsReceiptReference =
    input.operations?.receiptReference ?? input.current.operationsReceiptReference;
  const operationsReceiptDigest =
    input.operations === null
      ? input.current.operationsReceiptDigest
      : digest(ports, fingerprint(input.operations));
  const operationsRefundEvidenceDigest =
    input.operations?.refundEvidenceDigest ?? input.current.operationsRefundEvidenceDigest;
  const operationsReconciledAt =
    input.operations?.reconciledAt ?? input.current.operationsReconciledAt;
  if (
    (input.current.refundDisposition === "ProviderConfirmed" &&
      input.refundComposition !== null &&
      (input.current.refundReference !== refund?.refundReference ||
        input.current.refundCompositionDigest !==
          digest(ports, fingerprint(input.refundComposition)) ||
        input.current.refundEvidenceDigest !== refund?.evidenceDigest ||
        input.current.refundConfirmedAt !== refund?.providerConfirmedAt)) ||
    (input.current.operationsDisposition === "Reconciled" &&
      input.operations !== null &&
      (input.current.operationsReceiptReference !== input.operations.receiptReference ||
        input.current.operationsReceiptDigest !== digest(ports, fingerprint(input.operations)) ||
        input.current.operationsRefundEvidenceDigest !== input.operations.refundEvidenceDigest ||
        input.current.operationsReconciledAt !== input.operations.reconciledAt))
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  if (
    refundConfirmed &&
    operationsReconciled &&
    refundEvidenceDigest !== operationsRefundEvidenceDigest
  )
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  if (input.current.state === "Closed") {
    if (input.refundComposition === null || input.operations === null) return sourceUnavailable();
    return input.current;
  }
  if (Date.parse(input.now) < Date.parse(input.current.updatedAt)) return sourceUnavailable();
  const effectiveAt = [input.now, refundConfirmedAt, operationsReconciledAt]
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] as string;
  if (Date.parse(effectiveAt) > Date.parse(input.lease.expiresAt)) return sourceUnavailable();
  const closed = refundConfirmed && operationsReconciled;
  const next = parsePaymentCompensationCase({
    ...input.current,
    state: closed ? "Closed" : "Open",
    refundDisposition: refundConfirmed ? "ProviderConfirmed" : input.refundDisposition,
    operationsDisposition: operationsReconciled ? "Reconciled" : "Pending",
    refundReference,
    refundCompositionDigest,
    refundEvidenceDigest,
    refundConfirmedAt,
    operationsReceiptReference,
    operationsReceiptDigest,
    operationsRefundEvidenceDigest,
    operationsReconciledAt,
    updatedAt: effectiveAt,
    closedAt: closed ? effectiveAt : null,
    version: input.current.version + 1,
  });
  let reconciled;
  try {
    reconciled = await ports.cases.reconcile({
      current: input.current,
      next,
      refund,
      operations: input.operations,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  if (
    reconciled.status !== "Updated" &&
    reconciled.status !== "Duplicate" &&
    reconciled.status !== "Conflict"
  )
    return dependency();
  if (reconciled.status === "Conflict") return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  const parsed = parsePaymentCompensationCase(reconciled.record);
  if (fingerprint(parsed) !== fingerprint(next))
    return reconciled.status === "Duplicate"
      ? fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT")
      : dependency();
  return parsed;
}

async function commitResult(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly disposition: PaidWithoutFulfillableOrderDisposition;
    readonly requestDigest: string;
    readonly operationReference: string;
    readonly caseRecord: PaymentCompensationCase;
    readonly refundComposition: ReturnType<typeof verifyRefundComposition> | null;
    readonly lease: PaymentCompensationLeaseReceipt;
    readonly identity: PaymentCompensationIdentitySource;
  },
) {
  const result = parsePaymentCompensationResult({
    status:
      input.caseRecord.refundDisposition === "ProviderConfirmed"
        ? input.caseRecord.operationsDisposition === "Reconciled"
          ? "Closed"
          : "AwaitingOperationsReconciliation"
        : input.caseRecord.refundDisposition,
    operationReference: input.operationReference,
    caseReference: input.caseRecord.caseReference,
    evaluatedAt: input.caseRecord.updatedAt,
    refundReference: input.refundComposition?.fact.refundReference ?? null,
    eventReference: input.refundComposition?.event.eventId ?? null,
    exceptionSource: createPaidWithoutFulfillableExceptionSource(input.caseRecord),
  });
  const record = parsePaymentCompensationOperationRecord({
    disposition: input.disposition,
    requestDigest: input.requestDigest,
    result,
    resultDigest: digest(ports, fingerprint(result)),
  });
  let committed;
  try {
    committed = await ports.repository.commitOperation({
      record,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  if (
    committed.status !== "Created" &&
    committed.status !== "Updated" &&
    committed.status !== "Duplicate" &&
    committed.status !== "Conflict"
  )
    return dependency();
  if (committed.status === "Conflict") return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  const verified = verifyReplay(
    committed.record,
    input.disposition,
    input.requestDigest,
    input.identity,
    input.operationReference,
    ports,
  );
  if (fingerprint(verified) !== fingerprint(record))
    return committed.status === "Duplicate"
      ? fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT")
      : dependency();
  return verified.result;
}

async function recordActionPhase(
  ports: PaidWithoutFulfillableOrderPorts,
  input: {
    readonly action: PaymentCompensationActionReceipt;
    readonly nextPhase: "InvocationUnknown" | "ProviderPending" | "ProviderConfirmed";
    readonly observedAt: string;
    readonly verification: Parameters<typeof verifyAction>[1];
    readonly lease: PaymentCompensationLeaseReceipt;
  },
) {
  if (input.action.phase === input.nextPhase) return input.action;
  let raw;
  try {
    raw = await ports.actions.recordOutcome({
      actionReference: input.action.actionReference,
      expectedPhase: input.action.phase,
      nextPhase: input.nextPhase,
      observedAt: input.observedAt,
      fenceReference: input.lease.fenceReference,
      fenceVersion: input.lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  const updated = verifyAction(raw, input.verification, ports);
  if (updated.phase !== input.nextPhase) return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  if (fingerprint({ ...updated, phase: input.action.phase }) !== fingerprint(input.action))
    return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
  return updated;
}

async function executeClaimed(
  ports: PaidWithoutFulfillableOrderPorts,
  disposition: PaidWithoutFulfillableOrderDisposition,
  operationReference: string,
  expectedRequestDigest: string,
  identity: PaymentCompensationIdentitySource,
  lease: PaymentCompensationLeaseReceipt,
  now: string,
): Promise<PaymentCompensationResult> {
  let rawSource;
  try {
    rawSource = await ports.source.resolve({
      brandReference: disposition.brandReference,
      storeReference: disposition.storeReference,
      orderReference: disposition.orderReference,
      paymentTransactionReference: disposition.paymentTransactionReference,
      paymentIntentReference: disposition.paymentIntentReference,
      paymentAttemptReference: disposition.paymentAttemptReference,
      environment: identity.environment,
      identityVersion: identity.identityVersion,
      identityDigest: identity.identityDigest,
    });
  } catch {
    return dependency();
  }
  if (rawSource === null) return sourceUnavailable();
  const source = verifySource(rawSource, disposition, identity, now, ports);
  const references = stableReferences(ports, disposition, identity);
  let caseRecord = await resolveCase(ports, {
    ...references,
    operationReference,
    disposition,
    identity,
    source,
    lease,
    now,
  });
  let refundComposition = await resolveRefundComposition(ports, {
    ...references,
    disposition,
    source,
    trustedThrough: now,
  });
  if (caseRecord.refundDisposition === "ProviderConfirmed" && refundComposition === null)
    return sourceUnavailable();
  let refundDisposition:
    | "InPersonActionRequired"
    | "RefundPending"
    | "ReconciliationRequired"
    | "AwaitingProviderConfirmation"
    | "ProviderConfirmed" =
    refundComposition === null ? "ReconciliationRequired" : "ProviderConfirmed";

  if (refundComposition === null) {
    const initialTruth = await retrieveProvider(
      ports,
      source,
      references.actionReference,
      now,
      lease.expiresAt,
    );
    if (initialTruth !== null) {
      if (initialTruth.refundedAmount.amountMinor === source.capturedAmount.amountMinor) {
        refundComposition = await ensureRefund(ports, {
          ...references,
          disposition,
          source,
          truth: initialTruth,
          lease,
          trustedThrough: initialTruth.observedAt,
        });
        refundDisposition = "ProviderConfirmed";
      } else {
        const remaining =
          source.capturedAmount.amountMinor - initialTruth.refundedAmount.amountMinor;
        if (remaining <= 0n) return sourceUnavailable();
        const action = await resolveOrClaimAction(ports, {
          ...references,
          disposition,
          source,
          observation: initialTruth,
          amountMinor: remaining,
          lease,
          now,
        });
        if (action === null) {
          refundDisposition =
            source.originalPaymentMethod === "TerminalInterac"
              ? "InPersonActionRequired"
              : "ReconciliationRequired";
        } else if (source.originalPaymentMethod === "TerminalInterac") {
          if (action.phase === "ProviderConfirmed")
            return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
          if (action.phase !== "ProviderPending")
            await recordActionPhase(ports, {
              action,
              nextPhase: "ProviderPending",
              observedAt: initialTruth.observedAt,
              verification: {
                ...references,
                disposition,
                source,
                observation: initialTruth,
                amountMinor: action.amount.amountMinor,
                now: lease.expiresAt,
              },
              lease,
            });
          refundDisposition = "AwaitingProviderConfirmation";
        } else {
          const claimedBalance = source.capturedAmount.amountMinor - action.amount.amountMinor;
          if (initialTruth.refundedAmount.amountMinor < claimedBalance) return sourceUnavailable();
          if (
            action.phase === "ProviderConfirmed" &&
            initialTruth.refundedAmount.amountMinor !== source.capturedAmount.amountMinor
          )
            return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
          const unchanged = initialTruth.refundedAmount.amountMinor === claimedBalance;
          const mayRetry = action.phase === "Claimed" || action.phase === "InvocationUnknown";
          if (unchanged && mayRetry) {
            let nextPhase: "ProviderPending" | "InvocationUnknown" | "ProviderConfirmed" =
              "InvocationUnknown";
            let mutationLowerBound = initialTruth.observedAt;
            try {
              const mutation = parsePaymentProviderOutcome(
                await ports.provider.refundPayment(
                  createRefundPaymentRequest({
                    operation: "RefundPayment",
                    purpose: "RefundPayment",
                    context: providerContext(source, references.actionReference),
                    idempotencyKey: action.providerIdempotencyKey,
                    providerIntentReference: source.providerIntentReference,
                    originalPaymentMethod: source.originalPaymentMethod,
                    amount: action.amount,
                  }),
                ),
              );
              const contextMismatch =
                mutation.context.environment !== source.environment ||
                mutation.context.brandReference !== source.brandReference ||
                mutation.context.storeReference !== source.storeReference ||
                mutation.context.paymentAttemptReference !== source.paymentAttemptReference ||
                mutation.context.operationReference !== references.actionReference;
              if (
                !contextMismatch &&
                mutation.kind === "Snapshot" &&
                mutation.providerIntentReference === source.providerIntentReference &&
                mutation.paymentMethod === source.originalPaymentMethod &&
                mutation.captureMode === source.captureMode &&
                mutation.requestedAmount.amountMinor === source.requestedAmount.amountMinor &&
                mutation.capturedAmount.amountMinor === source.capturedAmount.amountMinor &&
                mutation.refundedAmount.amountMinor >= source.confirmedRefundedAmount.amountMinor &&
                mutation.refundedAmount.amountMinor <= source.capturedAmount.amountMinor &&
                Date.parse(mutation.observedAt) >= Date.parse(initialTruth.observedAt) &&
                Date.parse(mutation.observedAt) >= Date.parse(now) &&
                Date.parse(mutation.observedAt) <= Date.parse(lease.expiresAt)
              )
                mutationLowerBound = mutation.observedAt;
            } catch {
              nextPhase = "InvocationUnknown";
            }
            let postTruth: PaymentProviderSnapshot | null;
            try {
              postTruth = await retrieveProvider(
                ports,
                source,
                references.actionReference,
                mutationLowerBound,
                lease.expiresAt,
              );
            } catch {
              postTruth = null;
            }
            if (postTruth !== null) {
              if (postTruth.refundedAmount.amountMinor < claimedBalance) return sourceUnavailable();
              if (postTruth.refundedAmount.amountMinor === source.capturedAmount.amountMinor) {
                refundComposition = await ensureRefund(ports, {
                  ...references,
                  disposition,
                  source,
                  truth: postTruth,
                  lease,
                  trustedThrough: postTruth.observedAt,
                });
                refundDisposition = "ProviderConfirmed";
                nextPhase = "ProviderConfirmed";
              } else if (postTruth.refundedAmount.amountMinor > claimedBalance) {
                refundDisposition = "RefundPending";
                nextPhase = "ProviderPending";
              } else {
                refundDisposition = "AwaitingProviderConfirmation";
              }
            } else {
              refundDisposition = "AwaitingProviderConfirmation";
            }
            await recordActionPhase(ports, {
              action,
              nextPhase,
              observedAt: postTruth?.observedAt ?? mutationLowerBound,
              verification: {
                ...references,
                disposition,
                source,
                observation: initialTruth,
                amountMinor: action.amount.amountMinor,
                now: lease.expiresAt,
              },
              lease,
            });
          } else if (initialTruth.refundedAmount.amountMinor > claimedBalance) {
            refundDisposition = "RefundPending";
            if (action.phase !== "ProviderPending")
              await recordActionPhase(ports, {
                action,
                nextPhase: "ProviderPending",
                observedAt: initialTruth.observedAt,
                verification: {
                  ...references,
                  disposition,
                  source,
                  observation: initialTruth,
                  amountMinor: action.amount.amountMinor,
                  now: lease.expiresAt,
                },
                lease,
              });
          } else {
            refundDisposition = "AwaitingProviderConfirmation";
          }
        }
      }
    }
  }
  const operations = await resolveOperations(ports, {
    ...references,
    source,
    current: caseRecord,
    refundFact: refundComposition?.fact ?? null,
    now,
  });
  caseRecord = await reconcileCase(ports, {
    current: caseRecord,
    refundDisposition,
    refundComposition,
    operations,
    lease,
    now,
  });
  return await commitResult(ports, {
    disposition,
    requestDigest: expectedRequestDigest,
    operationReference,
    caseRecord,
    refundComposition,
    lease,
    identity,
  });
}

export function createPaidWithoutFulfillableOrderService(ports: PaidWithoutFulfillableOrderPorts) {
  return Object.freeze({
    async execute(value: unknown): Promise<PaymentCompensationResult> {
      let disposition;
      try {
        disposition = parsePaidWithoutFulfillableOrderDisposition(value);
      } catch {
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      let authorized;
      try {
        authorized = await ports.authorization.authorize(disposition);
      } catch {
        return dependency();
      }
      if (authorized !== true) return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");

      let rawIdentity;
      try {
        rawIdentity = await ports.source.resolveIdentity({
          brandReference: disposition.brandReference,
          storeReference: disposition.storeReference,
          orderReference: disposition.orderReference,
          paymentTransactionReference: disposition.paymentTransactionReference,
          paymentIntentReference: disposition.paymentIntentReference,
          paymentAttemptReference: disposition.paymentAttemptReference,
        });
      } catch {
        return dependency();
      }
      if (rawIdentity === null) return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      let identity;
      try {
        identity = parsePaymentCompensationIdentitySource(rawIdentity);
      } catch {
        return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      }
      if (
        String(identity.brandReference) !== String(disposition.brandReference) ||
        String(identity.storeReference) !== String(disposition.storeReference) ||
        String(identity.orderReference) !== String(disposition.orderReference) ||
        String(identity.paymentTransactionReference) !==
          String(disposition.paymentTransactionReference) ||
        String(identity.paymentIntentReference) !== String(disposition.paymentIntentReference) ||
        String(identity.paymentAttemptReference) !== String(disposition.paymentAttemptReference)
      )
        return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      if (!equalDigest(ports, identity.identityDigest, digest(ports, identityBinding(identity))))
        return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");

      let operationReference;
      try {
        operationReference = parsePaymentReference(
          ports.references.operationFor({
            environment: identity.environment,
            brandReference: disposition.brandReference,
            storeReference: disposition.storeReference,
            orderReference: disposition.orderReference,
            paymentTransactionReference: disposition.paymentTransactionReference,
            paymentAttemptReference: disposition.paymentAttemptReference,
            purpose: "CompensatePaidWithoutFulfillableOrder",
          }),
        );
      } catch {
        return dependency();
      }
      const expectedDigest = requestDigest(ports, disposition, identity);
      let existing;
      try {
        existing = await ports.repository.resolveOperation({ operationReference });
      } catch {
        return dependency();
      }
      if (existing !== null) {
        const replay = verifyReplay(
          existing,
          disposition,
          expectedDigest,
          identity,
          operationReference,
          ports,
        );
        if (replay.result.status === "Closed") return replay.result;
      }

      let lease;
      try {
        lease = await ports.lease.claim({
          paymentAttemptReference: disposition.paymentAttemptReference,
          operationReference,
          jobName: paidWithoutFulfillableOrderJobName,
        });
      } catch {
        return fail("PAYMENT_COMPENSATION_LEASE_UNAVAILABLE");
      }
      if (lease === null) return fail("PAYMENT_COMPENSATION_LEASE_UNAVAILABLE");
      let parsedLease: ReturnType<typeof parsePaymentCompensationLeaseReceipt> | null = null;
      try {
        parsedLease = parsePaymentCompensationLeaseReceipt(lease);
        const now = parsePaymentInstant(ports.clock.now());
        if (
          String(parsedLease.paymentAttemptReference) !==
            String(disposition.paymentAttemptReference) ||
          parsedLease.operationReference !== operationReference ||
          Date.parse(parsedLease.claimedAt) > Date.parse(now) ||
          Date.parse(parsedLease.expiresAt) <= Date.parse(now)
        )
          return fail("PAYMENT_COMPENSATION_LEASE_UNAVAILABLE");
        return await executeClaimed(
          ports,
          disposition,
          operationReference,
          expectedDigest,
          identity,
          parsedLease,
          now,
        );
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_LEASE_UNAVAILABLE");
      } finally {
        if (parsedLease !== null)
          try {
            await ports.lease.release({
              paymentAttemptReference: disposition.paymentAttemptReference,
              operationReference,
              jobName: paidWithoutFulfillableOrderJobName,
              fenceReference: parsedLease.fenceReference,
              fenceVersion: parsedLease.fenceVersion,
            });
          } catch {
            // Lease expiry remains the recovery boundary after a completed financial decision.
          }
      }
    },
  });
}
