import { describe, expect, it } from "vitest";
import { readMigrationCatalog } from "./catalog.ts";
import { compareMigrationState } from "./runner.ts";

const catalog = await readMigrationCatalog(process.cwd());
const history = catalog.migrations.map((migration) => ({
  migration_id: migration.id,
  namespace: migration.namespace,
  sequence: migration.sequence,
  relative_path: migration.relativePath,
  owner_id: migration.metadata.owner,
  schema_name: migration.metadata.schema,
  checksum_sha256: migration.checksumSha256,
  runner_contract_version: 1,
}));
const quoteMigration = "1200_008_alter_quote_snapshot";

describe("namespace-local migration evolution", () => {
  it("allows a full predecessor to append Pricing after later namespaces advanced", () => {
    expect(catalog.diagnostics).toEqual([]);
    const result = compareMigrationState(
      catalog,
      history.filter((row) => row.migration_id !== quoteMigration),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.pending.map((migration) => migration.id)).toEqual([quoteMigration]);
    expect(compareMigrationState(catalog, history)).toEqual({ diagnostics: [], pending: [] });
  });

  it("rejects missing earlier history within the same namespace", () => {
    const result = compareMigrationState(
      catalog,
      history.filter((row) => row.migration_id !== "1200_005_create_tax_config_admin_projection"),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "MIGRATION_OUT_OF_ORDER",
    ]);
  });

  it("keeps deterministic pending order for new namespaces and empty databases", () => {
    const result = compareMigrationState(
      catalog,
      history.filter((row) => row.namespace !== 1200),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.pending).toEqual(
      catalog.migrations.filter((migration) => migration.namespace === 1200),
    );
    expect(compareMigrationState(catalog, [])).toEqual({
      diagnostics: [],
      pending: [...catalog.migrations],
    });
  });

  it.each([
    ["checksum_sha256", "0".repeat(64), "MIGRATION_CHECKSUM_MISMATCH"],
    ["relative_path", "synthetic/changed.sql", "MIGRATION_HISTORY_ORPHANED"],
    ["owner_id", "synthetic-owner", "MIGRATION_OWNER_MISMATCH"],
    ["schema_name", "synthetic_schema", "MIGRATION_SCHEMA_MISMATCH"],
    ["runner_contract_version", 2, "MIGRATION_HISTORY_ORPHANED"],
    ["namespace", 9999, "MIGRATION_OUT_OF_ORDER"],
    ["sequence", 999, "MIGRATION_OUT_OF_ORDER"],
  ])("retains drift refusal for %s", (field, value, code) => {
    const changed = history.map((row) =>
      row.migration_id === quoteMigration ? { ...row, [field]: value } : row,
    );
    expect(
      compareMigrationState(catalog, changed).diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual([code]);
  });

  it("rejects orphan history and changed catalog bytes", () => {
    const removed = {
      ...catalog,
      migrations: catalog.migrations.filter((migration) => migration.id !== quoteMigration),
    };
    expect(
      compareMigrationState(removed, history).diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual(["MIGRATION_HISTORY_ORPHANED"]);
    const changed = {
      ...catalog,
      migrations: catalog.migrations.map((migration) =>
        migration.id === quoteMigration
          ? { ...migration, checksumSha256: "0".repeat(64) }
          : migration,
      ),
    };
    expect(
      compareMigrationState(changed, history).diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual(["MIGRATION_CHECKSUM_MISMATCH"]);
  });
});
