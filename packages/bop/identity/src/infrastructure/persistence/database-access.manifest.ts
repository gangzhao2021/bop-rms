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
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
