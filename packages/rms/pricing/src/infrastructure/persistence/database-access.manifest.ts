const databaseAccessManifestInput = {
  version: 1,
  module: {
    moduleName: "pricing",
    packageName: "@rms/pricing",
    layer: "RMS",
  },
  tables: [
    {
      table: "tax_reference_generation",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-reference.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_reference_scope",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-reference.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "option_price_rule",
      classification: "aggregate-root",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "option_price_rule_version",
      classification: "configuration-version",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_configuration",
      classification: "aggregate-root",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_configuration_version",
      classification: "configuration-version",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_configuration_rule",
      classification: "aggregate-child-entity",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_configuration_operation_record",
      classification: "append-only-record",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_config_admin_projection_generation",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-config-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_config_admin_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-config-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_config_rule_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-config-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_config_receipt_fixture_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-config-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "tax_config_admin_projection_checkpoint",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.tax-config-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book",
      classification: "aggregate-root",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion",
      classification: "aggregate-root",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_version",
      classification: "configuration-version",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_eligibility_reference",
      classification: "aggregate-child-entity",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_operation_record",
      classification: "append-only-record",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_admin_projection_generation",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.promotion-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_admin_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.promotion-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "promotion_admin_projection_checkpoint",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.promotion-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_version",
      classification: "configuration-version",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_entry",
      classification: "aggregate-child-entity",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_operation_record",
      classification: "append-only-record",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_admin_projection_generation",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.price-book-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_admin_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.price-book-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_entry_projection",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.price-book-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_book_admin_projection_checkpoint",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.price-book-admin.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_quote_request",
      classification: "append-only-record",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository"],
      retentionCategory: "audit-security",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_quote",
      classification: "aggregate-root",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_quote_line",
      classification: "aggregate-child-entity",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "price_quote_tax_line",
      classification: "aggregate-child-entity",
      writeOwner: {
        kind: "module",
        id: "@rms/pricing",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
    {
      table: "configuration_reference_generation",
      classification: "projection-read-model",
      writeOwner: {
        kind: "projection-builder",
        id: "@rms/pricing.configuration-reference.v1",
      },
      allowedReadPatterns: ["owner-repository", "public-query-contract"],
      retentionCategory: "operational",
      piiClassification: ["indirect_identifier"],
    },
  ],
  accesses: [
    {
      id: "brand-tax-reference-source.read.tax_reference_generation",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "tax_reference_generation",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/brand-tax-reference-source-store.ts",
    },
    {
      id: "brand-tax-reference-source.read.tax_reference_scope",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "tax_reference_scope",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/brand-tax-reference-source-store.ts",
    },
    {
      id: "promotion-reference-source.read.promotion",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "promotion",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/promotion-reference-source-store.ts",
    },
    {
      id: "promotion-reference-source.read.promotion_version",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "promotion_version",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/promotion-reference-source-store.ts",
    },
    {
      id: "promotion-reference-source.read.promotion_eligibility_reference",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "promotion_eligibility_reference",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/promotion-reference-source-store.ts",
    },
    {
      id: "option-price-reference-source.read.option_price_rule",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "option_price_rule",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/option-price-reference-source-store.ts",
    },
    {
      id: "option-price-reference-source.read.option_price_rule_version",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "option_price_rule_version",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/option-price-reference-source-store.ts",
    },
    {
      id: "price-book-reference-source.read.price_book",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "price_book",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/price-book-reference-source-store.ts",
    },
    {
      id: "price-book-reference-source.read.price_book_version",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "price_book_version",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/price-book-reference-source-store.ts",
    },
    {
      id: "price-book-reference-source.read.price_entry",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "price_entry",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/price-book-reference-source-store.ts",
    },
    {
      id: "tax-configuration-reference-source.read.tax_configuration",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "tax_configuration",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/tax-configuration-reference-source-store.ts",
    },
    {
      id: "tax-configuration-reference-source.read.tax_configuration_version",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "tax_configuration_version",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/tax-configuration-reference-source-store.ts",
    },
    {
      id: "tax-configuration-reference-source.read.tax_configuration_rule",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "tax_configuration_rule",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "public-query-contract",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/tax-configuration-reference-source-store.ts",
    },
    {
      id: "configuration-reference-source.read.configuration_reference_generation",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "configuration_reference_generation",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/configuration-reference-source-store.ts",
    },
    {
      id: "configuration-reference-source.read.price_book",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "price_book",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/configuration-reference-source-store.ts",
    },
    {
      id: "configuration-reference-source.read.option_price_rule",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "option_price_rule",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/configuration-reference-source-store.ts",
    },
    {
      id: "configuration-reference-source.read.promotion",
      operation: "read",
      mechanism: "repository",
      target: {
        schema: "rms_pricing",
        table: "promotion",
      },
      principal: {
        kind: "module",
        id: "@rms/pricing",
      },
      readPattern: "owner-repository",
      source:
        "packages/rms/pricing/src/infrastructure/persistence/configuration-reference-source-store.ts",
    },
  ],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
