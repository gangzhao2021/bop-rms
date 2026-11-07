import {
  parseKitchenStationRoutingCandidateSetEvidence,
  createKitchenRoutingRuleDigestBinding,
  createKitchenStationRoutingCandidateSetDigestBinding,
  type KitchenStationRoutingCandidateSetEvidence,
  type KitchenStationRoutingCandidate,
} from "./station-routing.js";
import {
  parseKitchenTicketReference,
  parseKitchenTicketInstant,
  parseKitchenTicketDigest,
} from "./kitchen-ticket.js";

export interface KitchenRoutingConfigurationRecord {
  readonly operationReference: string;
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly permissionCode: string;
  readonly reasonCode: string;
  readonly recordedAt: string;
  readonly expectedVersion: number;
  readonly configuration: KitchenStationRoutingCandidateSetEvidence;
}
export class KitchenRoutingConfigurationError extends Error {
  constructor(
    readonly code:
      "KITCHEN_ROUTING_CONFIGURATION_UNAVAILABLE" | "KITCHEN_ROUTING_CONFIGURATION_CONFLICT",
  ) {
    super("Kitchen routing configuration is unavailable");
    this.name = "KitchenRoutingConfigurationError";
  }
}
export function kitchenRoutingUnavailable(conflict = false): never {
  throw new KitchenRoutingConfigurationError(
    conflict
      ? "KITCHEN_ROUTING_CONFIGURATION_CONFLICT"
      : "KITCHEN_ROUTING_CONFIGURATION_UNAVAILABLE",
  );
}
export function routingObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return kitchenRoutingUnavailable();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return kitchenRoutingUnavailable();
    result[field] = d.value;
  }
  return result;
}
function code(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value))
    return kitchenRoutingUnavailable();
  return value;
}
export function rebindKitchenRoutingEvidence(
  value: unknown,
  effectiveAt: string,
  sha256: (value: string) => string,
): KitchenStationRoutingCandidateSetEvidence {
  const original = parseKitchenStationRoutingCandidateSetEvidence(value);
  const at = parseKitchenTicketInstant(effectiveAt);
  const candidates = original.candidates.map((candidate) => ({
    ...candidate,
    routingRuleDigest: parseKitchenTicketDigest(
      sha256(
        createKitchenRoutingRuleDigestBinding({
          brandReference: original.brandReference,
          storeReference: original.storeReference,
          effectiveAt: at,
          candidate,
        }),
      ),
    ),
  }));
  const bound = { ...original, effectiveAt: at, candidates };
  return parseKitchenStationRoutingCandidateSetEvidence({
    ...bound,
    evidenceDigest: parseKitchenTicketDigest(
      sha256(createKitchenStationRoutingCandidateSetDigestBinding(bound)),
    ),
  });
}

export function parseKitchenRoutingConfigurationRecord(
  value: unknown,
  sha256: (value: string) => string,
): KitchenRoutingConfigurationRecord {
  try {
    const raw = routingObject(value, [
      "operationReference",
      "actorReference",
      "purposeCode",
      "permissionCode",
      "reasonCode",
      "recordedAt",
      "expectedVersion",
      "configuration",
    ]);
    const configuration = parseKitchenStationRoutingCandidateSetEvidence(raw.configuration);
    const expected = raw.expectedVersion;
    const recordedAt = parseKitchenTicketInstant(raw.recordedAt);
    if (
      !Number.isInteger(expected) ||
      (expected as number) < 0 ||
      (expected as number) >= 2147483647 ||
      configuration.evidenceVersion !== (expected as number) + 1 ||
      configuration.candidates.length > 1 ||
      configuration.effectiveAt < recordedAt
    )
      return kitchenRoutingUnavailable();
    for (const candidate of configuration.candidates)
      if (
        candidate.stationVersion > 2147483647 ||
        candidate.routingRuleVersion > 2147483647 ||
        candidate.stationReference !== candidate.targetStationReference
      )
        return kitchenRoutingUnavailable();
    const rebound = rebindKitchenRoutingEvidence(configuration, configuration.effectiveAt, sha256);
    if (
      rebound.evidenceDigest !== configuration.evidenceDigest ||
      rebound.candidates.some(
        (candidate, i) =>
          candidate.routingRuleDigest !== configuration.candidates[i]?.routingRuleDigest,
      )
    )
      return kitchenRoutingUnavailable();
    return Object.freeze({
      operationReference: parseKitchenTicketReference(raw.operationReference),
      actorReference: parseKitchenTicketReference(raw.actorReference),
      purposeCode: code(raw.purposeCode),
      permissionCode: code(raw.permissionCode),
      reasonCode: code(raw.reasonCode),
      recordedAt,
      expectedVersion: expected as number,
      configuration,
    });
  } catch {
    return kitchenRoutingUnavailable();
  }
}

export function assertKitchenRoutingRevision(
  previous: KitchenRoutingConfigurationRecord | null,
  next: KitchenRoutingConfigurationRecord,
  stationHistory: KitchenStationRoutingCandidate | undefined = previous?.configuration
    .candidates[0],
  ruleHistory: KitchenStationRoutingCandidate | undefined = previous?.configuration.candidates[0],
): void {
  if (next.expectedVersion !== (previous?.configuration.evidenceVersion ?? 0))
    return kitchenRoutingUnavailable(true);
  if (
    previous &&
    (next.configuration.effectiveAt <= previous.configuration.effectiveAt ||
      next.recordedAt < previous.recordedAt)
  )
    return kitchenRoutingUnavailable(true);
  const candidate = next.configuration.candidates[0];
  if (!candidate) return;
  const stationSame = stationHistory?.stationReference === candidate.stationReference;
  const ruleSame = ruleHistory?.routingRuleReference === candidate.routingRuleReference;
  if (!stationSame && candidate.stationVersion !== 1) return kitchenRoutingUnavailable(true);
  if (!ruleSame && candidate.routingRuleVersion !== 1) return kitchenRoutingUnavailable(true);
  if (stationHistory && stationSame) {
    const unchanged =
      stationHistory.stationStatus === candidate.stationStatus &&
      JSON.stringify(stationHistory.stationCapabilityReferences) ===
        JSON.stringify(candidate.stationCapabilityReferences);
    if (candidate.stationVersion !== stationHistory.stationVersion + (unchanged ? 0 : 1))
      return kitchenRoutingUnavailable(true);
  }
  if (ruleHistory && ruleSame) {
    const unchanged =
      ruleHistory.routingRuleStatus === candidate.routingRuleStatus &&
      ruleHistory.targetStationReference === candidate.targetStationReference;
    if (candidate.routingRuleVersion !== ruleHistory.routingRuleVersion + (unchanged ? 0 : 1))
      return kitchenRoutingUnavailable(true);
  }
}
