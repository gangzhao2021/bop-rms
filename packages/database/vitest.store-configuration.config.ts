import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/database/test/store-configuration-acceptance.test.mjs",
      "packages/database/test/store-configuration-original-acceptance.test.mjs",
      "packages/database/test/store-configuration-ordinary-runtime-acceptance.test.mjs",
      "packages/database/test/store-publication-setup-basis-acceptance.test.mjs",
      "packages/database/test/tax-config-authoring-acceptance.test.mjs",
      "packages/database/test/tax-config-material-schema-acceptance.test.mjs",
      "packages/database/test/tax-config-candidate-schema-acceptance.test.mjs",
      "packages/database/test/tax-registrant-source-acceptance.test.mjs",
      "packages/database/test/tax-config-runtime-acceptance.test.mjs",
      "packages/database/test/store-setup-runtime-acceptance.test.mjs",
      "packages/database/test/store-setup-reference-schema-acceptance.test.mjs",
      "packages/database/test/store-payment-configuration-schema-acceptance.test.mjs",
      "packages/database/test/receipt-template-artifact-schema-acceptance.test.mjs",
      "packages/database/test/receipt-template-draft-schema-acceptance.test.mjs",
      "packages/database/test/receipt-template-submission-schema-acceptance.test.mjs",
      "packages/database/test/receipt-template-submit-operation-schema-acceptance.test.mjs",
      "packages/database/test/receipt-template-lifecycle-operation-schema-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
