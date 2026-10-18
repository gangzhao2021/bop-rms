import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanSqlOrdering } from "./scan.mjs";

// WP-2423 (v15 2026-10-16): `SELECT version::text AS version … ORDER BY version DESC LIMIT 1` sorts
// the text output column, so version 9 reads as the latest from version 10 on (the Brand
// sole-operator setting read "On" after it was turned off). Order by the table column instead
// (`ORDER BY brand_sole_operator_setting.version`).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Reviewed exceptions (file, ordered name, reason). Every entry orders a UUID returned as text:
 * the databases use collation "C", where the canonical lowercase text of a UUID sorts exactly as
 * the UUID does; or a value that is text by nature. A version, revision, sequence, number or
 * instant is never an exception: qualify it with its table.
 */
const uuid = "UUID as canonical text: same order as the UUID under collation C";
const allowlist = [
  ["packages/bop/task/src/infrastructure/persistence/task-store.ts", "task_id", uuid],
  ["packages/database/src/helpers.ts", "identity", "function signature text, sorted as text"],
  ["packages/database/test-support/approved-workforce-membership.mjs", "audit_id", uuid],
  ["packages/database/test-support/approved-workforce-membership.mjs", "membership_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "assignment_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "brand_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "grant_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "membership_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "override_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "permission_id", uuid],
  ["packages/database/test-support/approved-workforce-policy.mjs", "role_id", uuid],
  ["packages/database/test-support/product-scope-retirement.mjs", "product_id", uuid],
  [
    "packages/database/test-support/tax-config-candidate-schema-acceptance.mjs",
    "target_version_id",
    uuid,
  ],
  ["packages/database/test-support/workforce-invitation-persistence.mjs", "invitation_id", uuid],
  ["packages/database/test/audit-record-acceptance.test.mjs", "store_id", uuid],
  [
    "packages/database/test/inventory-configuration-reference-source-acceptance.test.mjs",
    "brand_id",
    uuid,
  ],
  [
    "packages/database/test/inventory-configuration-reference-source-acceptance.test.mjs",
    "tenant_id",
    uuid,
  ],
  [
    "packages/database/test/kitchen-queue-projection-acceptance.test.mjs",
    "projection_generation_id",
    uuid,
  ],
  ["packages/database/test/kitchen-ticket-acceptance.test.mjs", "target", "table name text"],
  ["packages/database/test/outbox-acceptance.test.mjs", "event_id", uuid],
  ["packages/database/test/pickup-fulfillment-acceptance.test.mjs", "fulfillment_id", uuid],
  [
    "packages/database/test/recipe-inventory-reference-source-acceptance.test.mjs",
    "brand_id",
    uuid,
  ],
  ["packages/database/test/recipe-reference-source-acceptance.test.mjs", "brand_id", uuid],
  ["packages/database/test/tenant-context-acceptance.test.mjs", "table_name", "table name text"],
  [
    "packages/rms/dining/src/infrastructure/persistence/dining-exception-task-store.ts",
    "task_reference",
    uuid + " (SELECT DISTINCT keyset page)",
  ],
  ["packages/rms/dining/src/infrastructure/persistence/dining-table-qr-store.ts", "table_id", uuid],
  ["packages/rms/kitchen/src/infrastructure/persistence/kitchen-rework-store.ts", "order_id", uuid],
  [
    "packages/rms/kitchen/src/infrastructure/persistence/kitchen-rework-store.ts",
    "order_item_id",
    uuid,
  ],
  [
    "packages/rms/ordering/src/infrastructure/persistence/dining-session-order-inventory.ts",
    "amendment_id",
    uuid,
  ],
  [
    "packages/rms/ordering/src/infrastructure/persistence/dining-session-order-inventory.ts",
    "order_id",
    uuid,
  ],
  [
    "packages/rms/ordering/src/infrastructure/persistence/dining-session-order-lookup.ts",
    "order_id",
    uuid,
  ],
  [
    "packages/rms/ordering/src/infrastructure/persistence/merchant-order-index.ts",
    "order_id",
    uuid,
  ],
  [
    "packages/rms/ordering/src/infrastructure/persistence/order-revision-position.ts",
    "order_batch_id",
    uuid,
  ],
  [
    "packages/rms/payment/src/infrastructure/persistence/order-payment-attempt-position.ts",
    "payment_intent_id",
    uuid,
  ],
  [
    "packages/rms/payment/src/infrastructure/persistence/payment-compensation-exception-source.ts",
    "case_reference",
    uuid + " (SELECT DISTINCT keyset page)",
  ],
  [
    "packages/rms/pricing/src/infrastructure/persistence/tax-config-candidate-store.ts",
    "target_version_id",
    uuid,
  ],
  [
    "packages/rms/pricing/src/infrastructure/persistence/tax-config-material-store.ts",
    "material_id",
    uuid,
  ],
];
/** A name that holds a number or an instant is never allowlisted (a `_id` UUID may be). */
const orderedValueName = (name) =>
  !/_id$/.test(name) &&
  /(version|revision|sequence|ordinal|number|generation|position|count|_at$|amount|minor)/i.test(
    name,
  );

