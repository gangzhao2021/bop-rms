import {
  createPostgresPaymentCompensationExceptionCandidates,
  createPostgresPaymentCompensationExceptionSource,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";
import console from "node:console";
import { createInternalCompensationProjection } from "./pilot-compensation-projection.mjs";
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;
/** Safe code only (never a message, value or identifier). */
function safeCode(error) {
  try {
    for (const key of ["code", "message"]) {
      const value = Object.getOwnPropertyDescriptor(error ?? {}, key)?.value;
      if (typeof value === "string" && SAFE_CODE.test(value)) return value;
    }
  } catch {
    /* Untrusted errors never break recovery. */
  }
  return null;
}
/** Bounded repair of existing owner facts only; never dispatch a financial command. */
export function createInternalCompensationProjectionRecovery({
  resources,
  scope,
  tenantReference,
  active,
  afterProject,
}) {
  let cursor = null;
  const authorized = async (_tx, input) =>
    active() &&
    input.brandReference === scope.brandReference &&
    input.storeReference === scope.storeReference;
  const discover = createPostgresPaymentCompensationExceptionCandidates({
    scope,
    authorize: authorized,
  });
  const read = createPostgresPaymentCompensationExceptionSource({ scope, authorize: authorized });
  const project = createInternalCompensationProjection({
    resources,
    scope,
    tenantReference,
    authorize: async () => active(),
  });
  return async () => {
    if (!active()) throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
    const page = await resources.transactions.run((tx) =>
      discover(tx, { afterCaseReference: cursor, limit: 5 }),
    );
    if (!Array.isArray(page.items) || page.items.length > 5)
      throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
    let previous = cursor,
      receiptFailures = 0;
    for (const value of page.items) {
      const reference = parsePaymentReference(value);
      if (previous !== null && reference <= previous)
        throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
      previous = reference;
    }
    if (
      page.nextAfterCaseReference !== null &&
      (page.items.length !== 5 || page.nextAfterCaseReference !== previous)
    )
      throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
    for (const reference of page.items) {
      const current = await resources.transactions.run((tx) => read(tx, reference));
      if (
        !active() ||
        !current ||
        current.source.exceptionReference !== reference ||
        current.source.brandReference !== scope.brandReference ||
        current.source.storeReference !== scope.storeReference
      )
        throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
      const disposition = {
        orderReference: parsePaymentReference(current.source.orderReference),
        paymentIntentReference: parsePaymentReference(current.source.paymentIntentReference),
        paymentAttemptReference: parsePaymentReference(current.source.paymentAttemptReference),
      };
      await project(disposition, reference);
      // WP-2423 pilot resilience: one Case's receipt repair failing must not hold back the
      // repair of every later Case (the page used to be retried forever). It is retried on the
      // next round; the failure is logged with its safe code only.
      if (afterProject)
        try {
          await afterProject(disposition, reference);
        } catch (error) {
          receiptFailures++;
          console.error(
            JSON.stringify({
              event: "INTERNAL_COMPENSATION_RECEIPT_REPAIR_FAILED",
              code: safeCode(error),
            }),
          );
        }
    }
    if (!active()) throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
    cursor = page.nextAfterCaseReference;
    return {
      recoveredCount: page.items.length,
      scanComplete: cursor === null,
      ...(receiptFailures > 0 ? { receiptFailures } : {}),
    };
  };
}
