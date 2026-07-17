import pg, { type Client as PgClient, type ClientConfig } from "pg";
import { type MigrationCatalog, type MigrationFile } from "./catalog.ts";
import {
  compareDiagnostics,
  type MigrationDiagnostic,
  MigrationOperationalError,
} from "./diagnostics.ts";
import { type MigrationConnectionConfig } from "./config.ts";

const { Client } = pg;
const advisoryKey = [1_112_494_162, 1_296_648_018] as const;

interface HistoryRow {
  readonly checksum_sha256: string;
  readonly migration_id: string;
  readonly namespace: number;
  readonly owner_id: string;
  readonly relative_path: string;
  readonly runner_contract_version: number;
  readonly schema_name: string;
  readonly sequence: number;
}

export type MigrationCommand = "status" | "verify" | "apply";
export type MigrationDatabaseState = "uninitialized" | "current" | "pending" | "drift";

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly command: MigrationCommand;
  readonly database: string;
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly pending: readonly string[];
  readonly state: MigrationDatabaseState;
}

function pgCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

function safeSqlState(error: unknown): string {
  const code = pgCode(error);
  return code ? `SQLSTATE class ${code.slice(0, 2)}` : "unclassified database error";
}

function isConnectionLoss(error: unknown): boolean {
  const code = pgCode(error);
  return code?.startsWith("08") === true || ["57P01", "57P02", "57P03"].includes(code ?? "");
}

async function connect(config: MigrationConnectionConfig): Promise<PgClient> {
  const clientConfig: ClientConfig = {
    application_name: "bop-rms-migration-runner",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new MigrationOperationalError(
      "MIGRATION_CONNECTION_FAILED",
      "PostgreSQL connection failed",
    );
  }
}

async function verifyTarget(client: PgClient, config: MigrationConnectionConfig): Promise<void> {
  try {
    const identity = await client.query<{
      database: string;
      date_style: string;
      encoding: string;
      role: string;
      server_version: string;
      timezone: string;
    }>(`SELECT current_database() AS database,
              current_user AS role,
              current_setting('server_version_num') AS server_version,
              current_setting('server_encoding') AS encoding,
              current_setting('TimeZone') AS timezone,
              current_setting('DateStyle') AS date_style`);
    const row = identity.rows[0];
    const locale = await client.query<{ datcollate: string; datctype: string }>(
      "SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()",
    );
    const databaseLocale = locale.rows[0];
    if (
      !row ||
      row.database !== config.database ||
      row.role !== config.user ||
      row.server_version !== "180004" ||
      row.encoding !== "UTF8" ||
      row.timezone !== "UTC" ||
      row.date_style !== "ISO, YMD" ||
      !databaseLocale ||
      databaseLocale.datcollate !== "C" ||
      databaseLocale.datctype !== "C"
    )
      throw new MigrationOperationalError(
        "MIGRATION_CONFIG_UNSAFE",
        "PostgreSQL target identity or initialization does not match the accepted baseline",
      );
  } catch (error) {
    if (error instanceof MigrationOperationalError) throw error;
    throw new MigrationOperationalError(
      "MIGRATION_CONNECTION_FAILED",
      "PostgreSQL target verification failed",
    );
  }
}

async function acquireLock(client: PgClient, command: MigrationCommand): Promise<boolean> {
  const fn = command === "apply" ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared";
  const result = await client.query<{ acquired: boolean }>(`SELECT ${fn}($1, $2) AS acquired`, [
    ...advisoryKey,
  ]);
  return result.rows[0]?.acquired === true;
}

async function releaseLock(client: PgClient, command: MigrationCommand): Promise<void> {
  const fn = command === "apply" ? "pg_advisory_unlock" : "pg_advisory_unlock_shared";
  await client.query(`SELECT ${fn}($1, $2)`, [...advisoryKey]);
}

