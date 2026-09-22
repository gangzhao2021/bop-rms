const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "membership", packageName: "@bop/membership", layer: "BOP" },
  tables: [
    {
      table: "membership",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/membership" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "store_assignment",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/membership" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [
    {
      id: "current-membership.membership",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_membership", table: "membership" },
      principal: { kind: "module", id: "@bop/membership" },
      readPattern: "owner-repository",
      source: "packages/bop/membership/src/infrastructure/persistence/current-membership-store.ts",
    },
    {
      id: "current-membership.store_assignment",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_membership", table: "store_assignment" },
      principal: { kind: "module", id: "@bop/membership" },
      readPattern: "owner-repository",
      source: "packages/bop/membership/src/infrastructure/persistence/current-membership-store.ts",
    },
  ],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
