const databaseAccessManifestInput = {
  version: 1,
  module: {
    moduleName: "operating-entity",
    packageName: "@bop/operating-entity",
    layer: "BOP",
  },
  tables: [
    {
      table: "operating_entity",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "personal", "sensitive_personal", "payment"],
    },
    {
      table: "brand_operating_entity_assignment",
      classification: "relationship-assignment",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store_operating_entity_assignment",
      classification: "relationship-assignment",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
