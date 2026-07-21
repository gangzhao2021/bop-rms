import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readMigrationCatalog } from "../src/catalog.ts";
import { verifyFoundation } from "../src/foundation.ts";
import { verifyHelpers } from "../src/helpers.ts";
import { migrationAdvisoryKey, runMigrationCommand } from "../src/runner.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
await withIsolatedDatabase({ caseId: "integration", root }, async (isolated) => {
  const { clientConfig, databaseName: lifecycleDatabase, fixtureRoot: temp, runId } = isolated;
  const { password, user } = clientConfig;
  const composeEnv = clientConfig.envFile;
  const controlRoot = path.dirname(composeEnv);
  const secret = path.join(path.dirname(composeEnv), "password");
  const databases = new Set([lifecycleDatabase]);
  const adminDatabase = `bop_rms_test_${runId}_admin`;
  const admin = new Client({ ...clientConfig, database: adminDatabase });
  admin.on("error", (error) => {
    if (error.code !== "57P01" && error.message !== "Connection terminated unexpectedly")
      throw error;
  });
  await admin.connect();

  function identifier(value) {
    assert.match(value, new RegExp(`^bop_rms_test_${runId}_[a-z][a-z0-9_]{0,19}$`, "u"));
    return `"${value}"`;
  }

  function config(database) {
    return { ...clientConfig, database, environment: "test" };
  }

  async function createDatabase(label) {
    const database = `bop_rms_test_${runId}_${label}`;
    identifier(database);
    await admin.query(
      `CREATE DATABASE ${identifier(database)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    databases.add(database);
    return database;
  }

  async function targetClient(database) {
    const client = new Client({ ...clientConfig, database });
    client.on("error", (error) => {
      if (error.code !== "57P01" && error.message !== "Connection terminated unexpectedly")
        throw error;
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
          "0000_010_create_synthetic_rollback_probe.sql",
        ),
        extraSql,
      );
    const catalog = await readMigrationCatalog(fixtureRoot);
    assert.deepEqual(catalog.diagnostics, []);
    return { catalog, fixtureRoot };
  }

  const catalog = await readMigrationCatalog(root);
  assert.deepEqual(catalog.diagnostics, []);
  const initial = await runMigrationCommand({
    catalog,
    command: "status",
    config: config(lifecycleDatabase),
  });
  assert.equal(initial.state, "current");
  assert.deepEqual(initial.pending, []);
  const pendingVerify = await runMigrationCommand({
    catalog,
    command: "verify",
    config: config(lifecycleDatabase),
  });
  assert.deepEqual(pendingVerify.diagnostics, []);
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
  assert.deepEqual(applied.applied, []);
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
    9,
  );
  assert.deepEqual(await verifyFoundation(lifecycleClient, user), {
    diagnostics: [],
    status: "compliant",
  });
  assert.deepEqual(await verifyHelpers(lifecycleClient, user), []);

  const helperBehavior = await lifecycleClient.query(`SELECT
      platform_helpers.is_uuid_v7('01890f47-2f7d-7cc2-98b1-9b4f680a8f11'::uuid) AS uuid_v7_valid,
      platform_helpers.is_uuid_v7('550e8400-e29b-41d4-a716-446655440000'::uuid) AS uuid_v4_invalid,
      platform_helpers.is_iana_time_zone('America/Toronto') AS timezone_valid,
      platform_helpers.is_iana_time_zone('Synthetic/Unknown') AS timezone_invalid,
      '9223372036854775807'::platform_helpers.amount_minor::bigint AS amount_max,
      'CAD'::platform_helpers.currency_code::text AS currency`);
  assert.deepEqual(helperBehavior.rows[0], {
    amount_max: "9223372036854775807",
    currency: "CAD",
    timezone_invalid: false,
    timezone_valid: true,
    uuid_v4_invalid: false,
    uuid_v7_valid: true,
  });
  await assert.rejects(
    lifecycleClient.query("SELECT 'cad'::platform_helpers.currency_code"),
    /currency_code_shape_check/u,
  );
  await lifecycleClient.query("BEGIN");
  await lifecycleClient.query(
    "SELECT set_config('bop.brand_id', '01890f47-2f7d-7cc2-98b1-9b4f680a8f11', true)",
  );
  await lifecycleClient.query(
    "SELECT set_config('bop.store_id', '01890f47-2f7d-7cc2-98b1-9b4f680a8f12', true)",
  );
  assert.deepEqual(
    (
      await lifecycleClient.query(`SELECT
        platform_helpers.current_brand_id()::text AS brand_id,
        platform_helpers.current_store_id()::text AS store_id`)
    ).rows[0],
    {
      brand_id: "01890f47-2f7d-7cc2-98b1-9b4f680a8f11",
      store_id: "01890f47-2f7d-7cc2-98b1-9b4f680a8f12",
    },
  );
  await lifecycleClient.query("ROLLBACK");
  assert.deepEqual(
    (
      await lifecycleClient.query(`SELECT
        platform_helpers.current_brand_id() AS brand_id,
        platform_helpers.current_store_id() AS store_id`)
    ).rows[0],
    { brand_id: null, store_id: null },
  );
  await lifecycleClient.query("BEGIN");
  await lifecycleClient.query("SELECT set_config('bop.brand_id', 'not-a-uuid', true)");
  await assert.rejects(lifecycleClient.query("SELECT platform_helpers.current_brand_id()"));
  await lifecycleClient.query("ROLLBACK");

  await lifecycleClient.query("CREATE SCHEMA wp0023_concurrency AUTHORIZATION CURRENT_USER");
  await lifecycleClient.query(`CREATE TABLE wp0023_concurrency.synthetic_aggregate (
    id uuid PRIMARY KEY,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    created_by_actor_id uuid,
    updated_by_actor_id uuid,
    synthetic_value text NOT NULL
  )`);
  const aggregateId = "01890f47-2f7d-7cc2-98b1-9b4f680a8f21";
  const creatorId = "01890f47-2f7d-7cc2-98b1-9b4f680a8f22";
  const winnerActorId = "01890f47-2f7d-7cc2-98b1-9b4f680a8f23";
  const staleActorId = "01890f47-2f7d-7cc2-98b1-9b4f680a8f24";
  const retryActorId = "01890f47-2f7d-7cc2-98b1-9b4f680a8f25";
  const createdAt = "2026-07-21T16:00:00.000Z";
  const winnerUpdatedAt = "2026-07-21T16:01:00.000Z";
  const staleUpdatedAt = "2026-07-21T16:02:00.000Z";
  const retryUpdatedAt = "2026-07-21T16:03:00.000Z";
  const rolledBackUpdatedAt = "2026-07-21T16:04:00.000Z";
  await lifecycleClient.query(
    `INSERT INTO wp0023_concurrency.synthetic_aggregate
      (id, version, created_at, updated_at, created_by_actor_id, updated_by_actor_id,
       synthetic_value)
     VALUES ($1::uuid, 1, $2::timestamptz, $2::timestamptz, $3::uuid, $3::uuid, $4)`,
    [aggregateId, createdAt, creatorId, "initial"],
  );

  const staleClient = await targetClient(lifecycleDatabase);
  await lifecycleClient.query("SET statement_timeout TO '5s'");
  await lifecycleClient.query("SET lock_timeout TO '5s'");
  await staleClient.query("SET statement_timeout TO '5s'");
  await staleClient.query("SET lock_timeout TO '5s'");
  await lifecycleClient.query("BEGIN");
  await staleClient.query("BEGIN");
  const winnerRead = await lifecycleClient.query(
    "SELECT version FROM wp0023_concurrency.synthetic_aggregate WHERE id = $1::uuid",
    [aggregateId],
  );
  const staleRead = await staleClient.query(
    "SELECT version FROM wp0023_concurrency.synthetic_aggregate WHERE id = $1::uuid",
    [aggregateId],
  );
  assert.equal(typeof winnerRead.rows[0].version, "string");
  assert.equal(typeof staleRead.rows[0].version, "string");
  assert.equal(winnerRead.rows[0].version, "1");
  assert.equal(staleRead.rows[0].version, "1");

  const winnerUpdate = await lifecycleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET synthetic_value = $2,
         version = version + 1,
         updated_at = $3::timestamptz,
         updated_by_actor_id = $4::uuid
     WHERE id = $1::uuid AND version = $5::bigint
     RETURNING version`,
    [aggregateId, "winner", winnerUpdatedAt, winnerActorId, winnerRead.rows[0].version],
  );
  assert.equal(winnerUpdate.rowCount, 1);
  assert.equal(typeof winnerUpdate.rows[0].version, "string");
  assert.equal(winnerUpdate.rows[0].version, "2");
  await lifecycleClient.query("COMMIT");

  const staleUpdate = await staleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET synthetic_value = $2,
         version = version + 1,
         updated_at = $3::timestamptz,
         updated_by_actor_id = $4::uuid
     WHERE id = $1::uuid AND version = $5::bigint
     RETURNING version`,
    [aggregateId, "stale", staleUpdatedAt, staleActorId, staleRead.rows[0].version],
  );
  assert.equal(staleUpdate.rowCount, 0);
  assert.deepEqual(staleUpdate.rows, []);
  await staleClient.query("COMMIT");

  const committedWinner = await staleClient.query(
    `SELECT version,
            synthetic_value,
            created_at = $2::timestamptz AS created_at_unchanged,
            updated_at = $3::timestamptz AS winner_updated_at,
            created_by_actor_id = $4::uuid AS creator_unchanged,
            updated_by_actor_id = $5::uuid AS winner_actor
     FROM wp0023_concurrency.synthetic_aggregate
     WHERE id = $1::uuid`,
    [aggregateId, createdAt, winnerUpdatedAt, creatorId, winnerActorId],
  );
  assert.deepEqual(committedWinner.rows, [
    {
      created_at_unchanged: true,
      creator_unchanged: true,
      synthetic_value: "winner",
      version: "2",
      winner_actor: true,
      winner_updated_at: true,
    },
  ]);

  const retryUpdate = await staleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET synthetic_value = $2,
         version = version + 1,
         updated_at = $3::timestamptz,
         updated_by_actor_id = $4::uuid
     WHERE id = $1::uuid AND version = $5::bigint
     RETURNING version`,
    [aggregateId, "retry", retryUpdatedAt, retryActorId, committedWinner.rows[0].version],
  );
  assert.equal(retryUpdate.rowCount, 1);
  assert.equal(retryUpdate.rows[0].version, "3");
  const duplicateRetry = await staleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET synthetic_value = $2,
         version = version + 1,
         updated_at = $3::timestamptz,
         updated_by_actor_id = $4::uuid
     WHERE id = $1::uuid AND version = $5::bigint
     RETURNING version`,
    [aggregateId, "duplicate-retry", staleUpdatedAt, staleActorId, committedWinner.rows[0].version],
  );
  assert.equal(duplicateRetry.rowCount, 0);
  assert.deepEqual(duplicateRetry.rows, []);

  await staleClient.query("BEGIN");
  const rolledBackUpdate = await staleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET synthetic_value = $2,
         version = version + 1,
         updated_at = $3::timestamptz,
         updated_by_actor_id = $4::uuid
     WHERE id = $1::uuid AND version = $5::bigint
     RETURNING version`,
    [aggregateId, "rolled-back", rolledBackUpdatedAt, staleActorId, retryUpdate.rows[0].version],
  );
  assert.equal(rolledBackUpdate.rowCount, 1);
  assert.equal(rolledBackUpdate.rows[0].version, "4");
  await staleClient.query("ROLLBACK");
  const afterRollback = await staleClient.query(
    `SELECT version,
            synthetic_value,
            updated_at = $2::timestamptz AS retry_updated_at,
            updated_by_actor_id = $3::uuid AS retry_actor
     FROM wp0023_concurrency.synthetic_aggregate
     WHERE id = $1::uuid`,
    [aggregateId, retryUpdatedAt, retryActorId],
  );
  assert.deepEqual(afterRollback.rows, [
    {
      retry_actor: true,
      retry_updated_at: true,
      synthetic_value: "retry",
      version: "3",
    },
  ]);

  const missingUpdate = await staleClient.query(
    `UPDATE wp0023_concurrency.synthetic_aggregate
     SET version = version + 1
     WHERE id = $1::uuid AND version = $2::bigint
     RETURNING version`,
    ["01890f47-2f7d-7cc2-98b1-9b4f680a8fff", afterRollback.rows[0].version],
  );
  assert.equal(missingUpdate.rowCount, 0);
  assert.deepEqual(missingUpdate.rows, []);
  await staleClient.end();
  await lifecycleClient.query("DROP SCHEMA wp0023_concurrency CASCADE");
  assert.equal(
    (
      await lifecycleClient.query(
        "SELECT to_regnamespace('wp0023_concurrency')::text AS schema_name",
      )
    ).rows[0].schema_name,
    null,
  );

  await lifecycleClient.query(
    `INSERT INTO platform_core.migration_history
      (migration_id, namespace, sequence, relative_path, owner_id, schema_name,
       checksum_sha256, runner_contract_version)
     VALUES ('0000_010_alter_orphan_history', 0, 10,
       'migrations/0000-platform/0000_010_alter_orphan_history.sql',
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
  assert.deepEqual(rollbackState.rows[0], { history_count: 9, probe: null });
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
  const cliEnv = path.join(controlRoot, "cli.env");
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
  const cliStatus = invoke("status", "--env-file", cliEnv);
  assert.equal(cliStatus.status, 0, cliStatus.stderr);
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
  const helpersCli = path.join(root, "packages", "database", "src", "helpers-cli.ts");
  const helpersInvoke = (...args) =>
    spawnSync(process.execPath, [helpersCli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: childEnvironment,
    });
  const helpersCompliant = helpersInvoke("--env-file", cliEnv, "--json");
  assert.equal(helpersCompliant.status, 0);
  assert.deepEqual(JSON.parse(helpersCompliant.stdout), {
    diagnostics: [],
    status: "compliant",
  });

  const helperViolationClient = await targetClient(cliDatabase);
  await helperViolationClient.query("GRANT USAGE ON SCHEMA platform_helpers TO PUBLIC");
  await helperViolationClient.end();
  const helpersViolation = helpersInvoke("--env-file", cliEnv, "--json");
  assert.equal(helpersViolation.status, 1);
  assert.deepEqual(
    JSON.parse(helpersViolation.stderr).diagnostics.map((item) => item.code),
    ["HELPER_PUBLIC_PRIVILEGE"],
  );
  const helperRestoreClient = await targetClient(cliDatabase);
  await helperRestoreClient.query("REVOKE ALL ON SCHEMA platform_helpers FROM PUBLIC");
  await helperRestoreClient.end();

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

  const wrongSecret = path.join(controlRoot, "wrong-password");
  await writeFile(wrongSecret, "wp0021-secret-must-not-leak", { mode: 0o600 });
  const wrongEnv = path.join(controlRoot, "wrong.env");
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

  const helpersRejected = helpersInvoke("--env-file", wrongEnv, "--json");
  assert.equal(helpersRejected.status, 2);
  assert.equal(JSON.parse(helpersRejected.stderr).status, "error");
  assert.deepEqual(
    JSON.parse(helpersRejected.stderr).diagnostics.map((item) => item.code),
    ["HELPER_CONNECTION_FAILED"],
  );
  assert(!`${helpersRejected.stdout}${helpersRejected.stderr}`.includes(password));
  assert(!`${helpersRejected.stdout}${helpersRejected.stderr}`.includes("SELECT"));

  for (const database of databases) {
    if (database === lifecycleDatabase) continue;
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
  }
  await admin.end();

  process.stdout.write(
    "WP-0024 isolated database integration passed: migrations, optimistic concurrency, redaction, and owned cleanup\n",
  );
});
