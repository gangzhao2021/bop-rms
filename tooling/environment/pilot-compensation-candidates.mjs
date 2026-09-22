import process from "node:process";
import {
  createPostgresOrderCompensationCandidateReader,
  parseOrderingReference,
  parseOrderingInstant,
} from "../../packages/rms/ordering/src/index.ts";
/** Read-only owner discovery; candidate presence never authorizes or executes a refund. */
export function createInternalCompensationCandidates(resources) {
  const unavailable = () => {
    throw new Error("INTERNAL_COMPENSATION_DISCOVERY_UNAVAILABLE");
  };
  if (process.env.NODE_ENV !== "development") return unavailable();
  const binding = resources.publicProfile.binding;
  const scope = {
    brandReference: String(parseOrderingReference(resources.scope.brandReference)),
    storeReference: String(parseOrderingReference(resources.scope.storeReference)),
  };
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return unavailable();
  const validUntil = parseOrderingInstant(binding.validUntil);
  const active = () =>
    process.env.NODE_ENV === "development" && parseOrderingInstant(resources.now()) < validUntil;
  const reader = createPostgresOrderCompensationCandidateReader({
    scope,
    authorize: async (_tx, input) =>
      active() &&
      input.brandReference === scope.brandReference &&
      input.storeReference === scope.storeReference &&
      input.purpose === "DiscoverPaidWithoutFulfillableOrder",
  });
  return Object.freeze({
    async discover(input) {
      if (!active()) return unavailable();
      return resources.transactions.run((tx) => reader(tx, input));
    },
  });
}
