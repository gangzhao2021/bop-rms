const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  tables: [
    {
      table: "brand",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/tenant" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/tenant" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
