import process from "node:process";
import {
  createRetrieveIntentRequest,
  parseOperationalReconciliationCandidate,
  parsePaymentProviderOutcome,
  parsePaymentInstant,
} from "../../packages/rms/payment/src/index.ts";
/** Reads the existing simulator's persisted occurrence; never creates a Provider outcome. */
export function createInternalReconciliationTerminalOccurrence({ simulator, scope, active }) {
  const fail = () => {
    throw Error("RECONCILIATION_TERMINAL_OCCURRENCE_UNAVAILABLE");
  };
  const authorized = () =>
    process.env.NODE_ENV === "development" && simulator.simulation === true && active() === true;
  if (!authorized()) return fail();
  return async ({ candidate: rawCandidate, snapshot: rawSnapshot }) => {
    if (!authorized()) return fail();
    const candidate = parseOperationalReconciliationCandidate(rawCandidate),
      snapshot = parsePaymentProviderOutcome(rawSnapshot);
    if (
      snapshot.kind !== "Snapshot" ||
      candidate.environment !== "Test" ||
      snapshot.context.environment !== "Test" ||
      candidate.brandReference !== scope.brandReference ||
      candidate.storeReference !== scope.storeReference ||
      candidate.providerAccountReference !== scope.providerAccountReference ||
      snapshot.context.brandReference !== candidate.brandReference ||
      snapshot.context.storeReference !== candidate.storeReference ||
      snapshot.context.paymentAttemptReference !== candidate.paymentAttemptReference ||
      snapshot.providerIntentReference !== candidate.providerIntentReference ||
      !["Captured", "Failed", "Cancelled"].includes(snapshot.status)
    )
      return fail();
    const occurrence = await simulator.readTerminalOccurrence(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: snapshot.context,
        providerIntentReference: snapshot.providerIntentReference,
      }),
    );
    const occurredAt = parsePaymentInstant(occurrence.occurredAt);
    if (!authorized() || occurrence.status !== snapshot.status || occurredAt > snapshot.observedAt)
      return fail();
    return Object.freeze({ status: occurrence.status, occurredAt });
  };
}
