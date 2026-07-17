import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readMigrationCatalog } from "./catalog.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join("/tmp", "bop-rms-wp0020-catalog-"));
  roots.push(root);
  await cp(path.join(repositoryRoot, "migrations"), path.join(root, "migrations"), {
    recursive: true,
  });
  return root;
}

const migrationPath = (root: string) =>
  path.join(root, "migrations", "0000-platform", "0000_001_create_migration_history.sql");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("migration catalog", () => {
  it("loads the committed Canonical catalog deterministically", async () => {
    const first = await readMigrationCatalog(repositoryRoot);
    const second = await readMigrationCatalog(repositoryRoot);
    expect(first.diagnostics).toEqual([]);
    expect(first).toEqual(second);
    expect(first.migrations).toHaveLength(1);
    expect(first.migrations[0]?.id).toBe("0000_001_create_migration_history");
    expect(first.migrations[0]?.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a changed namespace registry", async () => {
    const root = await fixture();
    const registry = path.join(root, "migrations", "namespaces.json");
    await writeFile(
      registry,
      (await readFile(registry, "utf8")).replace("1800-rms-reporting", "1800-rms-report"),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_NAMESPACE_UNKNOWN",
    );
  });

  it("rejects metadata order and values", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, (await readFile(file, "utf8")).replace("-- risk: low", "-- phase: low"));
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("rejects CRLF and missing final newline bytes", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("\n", "\r\n").trimEnd());
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("rejects a platform owner mismatch", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "shared-infrastructure/platform-core",
        "shared-infrastructure/eventing",
      ),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_OWNER_MISMATCH",
    );
  });

  it("rejects runner-owned or non-transactional SQL", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}COMMIT;\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_TRANSACTION_UNSUPPORTED",
    );
  });

  it("rejects database, role, tablespace, or extension DDL", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}CREATE EXTENSION pg_trgm;\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("does not confuse a PostgreSQL cast with template substitution", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}SELECT 1::integer;\n`);
    expect((await readMigrationCatalog(root)).diagnostics).toEqual([]);
  });

  it("rejects duplicate global order", async () => {
    const root = await fixture();
    const directory = path.dirname(migrationPath(root));
    const source = await readFile(migrationPath(root));
    await writeFile(path.join(directory, "0000_001_alter_migration_history.sql"), source);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_DUPLICATE_ORDER",
    );
  });

  it("rejects case-fold-colliding migration filenames", async () => {
    const root = await fixture();
    const directory = path.dirname(migrationPath(root));
    await writeFile(
      path.join(directory, "0000_001_CREATE_MIGRATION_HISTORY.sql"),
      await readFile(migrationPath(root)),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "CASE_CONFLICT",
    );
  });

  it("rejects an unqualified DDL target", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "CREATE TABLE platform_core.migration_history",
        "CREATE TABLE migration_history",
      ),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_SCHEMA_MISMATCH",
    );
  });

  it("rejects a symbolic namespace registry", async () => {
    const root = await fixture();
    const registry = path.join(root, "migrations", "namespaces.json");
    const outside = path.join(root, "outside-namespaces.json");
    await writeFile(outside, await readFile(registry));
    await rm(registry);
    await symlink(outside, registry);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects a symbolic root migration catalog", async () => {
    const root = await fixture();
    const catalog = path.join(root, "migrations");
    const outside = path.join(root, "outside-migrations");
    await rename(catalog, outside);
    await symlink(outside, catalog);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects symbolic migration files", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    const outside = path.join(root, "outside.sql");
    await writeFile(outside, await readFile(file));
    await rm(file);
    await symlink(outside, file);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects unknown namespace entries and case-fold collisions", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "migrations", "0000-Platform"));
    const codes = (await readMigrationCatalog(root)).diagnostics.map((item) => item.code);
    expect(codes).toContain("CASE_CONFLICT");
    expect(codes).toContain("MIGRATION_NAMESPACE_UNKNOWN");
  });
});
