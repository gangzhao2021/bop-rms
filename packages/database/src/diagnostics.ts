export const migrationDiagnosticCodes = [
  "MIGRATION_NAMESPACE_UNKNOWN",
  "MIGRATION_FILENAME_INVALID",
  "MIGRATION_METADATA_INVALID",
  "MIGRATION_DUPLICATE_ORDER",
  "MIGRATION_OWNER_MISMATCH",
  "MIGRATION_SCHEMA_MISMATCH",
  "CASE_CONFLICT",
  "PATH_ESCAPE",
  "SYMLINK_PATH",
  "UNREADABLE_MIGRATION",
  "MIGRATION_BOOTSTRAP_MISSING",
  "MIGRATION_UNMANAGED_DATABASE",
  "MIGRATION_CHECKSUM_MISMATCH",
  "MIGRATION_HISTORY_ORPHANED",
  "MIGRATION_OUT_OF_ORDER",
  "MIGRATION_PENDING",
  "MIGRATION_LOCK_BUSY",
  "MIGRATION_TRANSACTION_UNSUPPORTED",
  "MIGRATION_APPLY_FAILED",
  "MIGRATION_USAGE",
  "MIGRATION_ROOT_UNREADABLE",
  "MIGRATION_CONFIG_UNSAFE",
  "MIGRATION_CONNECTION_FAILED",
  "MIGRATION_CONNECTION_LOST",
  "MIGRATION_INTERNAL",
] as const;

export type MigrationDiagnosticCode = (typeof migrationDiagnosticCodes)[number];

export interface MigrationDiagnostic {
  readonly code: MigrationDiagnosticCode;
  readonly column?: number;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
  readonly migrationId?: string;
}

export function compareDiagnostics(left: MigrationDiagnostic, right: MigrationDiagnostic): number {
  const pathCompare = (left.file ?? left.migrationId ?? "").localeCompare(
    right.file ?? right.migrationId ?? "",
    "en",
  );
  if (pathCompare !== 0) return pathCompare;
  const lineCompare = (left.line ?? 0) - (right.line ?? 0);
  if (lineCompare !== 0) return lineCompare;
  const columnCompare = (left.column ?? 0) - (right.column ?? 0);
  if (columnCompare !== 0) return columnCompare;
  const codeCompare = left.code.localeCompare(right.code, "en");
  return codeCompare !== 0 ? codeCompare : left.message.localeCompare(right.message, "en");
}

export function formatDiagnostic(diagnostic: MigrationDiagnostic): string {
  if (diagnostic.file)
    return `${diagnostic.file}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1} [${diagnostic.code}] ${diagnostic.message}`;
  if (diagnostic.migrationId)
    return `migration:${diagnostic.migrationId} [${diagnostic.code}] ${diagnostic.message}`;
  return `Migration Runner error: [${diagnostic.code}] ${diagnostic.message}`;
}

export class MigrationOperationalError extends Error {
  readonly code: MigrationDiagnosticCode;

  constructor(code: MigrationDiagnosticCode, message: string) {
    super(message);
    this.code = code;
  }
}
