import {
  createRetrieveIntentRequest,
  parsePaymentProviderOutcome,
  parsePaymentReference,
} from "./payment-provider-adapter.js";
import {
  parsePaymentDigest,
  parsePaymentInstant,
  type PaymentInstant,
} from "./payment-intent-creation.js";
import {
  parsePaymentReconciliationRunInput,
  parseOperationalReconciliationCandidate,
  parseSettlementReconciliationCandidate,
  PaymentReconciliationError,
  paymentReconciliationOutcomes,
  type PaymentOperationalReconciliationCandidate,
  type PaymentReconciliationCheck,
  type PaymentReconciliationDifferenceReason,
  type PaymentReconciliationException,
  type PaymentReconciliationRunInput,
  type PaymentReconciliationRunResult,
  type PaymentSettlementReconciliationCandidate,
} from "./payment-reconciliation.js";
import type { PaymentReconciliationPorts } from "./ports/payment-reconciliation-ports.js";

export const paymentReconciliationJobName = "payment-reconciliation:v1" as const;
export const paymentReconciliationCadence = Object.freeze({
  operationalMaximumMinutes: 15,
  dailySettlement: true,
});

function fail(code: ConstructorParameters<typeof PaymentReconciliationError>[0]): never {
  throw new PaymentReconciliationError(code);
}

