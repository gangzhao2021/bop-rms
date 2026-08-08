import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseOrderPaymentPreparationEvidence,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";

import {
  createCreateIntentRequest,
  createPaymentProviderContext,
  createPaymentProviderFailure,
  parsePaymentProviderOutcome,
  parsePaymentReference,
  parseProviderIdempotencyKey,
} from "./payment-provider-adapter.js";
import type {
  PaymentProviderOutcome,
  PaymentReference,
} from "../contracts/payment-provider-adapter.js";
import {
  paymentProviderAdmissionKillSwitchKey,
  verifyPaymentProviderAdmission,
} from "./payment-kill-switch.js";
import {
  exactPaymentObject,
  parsePaymentDigest,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
  PaymentIntentCreationError,
  type CreatePaymentIntentResult,
  type PaymentDigest,
  type PaymentInstant,
  type PaymentIntentCreationRecord,
} from "./payment-intent-creation.js";
import type { PaymentIntentCreationPorts } from "./ports/payment-intent-creation-ports.js";

function fail(code: ConstructorParameters<typeof PaymentIntentCreationError>[0]): never {
  throw new PaymentIntentCreationError(code);
}

function dependency(error: unknown): never {
  if (error instanceof PaymentIntentCreationError) throw error;
  return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return fail("PAYMENT_INTENT_INPUT_INVALID");
  return value as number;
}

function optionalReference(value: unknown): PaymentReference | null {
  if (value === null) return null;
  try {
    return parsePaymentReference(value);
  } catch {
    return fail("PAYMENT_INTENT_INPUT_INVALID");
  }
}

