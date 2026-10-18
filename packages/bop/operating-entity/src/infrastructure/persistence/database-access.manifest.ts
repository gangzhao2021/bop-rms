const databaseAccessManifestInput = {
  version: 1,
  module: {
    moduleName: "operating-entity",
    packageName: "@bop/operating-entity",
    layer: "BOP",
  },
  tables: [
    {
      table: "business_function_assignment_decision",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "operating_entity_admin_operation",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "operating_entity_approval_decision",
      classification: "append-only-record",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "sensitive_personal"],
    },
    {
      table: "operating_entity_authority_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "personal", "sensitive_personal"],
    },
    {
      table: "operating_entity_profile_version",
      classification: "configuration-version",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "personal", "sensitive_personal", "payment"],
    },
    {
      table: "operating_entity",
      classification: "aggregate-root",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier", "personal", "sensitive_personal", "payment"],
    },
    {
      table: "brand_operating_entity_assignment",
      classification: "relationship-assignment",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "store_operating_entity_assignment",
      classification: "relationship-assignment",
      writeOwner: { kind: "module", id: "@bop/operating-entity" },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [
    {
      id: "tax-registrant-source.read.store_operating_entity_assignment",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_operating_entity", table: "store_operating_entity_assignment" },
      principal: { kind: "module", id: "@bop/operating-entity" },
      readPattern: "owner-repository",
      source:
        "packages/bop/operating-entity/src/infrastructure/persistence/tax-registrant-source.ts",
    },
    {
      id: "tax-registrant-source.read.operating_entity",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_operating_entity", table: "operating_entity" },
      principal: { kind: "module", id: "@bop/operating-entity" },
      readPattern: "owner-repository",
      source:
        "packages/bop/operating-entity/src/infrastructure/persistence/tax-registrant-source.ts",
    },
    {
      id: "tax-registrant-source.read.operating_entity_profile_version",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_operating_entity", table: "operating_entity_profile_version" },
      principal: { kind: "module", id: "@bop/operating-entity" },
      readPattern: "owner-repository",
      source:
        "packages/bop/operating-entity/src/infrastructure/persistence/tax-registrant-source.ts",
    },
    {
      id: "receipt-issuer-source.read.store_operating_entity_assignment",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_operating_entity", table: "store_operating_entity_assignment" },
      principal: { kind: "module", id: "@bop/operating-entity" },
      readPattern: "owner-repository",
      source:
        "packages/bop/operating-entity/src/infrastructure/persistence/receipt-issuer-source.ts",
    },
    {
      id: "receipt-issuer-source.read.operating_entity",
      operation: "read",
      mechanism: "repository",
      target: { schema: "bop_operating_entity", table: "operating_entity" },
      principal: { kind: "module", id: "@bop/operating-entity" },
      readPattern: "owner-repository",
      source:
        "packages/bop/operating-entity/src/infrastructure/persistence/receipt-issuer-source.ts",
    },
  ],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
