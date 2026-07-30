export function resolveQrTableContextDecision(input: {
  readonly evaluatedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maximumLifetimeMilliseconds: number;
  readonly keyValidFrom: string;
  readonly keyValidUntil: string;
  readonly compromisedAt: string | null;
  readonly registryValidUntil: string;
  readonly contextValidUntil: string;
  readonly contextMatches: boolean;
  readonly activeContext: boolean;
  readonly revocationMatches: boolean;
}): boolean {
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  return (
    issuedAt <= evaluatedAt &&
    evaluatedAt < expiresAt &&
    expiresAt - issuedAt <= input.maximumLifetimeMilliseconds &&
    Date.parse(input.keyValidFrom) <= issuedAt &&
    evaluatedAt < Date.parse(input.keyValidUntil) &&
    (input.compromisedAt === null || evaluatedAt < Date.parse(input.compromisedAt)) &&
    evaluatedAt < Date.parse(input.registryValidUntil) &&
    evaluatedAt < Date.parse(input.contextValidUntil) &&
    input.contextMatches &&
    input.activeContext &&
    input.revocationMatches
  );
}
