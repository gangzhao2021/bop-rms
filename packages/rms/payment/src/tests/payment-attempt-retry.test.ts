import { describe, expect, it } from "vitest";

import {
  createPaymentIntentCreationService,
  parsePaymentIntentCreationRecord,
  PaymentIntentCreationError,
  type PaymentIntentCreationPorts,
  type PaymentIntentCreationRecord,
} from "../index.js";
import { audit, command, harness, id, refs } from "./payment-intent-creation.fixture.js";

const later = "2026-08-03T15:05:00.000Z";
const retryAttempt = id(40);

/** WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): another card after a decline is a new attempt. */
async function firstAttempt() {
  const test = harness();
  const created = await createPaymentIntentCreationService(test.ports).create(command());
  return created.record;
}

function retryPorts(
  prior: PaymentIntentCreationRecord,
  options: {
    claim?: "Claimed" | "Existing";
    existing?: PaymentIntentCreationRecord;
    clock?: string;
    withoutClaimRetry?: boolean;
    denied?: boolean;
  } = {},
) {
  const test = harness({
    prior,
    clockNow: options.clock ?? later,
    denied: options.denied ?? false,
  });
  const claims: { previousAttemptReference: string; record: PaymentIntentCreationRecord }[] = [];
  const audits: unknown[] = [];
  const ports: PaymentIntentCreationPorts = {
    ...test.ports,
    references: { ...test.ports.references, generate: () => retryAttempt },
    audit: {
      async create(input) {
        test.calls.push("audit");
        return { ...audit(input.paymentIntentReference), occurredAt: input.observedAt };
      },
    },
    repository: {
      ...test.ports.repository,
      ...(options.withoutClaimRetry
        ? {}
        : {
            async claimRetry(input) {
              test.calls.push("claim-retry");
              claims.push(input);
              audits.push(input.audit);
              return options.claim === "Existing" && options.existing
                ? { status: "Existing" as const, record: options.existing }
                : { status: "Claimed" as const, record: input.record };
            },
          }),
    },
  };
  return { test, ports, claims, audits };
}

const retryCommand = {
  paymentOperationReference: refs.operation,
  submissionReference: refs.submission,
  requestedAt: later,
};

describe("Payment attempt retry after a declined card", () => {
  it("opens the next attempt on the same intent and creates a new Provider intent once", async () => {
    const prior = await firstAttempt();
    const { test, ports, claims, audits } = retryPorts(prior);
    const result = await createPaymentIntentCreationService(ports).retry(retryCommand);
    expect(result.status).toBe("Created");
    expect(result.record.intent).toEqual(prior.intent);
    expect(result.record.attempt).toMatchObject({
      paymentAttemptReference: retryAttempt,
      paymentIntentReference: prior.intent.paymentIntentReference,
      attemptNumber: 2,
      createdAt: later,
    });
    expect(result.record.providerOutcome?.kind).toBe("Snapshot");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.previousAttemptReference).toBe(prior.attempt.paymentAttemptReference);
    expect(audits[0]).toMatchObject({
      actionCode: "PAYMENT_ATTEMPT_RETRY",
      reasonCode: "CUSTOMER_RETRY_AFTER_DECLINE",
      afterSummary: { attemptNumber: 2 },
      occurredAt: later,
    });
    expect(test.providerCalls()).toBe(1);
    expect(test.calls).not.toContain("prepare-order");
    expect(test.calls.indexOf("claim-retry")).toBeLessThan(test.calls.indexOf("provider-create"));
  });

  it("returns the attempt another request already opened without calling the Provider", async () => {
    const prior = await firstAttempt();
    const existing = parsePaymentIntentCreationRecord({
      ...prior,
      attempt: {
        ...prior.attempt,
        paymentAttemptReference: id(41),
        attemptNumber: 2,
        createdAt: later,
      },
      providerOutcome: null,
    });
    const { test, ports } = retryPorts(prior, { claim: "Existing", existing });
    const result = await createPaymentIntentCreationService(ports).retry(retryCommand);
    expect(result).toMatchObject({ status: "Processing" });
    expect(result.record.attempt.paymentAttemptReference).toBe(id(41));
    expect(test.providerCalls()).toBe(0);
  });

  it("refuses once the payment window has ended, after the limit, without access or a store", async () => {
    const prior = await firstAttempt();
    const service = (ports: PaymentIntentCreationPorts) =>
      createPaymentIntentCreationService(ports).retry(retryCommand);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => (error instanceof PaymentIntentCreationError ? error.code : error),
      );
    const expired = retryPorts(prior, { clock: "2026-08-03T15:30:00.000Z" });
    expect(await code(service(expired.ports))).toBe("PAYMENT_INTENT_PREPARATION_EXPIRED");
    expect(expired.claims).toHaveLength(0);

    const fifth = parsePaymentIntentCreationRecord({
      ...prior,
      attempt: { ...prior.attempt, attemptNumber: 5, createdAt: "2026-08-03T15:04:00.000Z" },
    });
    const limit = retryPorts(fifth);
    expect(await code(service(limit.ports))).toBe("PAYMENT_INTENT_RETRY_LIMIT_REACHED");
    expect(limit.claims).toHaveLength(0);

    expect(await code(service(retryPorts(prior, { denied: true }).ports))).toBe(
      "PAYMENT_INTENT_PERMISSION_DENIED",
    );
    expect(await code(service(retryPorts(prior, { withoutClaimRetry: true }).ports))).toBe(
      "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
    );
    const other = retryPorts(prior);
    expect(
      await code(
        createPaymentIntentCreationService(other.ports).retry({
          ...retryCommand,
          submissionReference: id(77),
        }),
      ),
    ).toBe("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
    expect(other.test.providerCalls()).toBe(0);
  });

  it("keeps a retry inside the payment window and never as a first attempt", async () => {
    const prior = await firstAttempt();
    const attempt =
      (createdAt: string, attemptNumber = 2) =>
      () =>
        parsePaymentIntentCreationRecord({
          ...prior,
          attempt: { ...prior.attempt, attemptNumber, createdAt },
          providerOutcome: null,
        });
    expect(attempt(later)).not.toThrow();
    expect(attempt(prior.intent.createdAt)).toThrow(PaymentIntentCreationError);
    expect(attempt("2026-08-03T15:30:00.000Z")).toThrow(PaymentIntentCreationError);
    expect(attempt(later, 1)).toThrow(PaymentIntentCreationError);
    expect(attempt(later, 6)).toThrow(PaymentIntentCreationError);
  });
});
