import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  compareDiagnostics,
  type MigrationDiagnostic,
  MigrationOperationalError,
} from "./diagnostics.ts";

const expectedNamespaces = [
  ["0000", "0000-platform"],
  ["0100", "0100-bop-common"],
  ["0200", "0200-bop-identity-tenancy"],
  ["0300", "0300-bop-governance"],
  ["0400", "0400-bop-operations"],
  ["1000", "1000-rms-store"],
  ["1100", "1100-rms-catalog"],
  ["1101", "1101-rms-catalog-category-menu"],
  ["1102", "1102-rms-catalog-option-set"],
  ["1103", "1103-rms-catalog-availability"],
  ["1104", "1104-rms-catalog-menu-publishing"],
  ["1200", "1200-rms-pricing"],
  ["1300", "1300-rms-ordering"],
  ["1400", "1400-rms-payment"],
  ["1500", "1500-rms-kitchen"],
  ["1600", "1600-rms-device"],
  ["1700", "1700-rms-fulfillment"],
  ["1800", "1800-rms-reporting"],
] as const;
const namespaceByDirectory = new Map<string, string>(
  expectedNamespaces.map(([namespace, directory]) => [directory, namespace]),
);
const allowedActions = new Set([
  "create",
  "alter",
  "backfill",
  "contract",
  "index",
  "constraint",
  "seed",
]);
const platformOwners = new Map([
  ["platform_audit", "shared-infrastructure/audit"],
  ["platform_core", "shared-infrastructure/platform-core"],
  ["platform_eventing", "shared-infrastructure/eventing"],
  ["platform_helpers", "shared-infrastructure/helpers"],
  ["platform_jobs", "shared-infrastructure/jobs"],
  ["platform_projection", "shared-infrastructure/projection"],
]);
const businessOwners = new Map([
  ["bop_identity", "@bop/identity"],
  ["bop_membership", "@bop/membership"],
  ["bop_permission", "@bop/permission"],
  ["bop_tenant", "@bop/tenant"],
  ["bop_operating_entity", "@bop/operating-entity"],
  ["rms_catalog", "@rms/catalog"],
]);
const metadataKeys = [
  "bop-rms-migration",
  "owner",
  "schema",
  "phase",
  "risk",
  "transaction",
  "lock-timeout-ms",
  "statement-timeout-ms",
  "recovery",
] as const;
const fileNamePattern = /^(\d{4})_(\d{3})_([a-z]+)_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.sql$/u;
const snakeCase = /^[a-z][a-z0-9_]*$/u;
const ownerPattern = /^[a-z0-9@][a-z0-9@/._-]*$/u;

export interface MigrationMetadata {
  readonly lockTimeoutMs: number;
  readonly owner: string;
  readonly phase: "expand" | "migrate" | "contract";
  readonly recovery: "forward-fix" | "restore";
  readonly risk: "low" | "medium" | "high";
  readonly schema: string;
  readonly statementTimeoutMs: number;
}

export interface MigrationFile {
  readonly checksumSha256: string;
  readonly id: string;
  readonly metadata: MigrationMetadata;
  readonly namespace: number;
  readonly relativePath: string;
  readonly sequence: number;
  readonly sql: string;
}

export interface MigrationCatalog {
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly migrations: readonly MigrationFile[];
}

const diagnostic = (
  code: MigrationDiagnostic["code"],
  file: string,
  message: string,
  line = 1,
  column = 1,
): MigrationDiagnostic => ({ code, column, file: file.replaceAll("\\", "/"), line, message });

