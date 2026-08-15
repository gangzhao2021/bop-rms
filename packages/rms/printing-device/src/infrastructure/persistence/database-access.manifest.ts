const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "printing-device", packageName: "@rms/printing-device", layer: "RMS" },
  tables: [
    {
      table: "device",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@rms/printing-device" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier", "credential"],
    },
    {
      table: "device_assignment",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/printing-device" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "transactional",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "device_capability_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@rms/printing-device" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "device_health_current",
      classification: "projection-read-model",
      writeOwner: { kind: "projection-builder", id: "@rms/printing-device.device-health.v1" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "device_health_signal",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/printing-device" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "device_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@rms/printing-device" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier", "credential"],
    },
  ],
  accesses: [],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
