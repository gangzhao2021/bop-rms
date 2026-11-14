const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "notification", packageName: "@bop/notification", layer: "BOP" },
  tables: [
    // WP-2423 Q10: one message attempt per Order and purpose; never the destination or the text.
    {
      table: "customer_order_notification_attempt",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/notification" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "customer_order_notification_outcome",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/notification" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    // DEC-PILOT-NOTIFICATIONS: signed SES feedback, suppression list (keyed digest), issues.
    {
      table: "delivery_provider_event",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/notification" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "contact_suppression",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/notification" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "delivery_issue_case",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/notification" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifestInput;
