const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "feature-control", packageName: "@bop/feature-control", layer: "BOP" },
  tables: [
    {
      table: "control_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "control_dependency",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "control_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
