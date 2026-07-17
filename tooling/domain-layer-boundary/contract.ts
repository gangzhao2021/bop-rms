export const domainDependencyClassifications = [
  "domain-safe",
  "orm-database",
  "http-transport",
  "provider-sdk",
  "runtime-io",
] as const;

export type DomainDependencyClassification = (typeof domainDependencyClassifications)[number];

export interface DomainDependencyRecord {
  readonly packageName: string;
  readonly classification: DomainDependencyClassification;
  readonly allowedSubpaths: readonly string[];
}

export interface DomainDependenciesManifest {
  readonly version: 1;
  readonly dependencies: readonly DomainDependencyRecord[];
}

export function defineDomainDependenciesManifest<const T extends DomainDependenciesManifest>(
  value: T,
): T {
  return value;
}
