export interface PublicStoreEffectiveCandidateValue {
  readonly candidateIndex: number;
  readonly timingVersionReference: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
}

export interface PublicStoreProfileSelection {
  readonly candidateIndex: number;
  readonly selectedLocale: string;
}

export function resolvePublicStoreProfileSelection(input: {
  readonly candidates: readonly PublicStoreEffectiveCandidateValue[];
  readonly requestedLocale: string;
  readonly evaluatedAt: string;
}): PublicStoreProfileSelection | null {
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const matches = input.candidates
    .filter((candidate) => {
      const from = Date.parse(candidate.effectiveFrom);
      const until =
        candidate.effectiveUntil === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(candidate.effectiveUntil);
      return evaluatedAt >= from && evaluatedAt < until;
    })
    .sort(
      (left, right) =>
        left.timingVersionReference.localeCompare(right.timingVersionReference, "en") ||
        left.candidateIndex - right.candidateIndex,
    );
  if (matches.length !== 1 || matches[0] === undefined) return null;
  const match = matches[0];
  return Object.freeze({
    candidateIndex: match.candidateIndex,
    selectedLocale: match.supportedLocales.includes(input.requestedLocale)
      ? input.requestedLocale
      : match.defaultLocale,
  });
}
