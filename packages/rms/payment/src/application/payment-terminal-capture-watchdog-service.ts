import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { createTaskRecord } from "@bop/task";
import { parseOrderAcceptanceEvidence, type OrderAcceptanceEvidence } from "@rms/ordering";

import type {
  PaymentProviderSnapshot,
  PaymentReference,
} from "../contracts/payment-provider-adapter.js";
import {
  createCancelIntentRequest,
  createCaptureIntentRequest,
  createRetrieveIntentRequest,
  parsePaymentProviderOutcome,
  parsePaymentReference,
  parseProviderIdempotencyKey,
} from "./payment-provider-adapter.js";
import { parsePaymentDigest, parsePaymentInstant } from "./payment-intent-creation.js";
import {
  parsePaymentTerminalObservation,
  type PaymentTerminalObservation,
} from "./payment-terminal-fact.js";
import {
  parsePaymentTerminalAuthorizationEvidence,
  parsePaymentTerminalCaptureWatchdogCommand,
  parsePaymentTerminalCaptureWatchdogOperationRecord,
  parsePaymentTerminalCaptureWatchdogResult,
  parsePaymentTerminalWatchdogActionReceipt,
  parsePaymentTerminalWatchdogExceptionReceipt,
  parsePaymentTerminalWatchdogLeaseReceipt,
  parsePaymentTerminalWatchdogTerminalReceipt,
  paymentTerminalCaptureWatchdogJobName,
  PaymentTerminalCaptureWatchdogError,
  type PaymentTerminalAuthorizationEvidence,
  type PaymentTerminalCaptureWatchdogCommand,
  type PaymentTerminalCaptureWatchdogOperationRecord,
  type PaymentTerminalCaptureWatchdogResult,
  type PaymentTerminalWatchdogAction,
  type PaymentTerminalWatchdogActionReceipt,
  type PaymentTerminalWatchdogLeaseReceipt,
} from "./payment-terminal-capture-watchdog.js";
import type { PaymentTerminalCaptureWatchdogPorts } from "./ports/payment-terminal-capture-watchdog-ports.js";

function fail(code: ConstructorParameters<typeof PaymentTerminalCaptureWatchdogError>[0]): never {
  throw new PaymentTerminalCaptureWatchdogError(code);
}

function dependency(error?: unknown): never {
  if (error instanceof PaymentTerminalCaptureWatchdogError) throw error;
  return fail("PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE");
}

function sourceUnavailable(): never {
  return fail("PAYMENT_TERMINAL_WATCHDOG_SOURCE_UNAVAILABLE");
}

function exactPortObject(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    )
      return null;
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch {
    return null;
  }
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function sameCommand(
  left: PaymentTerminalCaptureWatchdogCommand,
  right: PaymentTerminalCaptureWatchdogCommand,
): boolean {
  return (
    left.operationReference === right.operationReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.paymentAttemptReference === right.paymentAttemptReference &&
    left.actorReference === right.actorReference &&
    left.purpose === right.purpose &&
    left.scheduledAt === right.scheduledAt
  );
}

function digest(
  ports: PaymentTerminalCaptureWatchdogPorts,
  value: string,
): ReturnType<typeof parsePaymentDigest> {
  try {
    return parsePaymentDigest(ports.references.hash(value));
  } catch {
    return dependency();
  }
}

function sameDigest(
  ports: PaymentTerminalCaptureWatchdogPorts,
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
  ports: PaymentTerminalCaptureWatchdogPorts,
  command: PaymentTerminalCaptureWatchdogCommand,
) {
  return digest(ports, `${paymentTerminalCaptureWatchdogJobName}:${JSON.stringify(command)}`);
}

function sameOperationRecord(
  ports: PaymentTerminalCaptureWatchdogPorts,
  left: PaymentTerminalCaptureWatchdogOperationRecord,
  right: PaymentTerminalCaptureWatchdogOperationRecord,
): boolean {
  return (
    sameCommand(left.command, right.command) &&
    sameDigest(ports, left.requestDigest, right.requestDigest) &&
    fingerprint(left.result) === fingerprint(right.result)
  );
}

function verifyReplay(
  value: unknown,
  command: PaymentTerminalCaptureWatchdogCommand,
  expectedDigest: string,
  ports: PaymentTerminalCaptureWatchdogPorts,
): PaymentTerminalCaptureWatchdogOperationRecord {
  let record;
  try {
    record = parsePaymentTerminalCaptureWatchdogOperationRecord(value);
  } catch {
    return dependency();
  }
  if (
    !sameCommand(record.command, command) ||
    !sameDigest(ports, record.requestDigest, expectedDigest)
  )
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  return record;
}

function addMinutes(value: string, minutes: number) {
  try {
    return parsePaymentInstant(new Date(Date.parse(value) + minutes * 60_000).toISOString());
  } catch {
    return sourceUnavailable();
  }
}

function earlier(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right)
    ? parsePaymentInstant(left)
    : parsePaymentInstant(right);
}

function thresholds(evidence: PaymentTerminalAuthorizationEvidence) {
  const rawAlertAt = addMinutes(evidence.authorizedAt, 10);
  const rawTargetAt = addMinutes(evidence.authorizedAt, 15);
  const policyDeadline = addMinutes(evidence.authorizedAt, 20);
  const hardDeadline =
    evidence.providerCaptureBeforeAt === null
      ? policyDeadline
      : earlier(policyDeadline, evidence.providerCaptureBeforeAt);
  return Object.freeze({
    alertAt: earlier(rawAlertAt, hardDeadline),
    targetCaptureAt: earlier(rawTargetAt, hardDeadline),
    hardDeadline,
  });
}

function verifyAuthorizationEvidence(
  value: unknown,
  command: PaymentTerminalCaptureWatchdogCommand,
  now: string,
) {
  let evidence;
  try {
    evidence = parsePaymentTerminalAuthorizationEvidence(value);
  } catch {
    return sourceUnavailable();
  }
  if (
    evidence.brandReference !== command.brandReference ||
    evidence.storeReference !== command.storeReference ||
    evidence.paymentAttemptReference !== command.paymentAttemptReference ||
    Date.parse(evidence.authorizedAt) > Date.parse(now)
  )
    return sourceUnavailable();
  return evidence;
}