async function historyExists(client: PgClient): Promise<boolean> {
  const result = await client.query<{ history: string | null }>(
    "SELECT to_regclass('platform_core.migration_history')::text AS history",
  );
  return result.rows[0]?.history === "platform_core.migration_history";
}

async function emptyDatabaseIsSafe(client: PgClient): Promise<boolean> {
  const schemas = await client.query<{ name: string }>(`SELECT nspname AS name
      FROM pg_namespace
      WHERE nspname NOT LIKE 'pg_%'
        AND nspname NOT IN ('information_schema', 'public')
      ORDER BY nspname`);
  const publicRelations = await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM pg_class AS object
      JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'public'
        AND object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  const publicRoutines = await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'`);
  const publicTypes = await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM pg_type AS type_record
      JOIN pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
      WHERE namespace.nspname = 'public'`);
  const publicExtensions = await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM pg_extension AS extension_record
      JOIN pg_namespace AS namespace ON namespace.oid = extension_record.extnamespace
      WHERE namespace.nspname = 'public'`);
  return (
    schemas.rowCount === 0 &&
    publicRelations.rows[0]?.count === "0" &&
    publicRoutines.rows[0]?.count === "0" &&
    publicTypes.rows[0]?.count === "0" &&
    publicExtensions.rows[0]?.count === "0"
  );
}

async function validHistoryShape(client: PgClient, configuredUser: string): Promise<boolean> {
  const owner = await client.query<{ schema_owner: string; table_owner: string }>(`SELECT
      pg_get_userbyid(namespace.nspowner) AS schema_owner,
      pg_get_userbyid(relation.relowner) AS table_owner
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'platform_core'
      AND relation.relname = 'migration_history'
      AND relation.relkind = 'r'`);
  if (
    owner.rows[0]?.schema_owner !== configuredUser ||
    owner.rows[0]?.table_owner !== configuredUser
  )
    return false;
  const columns = await client.query<{
    character_maximum_length: number | null;
    column_default: string | null;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
  }>(`SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
      FROM information_schema.columns
      WHERE table_schema = 'platform_core' AND table_name = 'migration_history'
      ORDER BY ordinal_position`);
  const actualColumns = columns.rows.map((column) => [
    column.column_name,
    column.data_type,
    column.is_nullable,
    column.character_maximum_length,
  ]);
  const expectedColumns = [
    ["migration_id", "text", "NO", null],
    ["namespace", "integer", "NO", null],
    ["sequence", "integer", "NO", null],
    ["relative_path", "text", "NO", null],
    ["owner_id", "text", "NO", null],
    ["schema_name", "text", "NO", null],
    ["checksum_sha256", "character", "NO", 64],
    ["runner_contract_version", "integer", "NO", null],
    ["applied_at", "timestamp with time zone", "NO", null],
  ];
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) return false;
  if (!columns.rows[8]?.column_default?.includes("statement_timestamp()")) return false;
  const constraints = await client.query<{
    definition: string;
  }>(`SELECT pg_get_constraintdef(constraint_record.oid) AS definition
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'platform_core' AND relation.relname = 'migration_history'
      ORDER BY definition`);
  const definitions = new Set(constraints.rows.map((row) => row.definition));
  return (
    definitions.has("PRIMARY KEY (migration_id)") &&
    definitions.has("UNIQUE (relative_path)") &&
    definitions.has("UNIQUE (namespace, sequence)")
  );
}

async function readHistory(client: PgClient): Promise<readonly HistoryRow[]> {
  const result =
    await client.query<HistoryRow>(`SELECT migration_id, namespace, sequence, relative_path,
      owner_id, schema_name, checksum_sha256::text, runner_contract_version
    FROM platform_core.migration_history
    ORDER BY namespace, sequence, migration_id`);
  return result.rows;
}

