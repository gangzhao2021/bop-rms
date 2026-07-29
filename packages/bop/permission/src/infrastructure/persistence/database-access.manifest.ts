const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "permission", packageName: "@bop/permission", layer: "BOP" },
  tables: [
    {
      table: "policy_state",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "permission_definition",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["none"],
    },
    {
      table: "role",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "role_assignment",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "permission_grant",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "permission_override",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/permission" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
