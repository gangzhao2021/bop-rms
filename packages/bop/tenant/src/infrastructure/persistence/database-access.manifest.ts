const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  tables: [
    {
      table: "brand_admin_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/tenant" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "brand_configuration_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/tenant" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "brand_store_membership_record",
      classification: "relationship-assignment",
      writeOwner: { kind: "module", id: "@bop/tenant" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
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