function verifyLease(value: unknown, command: PaymentTerminalCaptureWatchdogCommand, now: string) {
  let lease;
  try {
    lease = parsePaymentTerminalWatchdogLeaseReceipt(value);
  } catch {
    return fail("PAYMENT_TERMINAL_WATCHDOG_LEASE_UNAVAILABLE");
  }
  if (
    lease.paymentAttemptReference !== command.paymentAttemptReference ||
    lease.operationReference !== command.operationReference ||
    Date.parse(lease.claimedAt) > Date.parse(now) ||
    Date.parse(lease.expiresAt) <= Date.parse(now)
  )
    return fail("PAYMENT_TERMINAL_WATCHDOG_LEASE_UNAVAILABLE");
  return lease;
}

function verifyAcceptance(
  value: unknown,
  evidence: PaymentTerminalAuthorizationEvidence,
  now: string,
) {
  if (value === null) return null;
  let acceptance;
  try {
    acceptance = parseOrderAcceptanceEvidence(value);
  } catch {
    return sourceUnavailable();
  }
  if (
    String(acceptance.brandReference) !== evidence.brandReference ||
    String(acceptance.storeReference) !== evidence.storeReference ||
    String(acceptance.orderReference) !== evidence.orderReference ||
    String(acceptance.orderBatchReference) !== evidence.orderBatchReference ||
    String(acceptance.paymentAttemptReference) !== evidence.paymentAttemptReference ||
    Date.parse(acceptance.acceptedAt) < Date.parse(evidence.authorizedAt) ||
    Date.parse(acceptance.acceptedAt) > Date.parse(now)
  )
    return sourceUnavailable();
  return acceptance;
}

function providerContext(
  evidence: PaymentTerminalAuthorizationEvidence,
  operationReference: PaymentReference,
) {
  return {
    provider: "Stripe" as const,
    environment: evidence.environment,
    brandReference: evidence.brandReference,
    storeReference: evidence.storeReference,
    paymentAttemptReference: evidence.paymentAttemptReference,
    operationReference,
  };
}

type RetrievedTruth =
  | { readonly kind: "Captured"; readonly snapshot: PaymentProviderSnapshot }
  | { readonly kind: "Cancelled"; readonly snapshot: PaymentProviderSnapshot }
  | { readonly kind: "Failed"; readonly snapshot: PaymentProviderSnapshot }
  | { readonly kind: "Authorized"; readonly snapshot: PaymentProviderSnapshot }
  | { readonly kind: "Unresolved"; readonly snapshot: PaymentProviderSnapshot | null };

async function retrieveTruth(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  operationReference: PaymentReference,
  observedFrom: string,
  observedUntil: string,
): Promise<RetrievedTruth> {
  let raw;
  try {
    raw = await ports.provider.retrieveIntent(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: providerContext(evidence, operationReference),
        providerIntentReference: evidence.providerIntentReference,
      }),
    );
  } catch {
    return Object.freeze({ kind: "Unresolved" as const, snapshot: null });
  }
  let outcome;
  try {
    outcome = parsePaymentProviderOutcome(raw);
  } catch {
    return dependency();
  }
  if (
    outcome.context.provider !== "Stripe" ||
    outcome.context.environment !== evidence.environment ||
    outcome.context.brandReference !== evidence.brandReference ||
    outcome.context.storeReference !== evidence.storeReference ||
    outcome.context.paymentAttemptReference !== evidence.paymentAttemptReference ||
    outcome.context.operationReference !== operationReference
  )
    return dependency();
  if (outcome.kind === "Failure")
    return Object.freeze({ kind: "Unresolved" as const, snapshot: null });
  if (
    outcome.providerIntentReference !== evidence.providerIntentReference ||
    outcome.paymentMethod !== evidence.paymentMethod ||
    outcome.captureMode !== evidence.captureMode ||
    outcome.requestedAmount.currencyCode !== "CAD" ||
    outcome.authorizedAmount.currencyCode !== "CAD" ||
    outcome.capturedAmount.currencyCode !== "CAD" ||
    outcome.refundedAmount.currencyCode !== "CAD" ||
    outcome.requestedAmount.amountMinor !== evidence.requestedAmount.amountMinor ||
    outcome.refundedAmount.amountMinor !== 0n ||
    Date.parse(outcome.observedAt) < Date.parse(observedFrom) ||
    Date.parse(outcome.observedAt) > Date.parse(observedUntil)
  )
    return dependency();
  if (
    (outcome.status === "Authorized" &&
      (outcome.authorizedAmount.amountMinor !== evidence.authorizedAmount.amountMinor ||
        outcome.capturedAmount.amountMinor !== 0n)) ||
    (outcome.status === "Captured" &&
      (outcome.authorizedAmount.amountMinor !== evidence.authorizedAmount.amountMinor ||
        outcome.capturedAmount.amountMinor !== evidence.requestedAmount.amountMinor))
  )
    return dependency();
  if (outcome.status === "Captured")
    return Object.freeze({ kind: "Captured" as const, snapshot: outcome });
  if (outcome.status === "Cancelled")
    return Object.freeze({ kind: "Cancelled" as const, snapshot: outcome });
  if (outcome.status === "Failed")
    return Object.freeze({ kind: "Failed" as const, snapshot: outcome });
  if (outcome.status === "Authorized")
    return Object.freeze({ kind: "Authorized" as const, snapshot: outcome });
  return Object.freeze({ kind: "Unresolved" as const, snapshot: outcome });
}