async function safeState(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateNamespaceRegistry(value: unknown, diagnostics: MigrationDiagnostic[]): void {
  const file = "migrations/namespaces.json";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(
      diagnostic("MIGRATION_NAMESPACE_UNKNOWN", file, "namespace registry must be an object"),
    );
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "namespaces,version" || record.version !== 1) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_NAMESPACE_UNKNOWN",
        file,
        "namespace registry must use the exact version-1 shape",
      ),
    );
    return;
  }
  if (!Array.isArray(record.namespaces) || record.namespaces.length !== expectedNamespaces.length) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_NAMESPACE_UNKNOWN",
        file,
        "namespace registry does not contain the closed namespace set",
      ),
    );
    return;
  }
  const actual = record.namespaces.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [null, null];
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "directory,namespace") return [null, null];
    return [entry.namespace, entry.directory];
  });
  if (JSON.stringify(actual) !== JSON.stringify(expectedNamespaces))
    diagnostics.push(
      diagnostic(
        "MIGRATION_NAMESPACE_UNKNOWN",
        file,
        "namespace registry differs from the Canonical ordered set",
      ),
    );
}

function parsePositiveInteger(
  raw: string,
  maximum: number,
  file: string,
  line: number,
  diagnostics: MigrationDiagnostic[],
): number | null {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    diagnostics.push(
      diagnostic("MIGRATION_METADATA_INVALID", file, "timeout must be a positive integer", line),
    );
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (value > maximum) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_METADATA_INVALID",
        file,
        `timeout exceeds the ${maximum}ms bound`,
        line,
      ),
    );
    return null;
  }
  return value;
}

