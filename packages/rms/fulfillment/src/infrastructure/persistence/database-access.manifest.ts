const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "fulfillment", packageName: "@rms/fulfillment", layer: "RMS" },
  tables: [
    {
      table: "fulfillment",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/fulfillment" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "fulfillment_creation_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/fulfillment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "fulfillment_item",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/fulfillment" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "fulfillment_item_ready_result",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/fulfillment" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "fulfillment_ready_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/fulfillment" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