function dependency(): never {
  return fail("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
}

function sameRun(left: PaymentReconciliationRunInput, right: PaymentReconciliationRunInput) {
  return (
    left.runReference === right.runReference &&
    left.mode === right.mode &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.actorReference === right.actorReference &&
    left.purpose === right.purpose &&
    left.scheduledAt === right.scheduledAt &&
    left.cutoffAt === right.cutoffAt &&
    left.maxCandidates === right.maxCandidates
  );
}

function resultLooksSafe(
  result: PaymentReconciliationRunResult,
  run: PaymentReconciliationRunInput,
) {
  try {
    return (
      result !== null &&
      typeof result === "object" &&
      result.status === "Completed" &&
      sameRun(result.run, run) &&
      Array.isArray(result.checks) &&
      Array.isArray(result.exceptions) &&
      result.checks.length <= run.maxCandidates &&
      result.checks.every(
        (check) =>
          check.runReference === run.runReference &&
          check.brandReference === run.brandReference &&
          check.storeReference === run.storeReference &&
          paymentReconciliationOutcomes.includes(check.outcome),
      )
    );
  } catch {
    return false;
  }
}

function fingerprint(value: unknown) {
  return JSON.stringify(value, (_key, candidate) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate,
  );
}

function zeroCounts() {
  return {
    Matched: 0,
    Healed: 0,
    Unresolved: 0,
    Unavailable: 0,
    Difference: 0,
  };
}

function checkReference(ports: PaymentReconciliationPorts) {
  try {
    return parsePaymentReference(ports.references.generate("Check"));
  } catch {
    return dependency();
  }
}

function difference(
  ports: PaymentReconciliationPorts,
  run: PaymentReconciliationRunInput,
  candidate: PaymentOperationalReconciliationCandidate,
  checkedAt: PaymentInstant,
  reason: PaymentReconciliationDifferenceReason,
  providerStatus: PaymentReconciliationCheck["providerStatus"],
  providerCapturedAmount: PaymentReconciliationCheck["providerCapturedAmount"],
  providerRefundedAmount: PaymentReconciliationCheck["providerRefundedAmount"],
) {
  let exceptionReference;
  try {
    exceptionReference = parsePaymentReference(
      ports.references.exceptionFor({
        brandReference: run.brandReference,
        storeReference: run.storeReference,
        candidateReference: candidate.candidateReference,
        reason,
      }),
    );
  } catch {
    return dependency();
  }
  const exception: PaymentReconciliationException = Object.freeze({
    exceptionReference,
    brandReference: run.brandReference,
    storeReference: run.storeReference,
    candidateReference: candidate.candidateReference,
    reason,
    severity: reason === "TerminalConflict" ? "Critical" : "Error",
    status: "Open",
    openedAt: checkedAt,
  });
  const check: PaymentReconciliationCheck = Object.freeze({
    checkReference: checkReference(ports),
    runReference: run.runReference,
    candidateReference: candidate.candidateReference,
    mode: "Operational",
    brandReference: run.brandReference,
    storeReference: run.storeReference,
    paymentIntentReference: candidate.paymentIntentReference,
    settlementReference: null,
    outcome: "Difference",
    differenceReason: reason,
    internalStatus: candidate.internalStatus,
    providerStatus,
    internalCapturedAmount: candidate.capturedAmount,
    providerCapturedAmount,
    internalRefundedAmount: candidate.refundedAmount,
    providerRefundedAmount,
    exceptionReference,
    safeCode: null,
    checkedAt,
  });
  return { check, exception };
}

function ordinaryCheck(
  ports: PaymentReconciliationPorts,
  run: PaymentReconciliationRunInput,
  candidate: PaymentOperationalReconciliationCandidate,
  checkedAt: PaymentInstant,
  input: Pick<
    PaymentReconciliationCheck,
    "outcome" | "providerStatus" | "providerCapturedAmount" | "providerRefundedAmount" | "safeCode"
  >,
): PaymentReconciliationCheck {
  return Object.freeze({
    checkReference: checkReference(ports),
    runReference: run.runReference,
    candidateReference: candidate.candidateReference,
    mode: "Operational",
    brandReference: run.brandReference,
    storeReference: run.storeReference,
    paymentIntentReference: candidate.paymentIntentReference,
    settlementReference: null,
    outcome: input.outcome,
    differenceReason: null,
    internalStatus: candidate.internalStatus,
    providerStatus: input.providerStatus,
    internalCapturedAmount: candidate.capturedAmount,
    providerCapturedAmount: input.providerCapturedAmount,
    internalRefundedAmount: candidate.refundedAmount,
    providerRefundedAmount: input.providerRefundedAmount,
    exceptionReference: null,
    safeCode: input.safeCode,
    checkedAt,
  });
}

function exactCandidateScope(
  candidate: PaymentOperationalReconciliationCandidate,
  run: PaymentReconciliationRunInput,
) {
  return (
    candidate.brandReference === run.brandReference &&
    candidate.storeReference === run.storeReference &&
    Date.parse(candidate.dueAt) <= Date.parse(run.cutoffAt)
  );
}

async function operationalCheck(
  ports: PaymentReconciliationPorts,
  run: PaymentReconciliationRunInput,
  candidate: PaymentOperationalReconciliationCandidate,
  checkedAt: PaymentInstant,
) {
  let rawOutcome;
  try {
    rawOutcome = await ports.provider.retrieveIntent(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: {
          provider: "Stripe",
          environment: candidate.environment,
          brandReference: candidate.brandReference,
          storeReference: candidate.storeReference,
          paymentAttemptReference: candidate.paymentAttemptReference,
          operationReference: run.runReference,
        },
        providerIntentReference: candidate.providerIntentReference,
      }),
    );
  } catch {
    return {
      check: ordinaryCheck(ports, run, candidate, checkedAt, {
        outcome: "Unavailable",
        providerStatus: null,
        providerCapturedAmount: null,
        providerRefundedAmount: null,
        safeCode: "PROVIDER_DEPENDENCY_UNAVAILABLE",
      }),
      exception: null,
    };
  }
  let outcome;
  try {
    outcome = parsePaymentProviderOutcome(rawOutcome);
  } catch {
    return dependency();
  }
  if (
    outcome.context.brandReference !== run.brandReference ||
    outcome.context.storeReference !== run.storeReference ||
    outcome.context.paymentAttemptReference !== candidate.paymentAttemptReference ||
    outcome.context.operationReference !== run.runReference
  )
    return dependency();
  if (outcome.kind === "Failure")
    return {
      check: ordinaryCheck(ports, run, candidate, checkedAt, {
        outcome: "Unavailable",
        providerStatus: null,
        providerCapturedAmount: null,
        providerRefundedAmount: null,
        safeCode: outcome.safeReasonCode,
      }),
      exception: null,
    };
  if (
    outcome.providerIntentReference !== candidate.providerIntentReference ||
    outcome.paymentMethod !== candidate.paymentMethod ||
    outcome.captureMode !== candidate.captureMode ||
    Date.parse(outcome.observedAt) > Date.parse(checkedAt)
  )
    return dependency();
  if (outcome.requestedAmount.amountMinor !== candidate.requestedAmount.amountMinor)
    return difference(
      ports,
      run,
      candidate,
      checkedAt,
      "AmountMismatch",
      outcome.status,
      outcome.capturedAmount,
      outcome.refundedAmount,
    );
  const internalTerminal = ["Captured", "Failed", "Cancelled"].includes(candidate.internalStatus);
  const providerTerminal = ["Captured", "Failed", "Cancelled"].includes(outcome.status);
  if (internalTerminal && candidate.internalStatus !== outcome.status)
    return difference(
      ports,
      run,
      candidate,
      checkedAt,
      providerTerminal ? "TerminalConflict" : "StateMismatch",
      outcome.status,
      outcome.capturedAmount,
      outcome.refundedAmount,
    );
  if (!internalTerminal && providerTerminal) {
    let observationReference;
    try {
      observationReference = parsePaymentReference(ports.references.generate("Observation"));
      const terminalResult = await ports.terminal.record({
        observationReference,
        causationReference: run.runReference,
        webhookReceiptReference: null,
        providerEventReference: null,
        providerAccountReference: candidate.providerAccountReference,
        providerIntentReference: candidate.providerIntentReference,
        environment: candidate.environment,
        paymentIntentReference: candidate.paymentIntentReference,
        paymentAttemptReference: candidate.paymentAttemptReference,
        brandReference: candidate.brandReference,
        storeReference: candidate.storeReference,
        source: "ProviderRetrieval",
        status: outcome.status === "Captured" ? "Captured" : "Failed",
        amount: outcome.status === "Captured" ? outcome.capturedAmount : null,
        failureReason:
          outcome.status === "Captured"
            ? null
            : outcome.status === "Cancelled"
              ? "Cancelled"
              : "ProviderRejected",
        retryDisposition: outcome.status === "Captured" ? null : "Never",
        occurredAt: parsePaymentInstant(outcome.observedAt),
        evidenceDigest: parsePaymentDigest(outcome.evidenceDigest),
      });
      if (
        !["Created", "AlreadyCommitted"].includes(terminalResult.status) ||
        parsePaymentReference(terminalResult.paymentTransactionReference) !==
          terminalResult.paymentTransactionReference
      )
        return dependency();
    } catch {
      return dependency();
    }
    return {
      check: ordinaryCheck(ports, run, candidate, checkedAt, {
        outcome: "Healed",
        providerStatus: outcome.status,
        providerCapturedAmount: outcome.capturedAmount,
        providerRefundedAmount: outcome.refundedAmount,
        safeCode: null,
      }),
      exception: null,
    };
  }
  if (candidate.capturedAmount.amountMinor !== outcome.capturedAmount.amountMinor)
    return difference(
      ports,
      run,
      candidate,
      checkedAt,
      "AmountMismatch",
      outcome.status,
      outcome.capturedAmount,
      outcome.refundedAmount,
    );
  if (candidate.refundedAmount.amountMinor !== outcome.refundedAmount.amountMinor)
    return difference(
      ports,
      run,
      candidate,
      checkedAt,
      "RefundMismatch",
      outcome.status,
      outcome.capturedAmount,
      outcome.refundedAmount,
    );
  return {
    check: ordinaryCheck(ports, run, candidate, checkedAt, {
      outcome: internalTerminal ? "Matched" : "Unresolved",
      providerStatus: outcome.status,
      providerCapturedAmount: outcome.capturedAmount,
      providerRefundedAmount: outcome.refundedAmount,
      safeCode: null,
    }),
    exception: null,
  };
}