function validateSql(
  sql: string,
  file: string,
  metadata: MigrationMetadata,
  diagnostics: MigrationDiagnostic[],
): void {
  const body = sql.split("\n").slice(metadataKeys.length).join("\n");
  const unsupported = [
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/iu,
    /\bDROP\s+INDEX\s+CONCURRENTLY\b/iu,
    /\bREINDEX\s+(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)?\s*CONCURRENTLY\b/iu,
    /\bREFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\b/iu,
    /\bSET\s+ROLE\b/iu,
    /\bSET\s+SESSION\s+AUTHORIZATION\b/iu,
    /\b(?:VACUUM|ALTER\s+SYSTEM)\b/iu,
    /^\s*\\/mu,
  ];
  if (unsupported.some((pattern) => pattern.test(body)))
    diagnostics.push(
      diagnostic(
        "MIGRATION_TRANSACTION_UNSUPPORTED",
        file,
        "migration contains transaction-prohibited or runner-owned SQL",
        metadataKeys.length + 1,
      ),
    );
  const withoutFunctionBodies = body.replace(
    /\bCREATE\s+FUNCTION\b[\s\S]*?\bAS\s+(\$[A-Za-z0-9_]*\$)[\s\S]*?\1\s*;/giu,
    "CREATE FUNCTION AS $$function-body$$;",
  );
  if (
    /\b(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT)\b/iu.test(
      withoutFunctionBodies,
    )
  )
    diagnostics.push(
      diagnostic(
        "MIGRATION_TRANSACTION_UNSUPPORTED",
        file,
        "migration contains transaction-prohibited or runner-owned SQL",
        metadataKeys.length + 1,
      ),
    );
  for (const match of body.matchAll(/\bSET\s+(?:LOCAL\s+|SESSION\s+)?search_path\b[^\n;]*/giu)) {
    const statement = match[0].trim();
    const currentStatement = body.slice(body.lastIndexOf(";", match.index) + 1, match.index);
    const acceptedFunctionSetting =
      statement === "SET search_path = pg_catalog" &&
      /\bCREATE\s+FUNCTION\b/iu.test(currentStatement);
    if (!acceptedFunctionSetting)
      diagnostics.push(
        diagnostic(
          "MIGRATION_TRANSACTION_UNSUPPORTED",
          file,
          "migration contains transaction-prohibited or runner-owned SQL",
          metadataKeys.length + 1,
        ),
      );
  }
  if (/\b(?:CREATE|ALTER|DROP)\s+(?:DATABASE|ROLE|USER|TABLESPACE|EXTENSION)\b/iu.test(body))
    diagnostics.push(
      diagnostic(
        "MIGRATION_METADATA_INVALID",
        file,
        "database, role, tablespace, and extension DDL is outside the migration contract",
        metadataKeys.length + 1,
      ),
    );
  if (/\$\{|\{\{|(?<!:):[A-Za-z][A-Za-z0-9_]*/u.test(body))
    diagnostics.push(
      diagnostic(
        "MIGRATION_METADATA_INVALID",
        file,
        "migration SQL must not contain template substitution",
        metadataKeys.length + 1,
      ),
    );
  const qualifiedTargets = [
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([^\s(;,]+)/giu,
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+[^\s]+\s+ON\s+([^\s(;,]+)/giu,
    /\b(?:ALTER|DROP)\s+INDEX\s+(?:IF\s+EXISTS\s+)?([^\s(;,]+)/giu,
    /\b(?:CREATE|ALTER|DROP)\s+SEQUENCE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([^\s(;,]+)/giu,
  ];
  for (const pattern of qualifiedTargets)
    for (const match of body.matchAll(pattern))
      if (!(match[1] ?? "").replaceAll('"', "").startsWith(`${metadata.schema}.`))
        diagnostics.push(
          diagnostic(
            "MIGRATION_SCHEMA_MISMATCH",
            file,
            "DDL target must be fully qualified by the declared schema",
            metadataKeys.length + 1,
          ),
        );
  const acceptedForeignReferences = new Set([
    "platform_helpers.current_brand_id",
    "platform_helpers.current_store_id",
    "platform_helpers.uuid_v7",
  ]);
  for (const match of body.matchAll(/\b((?:platform|bop|rms)_[a-z0-9_]+)\s*\.([a-z][a-z0-9_]*)/gu))
    if (
      match[1] !== metadata.schema &&
      !(
        [
          "platform_audit",
          "platform_eventing",
          "bop_identity",
          "bop_membership",
          "bop_permission",
          "bop_tenant",
          "bop_operating_entity",
          "rms_catalog",
        ].includes(metadata.schema) && acceptedForeignReferences.has(`${match[1]}.${match[2]}`)
      )
    )
      diagnostics.push(
        diagnostic(
          "MIGRATION_SCHEMA_MISMATCH",
          file,
          `SQL references foreign schema ${match[1]}`,
          metadataKeys.length + 1,
        ),
      );
  for (const match of body.matchAll(
    /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\b/giu,
  ))
    if (match[1] !== metadata.schema)
      diagnostics.push(
        diagnostic(
          "MIGRATION_SCHEMA_MISMATCH",
          file,
          `SQL creates foreign schema ${match[1]}`,
          metadataKeys.length + 1,
        ),
      );
}

function parseMigration(
  bytes: Buffer,
  relativePath: string,
  directoryNamespace: string,
  diagnostics: MigrationDiagnostic[],
): MigrationFile | null {
  const fileName = path.posix.basename(relativePath);
  const match = fileNamePattern.exec(fileName);
  if (!match || match[1] !== directoryNamespace || !allowedActions.has(match[3] ?? "")) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_FILENAME_INVALID",
        relativePath,
        "migration filename does not match its namespace and closed grammar",
      ),
    );
    return null;
  }
  const sequence = Number.parseInt(match[2] ?? "0", 10);
  if (sequence < 1 || sequence > 999) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_FILENAME_INVALID",
        relativePath,
        "migration sequence must be 001 through 999",
      ),
    );
    return null;
  }
  if (
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    bytes.includes(0x0d) ||
    bytes.at(-1) !== 0x0a
  ) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_METADATA_INVALID",
        relativePath,
        "migration must be UTF-8 without BOM, LF-only, and final-newline terminated",
      ),
    );
    return null;
  }
  let sql: string;
  try {
    sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push(
      diagnostic("MIGRATION_METADATA_INVALID", relativePath, "migration is not valid UTF-8"),
    );
    return null;
  }
  const lines = sql.split("\n");
  const values = new Map<string, string>();
  for (const [index, key] of metadataKeys.entries()) {
    const header = /^-- ([a-z-]+): (.+)$/u.exec(lines[index] ?? "");
    if (!header || header[1] !== key) {
      diagnostics.push(
        diagnostic(
          "MIGRATION_METADATA_INVALID",
          relativePath,
          `expected ordered metadata field ${key}`,
          index + 1,
        ),
      );
      return null;
    }
    values.set(key, header[2] ?? "");
  }
  const owner = values.get("owner") ?? "";
  const schema = values.get("schema") ?? "";
  const phase = values.get("phase") ?? "";
  const risk = values.get("risk") ?? "";
  const recovery = values.get("recovery") ?? "";
  const lockTimeoutMs = parsePositiveInteger(
    values.get("lock-timeout-ms") ?? "",
    60_000,
    relativePath,
    7,
    diagnostics,
  );
  const statementTimeoutMs = parsePositiveInteger(
    values.get("statement-timeout-ms") ?? "",
    900_000,
    relativePath,
    8,
    diagnostics,
  );
  if (
    values.get("bop-rms-migration") !== "1" ||
    !ownerPattern.test(owner) ||
    !snakeCase.test(schema) ||
    !["expand", "migrate", "contract"].includes(phase) ||
    !["low", "medium", "high"].includes(risk) ||
    values.get("transaction") !== "required" ||
    !["forward-fix", "restore"].includes(recovery) ||
    lockTimeoutMs === null ||
    statementTimeoutMs === null
  ) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_METADATA_INVALID",
        relativePath,
        "migration metadata contains an invalid closed value",
      ),
    );
    return null;
  }
  const expectedOwner = platformOwners.get(schema) ?? businessOwners.get(schema);
  if (schema === "public" || !expectedOwner) {
    diagnostics.push(
      diagnostic(
        "MIGRATION_OWNER_MISMATCH",
        relativePath,
        "business or public migrations require their separately authorized persistence contract",
        2,
      ),
    );
    return null;
  }
  if (expectedOwner !== owner)
    diagnostics.push(
      diagnostic(
        "MIGRATION_OWNER_MISMATCH",
        relativePath,
        `owner does not match the platform registry for ${schema}`,
        2,
      ),
    );
  const metadata: MigrationMetadata = {
    lockTimeoutMs,
    owner,
    phase: phase as MigrationMetadata["phase"],
    recovery: recovery as MigrationMetadata["recovery"],
    risk: risk as MigrationMetadata["risk"],
    schema,
    statementTimeoutMs,
  };
  validateSql(sql, relativePath, metadata, diagnostics);
  return {
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    id: fileName.slice(0, -4),
    metadata,
    namespace: Number.parseInt(directoryNamespace, 10),
    relativePath,
    sequence,
    sql,
  };
}

