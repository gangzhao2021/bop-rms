const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "store", packageName: "@rms/store", layer: "RMS" },
  tables: [
    {
      table: "store_configuration_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@rms/store" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store_weekly_service_period",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/store" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store_service_exception",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/store" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store_configuration_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/store" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