function compareState(
  catalog: MigrationCatalog,
  history: readonly HistoryRow[],
): { diagnostics: MigrationDiagnostic[]; pending: MigrationFile[] } {
  const diagnostics: MigrationDiagnostic[] = [];
  const byId = new Map(catalog.migrations.map((migration) => [migration.id, migration]));
  const applied = new Set<string>();
  let highWater = -1;
  for (const row of history) {
    const migration = byId.get(row.migration_id);
    if (!migration) {
      diagnostics.push({
        code: "MIGRATION_HISTORY_ORPHANED",
        message: "history row has no catalog migration",
        migrationId: row.migration_id,
      });
      continue;
    }
    applied.add(migration.id);
    highWater = Math.max(highWater, catalog.migrations.indexOf(migration));
    if (row.checksum_sha256 !== migration.checksumSha256)
      diagnostics.push({
        code: "MIGRATION_CHECKSUM_MISMATCH",
        message: "applied checksum differs from exact catalog bytes",
        migrationId: migration.id,
      });
    if (row.relative_path !== migration.relativePath || row.runner_contract_version !== 1)
      diagnostics.push({
        code: "MIGRATION_HISTORY_ORPHANED",
        message: "history identity differs from the catalog",
        migrationId: migration.id,
      });
    if (row.owner_id !== migration.metadata.owner)
      diagnostics.push({
        code: "MIGRATION_OWNER_MISMATCH",
        message: "history owner differs from migration metadata",
        migrationId: migration.id,
      });
    if (row.schema_name !== migration.metadata.schema)
      diagnostics.push({
        code: "MIGRATION_SCHEMA_MISMATCH",
        message: "history schema differs from migration metadata",
        migrationId: migration.id,
      });
    if (row.namespace !== migration.namespace || row.sequence !== migration.sequence)
      diagnostics.push({
        code: "MIGRATION_OUT_OF_ORDER",
        message: "history order differs from the catalog",
        migrationId: migration.id,
      });
  }
  for (let index = 0; index <= highWater; index += 1) {
    const migration = catalog.migrations[index];
    if (migration && !applied.has(migration.id))
      diagnostics.push({
        code: "MIGRATION_OUT_OF_ORDER",
        message: "pending migration exists below the applied high-water mark",
        migrationId: migration.id,
      });
  }
  const pending = catalog.migrations.filter((migration) => !applied.has(migration.id));
  diagnostics.sort(compareDiagnostics);
  return { diagnostics, pending };
}

