const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "publishing", packageName: "@bop/publishing", layer: "BOP" },
  tables: [
    {
      table: "publishing_mutation_record",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "live_gate_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "live_gate_requirement",
      classification: "aggregate-child-entity",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "live_gate_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/publishing" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [
    {
      id: "current-live-gate.read.live_gate_version",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_publishing", table: "live_gate_version" },
      principal: { kind: "module", id: "@bop/publishing" },
      readPattern: "owner-repository",
      source: "packages/bop/publishing/src/infrastructure/persistence/current-live-gate-source.ts",
    },
    {
      id: "current-live-gate.read.live_gate_requirement",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_publishing", table: "live_gate_requirement" },
      principal: { kind: "module", id: "@bop/publishing" },
      readPattern: "owner-repository",
      source: "packages/bop/publishing/src/infrastructure/persistence/current-live-gate-source.ts",
    },
  ],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
