import { validateAuditRecord } from "@bop/audit";

import { createPaymentTerminalEnvelope } from "./payment-terminal-event.js";
import {
  parsePaymentTerminalObservation,
  parsePaymentTerminalIntentSource,
  PaymentTerminalError,
  type PaymentTerminalFact,
  type PaymentTerminalIntentSource,
} from "./payment-terminal-fact.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant } from "./payment-intent-creation.js";
import type { PaymentTerminalPorts } from "./ports/payment-terminal-ports.js";

function fail(code: ConstructorParameters<typeof PaymentTerminalError>[0]): never {
  throw new PaymentTerminalError(code);
}

function dependency(error: unknown): never {
  if (error instanceof PaymentTerminalError) throw error;
  return fail("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
}

function matches(
  source: PaymentTerminalIntentSource,
  observation: ReturnType<typeof parsePaymentTerminalObservation>,
) {
  return (
    source.provider === "Stripe" &&
    source.environment === observation.environment &&
    source.paymentIntentReference === observation.paymentIntentReference &&
    source.paymentAttemptReference === observation.paymentAttemptReference &&
    source.brandReference === observation.brandReference &&
    source.storeReference === observation.storeReference &&
    source.providerAccountReference === observation.providerAccountReference &&
    source.providerIntentReference === observation.providerIntentReference
  );
}

function sameFact(left: PaymentTerminalFact, right: PaymentTerminalFact): boolean {
  return (
    left.paymentIntentReference === right.paymentIntentReference &&
    left.paymentAttemptReference === right.paymentAttemptReference &&
    left.observationReference === right.observationReference &&
    left.outcome === right.outcome &&
    left.occurredAt === right.occurredAt &&
    left.evidenceDigest === right.evidenceDigest &&
    left.amount?.amountMinor === right.amount?.amountMinor &&
    left.failureReason === right.failureReason &&
    left.retryDisposition === right.retryDisposition
  );
}

export function createPaymentTerminalService(ports: PaymentTerminalPorts) {
  return Object.freeze({
    async record(value: unknown) {
      let observation;
      try {
        observation = parsePaymentTerminalObservation(value);
      } catch (error) {
        if (error instanceof PaymentTerminalError) throw error;
        return fail("PAYMENT_TERMINAL_INPUT_INVALID");
      }
      const source = await ports.source
        .resolve(observation)
        .then((candidate) =>
          candidate === null ? null : parsePaymentTerminalIntentSource(candidate),
        )
        .catch(dependency);
      if (source === null) return fail("PAYMENT_TERMINAL_SOURCE_NOT_FOUND");
      if (!matches(source, observation)) return fail("PAYMENT_TERMINAL_SCOPE_MISMATCH");
      if (
        observation.status === "Captured" &&
        (observation.amount?.currencyCode !== source.expectedAmount.currencyCode ||
          observation.amount.amountMinor !== source.expectedAmount.amountMinor)
      )
        return fail("PAYMENT_TERMINAL_AMOUNT_MISMATCH");
      let factWithoutEvent: Omit<PaymentTerminalFact, "event">;
      try {
        factWithoutEvent = Object.freeze({
          paymentTransactionReference: parsePaymentReference(
            ports.references.generate("PaymentTransaction"),
          ),
          paymentIntentReference: observation.paymentIntentReference,
          paymentAttemptReference: observation.paymentAttemptReference,
          orderReference: parsePaymentReference(source.orderReference),
          brandReference: observation.brandReference,
          storeReference: observation.storeReference,
          webhookReceiptReference: observation.webhookReceiptReference,
          providerEventReference: observation.providerEventReference,
          providerAccountReference: observation.providerAccountReference,
          providerIntentReference: observation.providerIntentReference,
          environment: observation.environment,
          observationReference: observation.observationReference,
          source: observation.source,
          outcome: observation.status === "Captured" ? "Succeeded" : "Failed",
          amount: observation.amount,
          failureReason: observation.failureReason,
          retryDisposition: observation.retryDisposition,
          occurredAt: observation.occurredAt,
          recordedAt: parsePaymentInstant(ports.clock.now()),
          evidenceDigest: observation.evidenceDigest,
        });
      } catch {
        return fail("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
      }
      if (Date.parse(factWithoutEvent.recordedAt) < Date.parse(factWithoutEvent.occurredAt))
        return fail("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
      let event;
      try {
        event = createPaymentTerminalEnvelope({
          eventReference: ports.references.generate("Event"),
          correlationReference: source.paymentOperationReference,
          fact: factWithoutEvent,
        });
      } catch {
        return fail("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
      }
      const fact = Object.freeze({ ...factWithoutEvent, event });
      const audit = await ports.audit
        .create({ fact: factWithoutEvent, correlationReference: source.paymentOperationReference })
        .then((candidate) => validateAuditRecord(candidate, Date.parse(fact.recordedAt)))
        .catch(dependency);
      const outcome = await ports.repository.commit({ fact, audit, event }).catch(dependency);
      if (outcome.status === "Conflict") return fail("PAYMENT_TERMINAL_OUTCOME_CONFLICT");
      try {
        if (!sameFact(fact, outcome.fact)) return fail("PAYMENT_TERMINAL_OUTCOME_CONFLICT");
      } catch {
        return fail("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
      }
      return Object.freeze({ status: outcome.status, fact: outcome.fact });
    },
  });
}