async function recordTerminal(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  truth: Extract<RetrievedTruth, { kind: "Captured" | "Cancelled" | "Failed" }>,
) {
  const expectedOutcome = truth.kind === "Captured" ? "Captured" : "Failed";
  const expectedFailureReason =
    truth.kind === "Captured"
      ? null
      : truth.kind === "Cancelled"
        ? "Cancelled"
        : "ProviderRejected";
  let existingRaw;
  try {
    existingRaw = await ports.terminal.resolve({
      paymentAttemptReference: evidence.paymentAttemptReference,
    });
  } catch {
    return dependency();
  }
  if (existingRaw !== null) {
    let existing;
    try {
      existing = parsePaymentTerminalWatchdogTerminalReceipt(existingRaw);
    } catch {
      return dependency();
    }
    if (
      existing.paymentIntentReference !== evidence.paymentIntentReference ||
      existing.paymentAttemptReference !== evidence.paymentAttemptReference ||
      existing.orderReference !== evidence.orderReference ||
      existing.brandReference !== evidence.brandReference ||
      existing.storeReference !== evidence.storeReference ||
      existing.outcome !== expectedOutcome ||
      existing.failureReason !== expectedFailureReason ||
      (expectedOutcome === "Captured" &&
        existing.amount?.amountMinor !== evidence.requestedAmount.amountMinor)
    )
      return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
    return existing;
  }

  let observationReference, causationReference;
  try {
    observationReference = parsePaymentReference(
      ports.references.observationFor({
        paymentAttemptReference: evidence.paymentAttemptReference,
        outcome: expectedOutcome,
      }),
    );
    causationReference = parsePaymentReference(
      ports.references.terminalCausationFor({
        paymentAttemptReference: evidence.paymentAttemptReference,
        outcome: expectedOutcome,
      }),
    );
  } catch {
    return dependency();
  }
  let observation: PaymentTerminalObservation;
  try {
    observation = parsePaymentTerminalObservation({
      observationReference,
      causationReference,
      webhookReceiptReference: null,
      providerEventReference: null,
      providerAccountReference: evidence.providerAccountReference,
      providerIntentReference: evidence.providerIntentReference,
      environment: evidence.environment,
      paymentIntentReference: evidence.paymentIntentReference,
      paymentAttemptReference: evidence.paymentAttemptReference,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      source: "ProviderRetrieval",
      status: truth.kind === "Captured" ? "Captured" : "Failed",
      amount: truth.kind === "Captured" ? truth.snapshot.capturedAmount : null,
      failureReason:
        truth.kind === "Captured"
          ? null
          : truth.kind === "Cancelled"
            ? "Cancelled"
            : "ProviderRejected",
      retryDisposition: truth.kind === "Captured" ? null : "Never",
      occurredAt: truth.snapshot.observedAt,
      evidenceDigest: truth.snapshot.evidenceDigest,
    });
  } catch {
    return dependency();
  }
  let rawReceipt;
  try {
    rawReceipt = await ports.terminal.record(observation);
  } catch {
    return dependency();
  }
  let receipt;
  try {
    receipt = parsePaymentTerminalWatchdogTerminalReceipt(rawReceipt);
  } catch {
    return dependency();
  }
  if (
    receipt.paymentIntentReference !== evidence.paymentIntentReference ||
    receipt.paymentAttemptReference !== evidence.paymentAttemptReference ||
    receipt.orderReference !== evidence.orderReference ||
    receipt.brandReference !== evidence.brandReference ||
    receipt.storeReference !== evidence.storeReference ||
    receipt.outcome !== expectedOutcome ||
    receipt.failureReason !== expectedFailureReason ||
    receipt.observationReference !== observationReference ||
    receipt.causationReference !== causationReference ||
    receipt.source !== "ProviderRetrieval" ||
    String(receipt.evidenceDigest) !== String(truth.snapshot.evidenceDigest) ||
    receipt.occurredAt !== truth.snapshot.observedAt ||
    (expectedOutcome === "Captured" &&
      receipt.amount?.amountMinor !== evidence.requestedAmount.amountMinor)
  )
    return dependency();
  return receipt;
}

function actionIdentity(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  action: PaymentTerminalWatchdogAction,
  acceptance: OrderAcceptanceEvidence | null,
  persistedAcceptanceDigest?: string | null,
) {
  try {
    const actionReference = parsePaymentReference(
      ports.references.actionFor({
        paymentAttemptReference: evidence.paymentAttemptReference,
        action,
      }),
    );
    const providerIdempotencyKey = parseProviderIdempotencyKey(
      ports.references.providerIdempotencyKey({
        environment: evidence.environment,
        brandReference: evidence.brandReference,
        storeReference: evidence.storeReference,
        paymentAttemptReference: evidence.paymentAttemptReference,
        action,
        purpose: action === "Capture" ? "CapturePaymentIntent" : "CancelPaymentIntent",
        amountMinor: evidence.requestedAmount.amountMinor,
        currencyCode: "CAD",
      }),
    );
    const calculatedAcceptanceDigest =
      acceptance === null
        ? null
        : digest(
            ports,
            `OrderAcceptanceEvidence:v1:${JSON.stringify({
              acceptanceReference: acceptance.acceptanceReference,
              checkpointReference: acceptance.checkpointReference,
              sourceVersion: acceptance.sourceVersion,
              sourceDigest: acceptance.sourceDigest,
              brandReference: acceptance.brandReference,
              storeReference: acceptance.storeReference,
              orderReference: acceptance.orderReference,
              orderBatchReference: acceptance.orderBatchReference,
              paymentAttemptReference: acceptance.paymentAttemptReference,
              phase: acceptance.phase,
              acceptanceKind: acceptance.acceptanceKind,
              acceptedAt: acceptance.acceptedAt,
            })}`,
          );
    if (
      persistedAcceptanceDigest !== undefined &&
      (calculatedAcceptanceDigest === null
        ? action === "Cancel"
          ? persistedAcceptanceDigest !== null
          : persistedAcceptanceDigest === null
        : !sameDigest(ports, calculatedAcceptanceDigest, persistedAcceptanceDigest ?? ""))
    )
      return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
    const acceptanceDigest = calculatedAcceptanceDigest ?? persistedAcceptanceDigest ?? null;
    if (
      (action === "Capture" && acceptanceDigest === null) ||
      (action === "Cancel" && acceptanceDigest !== null)
    )
      return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
    const actionDigest = digest(
      ports,
      `TerminalWatchdog${action}:v1:${JSON.stringify({
        actionReference,
        environment: evidence.environment,
        brandReference: evidence.brandReference,
        storeReference: evidence.storeReference,
        paymentAttemptReference: evidence.paymentAttemptReference,
        authorizationDigest: evidence.evidenceDigest,
        acceptanceDigest,
        amountMinor: evidence.requestedAmount.amountMinor.toString(),
        currencyCode: "CAD",
      })}`,
    );
    return Object.freeze({
      actionReference,
      providerIdempotencyKey,
      acceptanceDigest,
      actionDigest,
    });
  } catch (error) {
    return dependency(error);
  }
}

