import {
  createPostgresPaymentCompensationExceptionCandidates,
  createPostgresPaymentCompensationExceptionSource,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";
import { createInternalCompensationProjection } from "./pilot-compensation-projection.mjs";
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
    let previous = cursor;
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
      if (afterProject) await afterProject(disposition, reference);
    }
    if (!active()) throw Error("INTERNAL_COMPENSATION_RECOVERY_UNAVAILABLE");
    cursor = page.nextAfterCaseReference;
    return { recoveredCount: page.items.length, scanComplete: cursor === null };
  };
}
