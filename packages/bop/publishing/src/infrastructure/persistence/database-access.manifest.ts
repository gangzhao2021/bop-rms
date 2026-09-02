const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "publishing", packageName: "@bop/publishing", layer: "BOP" },
  tables: [
    {
      table: "live_gate_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "live_gate_requirement",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "live_gate_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