function settlementCheck(
  ports: PaymentReconciliationPorts,
  run: PaymentReconciliationRunInput,
  candidate: PaymentSettlementReconciliationCandidate,
  checkedAt: PaymentInstant,
) {
  const capturedDifference =
    candidate.internalCapturedAmount.amountMinor !== candidate.providerCapturedAmount.amountMinor;
  const refundDifference =
    candidate.internalRefundedAmount.amountMinor !== candidate.providerRefundedAmount.amountMinor;
  const reason: PaymentReconciliationDifferenceReason | null = capturedDifference
    ? "AmountMismatch"
    : refundDifference
      ? "RefundMismatch"
      : null;
  let exception: PaymentReconciliationException | null = null;
  let exceptionReference = null;
  if (reason !== null) {
    try {
      exceptionReference = parsePaymentReference(
        ports.references.exceptionFor({
          brandReference: run.brandReference,
          storeReference: run.storeReference,
          candidateReference: candidate.candidateReference,
          reason,
        }),
      );
    } catch {
      return dependency();
    }
    exception = Object.freeze({
      exceptionReference,
      brandReference: run.brandReference,
      storeReference: run.storeReference,
      candidateReference: candidate.candidateReference,
      reason,
      severity: "Error",
      status: "Open",
      openedAt: checkedAt,
    });
  }
  const check: PaymentReconciliationCheck = Object.freeze({
    checkReference: checkReference(ports),
    runReference: run.runReference,
    candidateReference: candidate.candidateReference,
    mode: "DailySettlement",
    brandReference: run.brandReference,
    storeReference: run.storeReference,
    paymentIntentReference: null,
    settlementReference: candidate.settlementReference,
    outcome: reason === null ? "Matched" : "Difference",
    differenceReason: reason,
    internalStatus: null,
    providerStatus: null,
    internalCapturedAmount: candidate.internalCapturedAmount,
    providerCapturedAmount: candidate.providerCapturedAmount,
    internalRefundedAmount: candidate.internalRefundedAmount,
    providerRefundedAmount: candidate.providerRefundedAmount,
    exceptionReference,
    safeCode: null,
    checkedAt,
  });
  return { check, exception };
}