function verifyActionReceipt(
  value: unknown,
  expected: ReturnType<typeof actionIdentity> & {
    action: PaymentTerminalWatchdogAction;
    evidence: PaymentTerminalAuthorizationEvidence;
    now: string;
  },
  ports: PaymentTerminalCaptureWatchdogPorts,
) {
  let receipt;
  try {
    receipt = parsePaymentTerminalWatchdogActionReceipt(value);
  } catch {
    return dependency();
  }
  if (
    receipt.action !== expected.action ||
    receipt.actionReference !== expected.actionReference ||
    receipt.brandReference !== expected.evidence.brandReference ||
    receipt.storeReference !== expected.evidence.storeReference ||
    receipt.paymentAttemptReference !== expected.evidence.paymentAttemptReference ||
    !sameDigest(ports, receipt.authorizationDigest, expected.evidence.evidenceDigest) ||
    (receipt.acceptanceDigest === null) !== (expected.acceptanceDigest === null) ||
    (receipt.acceptanceDigest !== null &&
      expected.acceptanceDigest !== null &&
      !sameDigest(ports, receipt.acceptanceDigest, expected.acceptanceDigest)) ||
    !sameDigest(ports, receipt.actionDigest, expected.actionDigest) ||
    receipt.providerIdempotencyKey !== expected.providerIdempotencyKey ||
    Date.parse(receipt.claimedAt) < Date.parse(expected.evidence.authorizedAt) ||
    Date.parse(receipt.claimedAt) > Date.parse(expected.now)
  )
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  return receipt;
}

function verifyActionAudit(
  value: AppendAuditRecordInput,
  action: PaymentTerminalWatchdogAction,
  evidence: PaymentTerminalAuthorizationEvidence,
  command: PaymentTerminalCaptureWatchdogCommand,
  actionReference: PaymentReference,
  now: string,
) {
  try {
    const audit = validateAuditRecord(value, Date.parse(now));
    const actorMatches =
      command.actorReference === null
        ? audit.actor.type === "System"
        : audit.actor.type === "User" && audit.actor.reference === command.actorReference;
    if (
      audit.brandId !== evidence.brandReference ||
      audit.storeId !== evidence.storeReference ||
      !actorMatches ||
      audit.actionCode !== `PAYMENT_TERMINAL_${action.toUpperCase()}_CLAIM` ||
      audit.targetType !== "PaymentAttempt" ||
      audit.targetId !== evidence.paymentAttemptReference ||
      audit.beforeSummary !== undefined ||
      audit.afterSummary !== undefined ||
      audit.reasonCode !== "WATCH_TERMINAL_AUTHORIZATION" ||
      audit.correlationId !== actionReference ||
      audit.occurredAt !== now ||
      audit.sourceChannel !== "PAYMENT_WATCHDOG" ||
      audit.dataClassification !== "Restricted"
    )
      return dependency();
    return audit;
  } catch {
    return dependency();
  }
}

async function resolveAction(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  action: PaymentTerminalWatchdogAction,
  now: string,
  acceptance: OrderAcceptanceEvidence | null,
) {
  let raw;
  try {
    raw = await ports.actions.resolve({
      action,
      paymentAttemptReference: evidence.paymentAttemptReference,
    });
  } catch {
    return dependency();
  }
  if (raw === null) return Object.freeze({ receipt: null });
  let parsed;
  try {
    parsed = parsePaymentTerminalWatchdogActionReceipt(raw);
  } catch {
    return dependency();
  }
  const identity = actionIdentity(ports, evidence, action, acceptance, parsed.acceptanceDigest);
  return Object.freeze({
    receipt: verifyActionReceipt(parsed, { ...identity, action, evidence, now }, ports),
  });
}

async function claimAction(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  command: PaymentTerminalCaptureWatchdogCommand,
  lease: PaymentTerminalWatchdogLeaseReceipt,
  action: PaymentTerminalWatchdogAction,
  now: string,
  acceptance: OrderAcceptanceEvidence | null,
) {
  if (action === "Capture" && acceptance === null) return dependency();
  const identity = actionIdentity(ports, evidence, action, acceptance);
  let rawAudit;
  try {
    rawAudit = await ports.audit.createAction({
      action,
      actionReference: identity.actionReference,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      paymentAttemptReference: evidence.paymentAttemptReference,
      actorReference: command.actorReference,
      occurredAt: now,
    });
  } catch {
    return dependency();
  }
  const audit = verifyActionAudit(
    rawAudit,
    action,
    evidence,
    command,
    identity.actionReference,
    now,
  );
  let raw;
  try {
    raw = await ports.actions.claim({
      action,
      actionReference: identity.actionReference,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      paymentAttemptReference: evidence.paymentAttemptReference,
      authorizationDigest: evidence.evidenceDigest,
      acceptanceDigest: identity.acceptanceDigest,
      actionDigest: identity.actionDigest,
      providerIdempotencyKey: identity.providerIdempotencyKey,
      claimedAt: now,
      fenceReference: lease.fenceReference,
      fenceVersion: lease.fenceVersion,
      audit,
    });
  } catch {
    return dependency();
  }
  const receipt = verifyActionReceipt(raw, { ...identity, action, evidence, now }, ports);
  if (
    receipt.claimDisposition === "Claimed" &&
    (receipt.phase !== "Claimed" || receipt.claimedAt !== now)
  )
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  return receipt;
}

