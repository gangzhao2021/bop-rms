const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "feature-control", packageName: "@bop/feature-control", layer: "BOP" },
  tables: [
    {
      table: "kill_switch_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },

    {
      table: "control_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "control_dependency",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "control_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/feature-control" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [
    {
      id: "kill-switch.write.version",
      operation: "write",
      readPattern: null,
      mechanism: "repository",
      target: { schema: "bop_feature_control", table: "kill_switch_version" },
      principal: { kind: "module", id: "@bop/feature-control" },
      source:
        "packages/bop/feature-control/src/infrastructure/persistence/kill-switch-query-store.ts",
    },

    {
      id: "kill-switch.read.current",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_feature_control", table: "kill_switch_version" },
      principal: { kind: "module", id: "@bop/feature-control" },
      readPattern: "owner-repository",
      source:
        "packages/bop/feature-control/src/infrastructure/persistence/kill-switch-query-store.ts",
    },
  ],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
