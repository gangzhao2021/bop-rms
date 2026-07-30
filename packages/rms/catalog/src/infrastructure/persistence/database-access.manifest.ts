const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "catalog", packageName: "@rms/catalog", layer: "RMS" },
  tables: [
    {
      table: "product",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/catalog" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "product_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@rms/catalog" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "sku",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/catalog" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "product_operation_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/catalog" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