function authorization(value: unknown): Readonly<{
  action: "CreatePaymentIntent";
  guestSessionReference: PaymentReference;
  brandReference: PaymentReference;
  storeReference: PaymentReference;
}> {
  const raw = exactPaymentObject(
    value,
    ["action", "guestSessionReference", "brandReference", "storeReference"],
    "PAYMENT_INTENT_PERMISSION_DENIED",
  );
  if (raw.action !== "CreatePaymentIntent") return fail("PAYMENT_INTENT_PERMISSION_DENIED");
  try {
    return Object.freeze({
      action: "CreatePaymentIntent",
      guestSessionReference: parsePaymentReference(raw.guestSessionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
    });
  } catch {
    return fail("PAYMENT_INTENT_PERMISSION_DENIED");
  }
}

function digest(ports: PaymentIntentCreationPorts, value: string): PaymentDigest {
  try {
    return parsePaymentDigest(ports.references.hash(value));
  } catch {
    return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
  }
}

function reference(
  ports: PaymentIntentCreationPorts,
  purpose: "PaymentIntent" | "PaymentAttempt",
): PaymentReference {
  try {
    return parsePaymentReference(ports.references.generate(purpose));
  } catch {
    return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
  }
}

function verifyPreparation(
  value: unknown,
  expected: {
    authorization: ReturnType<typeof authorization>;
    submissionReference: PaymentReference;
    cartReference: PaymentReference;
    expectedCartVersion: number;
    quoteReference: PaymentReference;
    requestedAt: PaymentInstant;
  },
): OrderPaymentPreparationEvidence {
  let evidence: OrderPaymentPreparationEvidence;
  try {
    evidence = parseOrderPaymentPreparationEvidence(value);
  } catch {
    return fail("PAYMENT_INTENT_ORDER_NOT_READY");
  }
  if (
    String(evidence.submissionReference) !== expected.submissionReference ||
    String(evidence.sourceCartReference) !== expected.cartReference ||
    evidence.sourceCartVersion !== expected.expectedCartVersion ||
    String(evidence.quoteReference) !== expected.quoteReference ||
    String(evidence.brandReference) !== expected.authorization.brandReference ||
    String(evidence.storeReference) !== expected.authorization.storeReference ||
    String(evidence.guestSessionReference) !== expected.authorization.guestSessionReference ||
    Date.parse(evidence.committedAt) > Date.parse(expected.requestedAt)
  )
    return fail("PAYMENT_INTENT_ORDER_NOT_READY");
  if (Date.parse(expected.requestedAt) >= Date.parse(evidence.capacityExpiresAt))
    return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
  if (Date.parse(evidence.capacityExpiresAt) - Date.parse(expected.requestedAt) !== 30 * 60 * 1_000)
    return fail("PAYMENT_INTENT_ORDER_NOT_READY");
  return evidence;
}

function verifyReplay(
  value: unknown,
  expected: {
    operation: PaymentReference;
    intentDigest: PaymentDigest;
    authorization: ReturnType<typeof authorization>;
  },
  ports: PaymentIntentCreationPorts,
): PaymentIntentCreationRecord {
  let record: PaymentIntentCreationRecord;
  try {
    record = parsePaymentIntentCreationRecord(value);
  } catch {
    return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
  }
  const intent = record.intent;
  if (
    intent.paymentOperationReference !== expected.operation ||
    !ports.references.equals(intent.intentDigest, expected.intentDigest) ||
    String(intent.preparation.brandReference) !== expected.authorization.brandReference ||
    String(intent.preparation.storeReference) !== expected.authorization.storeReference ||
    String(intent.preparation.guestSessionReference) !==
      expected.authorization.guestSessionReference
  )
    return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
  return record;
}

function verifyAudit(
  value: AppendAuditRecordInput,
  expected: {
    intentReference: PaymentReference;
    brandReference: string;
    storeReference: string;
    at: PaymentInstant;
  },
): AppendAuditRecordInput {
  try {
    const parsed = validateAuditRecord(value, Date.parse(expected.at));
    if (
      parsed.brandId !== expected.brandReference ||
      parsed.storeId !== expected.storeReference ||
      parsed.actor.type !== "System" ||
      parsed.actionCode !== "PAYMENT_INTENT_CREATE" ||
      parsed.targetType !== "PaymentIntent" ||
      parsed.targetId !== expected.intentReference ||
      parsed.beforeSummary !== undefined ||
      parsed.afterSummary !== undefined ||
      parsed.reasonCode !== "AUTHORIZED_PAYMENT_INTENT_CREATE" ||
      parsed.occurredAt !== expected.at ||
      parsed.sourceChannel !== "CUSTOMER_PWA" ||
      parsed.dataClassification !== "Restricted"
    )
      throw new Error("invalid audit");
    return parsed;
  } catch {
    return fail("PAYMENT_INTENT_PERMISSION_DENIED");
  }
}

function unknownOutcome(record: PaymentIntentCreationRecord): PaymentProviderOutcome {
  return createPaymentProviderFailure({
    kind: "Failure",
    context: createPaymentProviderContext({
      provider: "Stripe",
      environment: record.attempt.providerEnvironment,
      brandReference: String(record.intent.preparation.brandReference) as never,
      storeReference: String(record.intent.preparation.storeReference) as never,
      paymentAttemptReference: record.attempt.paymentAttemptReference,
      operationReference: record.intent.paymentOperationReference,
    }),
    code: "Unknown",
    retryDisposition: "Unknown",
    safeReasonCode: "CREATE_RESULT_UNKNOWN" as never,
  });
}

function verifyProviderOutcome(
  value: unknown,
  pending: PaymentIntentCreationRecord,
): PaymentProviderOutcome {
  try {
    return parsePaymentIntentCreationRecord({
      ...pending,
      providerOutcome: parsePaymentProviderOutcome(value),
    }).providerOutcome as PaymentProviderOutcome;
  } catch {
    return unknownOutcome(pending);
  }
}

export function createPaymentIntentCreationService(ports: PaymentIntentCreationPorts) {
  return Object.freeze({
    async create(value: unknown): Promise<CreatePaymentIntentResult> {
      const raw = exactPaymentObject(value, [
        "paymentOperationReference",
        "submissionReference",
        "cartReference",
        "expectedCartVersion",
        "quoteReference",
        "tipSelectionReference",
        "requestedAt",
      ]);
      let operation: PaymentReference;
      let submissionReference: PaymentReference;
      let cartReference: PaymentReference;
      let quoteReference: PaymentReference;
      let tipSelectionReference: PaymentReference | null;
      let requestedAt: PaymentInstant;
      try {
        operation = parsePaymentReference(raw.paymentOperationReference);
        submissionReference = parsePaymentReference(raw.submissionReference);
        cartReference = parsePaymentReference(raw.cartReference);
        quoteReference = parsePaymentReference(raw.quoteReference);
        tipSelectionReference = optionalReference(raw.tipSelectionReference);
        requestedAt = parsePaymentInstant(raw.requestedAt);
      } catch (error) {
        if (error instanceof PaymentIntentCreationError) throw error;
        return fail("PAYMENT_INTENT_INPUT_INVALID");
      }
      const expectedCartVersion = positiveVersion(raw.expectedCartVersion);
      const authorizedValue = await ports.authorization
        .authorize({
          action: "CreatePaymentIntent",
          paymentOperationReference: operation,
          submissionReference,
          observedAt: requestedAt,
        })
        .catch(dependency);
      if (authorizedValue === null) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
      const authorized = authorization(authorizedValue);
      const intentDigest = digest(
        ports,
        `CreatePaymentIntent:v1:${JSON.stringify({
          operation,
          submissionReference,
          cartReference,
          expectedCartVersion,
          quoteReference,
          tipSelectionReference,
        })}`,
      );
      const replayExpected = { operation, intentDigest, authorization: authorized };
      const prior = await ports.repository.resolveOperation(operation).catch(dependency);
      if (prior !== null) {
        const record = verifyReplay(prior, replayExpected, ports);
        return Object.freeze({
          status: record.providerOutcome === null ? "Processing" : "AlreadyCreated",
          record,
        });
      }
      let evaluatedAt: PaymentInstant;
      try {
        evaluatedAt = parsePaymentInstant(ports.clock.now());
      } catch {
        return fail("PAYMENT_INTENT_PROVIDER_DISABLED");
      }
      let killSwitchEvaluation: unknown;
      try {
        killSwitchEvaluation = await ports.killSwitch.evaluate({
          key: paymentProviderAdmissionKillSwitchKey,
          action: "CreatePaymentIntent",
          brandReference: authorized.brandReference,
          storeReference: authorized.storeReference,
          evaluatedAt,
        });
      } catch {
        return fail("PAYMENT_INTENT_PROVIDER_DISABLED");
      }
      if (
        verifyPaymentProviderAdmission(killSwitchEvaluation, {
          action: "CreatePaymentIntent",
          brandReference: authorized.brandReference,
          storeReference: authorized.storeReference,
          evaluatedAt,
        }) === null
      )
        return fail("PAYMENT_INTENT_PROVIDER_DISABLED");
      const preparedValue = await ports.ordering
        .preparePayment({
          submissionReference,
          cartReference,
          expectedCartVersion,
          quoteReference,
          tipSelectionReference,
          requestedAt,
        })
        .catch(dependency);
      const preparation = verifyPreparation(preparedValue, {
        authorization: authorized,
        submissionReference,
        cartReference,
        expectedCartVersion,
        quoteReference,
        requestedAt,
      });
      const paymentIntentReference = reference(ports, "PaymentIntent");
      const paymentAttemptReference = reference(ports, "PaymentAttempt");
      let providerIdempotencyKey;
      try {
        providerIdempotencyKey = parseProviderIdempotencyKey(
          ports.references.providerIdempotencyKey({
            environment: ports.providerEnvironment,
            paymentOperationReference: operation,
            paymentAttemptReference,
          }),
        );
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      const pending = parsePaymentIntentCreationRecord({
        intent: {
          paymentIntentReference,
          paymentOperationReference: operation,
          intentDigest,
          preparation,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          aggregateVersion: 1,
          creationStatus: "ProviderCreatePending",
          createdAt: requestedAt,
        },
        attempt: {
          paymentAttemptReference,
          paymentIntentReference,
          attemptNumber: 1,
          provider: "Stripe",
          providerEnvironment: ports.providerEnvironment,
          providerIdempotencyDigest: digest(ports, providerIdempotencyKey),
          createdAt: requestedAt,
        },
        providerOutcome: null,
      });
      const audit = await ports.audit
        .create({
          paymentIntentReference,
          paymentOperationReference: operation,
          brandReference: String(preparation.brandReference),
          storeReference: String(preparation.storeReference),
          observedAt: requestedAt,
        })
        .then((value) =>
          verifyAudit(value, {
            intentReference: paymentIntentReference,
            brandReference: String(preparation.brandReference),
            storeReference: String(preparation.storeReference),
            at: requestedAt,
          }),
        )
        .catch(dependency);
      const claimed = await ports.repository.claim({ record: pending, audit }).catch(dependency);
      const claimedRaw = exactPaymentObject(claimed, ["status", "record"]);
      if (claimedRaw.status !== "Claimed" && claimedRaw.status !== "Existing")
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      const claimedRecord = verifyReplay(claimedRaw.record, replayExpected, ports);
      if (claimedRaw.status === "Existing")
        return Object.freeze({
          status: claimedRecord.providerOutcome === null ? "Processing" : "AlreadyCreated",
          record: claimedRecord,
        });
      let outcome: PaymentProviderOutcome;
      try {
        outcome = verifyProviderOutcome(
          await ports.provider.createIntent(
            createCreateIntentRequest({
              operation: "CreateIntent",
              purpose: "CreatePaymentIntent",
              context: createPaymentProviderContext({
                provider: "Stripe",
                environment: claimedRecord.attempt.providerEnvironment,
                brandReference: String(preparation.brandReference) as never,
                storeReference: String(preparation.storeReference) as never,
                paymentAttemptReference,
                operationReference: operation,
              }),
              idempotencyKey: providerIdempotencyKey,
              paymentMethod: "OnlineCard",
              captureMode: "Automatic",
              amount: preparation.total,
            }),
          ),
          claimedRecord,
        );
      } catch {
        outcome = unknownOutcome(claimedRecord);
      }
      const observed = parsePaymentIntentCreationRecord({
        ...claimedRecord,
        providerOutcome: outcome,
      });
      const saved = await ports.repository
        .recordObservation({ record: observed })
        .then(parsePaymentIntentCreationRecord)
        .catch(dependency);
      return Object.freeze({ status: "Created", record: saved });
    },
  });
}
