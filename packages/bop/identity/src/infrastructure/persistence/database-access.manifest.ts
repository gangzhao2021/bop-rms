const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "identity", packageName: "@bop/identity", layer: "BOP" },
  tables: [
    {
      table: "authentication_session",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal", "credential"],
    },
    {
      table: "oidc_authorization_transaction",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "credential"],
    },
    {
      table: "session_revocation_request",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "workforce_invitation",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "personal", "credential"],
    },
    {
      table: "workforce_mfa_status",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "workforce_recovery_case",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/identity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "privacy-governance",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
