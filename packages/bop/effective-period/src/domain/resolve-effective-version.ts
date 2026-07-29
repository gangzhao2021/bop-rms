export interface EffectivePeriodValue {
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

export interface EffectiveCandidateValue {
  readonly timingVersionReference: string;
  readonly period: EffectivePeriodValue;
}

export type EffectiveStatus = "Scheduled" | "Effective" | "Expired";

export type EffectiveResolution =
  | { readonly outcome: "Unavailable"; readonly reason: "NO_EFFECTIVE_VERSION" }
  | { readonly outcome: "Selected"; readonly timingVersionReference: string }
  | {
      readonly outcome: "Conflict";
      readonly reason: "MULTIPLE_EFFECTIVE_VERSIONS";
      readonly timingVersionReferences: readonly string[];
    };

function instant(value: string): number {
  return Date.parse(value);
}

export function periodsOverlap(left: EffectivePeriodValue, right: EffectivePeriodValue): boolean {
  const leftUntil =
    left.effectiveUntil === null ? Number.POSITIVE_INFINITY : instant(left.effectiveUntil);
  const rightUntil =
    right.effectiveUntil === null ? Number.POSITIVE_INFINITY : instant(right.effectiveUntil);
  return instant(left.effectiveFrom) < rightUntil && instant(right.effectiveFrom) < leftUntil;
}

export function deriveEffectiveStatus(
  period: EffectivePeriodValue,
  evaluationInstant: string,
): EffectiveStatus {
  const at = instant(evaluationInstant);
  if (at < instant(period.effectiveFrom)) return "Scheduled";
  if (period.effectiveUntil !== null && at >= instant(period.effectiveUntil)) return "Expired";
  return "Effective";
}

export function resolveEffectiveVersion(
  candidates: readonly EffectiveCandidateValue[],
  evaluationInstant: string,
): EffectiveResolution {
  const matches = candidates
    .filter(
      (candidate) => deriveEffectiveStatus(candidate.period, evaluationInstant) === "Effective",
    )
    .map((candidate) => candidate.timingVersionReference)
    .sort();
  const selected = matches.at(0);
  if (selected === undefined)
    return Object.freeze({ outcome: "Unavailable", reason: "NO_EFFECTIVE_VERSION" });
  if (matches.length === 1)
    return Object.freeze({ outcome: "Selected", timingVersionReference: selected });
  return Object.freeze({
    outcome: "Conflict",
    reason: "MULTIPLE_EFFECTIVE_VERSIONS",
    timingVersionReferences: Object.freeze(matches),
  });
}
