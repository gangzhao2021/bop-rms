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
  paymentAttemptLimit,
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

function requireCurrentPreparation(
  ports: PaymentIntentCreationPorts,
  preparation: OrderPaymentPreparationEvidence,
  previous: PaymentInstant,
): PaymentInstant {
  let current: PaymentInstant;
  try {
    current = parsePaymentInstant(ports.clock.now());
  } catch {
    return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
  }
  if (Date.parse(current) < Date.parse(previous))
    return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
  if (Date.parse(current) >= Date.parse(preparation.capacityExpiresAt))
    return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
  return current;
}

/** Both records have already been closed-parsed into immutable data, including bigint Money. */
function sameClaimedRecord(
  left: PaymentIntentCreationRecord,
  right: PaymentIntentCreationRecord,
): boolean {
  const serialize = (record: PaymentIntentCreationRecord) =>
    JSON.stringify(record, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  return serialize(left) === serialize(right);
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

function verifyRetryAudit(
  value: AppendAuditRecordInput,
  expected: {
    intentReference: PaymentReference;
    brandReference: string;
    storeReference: string;
    at: PaymentInstant;
    attemptNumber: number;
  },
): AppendAuditRecordInput {
  try {
    const base = verifyAudit(value, expected);
    return validateAuditRecord(
      {
        ...base,
        actionCode: "PAYMENT_ATTEMPT_RETRY",
        reasonCode: "CUSTOMER_RETRY_AFTER_DECLINE",
        afterSummary: { attemptNumber: expected.attemptNumber },
      },
      Date.parse(expected.at),
    );
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
  /** Create the Provider intent of a claimed attempt and persist what the Provider answered. */
  async function createAtProvider(
    claimedRecord: PaymentIntentCreationRecord,
    providerIdempotencyKey: ReturnType<typeof parseProviderIdempotencyKey>,
  ): Promise<PaymentIntentCreationRecord> {
    const preparation = claimedRecord.intent.preparation;
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
              paymentAttemptReference: claimedRecord.attempt.paymentAttemptReference,
              operationReference: claimedRecord.intent.paymentOperationReference,
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
    return ports.repository
      .recordObservation({ record: observed })
      .then(parsePaymentIntentCreationRecord)
      .catch(dependency);
  }
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
      let authorizationAt: PaymentInstant | undefined;
      const authorizeCurrent = async () => {
        let at: PaymentInstant;
        try {
          at = parsePaymentInstant(ports.clock.now());
        } catch {
          return fail(
            authorizationAt === undefined
              ? "PAYMENT_INTENT_PROVIDER_DISABLED"
              : "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
          );
        }
        if (authorizationAt !== undefined && Date.parse(at) < Date.parse(authorizationAt))
          return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
        authorizationAt = at;
        const value = await ports.authorization
          .authorize({
            action: "CreatePaymentIntent",
            paymentOperationReference: operation,
            submissionReference,
            observedAt: at,
          })
          .catch(dependency);
        if (value === null) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        return authorization(value);
      };
      const authorized = await authorizeCurrent();
      const reauthorize = async () => {
        const current = await authorizeCurrent();
        if (JSON.stringify(current) !== JSON.stringify(authorized))
          return fail("PAYMENT_INTENT_PERMISSION_DENIED");
      };
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
        await reauthorize();
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
      if (Date.parse(requestedAt) > Date.parse(evaluatedAt))
        return fail("PAYMENT_INTENT_ORDER_NOT_READY");
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
      evaluatedAt = requireCurrentPreparation(ports, preparation, evaluatedAt);
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
      await reauthorize();
      evaluatedAt = requireCurrentPreparation(ports, preparation, evaluatedAt);
      const claimed = await ports.repository.claim({ record: pending, audit }).catch(dependency);
      const claimedRaw = exactPaymentObject(claimed, ["status", "record"]);
      if (claimedRaw.status !== "Claimed" && claimedRaw.status !== "Existing")
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      const claimedRecord = verifyReplay(claimedRaw.record, replayExpected, ports);
      await reauthorize();
      if (claimedRaw.status === "Existing")
        return Object.freeze({
          status: claimedRecord.providerOutcome === null ? "Processing" : "AlreadyCreated",
          record: claimedRecord,
        });
      if (!sameClaimedRecord(claimedRecord, pending))
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      try {
        requireCurrentPreparation(ports, preparation, evaluatedAt);
      } catch {
        // The local claim remains durable. Recovery decides its disposition; no Provider result exists.
        return Object.freeze({ status: "Processing", record: claimedRecord });
      }
      const saved = await createAtProvider(claimedRecord, providerIdempotencyKey);
      // Persist financial observation even if access was revoked while Provider was in flight.
      await reauthorize();
      return Object.freeze({ status: "Created", record: saved });
    },
    /**
     * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): the customer who started paying
     * comes back (reload, another tab) to the same payment. Returns the intent's latest attempt as
     * stored — no new attempt, no Provider call, no tip or amount from the request — while the
     * payment window is open and the same guest session is still authorized for it. Whether that
     * attempt already has a terminal outcome is the caller's read (Payment's terminal facts).
     */
    async resume(value: unknown): Promise<CreatePaymentIntentResult> {
      const raw = exactPaymentObject(value, [
        "paymentOperationReference",
        "submissionReference",
        "requestedAt",
      ]);
      let operation: PaymentReference;
      let submissionReference: PaymentReference;
      try {
        operation = parsePaymentReference(raw.paymentOperationReference);
        submissionReference = parsePaymentReference(raw.submissionReference);
        parsePaymentInstant(raw.requestedAt);
      } catch {
        return fail("PAYMENT_INTENT_INPUT_INVALID");
      }
      const authorize = async () => {
        let at: PaymentInstant;
        try {
          at = parsePaymentInstant(ports.clock.now());
        } catch {
          return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
        }
        const value = await ports.authorization
          .authorize({
            action: "CreatePaymentIntent",
            paymentOperationReference: operation,
            submissionReference,
            observedAt: at,
          })
          .catch(dependency);
        if (value === null) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        return authorization(value);
      };
      const authorized = await authorize();
      const priorValue = await ports.repository.resolveOperation(operation).catch(dependency);
      if (priorValue === null) return fail("PAYMENT_INTENT_ORDER_NOT_READY");
      let prior: PaymentIntentCreationRecord;
      try {
        prior = parsePaymentIntentCreationRecord(priorValue);
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      const p = prior.intent.preparation;
      if (
        prior.intent.paymentOperationReference !== operation ||
        String(p.submissionReference) !== submissionReference ||
        String(p.brandReference) !== authorized.brandReference ||
        String(p.storeReference) !== authorized.storeReference ||
        String(p.guestSessionReference) !== authorized.guestSessionReference
      )
        return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
      let evaluatedAt: PaymentInstant;
      try {
        evaluatedAt = parsePaymentInstant(ports.clock.now());
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      if (Date.parse(evaluatedAt) >= Date.parse(p.capacityExpiresAt))
        return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
      if (JSON.stringify(await authorize()) !== JSON.stringify(authorized))
        return fail("PAYMENT_INTENT_PERMISSION_DENIED");
      return Object.freeze({
        status: prior.providerOutcome === null ? "Processing" : "AlreadyCreated",
        record: prior,
      });
    },
    /**
     * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): after the latest attempt failed (a declined card), open
     * the next attempt on the same intent: same order batch, amount and payment window. Repeating
     * the request while that attempt is open returns it; nothing is charged by opening an attempt.
     */
    async retry(value: unknown): Promise<CreatePaymentIntentResult> {
      const raw = exactPaymentObject(value, [
        "paymentOperationReference",
        "submissionReference",
        "requestedAt",
      ]);
      let operation: PaymentReference;
      let submissionReference: PaymentReference;
      try {
        operation = parsePaymentReference(raw.paymentOperationReference);
        submissionReference = parsePaymentReference(raw.submissionReference);
        parsePaymentInstant(raw.requestedAt);
      } catch {
        return fail("PAYMENT_INTENT_INPUT_INVALID");
      }
      const claimRetry = ports.repository.claimRetry?.bind(ports.repository);
      if (claimRetry === undefined) return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      let authorizedAt: PaymentInstant | undefined;
      const authorizeCurrent = async () => {
        let at: PaymentInstant;
        try {
          at = parsePaymentInstant(ports.clock.now());
        } catch {
          return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
        }
        if (authorizedAt !== undefined && Date.parse(at) < Date.parse(authorizedAt))
          return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
        authorizedAt = at;
        const value = await ports.authorization
          .authorize({
            action: "CreatePaymentIntent",
            paymentOperationReference: operation,
            submissionReference,
            observedAt: at,
          })
          .catch(dependency);
        if (value === null) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        return authorization(value);
      };
      const authorized = await authorizeCurrent();
      const reauthorize = async () => {
        if (JSON.stringify(await authorizeCurrent()) !== JSON.stringify(authorized))
          return fail("PAYMENT_INTENT_PERMISSION_DENIED");
      };
      const priorValue = await ports.repository.resolveOperation(operation).catch(dependency);
      if (priorValue === null) return fail("PAYMENT_INTENT_ORDER_NOT_READY");
      let prior: PaymentIntentCreationRecord;
      try {
        prior = parsePaymentIntentCreationRecord(priorValue);
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      const p = prior.intent.preparation;
      if (
        prior.intent.paymentOperationReference !== operation ||
        String(p.submissionReference) !== submissionReference ||
        String(p.brandReference) !== authorized.brandReference ||
        String(p.storeReference) !== authorized.storeReference ||
        String(p.guestSessionReference) !== authorized.guestSessionReference
      )
        return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
      if (prior.intent.paymentMethod !== "OnlineCard" || prior.attempt.provider !== "Stripe")
        return fail("PAYMENT_INTENT_RETRY_NOT_ALLOWED");
      let evaluatedAt: PaymentInstant;
      try {
        evaluatedAt = parsePaymentInstant(ports.clock.now());
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      if (Date.parse(evaluatedAt) >= Date.parse(p.capacityExpiresAt))
        return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
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
      if (prior.attempt.attemptNumber >= paymentAttemptLimit)
        return fail("PAYMENT_INTENT_RETRY_LIMIT_REACHED");
      const paymentAttemptReference = reference(ports, "PaymentAttempt");
      let providerIdempotencyKey;
      try {
        providerIdempotencyKey = parseProviderIdempotencyKey(
          ports.references.providerIdempotencyKey({
            environment: prior.attempt.providerEnvironment,
            paymentOperationReference: operation,
            paymentAttemptReference,
          }),
        );
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      const attemptNumber = prior.attempt.attemptNumber + 1;
      const pending = parsePaymentIntentCreationRecord({
        intent: prior.intent,
        attempt: {
          paymentAttemptReference,
          paymentIntentReference: prior.intent.paymentIntentReference,
          attemptNumber,
          provider: "Stripe",
          providerEnvironment: prior.attempt.providerEnvironment,
          providerIdempotencyDigest: digest(ports, providerIdempotencyKey),
          createdAt: evaluatedAt,
        },
        providerOutcome: null,
      });
      const audit = await ports.audit
        .create({
          paymentIntentReference: prior.intent.paymentIntentReference,
          paymentOperationReference: operation,
          brandReference: String(p.brandReference),
          storeReference: String(p.storeReference),
          observedAt: evaluatedAt,
        })
        .then((value) =>
          verifyRetryAudit(value, {
            intentReference: prior.intent.paymentIntentReference,
            brandReference: String(p.brandReference),
            storeReference: String(p.storeReference),
            at: evaluatedAt,
            attemptNumber,
          }),
        )
        .catch(dependency);
      await reauthorize();
      const claimed = await claimRetry({
        previousAttemptReference: prior.attempt.paymentAttemptReference,
        record: pending,
        audit,
      }).catch(dependency);
      const claimedRaw = exactPaymentObject(claimed, ["status", "record"]);
      if (claimedRaw.status !== "Claimed" && claimedRaw.status !== "Existing")
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      let claimedRecord: PaymentIntentCreationRecord;
      try {
        claimedRecord = parsePaymentIntentCreationRecord(claimedRaw.record);
      } catch {
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
      if (
        claimedRecord.intent.paymentIntentReference !== prior.intent.paymentIntentReference ||
        claimedRecord.attempt.attemptNumber < prior.attempt.attemptNumber
      )
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      await reauthorize();
      if (claimedRaw.status === "Existing")
        return Object.freeze({
          status: claimedRecord.providerOutcome === null ? "Processing" : "AlreadyCreated",
          record: claimedRecord,
        });
      if (!sameClaimedRecord(claimedRecord, pending))
        return fail("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      const saved = await createAtProvider(claimedRecord, providerIdempotencyKey);
      await reauthorize();
      return Object.freeze({ status: "Created", record: saved });
    },
  });
}
