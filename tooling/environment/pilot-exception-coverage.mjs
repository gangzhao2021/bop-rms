import { readInternalCompensationCoverage } from "./pilot-compensation-coverage.mjs";
import {
  createInternalDiningCoverage,
  createInternalReconciliationCoverage,
} from "./pilot-owner-exception-coverage.mjs";
/** Fresh is scoped to the actual local OnlineCard/Automatic composition, never terminal/live rollout. */
export async function readInternalExceptionCoverage({
  resources,
  providerAccountReference,
  paymentMode,
  tx,
  sources,
}) {
  if (
    paymentMode !== "InternalTestOnlineCardAutomatic" ||
    sources.some(
      (source) =>
        ![
          "DiningUnpaidBatch",
          "PaymentReconciliationDifference",
          "PaidWithoutFulfillableOrder",
        ].includes(source.kind),
    )
  )
    return "Stale";
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const authorize = async (t) =>
    t === tx && resources.now() < resources.publicProfile.binding.validUntil;
  const input = { tx, projected: sources, authorize };
  const compensation = await readInternalCompensationCoverage({
    ...input,
    scope,
    tenantReference: scope.tenantReference,
  });
  if (!compensation.complete) return "Stale";
  const dining = await createInternalDiningCoverage({ resources, providerAccountReference })(input);
  if (!dining.complete) return "Stale";
  const reconciliation = await createInternalReconciliationCoverage(resources)(input);
  return reconciliation.complete && (await authorize(tx)) ? "Fresh" : "Stale";
}
