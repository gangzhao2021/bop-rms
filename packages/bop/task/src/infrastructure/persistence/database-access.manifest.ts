const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "task", packageName: "@bop/task", layer: "BOP" },
  tables: [
    {
      table: "support_case_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/task" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "diagnostic_access_grant",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/task" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "diagnostic_access_revocation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/task" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "support_action_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/task" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "support_case_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/task" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
  ],
  accesses: [],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifestInput;
