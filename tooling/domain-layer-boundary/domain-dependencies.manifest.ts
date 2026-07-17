import { defineDomainDependenciesManifest } from "./contract.js";

const domainDependenciesManifestInput = {
  version: 1,
  dependencies: [],
} as const;

export const domainDependenciesManifest = defineDomainDependenciesManifest(
  domainDependenciesManifestInput,
);
