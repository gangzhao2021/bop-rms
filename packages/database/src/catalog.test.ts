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
    expect(first.migrations.map((migration) => migration.id)).toEqual([
      "0000_001_create_migration_history",
      "0000_002_alter_platform_core",
      "0000_003_create_platform_eventing",
      "0000_004_create_platform_audit",
      "0000_005_create_platform_jobs",
      "0000_006_create_platform_helpers",
      "0000_007_create_uuid_money_helpers",
      "0000_008_create_time_helpers",
      "0000_009_create_tenant_scope_helpers",
      "0000_010_create_outbox_event",
      "0000_011_alter_outbox_dispatch",
      "0000_012_create_consumer_inbox",
      "0000_013_create_retry_dead_letter",
      "0000_014_create_audit_record",
      "0000_015_alter_audit_hash_chain",
      "0200_001_create_tenant_organization",
      "0200_002_create_operating_entity",
      "0200_003_create_membership",
    ]);
    expect(
      first.migrations.every((migration) => /^[0-9a-f]{64}$/u.test(migration.checksumSha256)),
    ).toBe(true);
  });

  it("keeps WP-0021 schema-only with the exact owner and schema sequence", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(
      catalog.migrations
        .slice(1, 5)
        .map((migration) => [migration.id, migration.metadata.owner, migration.metadata.schema]),
    ).toEqual([
      ["0000_002_alter_platform_core", "shared-infrastructure/platform-core", "platform_core"],
      ["0000_003_create_platform_eventing", "shared-infrastructure/eventing", "platform_eventing"],
      ["0000_004_create_platform_audit", "shared-infrastructure/audit", "platform_audit"],
      ["0000_005_create_platform_jobs", "shared-infrastructure/jobs", "platform_jobs"],
    ]);
    const wp0021Sql = catalog.migrations
      .slice(1, 5)
      .map((migration) => migration.sql)
      .join("\n");
    expect(wp0021Sql).not.toMatch(
      /\bCREATE\s+(?:TABLE|VIEW|MATERIALIZED|SEQUENCE|FUNCTION|TRIGGER|EXTENSION|ROLE|USER|POLICY)\b/iu,
    );
    expect(wp0021Sql).not.toContain("platform_projection");
  });

  it("registers the exact WP-0022 helper migration authority", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(
      catalog.migrations
        .slice(5, 9)
        .map((migration) => [migration.id, migration.metadata.owner, migration.metadata.schema]),
    ).toEqual([
      ["0000_006_create_platform_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_007_create_uuid_money_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_008_create_time_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_009_create_tenant_scope_helpers", "shared-infrastructure/helpers", "platform_helpers"],
    ]);
  });

  it("registers the exact WP-0030 and WP-0031 Eventing migrations", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const outbox = catalog.migrations.find(
      (migration) => migration.id === "0000_010_create_outbox_event",
    );
    const dispatcher = catalog.migrations.find(
      (migration) => migration.id === "0000_011_alter_outbox_dispatch",
    );
    const inbox = catalog.migrations.find(
      (migration) => migration.id === "0000_012_create_consumer_inbox",
    );
    const retry = catalog.migrations.find(
      (migration) => migration.id === "0000_013_create_retry_dead_letter",
    );
    expect(outbox).toMatchObject({
      id: "0000_010_create_outbox_event",
      metadata: {
        owner: "shared-infrastructure/eventing",
        schema: "platform_eventing",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(outbox?.sql).toContain("platform_helpers.uuid_v7");
    expect(outbox?.sql).toContain("platform_helpers.current_brand_id()");
    expect(outbox?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(dispatcher).toMatchObject({
      id: "0000_011_alter_outbox_dispatch",
      metadata: {
        owner: "shared-infrastructure/eventing",
        schema: "platform_eventing",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(dispatcher?.sql).toContain("lease_token platform_helpers.uuid_v7");
    expect(dispatcher?.sql).toContain("outbox_event_dispatch_claim_idx");
    expect(inbox).toMatchObject({
      id: "0000_012_create_consumer_inbox",
      metadata: { owner: "shared-infrastructure/eventing", schema: "platform_eventing" },
    });
    expect(inbox?.sql).toContain("consumer_inbox_tenant_scope");
    expect(retry).toMatchObject({
      id: "0000_013_create_retry_dead_letter",
      metadata: { owner: "shared-infrastructure/eventing", schema: "platform_eventing" },
    });
    expect(retry?.sql).toContain("CREATE TABLE platform_eventing.delivery_attempt");
    expect(retry?.sql).toContain("CREATE TABLE platform_eventing.dead_letter_item");
    expect(retry?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(`${outbox?.sql}\n${dispatcher?.sql}\n${inbox?.sql}\n${retry?.sql}`).not.toMatch(
      /\b(?:GRANT|CREATE ROLE|CREATE USER)\b/iu,
    );
  });

  it("registers the exact WP-0042 Audit migration authority", async () => {
    const audit = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (migration) => migration.id === "0000_014_create_audit_record",
    );
    expect(audit).toMatchObject({
      id: "0000_014_create_audit_record",
      metadata: {
        owner: "shared-infrastructure/audit",
        schema: "platform_audit",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(audit?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(audit?.sql).toContain("corrects_audit_id");
    expect(audit?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-0046 Audit integrity migration authority", async () => {
    const integrity = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (migration) => migration.id === "0000_015_alter_audit_hash_chain",
    );
    expect(integrity).toMatchObject({
      id: "0000_015_alter_audit_hash_chain",
      metadata: {
        owner: "shared-infrastructure/audit",
        schema: "platform_audit",
        phase: "expand",
        risk: "high",
      },
    });
    expect(integrity?.sql).toContain("requires an empty audit_record table");
    expect(integrity?.sql).toContain("CREATE TABLE platform_audit.audit_chain_head");
    expect(integrity?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(integrity?.sql).toContain("AUDIT_CHAIN_V1");
    expect(integrity?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-0101 and WP-0102 business migration authorities", async () => {
    const migrations = (await readMigrationCatalog(repositoryRoot)).migrations.filter(
      (migration) => migration.namespace === 200,
    );
    expect(
      migrations.map((migration) => [
        migration.id,
        migration.metadata.owner,
        migration.metadata.schema,
      ]),
    ).toEqual([
      ["0200_001_create_tenant_organization", "@bop/tenant", "bop_tenant"],
      ["0200_002_create_operating_entity", "@bop/operating-entity", "bop_operating_entity"],
      ["0200_003_create_membership", "@bop/membership", "bop_membership"],
    ]);
    expect(migrations.map((migration) => migration.sql).join("\n")).not.toMatch(
      /\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu,
    );
  });

  it("rejects any non-allowlisted foreign helper reference", async () => {
    const root = await fixture();
    const file = path.join(root, "migrations", "0000-platform", "0000_010_create_outbox_event.sql");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}SELECT platform_helpers.unapproved_helper();\n`,
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_SCHEMA_MISMATCH",
    );
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

  it("allows only a fixed pg_catalog search path inside a function definition", async () => {
    const clean = await readMigrationCatalog(repositoryRoot);
    expect(clean.diagnostics).toEqual([]);
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}SET search_path = pg_catalog;\n`);
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