export function createPaymentReconciliationService(ports: PaymentReconciliationPorts) {
  return Object.freeze({
    async run(value: unknown) {
      let run;
      try {
        run = parsePaymentReconciliationRunInput(value);
      } catch {
        return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      }
      const authorized = await ports.authorization.authorize(run).catch(dependency);
      if (authorized !== true) return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      const claimed = await ports.lease
        .claim({
          runReference: run.runReference,
          jobName: paymentReconciliationJobName,
          scheduledAt: run.scheduledAt,
        })
        .catch(dependency);
      if (claimed !== true) return fail("PAYMENT_RECONCILIATION_LEASE_UNAVAILABLE");
      try {
        const existing = await ports.repository
          .loadRun({ runReference: run.runReference })
          .catch(dependency);
        if (existing !== null) {
          if (!resultLooksSafe(existing, run)) return fail("PAYMENT_RECONCILIATION_RUN_CONFLICT");
          return Object.freeze({ status: "Duplicate" as const, result: existing });
        }
        let completedAt;
        try {
          completedAt = parsePaymentInstant(ports.clock.now());
        } catch {
          return dependency();
        }
        if (Date.parse(completedAt) < Date.parse(run.scheduledAt)) return dependency();
        const rawCandidates = await (
          run.mode === "Operational"
            ? ports.candidates.claimOperational({
                runReference: run.runReference,
                brandReference: run.brandReference,
                storeReference: run.storeReference,
                cutoffAt: run.cutoffAt,
                limit: run.maxCandidates,
              })
            : ports.candidates.claimDailySettlement({
                runReference: run.runReference,
                brandReference: run.brandReference,
                storeReference: run.storeReference,
                cutoffAt: run.cutoffAt,
                limit: run.maxCandidates,
              })
        ).catch(dependency);
        if (rawCandidates.length > run.maxCandidates) return dependency();
        if (run.mode === "DailySettlement" && rawCandidates.length === 0) return dependency();
        const seen = new Set<string>();
        const checks: PaymentReconciliationCheck[] = [];
        const exceptions: PaymentReconciliationException[] = [];
        for (const rawCandidate of rawCandidates) {
          if (run.mode === "Operational") {
            let candidate;
            try {
              candidate = parseOperationalReconciliationCandidate(rawCandidate);
            } catch {
              return dependency();
            }
            if (!exactCandidateScope(candidate, run) || seen.has(candidate.candidateReference))
              return dependency();
            seen.add(candidate.candidateReference);
            const outcome = await operationalCheck(ports, run, candidate, completedAt);
            checks.push(outcome.check);
            if (outcome.exception !== null) exceptions.push(outcome.exception);
          } else {
            let candidate;
            try {
              candidate = parseSettlementReconciliationCandidate(rawCandidate);
            } catch {
              return dependency();
            }
            if (
              candidate.brandReference !== run.brandReference ||
              candidate.storeReference !== run.storeReference ||
              Date.parse(candidate.evidenceObservedAt) > Date.parse(run.cutoffAt) ||
              seen.has(candidate.candidateReference)
            )
              return dependency();
            seen.add(candidate.candidateReference);
            const outcome = settlementCheck(ports, run, candidate, completedAt);
            checks.push(outcome.check);
            if (outcome.exception !== null) exceptions.push(outcome.exception);
          }
        }
        const counts = zeroCounts();
        for (const check of checks) counts[check.outcome] += 1;
        if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== checks.length)
          return dependency();
        const result: PaymentReconciliationRunResult = Object.freeze({
          run,
          status: "Completed",
          completedAt,
          checks: Object.freeze(checks),
          exceptions: Object.freeze(exceptions),
          counts: Object.freeze(counts),
        });
        const committed = await ports.repository.commit(result).catch(dependency);
        if (committed.status === "Conflict") return fail("PAYMENT_RECONCILIATION_RUN_CONFLICT");
        if (
          !resultLooksSafe(committed.result, run) ||
          fingerprint(committed.result) !== fingerprint(result)
        )
          return fail("PAYMENT_RECONCILIATION_RUN_CONFLICT");
        return Object.freeze({ status: committed.status, result: committed.result });
      } finally {
        await ports.lease
          .release({ runReference: run.runReference, jobName: paymentReconciliationJobName })
          .catch(() => undefined);
      }
    },
  });
}
