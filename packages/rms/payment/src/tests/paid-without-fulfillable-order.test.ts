import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPaidWithoutFulfillableOrderService,
  createPaymentReconciliationExceptionSource,
  createPaymentRefundedEnvelope,
  createPaymentTerminalWatchdogExceptionSource,
  paymentCompensationSourceSnapshotContent,
  parsePaidWithoutFulfillableOrderDisposition,
  parsePaymentCompensationIdentitySource,
  parsePaymentCompensationSource,
  parsePaymentOperationsReconciliationReceipt,
  parsePaymentRefundedEnvelope,
  PaymentCompensationError,
  type PaidWithoutFulfillableOrderPorts,
  type PaymentCompensationActionReceipt,
  type PaymentCompensationCase,
  type PaymentCompensationIdentitySource,
  type PaymentCompensationOperationRecord,
  type PaymentCompensationSource,
  type PaymentInteracInPersonClaimReceipt,
  type PaymentInteracInPersonEvidence,
  type PaymentOperationsReconciliationReceipt,
  type PaymentProviderSnapshot,
  type PaymentRefundCompositionReceipt,
} from "../index.js";

const id = (suffix: number) => `0198b010-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = "2026-08-08T16:00:00.000Z";

const refs = Object.freeze({
  disposition: id(1),
  brand: id(2),
  store: id(3),
  order: id(4),
  batch: id(5),
  submission: id(6),
  transaction: id(7),
  intent: id(8),
  attempt: id(9),
  paymentEvent: id(10),
  checkpoint: id(11),
  source: id(12),
  providerAccount: id(13),
  refund: id(14),
  refundEvent: id(15),
  compensationCase: id(16),
  causation: id(17),
  operation: id(18),
  action: id(19),
  fence: id(20),
  caseAudit: id(21),
  actionAudit: id(22),
  refundAudit: id(23),
  operationsReceipt: id(24),
  operationsActor: id(25),
  operationsAudit: id(26),
  interacEvidence: id(27),
  interacStaff: id(28),
  interacReader: id(29),
  interacLocation: id(30),
});

function disposition(overrides: Record<string, unknown> = {}) {
  return {
    dispositionReference: refs.disposition,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    submissionReference: refs.submission,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    paymentEventReference: refs.paymentEvent,
    sourceVersion: 3,
    sourceCheckpoint: refs.checkpoint,
    sourceDigest: digest("ordering-disposition"),
    evaluatedAt: "2026-08-08T15:59:00.000Z",
    disposition: "PaidWithoutFulfillableOrder",
    reason: "CapacityExpired",
    kitchenReleaseDisposition: "Blocked",
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    environment: "Test",
    identityVersion: 2,
    identityDigest: digest("identity"),
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceReference: refs.source,
    identityVersion: 2,
    identityDigest: digest("identity"),
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    providerAccountReference: refs.providerAccount,
    providerIntentReference: "pi_SYNTHETIC_WP1310_0001",
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    captureMode: "Automatic",
    status: "Captured",
    requestedAmount: { amountMinor: 2_000n, currencyCode: "CAD" },
    capturedAmount: { amountMinor: 2_000n, currencyCode: "CAD" },
    confirmedRefundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
    pendingRefundClaimedAmount: { amountMinor: 0n, currencyCode: "CAD" },
    terminalOccurredAt: "2026-08-08T15:58:00.000Z",
    lastProviderObservedAt: "2026-08-08T15:58:30.000Z",
    terminalEvidenceDigest: digest("terminal"),
    sourceVersion: 4,
    sourceSnapshotDigest: digest("source"),
    ...overrides,
  };
}

function refundFact(overrides: Record<string, unknown> = {}) {
  return {
    refundReference: refs.refund,
    eventReference: refs.refundEvent,
    compensationCaseReference: refs.compensationCase,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    orderReference: refs.order,
    brandReference: refs.brand,
    storeReference: refs.store,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 2_000n, currencyCode: "CAD" },
    source: "ProviderRetrieval",
    providerConfirmedAt: now,
    recordedAt: now,
    evidenceDigest: digest("provider-full"),
    causationReference: refs.causation,
    ...overrides,
  };
}

function expectInputInvalid(action: () => unknown) {
  expect(action).toThrowError(PaymentCompensationError);
  try {
    action();
  } catch (error) {
    expect((error as PaymentCompensationError).code).toBe("PAYMENT_COMPENSATION_INPUT_INVALID");
  }
}

const fingerprint = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item));

function harnessIdentity(): PaymentCompensationIdentitySource {
  const content = {
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    environment: "Test" as const,
    identityVersion: 2,
  };
  return parsePaymentCompensationIdentitySource({
    ...content,
    identityDigest: digest(fingerprint(content)),
  });
}

function harnessSource(
  currentIdentity: PaymentCompensationIdentitySource,
  method: "OnlineCard" | "TerminalCard" | "TerminalInterac",
  overrides: Record<string, unknown> = {},
): PaymentCompensationSource {
  const candidate = parsePaymentCompensationSource({
    sourceReference: refs.source,
    identityVersion: currentIdentity.identityVersion,
    identityDigest: currentIdentity.identityDigest,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    paymentTransactionReference: refs.transaction,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    providerAccountReference: refs.providerAccount,
    providerIntentReference: "pi_SYNTHETIC_WP1310_0001",
    environment: "Test",
    originalPaymentMethod: method,
    captureMode: method === "OnlineCard" ? "Automatic" : "ManualPreferred",
    status: "Captured",
    requestedAmount: { amountMinor: 2_000n, currencyCode: "CAD" },
    capturedAmount: { amountMinor: 2_000n, currencyCode: "CAD" },
    confirmedRefundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
    pendingRefundClaimedAmount: { amountMinor: 0n, currencyCode: "CAD" },
    terminalOccurredAt: "2026-08-08T15:58:00.000Z",
    lastProviderObservedAt: "2026-08-08T15:58:30.000Z",
    terminalEvidenceDigest: digest("terminal"),
    sourceVersion: 4,
    sourceSnapshotDigest: digest("placeholder"),
    ...overrides,
  });
  return parsePaymentCompensationSource({
    ...candidate,
    sourceSnapshotDigest: digest(fingerprint(paymentCompensationSourceSnapshotContent(candidate))),
  });
}

function systemAudit(
  auditId: string,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly occurredAt: string;
  },
  actionCode: string,
  targetType: string,
  targetId: string,
  correlationId: string,
) {
  return {
    auditId,
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: { type: "System" as const },
    actionCode,
    targetType,
    targetId,
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    correlationId,
    occurredAt: input.occurredAt,
    sourceChannel: "PAYMENT_COMPENSATION",
    dataClassification: "Restricted" as const,
    retentionPolicyCode: "PAYMENT_RECORDS",
    retentionPolicyVersion: 1,
  };
}

type RetrievePlan = bigint | "Failure" | "Malformed" | "CrossScope";
type RefundBehavior =
  "Effect" | "NoEffect" | "Throw" | "ThrowAfterEffect" | "Failure" | "Malformed" | "CrossScope";

interface ServiceHarnessOptions {
  readonly deny?: boolean;
  readonly method?: "OnlineCard" | "TerminalCard" | "TerminalInterac";
  readonly now?: string;
  readonly providerObservedAt?: string;
  readonly identity?: unknown | null;
  readonly lease?: unknown | null;
  readonly source?: unknown | null;
  readonly sourceOverrides?: Record<string, unknown>;
  readonly tamperSourceDigest?: boolean;
  readonly retrievePlan?: readonly RetrievePlan[];
  readonly refundBehaviors?: readonly RefundBehavior[];
  readonly operations?: boolean | unknown;
  readonly interacEvidence?: unknown | null;
  readonly interacExistingClaim?: unknown | null;
  readonly actionClaimRace?:
    | "Existing"
    | "ProviderKey"
    | "ActionDigest"
    | "Amount"
    | "SourceSnapshot"
    | "FutureTime"
    | "PreDispositionTime"
    | "BeforeInteracClaim"
    | "InteracDigest";
  readonly recordOutcomeTamper?:
    "providerKey" | "amount" | "actionDigest" | "sourceSnapshot" | "claimedAt";
  readonly recordOutcomeThrows?: boolean;
  readonly duplicateRefundTamper?: boolean;
  readonly releaseThrows?: boolean;
}

function serviceHarness(options: ServiceHarnessOptions = {}) {
  const calls: string[] = [];
  const providerKeys: string[] = [];
  const refundAmounts: bigint[] = [];
  const currentIdentity = harnessIdentity();
  const method = options.method ?? "OnlineCard";
  let currentSource: unknown =
    options.source === undefined
      ? harnessSource(currentIdentity, method, options.sourceOverrides)
      : options.source;
  if (options.tamperSourceDigest && currentSource !== null)
    currentSource = {
      ...(currentSource as object),
      sourceSnapshotDigest: digest("tampered-source"),
    };
  let providerRefunded = 0n;
  let operation: PaymentCompensationOperationRecord | null = null;
  let caseRecord: PaymentCompensationCase | null = null;
  let action: PaymentCompensationActionReceipt | null = null;
  let refundComposition: PaymentRefundCompositionReceipt | null = null;
  let interacClaim: PaymentInteracInPersonClaimReceipt | null =
    (options.interacExistingClaim as PaymentInteracInPersonClaimReceipt | null | undefined) ?? null;
  let operationsValue: boolean | unknown = options.operations ?? false;
  let interacEvidenceValue: unknown | null =
    options.interacEvidence === undefined
      ? method === "TerminalInterac"
        ? interacEvidence()
        : null
      : options.interacEvidence;
  let retrieveCalls = 0;
  let refundCalls = 0;
  let interacClaimCalls = 0;
  let interacAuthorizationCalls = 0;
  let clockNow = options.now ?? now;
  let providerObservedAt = options.providerObservedAt;

  function providerSnapshot(
    request: {
      readonly context: PaymentProviderSnapshot["context"];
      readonly providerIntentReference: PaymentProviderSnapshot["providerIntentReference"];
    },
    refundedAmount: bigint,
    overrides: Record<string, unknown> = {},
  ): PaymentProviderSnapshot {
    const captured = 2_000n;
    return {
      kind: "Snapshot" as const,
      context: request.context,
      providerIntentReference: request.providerIntentReference,
      providerTransactionReference: "ch_SYNTHETIC_WP1310_0001",
      paymentMethod: method,
      captureMode: method === "OnlineCard" ? "Automatic" : "ManualPreferred",
      status: "Captured" as const,
      requestedAmount: { amountMinor: captured, currencyCode: "CAD" as const },
      authorizedAmount: { amountMinor: captured, currencyCode: "CAD" as const },
      capturedAmount: { amountMinor: captured, currencyCode: "CAD" as const },
      refundedAmount: { amountMinor: refundedAmount, currencyCode: "CAD" as const },
      observedAt: providerObservedAt ?? clockNow,
      evidenceDigest:
        refundedAmount === captured
          ? digest("provider-full")
          : digest(`provider-${refundedAmount}`),
      ...overrides,
    } as PaymentProviderSnapshot;
  }

  function interacEvidence(
    overrides: Record<string, unknown> = {},
  ): PaymentInteracInPersonEvidence {
    return {
      evidenceReference: refs.interacEvidence as never,
      compensationCaseReference: refs.compensationCase as never,
      brandReference: refs.brand as never,
      storeReference: refs.store as never,
      paymentTransactionReference: refs.transaction as never,
      paymentAttemptReference: refs.attempt as never,
      staffActorReference: refs.interacStaff as never,
      readerReference: refs.interacReader as never,
      terminalLocationReference: refs.interacLocation as never,
      amount: { amountMinor: 2_000n, currencyCode: "CAD" as never },
      approval: "ApprovedReaderInPersonRefund",
      issuedAt: "2026-08-08T15:55:00.000Z" as never,
      expiresAt: "2026-08-08T16:03:00.000Z" as never,
      evidenceDigest: digest("interac-evidence") as never,
      ...overrides,
    };
  }

  function operationsReceipt(): PaymentOperationsReconciliationReceipt {
    return {
      receiptReference: refs.operationsReceipt as never,
      compensationCaseReference: refs.compensationCase as never,
      refundReference: refs.refund as never,
      brandReference: refs.brand as never,
      storeReference: refs.store as never,
      actorReference: refs.operationsActor as never,
      purpose: "ReconcilePaidWithoutFulfillableOrder",
      refundEvidenceDigest: digest("provider-full") as never,
      reconciledAt: clockNow as never,
      audit: {
        auditId: refs.operationsAudit,
        brandId: refs.brand,
        storeId: refs.store,
        actor: { type: "User", reference: refs.operationsActor },
        actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
        targetType: "PaymentCompensationCase",
        targetId: refs.compensationCase,
        reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
        correlationId: refs.operationsReceipt,
        occurredAt: clockNow,
        sourceChannel: "OPERATIONS",
        dataClassification: "Restricted",
        retentionPolicyCode: "PAYMENT_RECORDS",
        retentionPolicyVersion: 1,
      },
    };
  }

  const ports: PaidWithoutFulfillableOrderPorts = {
    authorization: {
      authorize: async () => {
        calls.push("authorize");
        return options.deny !== true;
      },
      authorizeInterac: async () => {
        calls.push("authorizeInterac");
        interacAuthorizationCalls += 1;
        return true;
      },
      authorizeOperations: async () => {
        calls.push("authorizeOperations");
        return true;
      },
    },
    clock: {
      now: () => {
        calls.push("clock");
        return clockNow;
      },
    },
    repository: {
      resolveOperation: async () => {
        calls.push("resolveOperation");
        return operation;
      },
      commitOperation: async (input) => {
        calls.push("commitOperation");
        const status = operation === null ? "Created" : "Updated";
        operation = input.record;
        return { status, record: input.record };
      },
    },
    lease: {
      claim: async () => {
        calls.push("lease.claim");
        const receipt = {
          paymentAttemptReference: refs.attempt as never,
          operationReference: refs.operation as never,
          jobName: "payment-paid-without-fulfillable-compensation:v1",
          fenceReference: refs.fence as never,
          fenceVersion: 1,
          claimedAt: clockNow as never,
          expiresAt: "2026-08-08T16:05:00.000Z" as never,
          status: "Claimed" as const,
        };
        return (options.lease === undefined ? receipt : options.lease) as never;
      },
      release: async () => {
        calls.push("lease.release");
        if (options.releaseThrows) throw new Error("synthetic release failure");
      },
    },
    source: {
      resolveIdentity: async () => {
        calls.push("resolveIdentity");
        return (options.identity === undefined ? currentIdentity : options.identity) as never;
      },
      resolve: async () => {
        calls.push("resolveSource");
        return currentSource as never;
      },
    },
    cases: {
      resolve: async () => {
        calls.push("case.resolve");
        return caseRecord;
      },
      ensure: async (input) => {
        calls.push("case.ensure");
        if (caseRecord !== null) return { status: "Existing", record: caseRecord };
        caseRecord = input.record;
        return { status: "Created", record: input.record };
      },
      reconcile: async (input) => {
        calls.push("case.reconcile");
        caseRecord = input.next;
        return { status: "Updated", record: input.next };
      },
    },
    actions: {
      resolve: async () => {
        calls.push("action.resolve");
        return action;
      },
      claim: async (input) => {
        calls.push("action.claim");
        const existing = {
          ...input.receipt,
          claimDisposition: "Existing" as const,
          claimedAt: "2026-08-08T15:59:30.000Z" as never,
        };
        const raced: PaymentCompensationActionReceipt =
          options.actionClaimRace === "ProviderKey"
            ? { ...existing, providerIdempotencyKey: `WP1310:${"e".repeat(64)}` as never }
            : options.actionClaimRace === "ActionDigest"
              ? { ...existing, actionDigest: digest("raced-action") as never }
              : options.actionClaimRace === "Amount"
                ? {
                    ...existing,
                    amount: { amountMinor: 1_999n, currencyCode: "CAD" as never },
                  }
                : options.actionClaimRace === "SourceSnapshot"
                  ? { ...existing, sourceSnapshotDigest: digest("raced-source") as never }
                  : options.actionClaimRace === "InteracDigest"
                    ? { ...existing, interacEvidenceDigest: digest("raced-interac") as never }
                    : options.actionClaimRace === "FutureTime"
                      ? { ...existing, claimedAt: "2026-08-08T16:00:30.000Z" as never }
                      : options.actionClaimRace === "PreDispositionTime"
                        ? { ...existing, claimedAt: "2026-08-08T15:58:30.000Z" as never }
                        : options.actionClaimRace === "BeforeInteracClaim"
                          ? { ...existing, claimedAt: "2026-08-08T15:59:00.000Z" as never }
                          : existing;
        action = options.actionClaimRace === undefined ? input.receipt : raced;
        return action;
      },
      recordOutcome: async (input) => {
        calls.push("action.recordOutcome");
        if (options.recordOutcomeThrows) throw new Error("synthetic record outcome failure");
        if (action === null) throw new Error("missing synthetic action");
        const updated: PaymentCompensationActionReceipt = {
          ...action,
          phase: input.nextPhase,
        };
        const tampered: PaymentCompensationActionReceipt =
          options.recordOutcomeTamper === "providerKey"
            ? { ...updated, providerIdempotencyKey: `WP1310:${"f".repeat(64)}` as never }
            : options.recordOutcomeTamper === "amount"
              ? {
                  ...updated,
                  amount: { amountMinor: 1_999n, currencyCode: "CAD" as never },
                }
              : options.recordOutcomeTamper === "actionDigest"
                ? { ...updated, actionDigest: digest("changed-action") as never }
                : options.recordOutcomeTamper === "sourceSnapshot"
                  ? { ...updated, sourceSnapshotDigest: digest("changed-source") as never }
                  : options.recordOutcomeTamper === "claimedAt"
                    ? { ...updated, claimedAt: "2026-08-08T15:59:30.000Z" as never }
                    : updated;
        if (options.recordOutcomeTamper === undefined) action = updated;
        return tampered;
      },
    },
    interac: {
      resolveClaim: async () => {
        calls.push("interac.resolveClaim");
        return interacClaim === null
          ? null
          : { ...interacClaim, claimDisposition: "Existing" as const };
      },
      resolve: async () => {
        calls.push("interac.resolve");
        return interacEvidenceValue as never;
      },
      claim: async (input) => {
        calls.push("interac.claim");
        interacClaimCalls += 1;
        interacClaim = {
          ...(input.evidence as PaymentInteracInPersonEvidence),
          actionReference: input.actionReference as never,
          claimedAt: input.claimedAt as never,
          claimDisposition: "Claimed",
          status: "Claimed",
        };
        return interacClaim;
      },
    },
    provider: {
      createIntent: async () => {
        throw new Error("not used");
      },
      cancelIntent: async () => {
        throw new Error("not used");
      },
      captureIntent: async () => {
        throw new Error("not used");
      },
      retrieveIntent: async (request) => {
        calls.push("provider.retrieve");
        const index = retrieveCalls;
        retrieveCalls += 1;
        const planned = options.retrievePlan?.[index];
        if (planned === "Malformed") return { kind: "Snapshot" } as never;
        if (planned === "Failure")
          return {
            kind: "Failure",
            context: request.context,
            code: "Unavailable",
            retryDisposition: "SameOperation",
            safeReasonCode: "PROVIDER_UNAVAILABLE",
          } as never;
        if (typeof planned === "bigint") providerRefunded = planned;
        const snapshot = providerSnapshot(request, providerRefunded);
        return planned === "CrossScope"
          ? providerSnapshot(request, providerRefunded, {
              context: { ...(request.context as object), storeReference: id(99) },
            })
          : snapshot;
      },
      refundPayment: async (request) => {
        calls.push("provider.refund");
        providerKeys.push(request.idempotencyKey);
        refundAmounts.push(request.amount.amountMinor);
        const behavior = options.refundBehaviors?.[refundCalls] ?? "Effect";
        refundCalls += 1;
        if (behavior === "Effect" || behavior === "ThrowAfterEffect") providerRefunded = 2_000n;
        if (behavior === "Throw" || behavior === "ThrowAfterEffect")
          throw new Error("synthetic provider throw");
        if (behavior === "Failure")
          return {
            kind: "Failure",
            context: request.context,
            code: "Unavailable",
            retryDisposition: "SameOperation",
            safeReasonCode: "PROVIDER_UNAVAILABLE",
          } as never;
        if (behavior === "Malformed") return { kind: "Snapshot" } as never;
        if (behavior === "CrossScope")
          return providerSnapshot(request, providerRefunded, {
            context: { ...(request.context as object), storeReference: id(99) },
          });
        return providerSnapshot(request, providerRefunded);
      },
    },
    refunds: {
      resolve: async () => {
        calls.push("refund.resolve");
        return refundComposition;
      },
      record: async (input) => {
        calls.push("refund.record");
        const proposed = { fact: input.fact, event: input.event };
        if (options.duplicateRefundTamper)
          return {
            status: "Duplicate",
            receipt: {
              ...proposed,
              fact: { ...input.fact, evidenceDigest: digest("changed-refund-evidence") as never },
            },
          };
        refundComposition = proposed;
        return { status: "Created", receipt: proposed };
      },
    },
    operations: {
      resolve: async () => {
        calls.push("operations.resolve");
        return operationsValue === true
          ? operationsReceipt()
          : operationsValue === false
            ? null
            : (operationsValue as never);
      },
    },
    audit: {
      createCase: async (input) =>
        systemAudit(
          refs.caseAudit,
          input,
          "PAYMENT_COMPENSATION_CASE_OPENED",
          "PaymentCompensationCase",
          refs.compensationCase,
          refs.compensationCase,
        ),
      createAction: async (input) =>
        systemAudit(
          refs.actionAudit,
          input,
          "PAYMENT_COMPENSATION_REFUND_CLAIMED",
          "PaymentCompensationAction",
          refs.action,
          refs.compensationCase,
        ),
      createRefund: async (input) =>
        systemAudit(
          refs.refundAudit,
          input,
          "PAYMENT_COMPENSATION_REFUND_CONFIRMED",
          "PaymentRefund",
          refs.refund,
          refs.compensationCase,
        ),
    },
    references: {
      hash: digest,
      equals: (left, right) => left === right,
      operationFor: () => refs.operation,
      caseFor: () => refs.compensationCase,
      actionFor: () => refs.action,
      providerIdempotencyKey: (input) =>
        `WP1310:${digest(fingerprint(input)).slice("sha256:".length)}`,
      refundFor: () => refs.refund,
      eventFor: () => refs.refundEvent,
      causationFor: () => refs.causation,
    },
  };

  return {
    service: createPaidWithoutFulfillableOrderService(ports),
    calls,
    providerKeys,
    refundAmounts,
    counts: {
      get retrieve() {
        return retrieveCalls;
      },
      get refund() {
        return refundCalls;
      },
      get interacClaim() {
        return interacClaimCalls;
      },
      get interacAuthorization() {
        return interacAuthorizationCalls;
      },
    },
    state: {
      get operation() {
        return operation;
      },
      get caseRecord() {
        return caseRecord;
      },
      get action() {
        return action;
      },
      get refundComposition() {
        return refundComposition;
      },
      setOperations(value: boolean | unknown) {
        operationsValue = value;
      },
      setInteracEvidence(value: unknown | null) {
        interacEvidenceValue = value;
      },
      setInteracClaim(value: PaymentInteracInPersonClaimReceipt | null) {
        interacClaim = value;
      },
      setSource(value: unknown) {
        currentSource = value;
      },
      makeSource(overrides: Record<string, unknown> = {}) {
        return harnessSource(currentIdentity, method, overrides);
      },
      setClock(value: string) {
        clockNow = value;
      },
      setProviderObservedAt(value: string | undefined) {
        providerObservedAt = value;
      },
      setProviderRefunded(value: bigint) {
        providerRefunded = value;
      },
      makeInteracEvidence(overrides: Record<string, unknown> = {}) {
        return interacEvidence(overrides);
      },
      makeInteracClaim(
        evidence: PaymentInteracInPersonEvidence,
        overrides: Record<string, unknown> = {},
      ): PaymentInteracInPersonClaimReceipt {
        return {
          ...evidence,
          actionReference: refs.action as never,
          claimedAt: "2026-08-08T15:59:00.000Z" as never,
          claimDisposition: "Existing",
          status: "Claimed",
          ...overrides,
        };
      },
      makeOperationsReceipt(overrides: Record<string, unknown> = {}) {
        return { ...operationsReceipt(), ...overrides };
      },
      setRefundComposition(value: PaymentRefundCompositionReceipt | null) {
        refundComposition = value;
      },
      tamperAction(value: PaymentCompensationActionReceipt) {
        action = value;
      },
      setCase(value: PaymentCompensationCase) {
        caseRecord = value;
      },
      setOperation(value: PaymentCompensationOperationRecord | null) {
        operation = value;
      },
    },
  };
}

async function compensationCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentCompensationError);
    return (error as PaymentCompensationError).code;
  }
  throw new Error("expected PaymentCompensationError");
}

describe("WP-1310 paid-without-fulfillable public contracts", () => {
  it("parses only the strict paid-without-fulfillable Ordering disposition", () => {
    const parsed = parsePaidWithoutFulfillableOrderDisposition(disposition());
    expect(parsed).toMatchObject({
      disposition: "PaidWithoutFulfillableOrder",
      reason: "CapacityExpired",
      kitchenReleaseDisposition: "Blocked",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expectInputInvalid(() =>
      parsePaidWithoutFulfillableOrderDisposition({ ...disposition(), clientAmountMinor: "2000" }),
    );
  });

  it("rejects disposition accessors without evaluating them", () => {
    let evaluated = false;
    const value = disposition();
    Object.defineProperty(value, "rawProviderPayload", {
      enumerable: true,
      get() {
        evaluated = true;
        return "forbidden";
      },
    });
    expectInputInvalid(() => parsePaidWithoutFulfillableOrderDisposition(value));
    expect(evaluated).toBe(false);
  });

  it("parses exact immutable Payment identity and rejects cross-shape fields", () => {
    const parsed = parsePaymentCompensationIdentitySource(identity());
    expect(parsed.environment).toBe("Test");
    expect(Object.isFrozen(parsed)).toBe(true);
    expectInputInvalid(() =>
      parsePaymentCompensationIdentitySource({
        ...identity(),
        providerIntentReference: "pi_secret",
      }),
    );
  });

  it("enforces captured CAD source invariants", () => {
    const parsed = parsePaymentCompensationSource(source());
    expect(parsed.capturedAmount.amountMinor).toBe(2_000n);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capturedAmount)).toBe(true);
    expectInputInvalid(() =>
      parsePaymentCompensationSource(
        source({
          confirmedRefundedAmount: { amountMinor: 1_500n, currencyCode: "CAD" },
          pendingRefundClaimedAmount: { amountMinor: 1_000n, currencyCode: "CAD" },
        }),
      ),
    );
  });

  it("composes the exact Store-scoped PaymentRefunded envelope", () => {
    const event = createPaymentRefundedEnvelope({ fact: refundFact() as never });
    expect(event).toMatchObject({
      eventType: "PaymentRefunded",
      aggregateType: "PaymentTransaction",
      aggregateId: refs.transaction,
      correlationId: refs.compensationCase,
      storeId: refs.store,
      redactionClassification: "payment",
      payload: {
        refundReference: refs.refund,
        amountMinor: "2000",
        currencyCode: "CAD",
        refundKind: "PaidWithoutFulfillableOrderCompensation",
      },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.actor)).toBe(true);
    expect(Object.isFrozen(event.replayMetadata)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it("defensively copies PaymentRefunded actor, replay metadata and payload", () => {
    const canonical = createPaymentRefundedEnvelope({ fact: refundFact() as never });
    const raw = {
      ...canonical,
      actor: { type: "System" },
      replayMetadata: { replaySafe: true },
      payload: { ...canonical.payload },
    };
    const parsed = parsePaymentRefundedEnvelope(raw);
    raw.payload.amountMinor = "9999";
    raw.replayMetadata.replaySafe = false;
    expect(parsed.payload.amountMinor).toBe("2000");
    expect(parsed.replayMetadata.replaySafe).toBe(true);
    expect(Object.isFrozen(parsed.actor)).toBe(true);
    expect(Object.isFrozen(parsed.replayMetadata)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
  });

  it("rejects PaymentRefunded aggregate, correlation, extras and accessors", () => {
    const event = createPaymentRefundedEnvelope({ fact: refundFact() as never });
    expectInputInvalid(() =>
      parsePaymentRefundedEnvelope({ ...event, aggregateId: refs.intent } as never),
    );
    expectInputInvalid(() =>
      parsePaymentRefundedEnvelope({ ...event, correlationId: refs.order } as never),
    );
    let evaluated = false;
    const accessor = { ...event } as Record<string, unknown>;
    Object.defineProperty(accessor, "rawProviderPayload", {
      enumerable: true,
      get() {
        evaluated = true;
        return "forbidden";
      },
    });
    expectInputInvalid(() => parsePaymentRefundedEnvelope(accessor));
    expect(evaluated).toBe(false);
  });

  it.each([
    ["StateMismatch", "ReconciliationStateMismatch", "Error"],
    ["AmountMismatch", "ReconciliationAmountMismatch", "Error"],
    ["RefundMismatch", "ReconciliationRefundMismatch", "Error"],
    ["TerminalConflict", "ReconciliationTerminalConflict", "Critical"],
  ] as const)(
    "maps %s reconciliation evidence to a bounded exception kind",
    (reason, kind, severity) => {
      const projected = createPaymentReconciliationExceptionSource(
        {
          exceptionReference: refs.compensationCase,
          brandReference: refs.brand,
          storeReference: refs.store,
          candidateReference: refs.source,
          reason,
          severity,
          status: "Open",
          openedAt: now,
        },
        { brandReference: refs.brand, storeReference: refs.store },
      );
      expect(projected).toMatchObject({ kind, severity, state: "Open" });
      expect(projected).not.toHaveProperty("evidenceDigest");
      expect(projected).not.toHaveProperty("amount");
      expect(projected).not.toHaveProperty("actorReference");
    },
  );

  it("maps a watchdog receipt without exposing its evidence digest", () => {
    const projected = createPaymentTerminalWatchdogExceptionSource(
      {
        exceptionReference: refs.compensationCase,
        brandReference: refs.brand,
        storeReference: refs.store,
        paymentAttemptReference: refs.attempt,
        evidenceDigest: digest("watchdog"),
        reason: "CaptureDeadlineExceeded",
        severity: "Critical",
        status: "Open",
        openedAt: now,
      },
      { brandReference: refs.brand, storeReference: refs.store },
    );
    expect(projected).toMatchObject({
      kind: "CaptureDeadlineExceeded",
      severity: "Critical",
      paymentAttemptReference: refs.attempt,
    });
    expect(projected).not.toHaveProperty("evidenceDigest");
  });

  it("parses an accessor-safe, deeply frozen Operations Audit receipt", () => {
    const raw = serviceHarness().state.makeOperationsReceipt();
    const parsed = parsePaymentOperationsReconciliationReceipt(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.audit)).toBe(true);
    expect(Object.isFrozen(parsed.audit.actor)).toBe(true);
    const mutable = raw.audit.actor as { type: "User"; reference: string };
    mutable.reference = id(94);
    expect(parsed.actorReference).toBe(refs.operationsActor);
    expect(parsed.audit.actor).toEqual({ type: "User", reference: refs.operationsActor });
  });

  it("rejects an Operations Audit accessor without evaluating it", () => {
    const raw = serviceHarness().state.makeOperationsReceipt();
    let evaluated = false;
    const audit = { ...raw.audit } as Record<string, unknown>;
    Object.defineProperty(audit, "actor", {
      enumerable: true,
      get() {
        evaluated = true;
        return raw.audit.actor;
      },
    });
    expectInputInvalid(() => parsePaymentOperationsReconciliationReceipt({ ...raw, audit }));
    expect(evaluated).toBe(false);
  });

  it.each(["deviceNetworkReference", "correctsAuditId", "beforeSummary", "afterSummary"] as const)(
    "rejects non-minimal Operations Audit field %s",
    (field) => {
      const raw = serviceHarness().state.makeOperationsReceipt();
      expectInputInvalid(() =>
        parsePaymentOperationsReconciliationReceipt({
          ...raw,
          audit: { ...raw.audit, [field]: field.includes("Summary") ? {} : id(95) },
        }),
      );
    },
  );
});

describe("WP-1310 paid-without-fulfillable compensation service", () => {
  it("authorizes before identity and performs no dependency work when denied", async () => {
    const value = serviceHarness({ deny: true });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_PERMISSION_DENIED",
    );
    expect(value.calls).toEqual(["authorize"]);
  });

  it("fails a tampered full-source digest before Provider retrieval", async () => {
    const value = serviceHarness({ tamperSourceDigest: true });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
    );
    expect(value.counts.retrieve).toBe(0);
    expect(value.counts.refund).toBe(0);
    expect(value.calls.at(-1)).toBe("lease.release");
  });

  it("retrieves, refunds with a server-derived amount, retrieves again and awaits Operations", async () => {
    const value = serviceHarness();
    const result = await value.service.execute(disposition());
    expect(result.status).toBe("AwaitingOperationsReconciliation");
    expect(value.counts.retrieve).toBe(2);
    expect(value.counts.refund).toBe(1);
    expect(value.refundAmounts).toEqual([2_000n]);
    expect(value.state.refundComposition?.event).toMatchObject({
      aggregateId: refs.transaction,
      correlationId: refs.compensationCase,
    });
    expect(value.calls.at(-1)).toBe("lease.release");
  });

  it("composes an already-full Provider refund with zero mutation", async () => {
    const value = serviceHarness({ retrievePlan: [2_000n] });
    const result = await value.service.execute(disposition());
    expect(result.status).toBe("AwaitingOperationsReconciliation");
    expect(value.counts.retrieve).toBe(1);
    expect(value.counts.refund).toBe(0);
    expect(result.eventReference).toBe(refs.refundEvent);
  });

  it("retries InvocationUnknown with the same Provider key only after a new retrieval", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw", "Effect"] });
    const first = await value.service.execute(disposition());
    expect(first.status).toBe("AwaitingProviderConfirmation");
    const callsBeforeRetry = value.calls.length;
    const second = await value.service.execute(disposition());
    expect(second.status).toBe("AwaitingOperationsReconciliation");
    expect(value.counts.refund).toBe(2);
    expect(value.providerKeys[0]).toBe(value.providerKeys[1]);
    expect(value.calls.slice(callsBeforeRetry).indexOf("provider.retrieve")).toBeLessThan(
      value.calls.slice(callsBeforeRetry).indexOf("provider.refund"),
    );
  });

  it("does not retry when a commit-unknown mutation effect is proven by the next retrieval", async () => {
    const value = serviceHarness({
      retrievePlan: [0n, "Failure", 2_000n],
      refundBehaviors: ["ThrowAfterEffect"],
    });
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingOperationsReconciliation",
    );
    expect(value.counts.refund).toBe(1);
  });

  it.each(["Failure", "Malformed", "CrossScope"] as const)(
    "retrieves after a %s mutation response and never treats the response as truth",
    async (behavior) => {
      const value = serviceHarness({ refundBehaviors: [behavior] });
      const result = await value.service.execute(disposition());
      expect(result.status).toBe("AwaitingProviderConfirmation");
      expect(value.counts.retrieve).toBe(2);
      expect(value.counts.refund).toBe(1);
      expect(value.state.refundComposition).toBeNull();
    },
  );

  it("retrieves and records full truth before a recordOutcome dependency failure", async () => {
    const value = serviceHarness({ recordOutcomeThrows: true });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
    );
    expect(value.counts.retrieve).toBe(2);
    expect(value.counts.refund).toBe(1);
    expect(value.state.refundComposition).not.toBeNull();
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingOperationsReconciliation",
    );
    expect(value.counts.refund).toBe(1);
  });

  it.each(["providerKey", "amount", "actionDigest", "sourceSnapshot", "claimedAt"] as const)(
    "rejects recordOutcome changing immutable %s",
    async (recordOutcomeTamper) => {
      const value = serviceHarness({ recordOutcomeTamper });
      await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
        "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
      );
      expect(value.counts.retrieve).toBe(2);
      expect(value.counts.refund).toBe(1);
      expect((await value.service.execute(disposition())).status).toBe(
        "AwaitingOperationsReconciliation",
      );
      expect(value.counts.refund).toBe(1);
    },
  );

  it("rejects a Duplicate refund receipt whose evidence differs from the proposed composition", async () => {
    const value = serviceHarness({
      retrievePlan: [2_000n],
      duplicateRefundTamper: true,
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.state.caseRecord).toMatchObject({
      state: "Open",
      refundDisposition: "NotStarted",
    });
    expect(value.state.operation).toBeNull();
  });

  it("closes when refund truth arrives before the exact Operations receipt", async () => {
    const value = serviceHarness();
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingOperationsReconciliation",
    );
    value.state.setOperations(true);
    expect((await value.service.execute(disposition())).status).toBe("Closed");
    value.calls.length = 0;
    expect((await value.service.execute(disposition())).status).toBe("Closed");
    expect(value.calls).toEqual(["authorize", "resolveIdentity", "resolveOperation"]);
  });

  it("closes when Operations evidence arrives before Provider-confirmed refund truth", async () => {
    const value = serviceHarness({
      operations: true,
      retrievePlan: ["Failure", 2_000n],
    });
    expect((await value.service.execute(disposition())).status).toBe("ReconciliationRequired");
    expect(value.state.caseRecord).toMatchObject({
      state: "Open",
      operationsDisposition: "Reconciled",
    });
    expect((await value.service.execute(disposition())).status).toBe("Closed");
    expect(value.counts.refund).toBe(0);
  });

  it("uses the cumulative Provider floor to derive only the remaining amount", async () => {
    const value = serviceHarness({
      retrievePlan: [500n, 1_000n, 1_000n],
      refundBehaviors: ["NoEffect"],
    });
    expect((await value.service.execute(disposition())).status).toBe("RefundPending");
    expect(value.refundAmounts).toEqual([1_500n]);
    expect((await value.service.execute(disposition())).status).toBe("RefundPending");
    expect(value.counts.refund).toBe(1);
  });

  it("rejects Provider refunded amount below the durable cumulative floor", async () => {
    const value = serviceHarness({
      sourceOverrides: {
        confirmedRefundedAmount: { amountMinor: 1_000n, currencyCode: "CAD" },
      },
      retrievePlan: [500n],
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("accepts an exact concurrent Existing action claim with its original causal time", async () => {
    const value = serviceHarness({ actionClaimRace: "Existing" });
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingOperationsReconciliation",
    );
    expect(value.state.action).toMatchObject({
      claimDisposition: "Existing",
      claimedAt: "2026-08-08T15:59:30.000Z",
    });
    expect(value.counts.refund).toBe(1);
  });

  it.each([
    "ProviderKey",
    "ActionDigest",
    "Amount",
    "SourceSnapshot",
    "FutureTime",
    "PreDispositionTime",
  ] as const)("rejects a concurrent Existing action with changed %s", async (actionClaimRace) => {
    const value = serviceHarness({ actionClaimRace });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("keeps expired unclaimed Interac evidence in person with zero financial mutation", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    value.state.setInteracEvidence(
      value.state.makeInteracEvidence({ expiresAt: "2026-08-08T15:59:30.000Z" }),
    );
    expect((await value.service.execute(disposition())).status).toBe("InPersonActionRequired");
    expect(value.counts.interacAuthorization).toBe(0);
    expect(value.counts.interacClaim).toBe(0);
    expect(value.counts.refund).toBe(0);
  });

  it("keeps missing Interac evidence in person with zero claim or generic refund", async () => {
    const value = serviceHarness({ method: "TerminalInterac", interacEvidence: null });
    expect((await value.service.execute(disposition())).status).toBe("InPersonActionRequired");
    expect(value.counts.interacAuthorization).toBe(0);
    expect(value.counts.interacClaim).toBe(0);
    expect(value.counts.refund).toBe(0);
  });

  it("claims fresh authorized Interac evidence but never calls the generic refund port", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    expect(value.counts.interacAuthorization).toBe(1);
    expect(value.counts.interacClaim).toBe(1);
    expect(value.counts.refund).toBe(0);
  });

  it("recovers an expired Interac claim committed before the action receipt", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    const expired = value.state.makeInteracEvidence({
      expiresAt: "2026-08-08T15:59:30.000Z",
    });
    value.state.setInteracEvidence(expired);
    value.state.setInteracClaim(value.state.makeInteracClaim(expired));
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    expect(value.counts.interacAuthorization).toBe(0);
    expect(value.counts.interacClaim).toBe(0);
    expect(value.counts.refund).toBe(0);
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    expect(value.counts.interacAuthorization).toBe(0);
    expect(value.counts.interacClaim).toBe(0);
    expect(value.counts.refund).toBe(0);
  });

  it("rejects an Existing Interac claim from the future", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    const evidence = value.state.makeInteracEvidence();
    value.state.setInteracClaim(
      value.state.makeInteracClaim(evidence, {
        claimedAt: "2026-08-08T16:00:30.000Z",
      }),
    );
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("rejects an Existing action whose claim time predates its durable Interac claim", async () => {
    const value = serviceHarness({
      method: "TerminalInterac",
      actionClaimRace: "BeforeInteracClaim",
    });
    const evidence = value.state.makeInteracEvidence();
    value.state.setInteracClaim(
      value.state.makeInteracClaim(evidence, {
        claimedAt: "2026-08-08T15:59:30.000Z",
      }),
    );
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("rejects a concurrent Interac action with a swapped evidence digest", async () => {
    const value = serviceHarness({
      method: "TerminalInterac",
      actionClaimRace: "InteracDigest",
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("replays a durable Interac action without current evidence, reauthorization or a generic refund", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    value.state.setInteracEvidence(null);
    const claimCalls = value.counts.interacClaim;
    const authorizationCalls = value.counts.interacAuthorization;
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingProviderConfirmation",
    );
    expect(value.counts.interacClaim).toBe(claimCalls);
    expect(value.counts.interacAuthorization).toBe(authorizationCalls);
    expect(value.counts.refund).toBe(0);
    expect(value.calls.filter((call) => call === "interac.resolve")).toHaveLength(1);
  });

  it("fails closed when a durable Interac action loses its exact claim receipt", async () => {
    const value = serviceHarness({ method: "TerminalInterac" });
    await value.service.execute(disposition());
    value.state.setInteracClaim(null);
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(0);
  });

  it("returns a bounded lease error without reading the clock when no lease is claimed", async () => {
    const value = serviceHarness({ lease: null });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
    );
    expect(value.calls).not.toContain("clock");
    expect(value.calls).not.toContain("lease.release");
  });

  it("releases a parsed lease that is expired at the single branch clock", async () => {
    const value = serviceHarness({
      lease: {
        paymentAttemptReference: refs.attempt,
        operationReference: refs.operation,
        jobName: "payment-paid-without-fulfillable-compensation:v1",
        fenceReference: refs.fence,
        fenceVersion: 1,
        claimedAt: "2026-08-08T15:59:00.000Z",
        expiresAt: now,
        status: "Claimed",
      },
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
    );
    expect(value.calls.at(-1)).toBe("lease.release");
    expect(value.counts.retrieve).toBe(0);
  });

  it("does not let a release failure replace a completed financial result", async () => {
    const value = serviceHarness({ retrievePlan: [2_000n], releaseThrows: true });
    await expect(value.service.execute(disposition())).resolves.toMatchObject({
      status: "AwaitingOperationsReconciliation",
    });
    expect(value.calls.at(-1)).toBe("lease.release");
  });

  it("rejects a changed open-operation result digest before claiming another lease", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw"] });
    await value.service.execute(disposition());
    const record = value.state.operation;
    if (record === null) throw new Error("expected synthetic operation record");
    value.state.setOperation({ ...record, resultDigest: digest("changed-result") as never });
    value.calls.length = 0;
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.calls).toEqual(["authorize", "resolveIdentity", "resolveOperation"]);
    expect(value.counts.refund).toBe(1);
  });

  it("rejects changed disposition content under the stable open operation", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw"] });
    await value.service.execute(disposition());
    value.calls.length = 0;
    await expect(
      compensationCode(value.service.execute(disposition({ reason: "SubmissionCancelled" }))),
    ).resolves.toBe("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    expect(value.calls).toEqual(["authorize", "resolveIdentity", "resolveOperation"]);
  });

  it("allows monotonic full-source version progression without minting another action", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw", "Effect"] });
    await value.service.execute(disposition());
    value.state.setSource(value.state.makeSource({ sourceVersion: 5 }));
    expect((await value.service.execute(disposition())).status).toBe(
      "AwaitingOperationsReconciliation",
    );
    expect(value.counts.refund).toBe(2);
    expect(new Set(value.providerKeys).size).toBe(1);
  });

  it("rejects changed immutable source evidence under a higher version", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw"] });
    await value.service.execute(disposition());
    value.state.setSource(
      value.state.makeSource({
        sourceVersion: 5,
        terminalEvidenceDigest: digest("changed-terminal"),
      }),
    );
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(1);
  });

  it("rejects a changed durable action anchor before a second mutation", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw"] });
    await value.service.execute(disposition());
    const current = value.state.action;
    if (current === null) throw new Error("expected synthetic action receipt");
    value.state.tamperAction({
      ...current,
      providerIdempotencyKey: `WP1310:${"d".repeat(64)}` as never,
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(1);
  });

  it("rejects a changed durable case source anchor before another Provider decision", async () => {
    const value = serviceHarness({ refundBehaviors: ["Throw"] });
    await value.service.execute(disposition());
    const current = value.state.caseRecord;
    if (current === null) throw new Error("expected synthetic case record");
    value.state.setCase({
      ...current,
      sourceSnapshotDigest: digest("changed-case-source") as never,
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.counts.refund).toBe(1);
  });

  it.each([
    ["2026-08-08T16:00:01.000Z", "AwaitingOperationsReconciliation"],
    ["2026-08-08T16:05:00.000Z", "AwaitingOperationsReconciliation"],
  ] as const)("accepts Provider evidence at causal time %s", async (providerObservedAt, status) => {
    const value = serviceHarness({ providerObservedAt });
    const result = await value.service.execute(disposition());
    expect(result.status).toBe(status);
    expect(result.evaluatedAt).toBe(providerObservedAt);
    expect(value.state.action?.claimedAt).toBe(now);
    expect(value.state.refundComposition?.fact.recordedAt).toBe(providerObservedAt);
  });

  it.each(["2026-08-08T15:59:59.999Z", "2026-08-08T16:05:00.001Z"] as const)(
    "rejects stale or post-lease Provider evidence at %s",
    async (providerObservedAt) => {
      const value = serviceHarness({ providerObservedAt });
      await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
        "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
      );
      expect(value.counts.refund).toBe(0);
    },
  );

  it.each(["digest", "future", "preCase", "actor"] as const)(
    "rejects Operations receipt %s tampering",
    async (tamper) => {
      const value = serviceHarness({ retrievePlan: [2_000n] });
      await value.service.execute(disposition());
      const exact = value.state.makeOperationsReceipt();
      const changed =
        tamper === "digest"
          ? { ...exact, refundEvidenceDigest: digest("wrong-refund") }
          : tamper === "future"
            ? { ...exact, reconciledAt: "2026-08-08T16:00:01.000Z" }
            : tamper === "preCase"
              ? { ...exact, reconciledAt: "2026-08-08T15:59:59.999Z" }
              : { ...exact, actorReference: id(98) };
      value.state.setOperations(changed);
      await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
        "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
      );
      expect(value.state.caseRecord?.state).toBe("Open");
    },
  );

  it("rejects changed Operations evidence after it was append-only reconciled", async () => {
    const value = serviceHarness({ operations: true, retrievePlan: ["Failure", "Failure"] });
    await value.service.execute(disposition());
    const exact = value.state.makeOperationsReceipt();
    const changedReceipt = id(91);
    const changedActor = id(92);
    value.state.setOperations({
      ...exact,
      receiptReference: changedReceipt,
      actorReference: changedActor,
      audit: {
        ...exact.audit,
        auditId: id(93),
        actor: { type: "User", reference: changedActor },
        correlationId: changedReceipt,
      },
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.state.caseRecord).toMatchObject({
      state: "Open",
      operationsReceiptReference: refs.operationsReceipt,
    });
  });

  it("rejects changed refund composition after the case anchored its full digest", async () => {
    const value = serviceHarness({ retrievePlan: [2_000n] });
    await value.service.execute(disposition());
    const exact = value.state.refundComposition;
    if (exact === null) throw new Error("expected synthetic refund composition");
    value.state.setRefundComposition({
      ...exact,
      fact: { ...exact.fact, evidenceDigest: digest("changed-existing-refund") as never },
    });
    await expect(compensationCode(value.service.execute(disposition()))).resolves.toBe(
      "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
    );
    expect(value.state.caseRecord?.state).toBe("Open");
  });

  it("keeps every public compensation error message bounded and identifier-free", async () => {
    const value = serviceHarness({ deny: true });
    try {
      await value.service.execute(disposition());
      throw new Error("expected compensation error");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentCompensationError);
      expect((error as Error).message).toBe("payment compensation is unavailable");
      expect((error as Error).message).not.toContain(refs.order);
      expect((error as Error).message).not.toContain("Provider");
    }
  });
});