export async function readMigrationCatalog(root: string): Promise<MigrationCatalog> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new MigrationOperationalError(
      "MIGRATION_ROOT_UNREADABLE",
      "repository root is not readable",
    );
  }
  const migrationsRoot = path.join(canonicalRoot, "migrations");
  const diagnostics: MigrationDiagnostic[] = [];
  const migrations: MigrationFile[] = [];
  const rootState = await safeState(migrationsRoot);
  if (rootState?.isSymbolicLink()) {
    diagnostics.push(
      diagnostic("SYMLINK_PATH", "migrations", "migration catalog must not be symbolic"),
    );
    return { diagnostics, migrations };
  }
  if (!rootState?.isDirectory()) {
    diagnostics.push(
      diagnostic("MIGRATION_BOOTSTRAP_MISSING", "migrations", "root migration catalog is missing"),
    );
    return { diagnostics, migrations };
  }
  const registryPath = path.join(migrationsRoot, "namespaces.json");
  try {
    if ((await lstat(registryPath)).isSymbolicLink())
      diagnostics.push(
        diagnostic(
          "SYMLINK_PATH",
          "migrations/namespaces.json",
          "namespace registry must not be symbolic",
        ),
      );
    else validateNamespaceRegistry(JSON.parse(await readFile(registryPath, "utf8")), diagnostics);
  } catch {
    diagnostics.push(
      diagnostic(
        "MIGRATION_NAMESPACE_UNKNOWN",
        "migrations/namespaces.json",
        "namespace registry is missing, unreadable, or invalid JSON",
      ),
    );
  }
  const entries = (await readdir(migrationsRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const previous = folded.get(lower);
    if (previous && previous !== entry.name)
      diagnostics.push(
        diagnostic(
          "CASE_CONFLICT",
          `migrations/${entry.name}`,
          `catalog entry conflicts with ${previous}`,
        ),
      );
    folded.set(lower, entry.name);
    if (entry.name === "namespaces.json") continue;
    const directoryNamespace = namespaceByDirectory.get(entry.name);
    if (entry.isSymbolicLink()) {
      diagnostics.push(
        diagnostic(
          "SYMLINK_PATH",
          `migrations/${entry.name}`,
          "namespace directory must not be symbolic",
        ),
      );
      continue;
    }
    if (!directoryNamespace || !entry.isDirectory()) {
      diagnostics.push(
        diagnostic(
          "MIGRATION_NAMESPACE_UNKNOWN",
          `migrations/${entry.name}`,
          "catalog entry is not a closed namespace directory",
        ),
      );
      continue;
    }
    const directory = path.join(migrationsRoot, entry.name);
    const foldedChildren = new Map<string, string>();
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    )) {
      const relativePath = `migrations/${entry.name}/${child.name}`;
      const childLower = child.name.toLowerCase();
      const previousChild = foldedChildren.get(childLower);
      if (previousChild && previousChild !== child.name)
        diagnostics.push(
          diagnostic(
            "CASE_CONFLICT",
            relativePath,
            `migration filename conflicts with ${previousChild}`,
          ),
        );
      foldedChildren.set(childLower, child.name);
      if (child.isSymbolicLink()) {
        diagnostics.push(
          diagnostic("SYMLINK_PATH", relativePath, "migration file must not be symbolic"),
        );
        continue;
      }
      if (!child.isFile() || path.extname(child.name) !== ".sql") {
        diagnostics.push(
          diagnostic(
            "MIGRATION_FILENAME_INVALID",
            relativePath,
            "namespace entries must be .sql files",
          ),
        );
        continue;
      }
      try {
        const target = path.join(directory, child.name);
        const resolved = await realpath(target);
        if (!resolved.startsWith(`${migrationsRoot}${path.sep}`)) {
          diagnostics.push(
            diagnostic("PATH_ESCAPE", relativePath, "migration resolves outside the root catalog"),
          );
          continue;
        }
        const migration = parseMigration(
          await readFile(target),
          relativePath,
          directoryNamespace,
          diagnostics,
        );
        if (migration) migrations.push(migration);
      } catch {
        diagnostics.push(
          diagnostic("UNREADABLE_MIGRATION", relativePath, "migration file is unreadable"),
        );
      }
    }
  }
  migrations.sort(
    (left, right) =>
      left.namespace - right.namespace ||
      left.sequence - right.sequence ||
      left.relativePath.localeCompare(right.relativePath, "en"),
  );
  const orders = new Map<string, string>();
  for (const migration of migrations) {
    const order = `${migration.namespace}:${migration.sequence}`;
    const previous = orders.get(order);
    if (previous)
      diagnostics.push(
        diagnostic(
          "MIGRATION_DUPLICATE_ORDER",
          migration.relativePath,
          `migration order duplicates ${previous}`,
        ),
      );
    else orders.set(order, migration.relativePath);
  }
  const bootstrap = migrations[0];
  if (
    !bootstrap ||
    bootstrap.id !== "0000_001_create_migration_history" ||
    bootstrap.relativePath !== "migrations/0000-platform/0000_001_create_migration_history.sql" ||
    bootstrap.metadata.owner !== "shared-infrastructure/platform-core" ||
    bootstrap.metadata.schema !== "platform_core"
  )
    diagnostics.push(
      diagnostic(
        "MIGRATION_BOOTSTRAP_MISSING",
        "migrations/0000-platform/0000_001_create_migration_history.sql",
        "the exact first migration-history bootstrap is required",
      ),
    );
  diagnostics.sort(compareDiagnostics);
  return { diagnostics, migrations };
}

export const canonicalMigrationNamespaces = expectedNamespaces;
