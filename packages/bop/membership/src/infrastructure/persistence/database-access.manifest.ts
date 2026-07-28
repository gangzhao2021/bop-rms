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
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
