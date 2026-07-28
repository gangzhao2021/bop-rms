import { defineDomainDependenciesManifest } from "./contract.js";

const domainDependenciesManifestInput = {
  version: 1,
  dependencies: [
    {
      packageName: "@bop/tenant",
      classification: "domain-safe",
      allowedSubpaths: ["."],
    },
  ],
} as const;

export const domainDependenciesManifest = defineDomainDependenciesManifest(
  domainDependenciesManifestInput,
);