async function recordActionPhase(
  ports: PaymentTerminalCaptureWatchdogPorts,
  receipt: PaymentTerminalWatchdogActionReceipt,
  nextPhase: "InvocationUnknown" | "ResolvedAuthorized" | "TerminalObserved",
  now: string,
  lease: PaymentTerminalWatchdogLeaseReceipt,
  expected: ReturnType<typeof actionIdentity> & {
    action: PaymentTerminalWatchdogAction;
    evidence: PaymentTerminalAuthorizationEvidence;
  },
) {
  if (receipt.phase === nextPhase) return receipt;
  if (receipt.phase === "TerminalObserved")
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  let raw;
  try {
    raw = await ports.actions.recordOutcome({
      actionReference: receipt.actionReference,
      paymentAttemptReference: receipt.paymentAttemptReference,
      expectedPhase: receipt.phase,
      nextPhase,
      observedAt: now,
      fenceReference: lease.fenceReference,
      fenceVersion: lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  const updated = verifyActionReceipt(raw, { ...expected, now }, ports);
  if (
    updated.phase !== nextPhase ||
    updated.claimDisposition !== receipt.claimDisposition ||
    updated.claimedAt !== receipt.claimedAt
  )
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  return updated;
}

async function invokeAction(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  receipt: PaymentTerminalWatchdogActionReceipt,
  observedFrom: string,
  observedUntil: string,
): Promise<
  Readonly<{
    returned: boolean;
    valid: boolean;
    definitiveAuthorized: boolean;
    observedAt: string | null;
  }>
> {
  let raw;
  try {
    if (receipt.action === "Capture") {
      raw = await ports.provider.captureIntent(
        createCaptureIntentRequest({
          operation: "CaptureIntent",
          purpose: "CapturePaymentIntent",
          context: providerContext(evidence, receipt.actionReference),
          idempotencyKey: receipt.providerIdempotencyKey,
          providerIntentReference: evidence.providerIntentReference,
          paymentMethod: "TerminalCard",
          amount: evidence.requestedAmount,
        }),
      );
    } else {
      raw = await ports.provider.cancelIntent(
        createCancelIntentRequest({
          operation: "CancelIntent",
          purpose: "CancelPaymentIntent",
          context: providerContext(evidence, receipt.actionReference),
          idempotencyKey: receipt.providerIdempotencyKey,
          providerIntentReference: evidence.providerIntentReference,
        }),
      );
    }
  } catch {
    return Object.freeze({
      returned: false,
      valid: true,
      definitiveAuthorized: false,
      observedAt: null,
    });
  }
  try {
    const outcome = parsePaymentProviderOutcome(raw);
    const snapshotAmountsMatch =
      outcome.kind !== "Snapshot" ||
      (outcome.authorizedAmount.currencyCode === "CAD" &&
        outcome.capturedAmount.currencyCode === "CAD" &&
        outcome.refundedAmount.currencyCode === "CAD" &&
        outcome.authorizedAmount.amountMinor ===
          (outcome.status === "Authorized" || outcome.status === "Captured"
            ? evidence.authorizedAmount.amountMinor
            : 0n) &&
        outcome.capturedAmount.amountMinor ===
          (outcome.status === "Captured" ? evidence.requestedAmount.amountMinor : 0n) &&
        outcome.refundedAmount.amountMinor === 0n);
    if (
      outcome.context.provider !== "Stripe" ||
      outcome.context.environment !== evidence.environment ||
      outcome.context.brandReference !== evidence.brandReference ||
      outcome.context.storeReference !== evidence.storeReference ||
      outcome.context.paymentAttemptReference !== evidence.paymentAttemptReference ||
      outcome.context.operationReference !== receipt.actionReference ||
      !snapshotAmountsMatch ||
      (outcome.kind === "Snapshot" &&
        (outcome.providerIntentReference !== evidence.providerIntentReference ||
          outcome.paymentMethod !== evidence.paymentMethod ||
          outcome.captureMode !== evidence.captureMode ||
          outcome.requestedAmount.currencyCode !== "CAD" ||
          outcome.requestedAmount.amountMinor !== evidence.requestedAmount.amountMinor ||
          Date.parse(outcome.observedAt) < Date.parse(observedFrom) ||
          Date.parse(outcome.observedAt) > Date.parse(observedUntil)))
    )
      return Object.freeze({
        returned: true,
        valid: false,
        definitiveAuthorized: false,
        observedAt: null,
      });
    return Object.freeze({
      returned: true,
      valid: true,
      definitiveAuthorized: outcome.kind === "Snapshot" && outcome.status === "Authorized",
      observedAt: outcome.kind === "Snapshot" ? outcome.observedAt : null,
    });
  } catch {
    return Object.freeze({
      returned: true,
      valid: false,
      definitiveAuthorized: false,
      observedAt: null,
    });
  }
}

async function mutateAndRetrieve(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  receipt: PaymentTerminalWatchdogActionReceipt,
  now: string,
  lease: PaymentTerminalWatchdogLeaseReceipt,
  acceptance: OrderAcceptanceEvidence | null,
  observationFrom: string,
) {
  const mutation = await invokeAction(ports, evidence, receipt, observationFrom, lease.expiresAt);
  const retrievalFrom =
    mutation.observedAt !== null && Date.parse(mutation.observedAt) > Date.parse(observationFrom)
      ? mutation.observedAt
      : observationFrom;
  const truth = await retrieveTruth(
    ports,
    evidence,
    receipt.actionReference,
    retrievalFrom,
    lease.expiresAt,
  );
  const identity = actionIdentity(ports, evidence, receipt.action, acceptance);
  const nextPhase =
    truth.kind === "Captured" || truth.kind === "Cancelled" || truth.kind === "Failed"
      ? "TerminalObserved"
      : mutation.returned &&
          mutation.valid &&
          mutation.definitiveAuthorized &&
          truth.kind === "Authorized"
        ? "ResolvedAuthorized"
        : "InvocationUnknown";
  const updated = await recordActionPhase(ports, receipt, nextPhase, now, lease, {
    ...identity,
    action: receipt.action,
    evidence,
  });
  if (truth.kind === "Captured" || truth.kind === "Cancelled" || truth.kind === "Failed")
    await recordTerminal(ports, evidence, truth);
  if (!mutation.valid) return dependency();
  return Object.freeze({
    truth,
    receipt: updated,
    observedThrough: truth.snapshot?.observedAt ?? retrievalFrom,
  });
}

async function processCapture(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  command: PaymentTerminalCaptureWatchdogCommand,
  lease: PaymentTerminalWatchdogLeaseReceipt,
  now: string,
  acceptance: OrderAcceptanceEvidence,
  hardDeadline: string,
) {
  const currentTruth = await retrieveTruth(
    ports,
    evidence,
    command.operationReference,
    now,
    lease.expiresAt,
  );
  if (
    currentTruth.kind === "Captured" ||
    currentTruth.kind === "Cancelled" ||
    currentTruth.kind === "Failed"
  ) {
    await recordTerminal(ports, evidence, currentTruth);
    return Object.freeze({
      truth: currentTruth,
      receipt: null,
      deadlineCrossed: false,
      initialKind: null,
      observedThrough: currentTruth.snapshot.observedAt,
    });
  }
  if (currentTruth.kind !== "Authorized")
    return Object.freeze({
      truth: currentTruth,
      receipt: null,
      deadlineCrossed: false,
      initialKind: null,
      observedThrough: currentTruth.snapshot?.observedAt ?? now,
    });
  if (Date.parse(currentTruth.snapshot.observedAt) >= Date.parse(hardDeadline)) {
    return Object.freeze({
      truth: currentTruth,
      receipt: null,
      deadlineCrossed: true,
      initialKind: currentTruth.kind,
      observedThrough: currentTruth.snapshot.observedAt,
    });
  }

  const resolved = await resolveAction(ports, evidence, "Capture", now, acceptance);
  let receipt = resolved.receipt;
  if (receipt !== null) {
    if (receipt.phase === "TerminalObserved")
      return Object.freeze({
        truth: currentTruth,
        receipt,
        deadlineCrossed: false,
        initialKind: null,
        observedThrough: currentTruth.snapshot.observedAt,
      });
  } else {
    receipt = await claimAction(ports, evidence, command, lease, "Capture", now, acceptance);
    if (receipt.claimDisposition === "Existing" && receipt.phase === "TerminalObserved")
      return Object.freeze({
        truth: currentTruth,
        receipt,
        deadlineCrossed: false,
        initialKind: null,
        observedThrough: currentTruth.snapshot.observedAt,
      });
  }
  const outcome = await mutateAndRetrieve(
    ports,
    evidence,
    receipt,
    now,
    lease,
    acceptance,
    currentTruth.snapshot.observedAt,
  );
  return Object.freeze({
    ...outcome,
    deadlineCrossed: false,
    initialKind: null,
  });
}

async function processDeadline(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  command: PaymentTerminalCaptureWatchdogCommand,
  lease: PaymentTerminalWatchdogLeaseReceipt,
  now: string,
  observedFrom = now,
) {
  const initialTruth = await retrieveTruth(
    ports,
    evidence,
    command.operationReference,
    observedFrom,
    lease.expiresAt,
  );
  if (
    initialTruth.kind === "Captured" ||
    initialTruth.kind === "Cancelled" ||
    initialTruth.kind === "Failed"
  ) {
    await recordTerminal(ports, evidence, initialTruth);
    return Object.freeze({
      truth: initialTruth,
      initialKind: initialTruth.kind,
      observedThrough: initialTruth.snapshot.observedAt,
    });
  }
  if (initialTruth.kind !== "Authorized")
    return Object.freeze({
      truth: initialTruth,
      initialKind: initialTruth.kind,
      observedThrough: initialTruth.snapshot?.observedAt ?? observedFrom,
    });
  const capture = await resolveAction(ports, evidence, "Capture", now, null);
  if (
    capture.receipt !== null &&
    (capture.receipt.phase === "Claimed" || capture.receipt.phase === "InvocationUnknown")
  )
    return Object.freeze({
      truth: Object.freeze({ kind: "Unresolved" as const, snapshot: initialTruth.snapshot }),
      initialKind: initialTruth.kind,
      observedThrough: initialTruth.snapshot.observedAt,
    });
  if (capture.receipt !== null && capture.receipt.phase === "TerminalObserved")
    return Object.freeze({
      truth: Object.freeze({ kind: "Unresolved" as const, snapshot: initialTruth.snapshot }),
      initialKind: initialTruth.kind,
      observedThrough: initialTruth.snapshot.observedAt,
    });

  const cancel = await resolveAction(ports, evidence, "Cancel", now, null);
  let receipt = cancel.receipt;
  if (receipt !== null) {
    if (receipt.phase === "TerminalObserved")
      return Object.freeze({
        truth: Object.freeze({ kind: "Unresolved" as const, snapshot: initialTruth.snapshot }),
        initialKind: initialTruth.kind,
        observedThrough: initialTruth.snapshot.observedAt,
      });
  } else {
    receipt = await claimAction(ports, evidence, command, lease, "Cancel", now, null);
    if (receipt.claimDisposition === "Existing" && receipt.phase === "TerminalObserved")
      return Object.freeze({
        truth: Object.freeze({ kind: "Unresolved" as const, snapshot: initialTruth.snapshot }),
        initialKind: initialTruth.kind,
        observedThrough: initialTruth.snapshot.observedAt,
      });
  }
  const outcome = await mutateAndRetrieve(
    ports,
    evidence,
    receipt,
    now,
    lease,
    null,
    initialTruth.snapshot.observedAt,
  );
  return Object.freeze({
    truth: outcome.truth,
    initialKind: initialTruth.kind,
    observedThrough: outcome.observedThrough,
  });
}

async function ensureTask(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  alertAt: string,
  hardDeadline: string,
  now: string,
  receiptValidUntil: string,
) {
  let taskReference;
  try {
    taskReference = parsePaymentReference(
      ports.references.taskFor({ paymentAttemptReference: evidence.paymentAttemptReference }),
    );
  } catch {
    return dependency();
  }
  let raw;
  try {
    raw = await ports.tasks.ensure({
      taskReference,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      sourceType: "PAYMENT_ATTEMPT",
      sourceReference: evidence.paymentAttemptReference,
      sourceDigest: evidence.evidenceDigest,
      taskType: "TERMINAL_CAPTURE_WATCHDOG",
      severityCode: "CRITICAL",
      priorityCode: "CRITICAL",
      assignmentKind: "Queue",
      hardDeadline,
      requestedAt: alertAt,
      evaluatedAt: now,
      receiptValidUntil,
    });
  } catch {
    return dependency();
  }
  let task;
  try {
    task = createTaskRecord(raw);
  } catch {
    return dependency();
  }
  const expectedDueAt = new Date(
    Math.max(Date.parse(hardDeadline), Date.parse(task.createdAt)),
  ).toISOString();
  if (
    String(task.taskReference) !== taskReference ||
    task.scope.kind !== "Store" ||
    String(task.scope.brandReference) !== evidence.brandReference ||
    String(task.scope.storeReference) !== evidence.storeReference ||
    String(task.source.sourceType) !== "PAYMENT_ATTEMPT" ||
    String(task.source.sourceReference) !== evidence.paymentAttemptReference ||
    String(task.source.snapshotDigest) !== evidence.evidenceDigest ||
    String(task.taskType) !== "TERMINAL_CAPTURE_WATCHDOG" ||
    String(task.severityCode) !== "CRITICAL" ||
    String(task.priorityCode) !== "CRITICAL" ||
    (task.status !== "Assigned" && task.status !== "Claimed") ||
    task.currentAssignment?.target.kind !== "Queue" ||
    task.dueAt !== expectedDueAt ||
    Date.parse(task.createdAt) < Date.parse(alertAt) ||
    Date.parse(task.createdAt) > Date.parse(receiptValidUntil) ||
    Date.parse(task.updatedAt) > Date.parse(receiptValidUntil)
  )
    return dependency();
  return taskReference;
}

async function ensureException(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  hardDeadline: string,
) {
  let exceptionReference;
  try {
    exceptionReference = parsePaymentReference(
      ports.references.exceptionFor({
        paymentAttemptReference: evidence.paymentAttemptReference,
      }),
    );
  } catch {
    return dependency();
  }
  const expected = parsePaymentTerminalWatchdogExceptionReceipt({
    exceptionReference,
    brandReference: evidence.brandReference,
    storeReference: evidence.storeReference,
    paymentAttemptReference: evidence.paymentAttemptReference,
    evidenceDigest: evidence.evidenceDigest,
    reason: "CaptureDeadlineExceeded",
    severity: "Critical",
    status: "Open",
    openedAt: hardDeadline,
  });
  let raw;
  try {
    raw = await ports.exceptions.ensure(expected);
  } catch {
    return dependency();
  }
  let receipt;
  try {
    receipt = parsePaymentTerminalWatchdogExceptionReceipt(raw);
  } catch {
    return dependency();
  }
  if (fingerprint(receipt) !== fingerprint(expected)) return dependency();
  return exceptionReference;
}

async function ensureOperationalReceipts(
  ports: PaymentTerminalCaptureWatchdogPorts,
  evidence: PaymentTerminalAuthorizationEvidence,
  alertAt: string,
  hardDeadline: string,
  now: string,
  deadlineBreached: boolean,
  receiptValidUntil: string,
) {
  let taskReference: PaymentReference | null = null;
  let exceptionReference: PaymentReference | null = null;
  let failed = false;
  if (Date.parse(now) >= Date.parse(alertAt)) {
    try {
      taskReference = await ensureTask(
        ports,
        evidence,
        alertAt,
        hardDeadline,
        now,
        receiptValidUntil,
      );
    } catch {
      failed = true;
    }
  }
  if (deadlineBreached) {
    try {
      exceptionReference = await ensureException(ports, evidence, hardDeadline);
    } catch {
      failed = true;
    }
  }
  if (failed) return dependency();
  return Object.freeze({ taskReference, exceptionReference });
}

async function commitResult(
  ports: PaymentTerminalCaptureWatchdogPorts,
  command: PaymentTerminalCaptureWatchdogCommand,
  requestDigestValue: ReturnType<typeof parsePaymentDigest>,
  result: PaymentTerminalCaptureWatchdogResult,
  lease: PaymentTerminalWatchdogLeaseReceipt,
) {
  const expected = parsePaymentTerminalCaptureWatchdogOperationRecord({
    command,
    requestDigest: requestDigestValue,
    result,
  });
  let raw;
  try {
    raw = await ports.repository.commit({
      record: expected,
      fenceReference: lease.fenceReference,
      fenceVersion: lease.fenceVersion,
    });
  } catch {
    return dependency();
  }
  const envelope = exactPortObject(raw, ["status", "record"]);
  if (
    envelope === null ||
    !["Created", "Duplicate", "Conflict"].includes(envelope.status as string)
  )
    return dependency();
  let committed;
  try {
    committed = parsePaymentTerminalCaptureWatchdogOperationRecord(envelope.record);
  } catch {
    return dependency();
  }
  if (envelope.status === "Conflict" || !sameOperationRecord(ports, committed, expected))
    return fail("PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT");
  return committed.result;
}

export function createPaymentTerminalCaptureWatchdogService(
  ports: PaymentTerminalCaptureWatchdogPorts,
) {
  return Object.freeze({
    async process(value: unknown): Promise<PaymentTerminalCaptureWatchdogResult> {
      let command;
      try {
        command = parsePaymentTerminalCaptureWatchdogCommand(value);
      } catch {
        return fail("PAYMENT_TERMINAL_WATCHDOG_INPUT_INVALID");
      }
      let authorized: boolean;
      try {
        authorized = (await ports.authorization.authorize(command)) === true;
      } catch {
        authorized = false;
      }
      if (!authorized) return fail("PAYMENT_TERMINAL_WATCHDOG_PERMISSION_DENIED");
      const requestDigestValue = requestDigest(ports, command);
      let existing;
      try {
        existing = await ports.repository.resolveOperation({
          operationReference: command.operationReference,
        });
      } catch {
        return dependency();
      }
      if (existing !== null)
        return verifyReplay(existing, command, requestDigestValue, ports).result;

      let rawLease;
      try {
        rawLease = await ports.lease.claim({
          paymentAttemptReference: command.paymentAttemptReference,
          operationReference: command.operationReference,
          jobName: paymentTerminalCaptureWatchdogJobName,
        });
      } catch {
        return dependency();
      }
      if (rawLease === null) return fail("PAYMENT_TERMINAL_WATCHDOG_LEASE_UNAVAILABLE");
      let now;
      try {
        now = parsePaymentInstant(ports.clock.now());
      } catch {
        return dependency();
      }
      const lease = verifyLease(rawLease, command, now);
      try {
        let rawEvidence;
        try {
          rawEvidence = await ports.source.resolveAuthorization({
            brandReference: command.brandReference,
            storeReference: command.storeReference,
            paymentAttemptReference: command.paymentAttemptReference,
          });
        } catch {
          return sourceUnavailable();
        }
        if (rawEvidence === null) return sourceUnavailable();
        const evidence = verifyAuthorizationEvidence(rawEvidence, command, now);

        if (evidence.paymentMethod === "TerminalInterac") {
          const result = parsePaymentTerminalCaptureWatchdogResult({
            status: "InteracSingleMessage",
            evaluatedAt: now,
            alertAt: null,
            targetCaptureAt: null,
            hardDeadline: null,
            taskReference: null,
            exceptionReference: null,
          });
          return commitResult(ports, command, requestDigestValue, result, lease);
        }

        const timing = thresholds(evidence);
        const deadlineBreached = Date.parse(now) >= Date.parse(timing.hardDeadline);
        let acceptance = null;
        if (!deadlineBreached) {
          let rawAcceptance;
          try {
            rawAcceptance = await ports.ordering.resolveAcceptance({
              brandReference: evidence.brandReference,
              storeReference: evidence.storeReference,
              orderReference: evidence.orderReference,
              orderBatchReference: evidence.orderBatchReference,
              paymentAttemptReference: evidence.paymentAttemptReference,
            });
          } catch {
            return sourceUnavailable();
          }
          acceptance = verifyAcceptance(rawAcceptance, evidence, now);
        }

        if (!deadlineBreached && acceptance === null) {
          const receipts = await ensureOperationalReceipts(
            ports,
            evidence,
            timing.alertAt,
            timing.hardDeadline,
            now,
            false,
            lease.expiresAt,
          );
          const result = parsePaymentTerminalCaptureWatchdogResult({
            status: "AwaitingOrderAcceptance",
            evaluatedAt: now,
            ...timing,
            ...receipts,
          });
          return commitResult(ports, command, requestDigestValue, result, lease);
        }

        let workflowOutcome;
        try {
          workflowOutcome = deadlineBreached
            ? Object.freeze({
                ...(await processDeadline(ports, evidence, command, lease, now)),
                deadlineCrossed: true,
              })
            : await processCapture(
                ports,
                evidence,
                command,
                lease,
                now,
                acceptance as OrderAcceptanceEvidence,
                timing.hardDeadline,
              );
        } catch (error) {
          await ensureOperationalReceipts(
            ports,
            evidence,
            timing.alertAt,
            timing.hardDeadline,
            now,
            deadlineBreached,
            lease.expiresAt,
          );
          return dependency(error);
        }
        const truth = workflowOutcome.truth;
        const operationalAt =
          Date.parse(workflowOutcome.observedThrough) > Date.parse(now)
            ? workflowOutcome.observedThrough
            : now;
        const operationalDeadlineBreached =
          workflowOutcome.deadlineCrossed ||
          Date.parse(operationalAt) >= Date.parse(timing.hardDeadline);
        if (truth.kind === "Captured") {
          const captureMissedDeadline = workflowOutcome.deadlineCrossed
            ? workflowOutcome.initialKind !== "Captured" ||
              Date.parse(truth.snapshot.observedAt) > Date.parse(timing.hardDeadline)
            : Date.parse(truth.snapshot.observedAt) > Date.parse(timing.hardDeadline);
          const receipts = captureMissedDeadline
            ? await ensureOperationalReceipts(
                ports,
                evidence,
                timing.alertAt,
                timing.hardDeadline,
                operationalAt,
                true,
                lease.expiresAt,
              )
            : Object.freeze({ taskReference: null, exceptionReference: null });
          const result = parsePaymentTerminalCaptureWatchdogResult({
            status: "CaptureConfirmed",
            evaluatedAt: now,
            ...timing,
            ...receipts,
          });
          return commitResult(ports, command, requestDigestValue, result, lease);
        }

        const receipts = await ensureOperationalReceipts(
          ports,
          evidence,
          timing.alertAt,
          timing.hardDeadline,
          operationalAt,
          operationalDeadlineBreached,
          lease.expiresAt,
        );
        const status =
          workflowOutcome.deadlineCrossed && truth.kind === "Cancelled"
            ? "CancelConfirmed"
            : operationalDeadlineBreached
              ? "ReconciliationRequired"
              : truth.kind === "Cancelled" || truth.kind === "Failed"
                ? "ReconciliationRequired"
                : "PendingCapture";
        const result = parsePaymentTerminalCaptureWatchdogResult({
          status,
          evaluatedAt: now,
          ...timing,
          ...receipts,
        });
        return commitResult(ports, command, requestDigestValue, result, lease);
      } finally {
        try {
          await ports.lease.release({
            paymentAttemptReference: command.paymentAttemptReference,
            operationReference: command.operationReference,
            jobName: paymentTerminalCaptureWatchdogJobName,
            fenceReference: lease.fenceReference,
            fenceVersion: lease.fenceVersion,
          });
        } catch {
          // The fenced lease expires independently; release failure cannot replace a bounded result.
        }
      }
    },
  });
}
