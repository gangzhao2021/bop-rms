import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadMigrationConnectionConfig } from "./config.ts";
import {
  formatFoundationDiagnostic,
  type FoundationDiagnostic,
  type FoundationDiagnosticCode,
  verifyFoundation,
} from "./foundation.ts";
import { MigrationOperationalError } from "./diagnostics.ts";
import {
  acquireMigrationLock,
  connectMigrationDatabase,
  releaseMigrationLock,
  verifyMigrationTarget,
} from "./runner.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const foundationUsage = `BOP-RMS Foundation Verifier

Usage:
  pnpm foundation:verify -- --env-file <path> [--json]
  pnpm foundation:verify -- --help

The verifier is read-only. It never executes DDL, repair, adopt, baseline, or mutation.
`;

interface ParsedArguments {
  readonly envFile: string;
  readonly json: boolean;
}

function usageError(message: string): never {
  throw new FoundationCliError("FOUNDATION_CONFIG_UNSAFE", message);
}

export class FoundationCliError extends Error {
  readonly code: FoundationDiagnosticCode;

  constructor(code: FoundationDiagnosticCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseFoundationArguments(args: readonly string[]): ParsedArguments | null {
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
      if (!envFile) usageError("--env-file requires a path");
    } else usageError("unknown argument");
  }
  if (!envFile) usageError("--env-file is required");
  return { envFile, json };
}

function writeDiagnostics(
  diagnostics: readonly FoundationDiagnostic[],
  json: boolean,
  status: "error" | "violation" = "violation",
): void {
  if (json) {
    process.stderr.write(
      `${JSON.stringify(
        {
          diagnostics: diagnostics.map((item) => ({
            target: item.target,
            code: item.code,
            message: item.message,
          })),
          status,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  for (const item of diagnostics) process.stderr.write(`${formatFoundationDiagnostic(item)}\n`);
}

function operationalDiagnostic(error: unknown): FoundationDiagnostic {
  if (error instanceof FoundationCliError)
    return { code: error.code, message: error.message, target: "configuration" };
  if (error instanceof MigrationOperationalError) {
    const code: FoundationDiagnosticCode =
      error.code === "MIGRATION_CONFIG_UNSAFE"
        ? "FOUNDATION_CONFIG_UNSAFE"
        : error.code === "MIGRATION_CONNECTION_FAILED" || error.code === "MIGRATION_CONNECTION_LOST"
          ? "FOUNDATION_CONNECTION_FAILED"
          : "FOUNDATION_INTERNAL";
    return {
      code,
      message: "foundation verification could not safely inspect the target",
      target: "operation",
    };
  }
  return {
    code: "FOUNDATION_INTERNAL",
    message: "unexpected foundation verification failure",
    target: "operation",
  };
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  try {
    const parsed = parseFoundationArguments(process.argv.slice(2));
    if (!parsed) {
      process.stdout.write(foundationUsage);
      return;
    }
    const config = await loadMigrationConnectionConfig(root, parsed.envFile);
    const client = await connectMigrationDatabase(config, "bop-rms-foundation-verifier");
    let locked = false;
    try {
      await verifyMigrationTarget(client, config);
      locked = await acquireMigrationLock(client, "verify");
      if (!locked)
        throw new FoundationCliError(
          "FOUNDATION_INTERNAL",
          "foundation verification could not acquire the shared migration lock",
        );
      const result = await verifyFoundation(client, config.user);
      if (result.diagnostics.length) {
        writeDiagnostics(result.diagnostics, parsed.json);
        process.exitCode = 1;
      } else if (parsed.json)
        process.stdout.write(
          `${JSON.stringify({ diagnostics: [], status: "compliant" }, null, 2)}\n`,
        );
      else process.stdout.write("Foundation verification compliant\n");
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
