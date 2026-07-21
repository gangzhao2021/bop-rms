import assert from "node:assert/strict";
import process from "node:process";
import { withIsolatedDatabase } from "./isolated-database.mjs";

await assert.rejects(withIsolatedDatabase(), {
  code: "ISOLATED_DB_USAGE",
  name: "IsolatedDatabaseError",
});
await assert.rejects(
  withIsolatedDatabase({ caseId: "UPPER" }, () => undefined),
  {
    code: "ISOLATED_DB_USAGE",
  },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", failureAt: "unknown" }, () => undefined),
  { code: "ISOLATED_DB_USAGE" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", environment: "production" }, () => undefined),
  { code: "ISOLATED_DB_UNSAFE_ENVIRONMENT" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", host: "db.example.test" }, () => undefined),
  { code: "ISOLATED_DB_UNSAFE_ENVIRONMENT" },
);
await assert.rejects(
  withIsolatedDatabase({ caseId: "safe", ssl: true }, () => undefined),
  {
    code: "ISOLATED_DB_UNSAFE_ENVIRONMENT",
  },
);

process.stdout.write("WP-0024 isolated database unit contract passed\n");
