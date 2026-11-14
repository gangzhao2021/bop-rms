import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/checkout-contact-staff-removal-acceptance.test.mjs"],
    testTimeout: 600_000,
  },
});
