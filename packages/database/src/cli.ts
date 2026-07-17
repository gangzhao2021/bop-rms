import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readMigrationCatalog } from "./catalog.ts";
import { loadMigrationConnectionConfig } from "./config.ts";
import {
  compareDiagnostics,
  formatDiagnostic,
  type MigrationDiagnostic,
  MigrationOperationalError,
} from "./diagnostics.ts";
import { runMigrationCommand, type MigrationCommand, type MigrationRunResult } from "./runner.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const migrationUsage = `BOP-RMS Migration Runner

Usage:
  pnpm db:migrate -- status --env-file <path> [--json]
  pnpm db:migrate -- verify --env-file <path> [--json]
  pnpm db:migrate -- apply --env-file <path> --confirm-target <environment>:<database> [--json]
  pnpm db:migrate -- --help

Commands:
  status  Observe uninitialized, pending, current, or drift state without DDL.
  verify  Require a fully applied, byte-exact, drift-free catalog.
  apply   Apply pending migrations under the accepted advisory-lock contract.

Passwords, DSNs, rollback, repair, baseline, force, and checksum bypass are unsupported.
`;

interface ParsedArguments {
  readonly command: MigrationCommand;
  readonly confirmTarget?: string;
  readonly envFile: string;
  readonly json: boolean;
}

function usageError(message: string): never {
  throw new MigrationOperationalError("MIGRATION_USAGE", message);
}

function parseArguments(args: readonly string[]): ParsedArguments | null {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return null;
  const command = args[0];
  if (command !== "status" && command !== "verify" && command !== "apply")
    usageError("expected status, verify, apply, or --help");
  let envFile: string | undefined;
  let confirmTarget: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--env-file") {
      envFile = args[index + 1];
      index += 1;
      if (!envFile) usageError("--env-file requires a path");
    } else if (argument === "--confirm-target") {
      confirmTarget = args[index + 1];
      index += 1;
      if (!confirmTarget) usageError("--confirm-target requires environment:database");
    } else usageError(`unknown argument ${String(argument)}`);
  }
  if (!envFile) usageError("--env-file is required");
  if (command === "apply" && !confirmTarget) usageError("apply requires --confirm-target");
  if (command !== "apply" && confirmTarget)
    usageError("--confirm-target is accepted only by apply");
  return confirmTarget ? { command, confirmTarget, envFile, json } : { command, envFile, json };
}

function stableDiagnostic(diagnostic: MigrationDiagnostic) {
  return {
    code: diagnostic.code,
    ...(diagnostic.file ? { file: diagnostic.file } : {}),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    ...(diagnostic.migrationId ? { migrationId: diagnostic.migrationId } : {}),
    message: diagnostic.message,
  };
}

function writeResult(result: MigrationRunResult, json: boolean): void {
  const diagnostics = [...result.diagnostics].sort(compareDiagnostics);
  if (json) {
    const output = {
      command: result.command,
      database: result.database,
      state: result.state,
      applied: [...result.applied],
      pending: [...result.pending],
      diagnostics: diagnostics.map(stableDiagnostic),
      status: diagnostics.length ? "violation" : "ok",
    };
    const target = diagnostics.length ? process.stderr : process.stdout;
    target.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (diagnostics.length) {
    for (const diagnostic of diagnostics) process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
    return;
  }
  process.stdout.write(
    `Migration ${result.command}: database=${result.database} state=${result.state} applied=${result.applied.length} pending=${result.pending.length}\n`,
  );
}

async function main(): Promise<void> {
  const jsonRequested = process.argv.includes("--json");
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (!parsed) {
      process.stdout.write(migrationUsage);
      return;
    }
    const config = await loadMigrationConnectionConfig(root, parsed.envFile);
    const catalog = await readMigrationCatalog(root);
    const options = parsed.confirmTarget
      ? { catalog, command: parsed.command, config, confirmTarget: parsed.confirmTarget }
      : { catalog, command: parsed.command, config };
    const result = await runMigrationCommand(options);
    writeResult(result, parsed.json);
    if (result.diagnostics.length) process.exitCode = 1;
  } catch (error) {
    const diagnostic: MigrationDiagnostic =
      error instanceof MigrationOperationalError
        ? { code: error.code, message: error.message }
        : { code: "MIGRATION_INTERNAL", message: "unexpected migration runner failure" };
    if (jsonRequested)
      process.stderr.write(
        `${JSON.stringify({ diagnostics: [stableDiagnostic(diagnostic)], status: "error" }, null, 2)}\n`,
      );
    else process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
    process.exitCode = 2;
  }
}

await main();
