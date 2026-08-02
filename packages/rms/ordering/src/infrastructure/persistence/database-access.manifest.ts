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
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
    {
      table: "cart_operation_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "ephemeral-technical",
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
    {
      table: "cart_quote_attachment",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "cart_quote_attachment_line",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "cart_lifecycle_operation_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/ordering" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "ephemeral-technical",
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
  ],
  accesses: [],
} as const;

export default databaseAccessManifestInput;