describe("SQL ordering on text output columns", () => {
  it("finds a text alias, an unaliased cast and a fragment completed elsewhere", () => {
    const aliased = scanSqlOrdering(
      `q("SELECT version::text AS version,state FROM t WHERE a=$1 ORDER BY version DESC LIMIT 1")`,
    );
    expect(aliased.map((hit) => hit.name)).toEqual(["version"]);
    const viaConstant = scanSqlOrdering(
      `const cols = "id,revision::text revision";\nq(\`SELECT \${cols} FROM t ORDER BY revision DESC LIMIT 1\`)`,
    );
    expect(viaConstant.map((hit) => hit.name)).toEqual(["revision"]);
    const concatenated = scanSqlOrdering(
      `const selectColumns = "a,version::text AS version";\nq("SELECT " + selectColumns + " FROM t ORDER BY version DESC")`,
    );
    expect(concatenated.map((hit) => hit.name)).toEqual(["version"]);
    const unaliased = scanSqlOrdering(
      `q("SELECT lifecycle_version::text,changed_at FROM t ORDER BY lifecycle_version DESC")`,
    );
    expect(unaliased.map((hit) => hit.name)).toEqual(["lifecycle_version"]);
    const fragment = scanSqlOrdering(
      `const columns = "id,qr_version::text AS qr_version";\nconst one = (w) => q("SELECT " + columns + " FROM t WHERE " + w);\none("x=$1 ORDER BY qr_version DESC LIMIT 1");`,
    );
    expect(fragment.map((hit) => hit.name)).toEqual(["qr_version"]);
    const formatted = scanSqlOrdering(
      `q("SELECT to_char(changed_at AT TIME ZONE 'UTC','YYYY') AS changed_at FROM t ORDER BY changed_at")`,
    );
    expect(formatted.map((hit) => hit.name)).toEqual(["changed_at"]);
  });

  it("accepts table-qualified items, window or aggregate ordering and casts inside arguments", () => {
    expect(
      scanSqlOrdering(
        `q("SELECT version::text AS version FROM bop_tenant.s ORDER BY s.version DESC LIMIT 1")`,
      ),
    ).toEqual([]);
    expect(
      scanSqlOrdering(
        `q("SELECT version::text AS version, row_number() OVER (PARTITION BY a ORDER BY version) FROM t")`,
      ),
    ).toEqual([]);
    expect(
      scanSqlOrdering(
        `q("SELECT jsonb_agg(v ORDER BY version) AS version FROM (SELECT version::text AS v, version FROM t) x")`,
      ),
    ).toEqual([]);
    expect(
      scanSqlOrdering(
        `q("SELECT jsonb_build_object('v',version::text) value FROM t ORDER BY id,version")`,
      ),
    ).toEqual([]);
    expect(scanSqlOrdering(`q("SELECT version FROM t ORDER BY version DESC LIMIT 1")`)).toEqual([]);
  });

  it("has no unreviewed text ordering in the repository", () => {
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (file) =>
          /\.(ts|tsx|mts|mjs|js|cjs|sql)$/.test(file) &&
          !/(^|\/)(dist|node_modules)\//.test(file) &&
          !file.startsWith("tooling/sql-ordering/"),
      );
    const hits = [];
    for (const file of files) {
      let text;
      try {
        text = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      if (/ORDER\s+BY/i.test(text)) hits.push(...scanSqlOrdering(text, file));
    }
    const allowed = new Set(allowlist.map(([file, name]) => file + "\t" + name));
    const unreviewed = hits
      .filter((hit) => !allowed.has(hit.file + "\t" + hit.name))
      .map((hit) => `${hit.file}:${hit.line} ORDER BY ${hit.item}`);
    expect(unreviewed).toEqual([]);
    // No stale entries, and nothing that holds a number or an instant.
    const found = new Set(hits.map((hit) => hit.file + "\t" + hit.name));
    expect(allowlist.filter(([file, name]) => !found.has(file + "\t" + name))).toEqual([]);
    expect(allowlist.filter(([, name]) => orderedValueName(name))).toEqual([]);
  });
});
