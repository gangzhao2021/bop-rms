const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "dining", packageName: "@rms/dining", layer: "RMS" },
  tables: [
    {
      table: "dining_table",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/dining" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "dining_table_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/dining" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;
export default databaseAccessManifestInput;
