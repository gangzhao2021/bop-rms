import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadMigrationConnectionConfig } from "./config.ts";
import {
  formatHelperDiagnostic,
  type HelperDiagnostic,
  type HelperDiagnosticCode,
  verifyHelpers,
} from "./helpers.ts";
import { MigrationOperationalError } from "./diagnostics.ts";
import {
  acquireMigrationLock,
  connectMigrationDatabase,
  releaseMigrationLock,
  verifyMigrationTarget,
} from "./runner.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const helpersUsage = `BOP-RMS Database Helper Verifier

Usage:
  pnpm helpers:verify -- --env-file <path> [--json]
  pnpm helpers:verify -- --help

The verifier is read-only. It never executes DDL, repair, grant, adopt, baseline, or mutation.
`;

interface ParsedArguments {
  readonly envFile: string;
  readonly json: boolean;
}

export class HelpersCliError extends Error {
  readonly code: HelperDiagnosticCode;
  constructor(code: HelperDiagnosticCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseHelpersArguments(args: readonly string[]): ParsedArguments | null {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return null;
  let envFile: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--env-file") {
      envFile = args[index + 1];
      index += 1;
      if (!envFile) throw new HelpersCliError("HELPER_CONFIG_UNSAFE", "--env-file requires a path");
    } else throw new HelpersCliError("HELPER_CONFIG_UNSAFE", "unknown argument");
  }
  if (!envFile) throw new HelpersCliError("HELPER_CONFIG_UNSAFE", "--env-file is required");
  return { envFile, json };
}

function operationalDiagnostic(error: unknown): HelperDiagnostic {
  if (error instanceof HelpersCliError)
    return { code: error.code, message: error.message, target: "configuration" };
  if (error instanceof MigrationOperationalError)
    return {
      code:
        error.code === "MIGRATION_CONFIG_UNSAFE"
          ? "HELPER_CONFIG_UNSAFE"
          : error.code === "MIGRATION_CONNECTION_FAILED" ||
              error.code === "MIGRATION_CONNECTION_LOST"
            ? "HELPER_CONNECTION_FAILED"
            : "HELPER_INTERNAL",
      message: "helper verification could not safely inspect the target",
      target: "operation",
    };
  return {
    code: "HELPER_INTERNAL",
    message: "unexpected helper verification failure",
    target: "operation",
  };
}

function writeDiagnostics(
  diagnostics: readonly HelperDiagnostic[],
  json: boolean,
  status: "error" | "violation",
): void {
  if (json) process.stderr.write(`${JSON.stringify({ diagnostics, status }, null, 2)}\n`);
  else for (const item of diagnostics) process.stderr.write(`${formatHelperDiagnostic(item)}\n`);
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  try {
    const parsed = parseHelpersArguments(process.argv.slice(2));
    if (!parsed) return void process.stdout.write(helpersUsage);
    const config = await loadMigrationConnectionConfig(root, parsed.envFile);
    const client = await connectMigrationDatabase(config, "bop-rms-helper-verifier");
    let locked = false;
    try {
      await verifyMigrationTarget(client, config);
      locked = await acquireMigrationLock(client, "verify");
      if (!locked) throw new HelpersCliError("HELPER_INTERNAL", "shared migration lock is busy");
      const diagnostics = await verifyHelpers(client, config.user);
      if (diagnostics.length) {
        writeDiagnostics(diagnostics, parsed.json, "violation");
        process.exitCode = 1;
      } else if (parsed.json)
        process.stdout.write(
          `${JSON.stringify({ diagnostics: [], status: "compliant" }, null, 2)}\n`,
        );
      else process.stdout.write("Database helper verification compliant\n");
    } finally {
      if (locked) await releaseMigrationLock(client, "verify").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  } catch (error) {
    writeDiagnostics([operationalDiagnostic(error)], json, "error");
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  await main();
