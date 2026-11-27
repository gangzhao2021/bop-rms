import {
  createCurrentKillSwitchEvaluationService,
  createPostgresKillSwitchQueryStore,
  parseFeatureControlKey,
  parseRolloutBucket,
  type CurrentKillSwitchEvaluationPorts,
  type KillSwitchQueryTransactionRunner,
} from "@bop/feature-control";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  parseAvailabilitySafetyEvidence,
  type CurrentAvailabilityQueryPorts,
} from "@rms/catalog";

/** Current observation for a configured ordering channel, never a checkout lease.
 * Caller supplies the approved key, rollout bucket and evidence lifetime.
 */
export function createCustomerCatalogKillSwitchSource(options: {
  scope: {
    brandReference: string;
    storeReference: string;
    channelCode: string;
    orderTypeCode: string;
  };
  transactions: KillSwitchQueryTransactionRunner;
  context: CurrentKillSwitchEvaluationPorts["context"];
  clock: CurrentKillSwitchEvaluationPorts["clock"];
  key: string;
  rolloutBucket: number;
  evidenceLifetimeMilliseconds: number;
}): CurrentAvailabilityQueryPorts["killSwitch"] {
  const brandReference = parseCatalogReference(options.scope.brandReference);
  const storeReference = parseCatalogReference(options.scope.storeReference);
  const channelCode = parseCatalogCode(options.scope.channelCode);
  const orderTypeCode = parseCatalogCode(options.scope.orderTypeCode);
  const key = parseFeatureControlKey(options.key);
  const rolloutBucket = parseRolloutBucket(options.rolloutBucket);
  const lifetime = options.evidenceLifetimeMilliseconds;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1)
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const scope = { brandReference, storeReference };
  const evaluator = createCurrentKillSwitchEvaluationService(
    {
      context: options.context,
      clock: options.clock,
      definitions: createPostgresKillSwitchQueryStore(options.transactions, scope),
    },
    scope,
  );
  return Object.freeze({
    async loadEvidence(
      input: Parameters<CurrentAvailabilityQueryPorts["killSwitch"]["loadEvidence"]>[0],
    ) {
      try {
        if (
          input.brandReference !== brandReference ||
          input.storeReference !== storeReference ||
          input.channelCode !== channelCode ||
          input.orderTypeCode !== orderTypeCode
        )
          throw new Error("scope mismatch");
        const sellableReference = parseCatalogReference(input.sellableReference);
        const observedAt = parseCatalogInstant(input.observedAt);
        const expiresAt = new Date(Date.parse(observedAt) + lifetime).toISOString();
        const result = await evaluator.evaluate({ key, rolloutBucket, evaluatedAt: observedAt });
        const completedAt = parseCatalogInstant(options.clock.now());
        if (completedAt < observedAt || completedAt >= expiresAt) return null;
        return parseAvailabilitySafetyEvidence({
          kind: "KillSwitch",
          ...scope,
          sellableReference,
          observedAt,
          expiresAt,
          status:
            result.reason === "CONTROL_UNAVAILABLE"
              ? "Indeterminate"
              : result.backendExecution === "Allow"
                ? "Clear"
                : "Blocked",
          reasonCode: result.reason,
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
