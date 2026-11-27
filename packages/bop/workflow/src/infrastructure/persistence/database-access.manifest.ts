const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "workflow", packageName: "@bop/workflow", layer: "BOP" },
  tables: [
    {
      table: "workflow_definition_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/workflow" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
