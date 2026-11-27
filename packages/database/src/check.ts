import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readMigrationCatalog } from "./catalog.ts";
import { formatDiagnostic, MigrationOperationalError } from "./diagnostics.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

try {
  const catalog = await readMigrationCatalog(root);
  if (catalog.diagnostics.length) {
    for (const diagnostic of catalog.diagnostics)
      process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `migration catalog valid: ${catalog.migrations.length} immutable migrations; Canonical namespace registry validated\n`,
    );
  }
} catch (error) {
  const code = error instanceof MigrationOperationalError ? error.code : "MIGRATION_INTERNAL";
  const message =
    error instanceof MigrationOperationalError
      ? error.message
      : "unexpected migration catalog failure";
  process.stderr.write(`Migration Runner error: [${code}] ${message}\n`);
  process.exitCode = 2;
}
