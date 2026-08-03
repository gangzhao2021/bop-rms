const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "payment", packageName: "@rms/payment", layer: "RMS" },
  tables: [
    {
      table: "payment_intent",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "financial-compliance",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "payment_attempt",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "financial-compliance",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "payment_intent_operation_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "payment_provider_observation",
      classification: "integration-record",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "financial-compliance",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "provider_webhook_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "provider_webhook_raw_evidence",
      classification: "integration-record",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "payment"],
    },
    {
      table: "provider_webhook_processing_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/payment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "payment"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
