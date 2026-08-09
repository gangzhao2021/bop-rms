const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "kitchen", packageName: "@rms/kitchen", layer: "RMS" },
  tables: [
    {
      table: "kitchen_action_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/kitchen" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
    {
      table: "kitchen_ticket",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/kitchen" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
    {
      table: "kitchen_work_item",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@rms/kitchen" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier", "personal", "health"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