async function applyOne(client: PgClient, migration: MigrationFile): Promise<void> {
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    await client.query(`SET LOCAL lock_timeout = '${migration.metadata.lockTimeoutMs}ms'`);
    await client.query(
      `SET LOCAL statement_timeout = '${migration.metadata.statementTimeoutMs}ms'`,
    );
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = '${migration.metadata.statementTimeoutMs}ms'`,
    );
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO platform_core.migration_history
        (migration_id, namespace, sequence, relative_path, owner_id, schema_name,
         checksum_sha256, runner_contract_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [
        migration.id,
        migration.namespace,
        migration.sequence,
        migration.relativePath,
        migration.metadata.owner,
        migration.metadata.schema,
        migration.checksumSha256,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    if (isConnectionLoss(error))
      throw new MigrationOperationalError(
        "MIGRATION_CONNECTION_LOST",
        "PostgreSQL connection was lost and commit state must be verified",
      );
    throw new MigrationApplyError(migration.id, safeSqlState(error));
  }
}

class MigrationApplyError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, safeDetail: string) {
    super(safeDetail);
    this.migrationId = migrationId;
  }
}

export async function runMigrationCommand(options: {
  readonly catalog: MigrationCatalog;
  readonly command: MigrationCommand;
  readonly config: MigrationConnectionConfig;
  readonly confirmTarget?: string;
}): Promise<MigrationRunResult> {
  const { catalog, command, config } = options;
  if (catalog.diagnostics.length)
    return {
      applied: [],
      command,
      database: config.database,
      diagnostics: catalog.diagnostics,
      pending: catalog.migrations.map((migration) => migration.id),
      state: "drift",
    };
  if (command === "apply" && options.confirmTarget !== `${config.environment}:${config.database}`)
    throw new MigrationOperationalError(
      "MIGRATION_CONFIG_UNSAFE",
      "apply target confirmation does not match the configured environment and database",
    );
  const client = await connect(config);
  let locked = false;
  try {
    await verifyTarget(client, config);
    locked = await acquireLock(client, command);
    if (!locked)
      return {
        applied: [],
        command,
        database: config.database,
        diagnostics: [
          {
            code: "MIGRATION_LOCK_BUSY",
            message: "another migration command owns the advisory lock",
          },
        ],
        pending: [],
        state: "drift",
      };
    const initialized = await historyExists(client);
    if (!initialized && !(await emptyDatabaseIsSafe(client)))
      return {
        applied: [],
        command,
        database: config.database,
        diagnostics: [
          {
            code: "MIGRATION_UNMANAGED_DATABASE",
            message: "database contains unmanaged user objects",
          },
        ],
        pending: catalog.migrations.map((migration) => migration.id),
        state: "drift",
      };
    if (initialized && !(await validHistoryShape(client, config.user)))
      return {
        applied: [],
        command,
        database: config.database,
        diagnostics: [
          {
            code: "MIGRATION_UNMANAGED_DATABASE",
            message: "migration history control plane has an unexpected shape or owner",
          },
        ],
        pending: [],
        state: "drift",
      };
    const history = initialized ? await readHistory(client) : [];
    const comparison = compareState(catalog, history);
    if (comparison.diagnostics.length)
      return {
        applied: [],
        command,
        database: config.database,
        diagnostics: comparison.diagnostics,
        pending: comparison.pending.map((migration) => migration.id),
        state: "drift",
      };
    if (command === "status")
      return {
        applied: history.map((row) => row.migration_id),
        command,
        database: config.database,
        diagnostics: [],
        pending: comparison.pending.map((migration) => migration.id),
        state: initialized ? (comparison.pending.length ? "pending" : "current") : "uninitialized",
      };
    if (command === "verify" && comparison.pending.length)
      return {
        applied: history.map((row) => row.migration_id),
        command,
        database: config.database,
        diagnostics: [
          { code: "MIGRATION_PENDING", message: "catalog contains unapplied migrations" },
        ],
        pending: comparison.pending.map((migration) => migration.id),
        state: initialized ? "pending" : "uninitialized",
      };
    if (command === "apply") {
      const applied: string[] = [];
      for (const migration of comparison.pending) {
        try {
          await applyOne(client, migration);
          applied.push(migration.id);
        } catch (error) {
          if (error instanceof MigrationApplyError)
            return {
              applied,
              command,
              database: config.database,
              diagnostics: [
                {
                  code: "MIGRATION_APPLY_FAILED",
                  message: `migration transaction failed (${error.message})`,
                  migrationId: error.migrationId,
                },
              ],
              pending: comparison.pending
                .filter((item) => !applied.includes(item.id))
                .map((item) => item.id),
              state: "pending",
            };
          throw error;
        }
      }
      return {
        applied,
        command,
        database: config.database,
        diagnostics: [],
        pending: [],
        state: "current",
      };
    }
    return {
      applied: history.map((row) => row.migration_id),
      command,
      database: config.database,
      diagnostics: [],
      pending: [],
      state: "current",
    };
  } catch (error) {
    if (error instanceof MigrationOperationalError) throw error;
    if (isConnectionLoss(error))
      throw new MigrationOperationalError(
        "MIGRATION_CONNECTION_LOST",
        "PostgreSQL connection was lost and observed state is uncertain",
      );
    throw new MigrationOperationalError(
      "MIGRATION_CONNECTION_FAILED",
      "PostgreSQL operation failed",
    );
  } finally {
    if (locked) await releaseLock(client, command).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export const migrationAdvisoryKey = advisoryKey;
