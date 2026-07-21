import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readMigrationCatalog } from "../src/catalog.ts";
import { verifyFoundation } from "../src/foundation.ts";
import { migrationAdvisoryKey, runMigrationCommand } from "../src/runner.ts";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localRoot = path.join(root, ".local");
await mkdir(localRoot, { mode: 0o700, recursive: true });
const temp = await mkdtemp(path.join(localRoot, "wp0021-integration-"));
const project = `bop-rms-wp0021-verify-${process.pid}`;
const port = Number.parseInt(process.env.BOP_RMS_WP0021_VERIFY_PORT ?? "55435", 10);
const adminDatabase = "bop_rms_wp0021_admin";
const user = "bop_rms_wp0021_runner";
const password = `wp0021-synthetic-${process.pid}`;
const secret = path.join(temp, "password");
const composeEnv = path.join(temp, "compose.env");
const logFile = path.join(temp, "postgres.log");
const databases = new Set();
let admin;

assert.match(project, /^bop-rms-wp0021-verify-[0-9]+$/u);
assert(Number.isInteger(port) && port >= 1 && port <= 65_535, "verification port must be safe");

await writeFile(secret, password, { mode: 0o600 });
await writeFile(
  composeEnv,
  [
    `BOP_RMS_COMPOSE_PROJECT=${project}`,
    "BOP_RMS_ENVIRONMENT=test",
    "BOP_RMS_POSTGRES_HOST=127.0.0.1",
    `BOP_RMS_POSTGRES_PASSWORD_FILE=${secret}`,
    `BOP_RMS_POSTGRES_PORT=${port}`,
    `BOP_RMS_POSTGRES_DB=${adminDatabase}`,
    `BOP_RMS_POSTGRES_USER=${user}`,
    "BOP_RMS_POSTGRES_SSL_MODE=disable",
    "BOP_RMS_API_PORT=53021",
    "BOP_RMS_MERCHANT_WEB_PORT=53022",
    "BOP_RMS_CUSTOMER_PWA_PORT=53023",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

function compose(...args) {
  return execFileSync(
    "docker",
    [
      "compose",
      "--project-directory",
      root,
      "--project-name",
      project,
      "--env-file",
      composeEnv,
      "--file",
      path.join(root, "compose.yaml"),
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function identifier(value) {
  assert.match(value, /^bop_rms_wp0021_[a-z0-9_]+$/u);
  return `"${value}"`;
}

function config(database) {
  return {
    database,
    environment: "test",
    host: "127.0.0.1",
    password,
    port,
    ssl: false,
    user,
  };
}

async function createDatabase(label) {
  const database = `bop_rms_wp0021_${process.pid}_${label}`;
  identifier(database);
  await admin.query(
    `CREATE DATABASE ${identifier(database)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  databases.add(database);
  return database;
}

async function targetClient(database) {
  const client = new Client({
    application_name: "bop-rms-wp0021-integration",
    database,
    host: "127.0.0.1",
    password,
    port,
    user,
  });
  await client.connect();
  return client;
}

async function syntheticCatalog(label, extraSql) {
  const fixtureRoot = path.join(temp, `catalog-${label}`);
  await cp(path.join(root, "migrations"), path.join(fixtureRoot, "migrations"), {
    recursive: true,
  });
  if (extraSql)
    await writeFile(
      path.join(
        fixtureRoot,
        "migrations",
        "0000-platform",
        "0000_006_create_synthetic_rollback_probe.sql",
      ),
      extraSql,
    );
  const catalog = await readMigrationCatalog(fixtureRoot);
  assert.deepEqual(catalog.diagnostics, []);
  return { catalog, fixtureRoot };
}

async function cleanup() {
  try {
    if (admin) {
      for (const database of databases) {
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
      }
      await admin.end();
    }
  } catch {
    // Compose cleanup still owns the isolated project and volume.
  }
  try {
    const logs = compose("logs", "--no-color", "postgres");
    await writeFile(logFile, logs, { mode: 0o600 });
    assert(!logs.includes(password), "PostgreSQL logs disclosed the synthetic password");
  } finally {
    try {
      compose("down", "--volumes", "--remove-orphans");
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  }
}

process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

try {
  compose("down", "--volumes", "--remove-orphans");
  compose("up", "--detach", "--wait", "--wait-timeout", "120", "postgres");
  admin = new Client({
    application_name: "bop-rms-wp0021-integration-admin",
    database: adminDatabase,
    host: "127.0.0.1",
    password,
    port,
    user,
  });
  await admin.connect();
  const catalog = await readMigrationCatalog(root);
  assert.deepEqual(catalog.diagnostics, []);

  const lifecycleDatabase = await createDatabase("lifecycle");
  const initial = await runMigrationCommand({
    catalog,
    command: "status",
    config: config(lifecycleDatabase),
  });
  assert.equal(initial.state, "uninitialized");
  assert.deepEqual(initial.pending, [
    "0000_001_create_migration_history",
    "0000_002_alter_platform_core",
    "0000_003_create_platform_eventing",
    "0000_004_create_platform_audit",
    "0000_005_create_platform_jobs",
  ]);
  const pendingVerify = await runMigrationCommand({
    catalog,
    command: "verify",
    config: config(lifecycleDatabase),
  });
  assert.deepEqual(
    pendingVerify.diagnostics.map((item) => item.code),
    ["MIGRATION_PENDING"],
  );
  await assert.rejects(
    runMigrationCommand({
      catalog,
      command: "apply",
      config: config(lifecycleDatabase),
      confirmTarget: `test:wrong_database`,
    }),
    { code: "MIGRATION_CONFIG_UNSAFE" },
  );
  const applied = await runMigrationCommand({
    catalog,
    command: "apply",
    config: config(lifecycleDatabase),
    confirmTarget: `test:${lifecycleDatabase}`,
  });
  assert.deepEqual(applied.diagnostics, []);
  assert.deepEqual(applied.applied, [
    "0000_001_create_migration_history",
    "0000_002_alter_platform_core",
    "0000_003_create_platform_eventing",
    "0000_004_create_platform_audit",
    "0000_005_create_platform_jobs",
  ]);
  const repeated = await runMigrationCommand({
    catalog,
    command: "apply",
    config: config(lifecycleDatabase),
    confirmTarget: `test:${lifecycleDatabase}`,
  });
  assert.deepEqual(repeated, {
    applied: [],
    command: "apply",
    database: lifecycleDatabase,
    diagnostics: [],
    pending: [],
    state: "current",
  });
  const lifecycleClient = await targetClient(lifecycleDatabase);
  const objects = await lifecycleClient.query(`SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name`);
  assert.deepEqual(objects.rows, [
    { table_name: "migration_history", table_schema: "platform_core" },
  ]);
  assert.equal(
    (
      await lifecycleClient.query(
        "SELECT count(*)::integer AS count FROM platform_core.migration_history",
      )
    ).rows[0].count,
    5,
  );
  assert.deepEqual(await verifyFoundation(lifecycleClient, user), {
    diagnostics: [],
    status: "compliant",
  });
  await lifecycleClient.query(
    `INSERT INTO platform_core.migration_history
      (migration_id, namespace, sequence, relative_path, owner_id, schema_name,
       checksum_sha256, runner_contract_version)
     VALUES ('0000_006_alter_orphan_history', 0, 6,
       'migrations/0000-platform/0000_006_alter_orphan_history.sql',
       'shared-infrastructure/platform-core', 'platform_core', $1, 1)`,
    ["0".repeat(64)],
  );
  await lifecycleClient.end();
  const orphaned = await runMigrationCommand({
    catalog,
    command: "verify",
    config: config(lifecycleDatabase),
  });
  assert.deepEqual(
    orphaned.diagnostics.map((item) => item.code),
    ["MIGRATION_HISTORY_ORPHANED"],
  );

  const lockDatabase = await createDatabase("lock");
  const lockClient = await targetClient(lockDatabase);
  await lockClient.query("SELECT pg_advisory_lock_shared($1, $2)", [...migrationAdvisoryKey]);
  const sharedStatus = await runMigrationCommand({
    catalog,
    command: "status",
    config: config(lockDatabase),
  });
  assert.equal(sharedStatus.state, "uninitialized");
  const busyApply = await runMigrationCommand({
    catalog,
    command: "apply",
    config: config(lockDatabase),
    confirmTarget: `test:${lockDatabase}`,
  });
  assert.deepEqual(
    busyApply.diagnostics.map((item) => item.code),
    ["MIGRATION_LOCK_BUSY"],
  );
  await lockClient.query("SELECT pg_advisory_unlock_shared($1, $2)", [...migrationAdvisoryKey]);
  await lockClient.end();

  const unmanagedDatabase = await createDatabase("unmanaged");
  const unmanagedClient = await targetClient(unmanagedDatabase);
  await unmanagedClient.query("CREATE SCHEMA synthetic_unmanaged");
  await unmanagedClient.end();
  const unmanaged = await runMigrationCommand({
    catalog,
    command: "status",
    config: config(unmanagedDatabase),
  });
  assert.deepEqual(
    unmanaged.diagnostics.map((item) => item.code),
    ["MIGRATION_UNMANAGED_DATABASE"],
  );

  const rollbackDatabase = await createDatabase("rollback");
  const rollbackFixture = await syntheticCatalog(
    "rollback",
    `-- bop-rms-migration: 1
-- owner: shared-infrastructure/platform-core
-- schema: platform_core
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_core.synthetic_rollback_probe (id integer PRIMARY KEY);
SELECT 1 / 0;
`,
  );
  const rollback = await runMigrationCommand({
    catalog: rollbackFixture.catalog,
    command: "apply",
    config: config(rollbackDatabase),
    confirmTarget: `test:${rollbackDatabase}`,
  });
  assert.deepEqual(
    rollback.diagnostics.map((item) => item.code),
    ["MIGRATION_APPLY_FAILED"],
  );
  const rollbackClient = await targetClient(rollbackDatabase);
  const rollbackState = await rollbackClient.query(`SELECT
      to_regclass('platform_core.synthetic_rollback_probe')::text AS probe,
      (SELECT count(*)::integer FROM platform_core.migration_history) AS history_count`);
  assert.deepEqual(rollbackState.rows[0], { history_count: 5, probe: null });
  await rollbackClient.end();

  const orderDatabase = await createDatabase("order");
  const orderFixture = await syntheticCatalog(
    "order",
    `-- bop-rms-migration: 1
-- owner: shared-infrastructure/platform-core
-- schema: platform_core
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_core.synthetic_order_probe (id integer PRIMARY KEY);
`,
  );
  const ordered = await runMigrationCommand({
    catalog: orderFixture.catalog,
    command: "apply",
    config: config(orderDatabase),
    confirmTarget: `test:${orderDatabase}`,
  });
  assert.deepEqual(ordered.diagnostics, []);
  const orderClient = await targetClient(orderDatabase);
  await orderClient.query(
    "DELETE FROM platform_core.migration_history WHERE migration_id = '0000_001_create_migration_history'",
  );
  await orderClient.end();
  const outOfOrder = await runMigrationCommand({
    catalog: orderFixture.catalog,
    command: "verify",
    config: config(orderDatabase),
  });
  assert.deepEqual(
    outOfOrder.diagnostics.map((item) => item.code),
    ["MIGRATION_OUT_OF_ORDER"],
  );

  const driftDatabase = await createDatabase("drift");
  const driftFixture = await syntheticCatalog("drift");
  await runMigrationCommand({
    catalog: driftFixture.catalog,
    command: "apply",
    config: config(driftDatabase),
    confirmTarget: `test:${driftDatabase}`,
  });
  const driftFile = path.join(
    driftFixture.fixtureRoot,
    "migrations",
    "0000-platform",
    "0000_001_create_migration_history.sql",
  );
  await writeFile(
    driftFile,
    (await readFile(driftFile, "utf8")).replace("-- risk: low", "-- risk: medium"),
  );
  const changedCatalog = await readMigrationCatalog(driftFixture.fixtureRoot);
  const drift = await runMigrationCommand({
    catalog: changedCatalog,
    command: "verify",
    config: config(driftDatabase),
  });
  assert.deepEqual(
    drift.diagnostics.map((item) => item.code),
    ["MIGRATION_CHECKSUM_MISMATCH"],
  );

  const cliDatabase = await createDatabase("cli");
  const cliEnv = path.join(temp, "cli.env");
  await writeFile(
    cliEnv,
    (await readFile(composeEnv, "utf8")).replace(
      `BOP_RMS_POSTGRES_DB=${adminDatabase}`,
      `BOP_RMS_POSTGRES_DB=${cliDatabase}`,
    ),
    { mode: 0o600 },
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment.PGPASSWORD;
  const cli = path.join(root, "packages", "database", "src", "cli.ts");
  const invoke = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: childEnvironment,
    });
  assert.equal(invoke("status", "--env-file", cliEnv).status, 0);
  assert.equal(invoke("verify", "--env-file", cliEnv).status, 1);
  assert.equal(
    invoke("apply", "--env-file", cliEnv, "--confirm-target", `test:${cliDatabase}`, "--json")
      .status,
    0,
  );
  const cliVerify = invoke("verify", "--env-file", cliEnv, "--json");
  assert.equal(cliVerify.status, 0);
  assert.equal(JSON.parse(cliVerify.stdout).state, "current");

  const foundationCli = path.join(root, "packages", "database", "src", "foundation-cli.ts");
  const foundationInvoke = (...args) =>
    spawnSync(process.execPath, [foundationCli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: childEnvironment,
    });
  const foundationCompliant = foundationInvoke("--env-file", cliEnv, "--json");
  assert.equal(foundationCompliant.status, 0);
  assert.deepEqual(JSON.parse(foundationCompliant.stdout), {
    diagnostics: [],
    status: "compliant",
  });

  const violationClient = await targetClient(cliDatabase);
  await violationClient.query("GRANT USAGE ON SCHEMA platform_core TO PUBLIC");
  await violationClient.query(
    'CREATE COLLATION platform_audit.synthetic_unexpected FROM pg_catalog."C"',
  );
  await violationClient.query("CREATE TABLE platform_eventing.synthetic_unexpected (id integer)");
  await violationClient.query("CREATE SCHEMA platform_projection AUTHORIZATION CURRENT_USER");
  await violationClient.end();
  const foundationViolation = foundationInvoke("--env-file", cliEnv, "--json");
  assert.equal(foundationViolation.status, 1);
  assert.deepEqual(
    JSON.parse(foundationViolation.stderr).diagnostics.map((item) => item.code),
    [
      "FOUNDATION_OBJECT_UNEXPECTED",
      "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE",
      "FOUNDATION_OBJECT_UNEXPECTED",
      "FOUNDATION_SCHEMA_UNEXPECTED",
    ],
  );

  const wrongSecret = path.join(temp, "wrong-password");
  await writeFile(wrongSecret, "wp0021-secret-must-not-leak", { mode: 0o600 });
  const wrongEnv = path.join(temp, "wrong.env");
  await writeFile(wrongEnv, (await readFile(cliEnv, "utf8")).replace(secret, wrongSecret), {
    mode: 0o600,
  });
  const rejected = invoke("status", "--env-file", wrongEnv, "--json");
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stderr).status, "error");
  assert(!`${rejected.stdout}${rejected.stderr}`.includes("wp0021-secret-must-not-leak"));
  assert(!`${rejected.stdout}${rejected.stderr}`.includes(password));
  assert(!`${rejected.stdout}${rejected.stderr}`.includes("SELECT"));

  const foundationRejected = foundationInvoke("--env-file", wrongEnv, "--json");
  assert.equal(foundationRejected.status, 2);
  assert.equal(JSON.parse(foundationRejected.stderr).status, "error");
  assert.deepEqual(
    JSON.parse(foundationRejected.stderr).diagnostics.map((item) => item.code),
    ["FOUNDATION_CONNECTION_FAILED"],
  );
  assert(
    !`${foundationRejected.stdout}${foundationRejected.stderr}`.includes(
      "wp0021-secret-must-not-leak",
    ),
  );
  assert(!`${foundationRejected.stdout}${foundationRejected.stderr}`.includes(password));
  assert(!`${foundationRejected.stdout}${foundationRejected.stderr}`.includes("SELECT"));

  process.stdout.write(
    "WP-0021 foundation integration passed: schemas, ACL, verifier, no-op, drift, rollback, locks, CLI, redaction, and cleanup\n",
  );
} finally {
  await cleanup();
}
