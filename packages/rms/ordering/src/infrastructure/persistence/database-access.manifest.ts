const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "ordering", packageName: "@rms/ordering", layer: "RMS" },
  tables: [
    {
      table: "cart",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "cart_line",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export default databaseAccessManifestInput;
