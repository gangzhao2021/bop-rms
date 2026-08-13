import { lstat, readFile, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { MigrationOperationalError } from "./diagnostics.ts";

const requiredKeys = [
  "BOP_RMS_COMPOSE_PROJECT",
  "BOP_RMS_ENVIRONMENT",
  "BOP_RMS_POSTGRES_HOST",
  "BOP_RMS_POSTGRES_PASSWORD_FILE",
  "BOP_RMS_POSTGRES_PORT",
  "BOP_RMS_POSTGRES_DB",
  "BOP_RMS_POSTGRES_USER",
  "BOP_RMS_POSTGRES_SSL_MODE",
  "BOP_RMS_API_PORT",
  "BOP_RMS_MERCHANT_WEB_PORT",
  "BOP_RMS_CUSTOMER_PWA_PORT",
] as const;
const optionalKeys = ["BOP_RMS_POSTGRES_SSL_CA_FILE"] as const;
const knownKeys = new Set<string>([...requiredKeys, ...optionalKeys]);
const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const hostname = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|::1)$/u;

export interface MigrationConnectionConfig {
  readonly database: string;
  readonly environment: "local" | "test" | "staging" | "production";
  readonly host: string;
  readonly password: string;
  readonly port: number;
  readonly ssl: false | { readonly ca: string; readonly rejectUnauthorized: true };
  readonly user: string;
}

function unsafe(message: string): never {
  throw new MigrationOperationalError("MIGRATION_CONFIG_UNSAFE", message);
}

function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) unsafe(`environment file has an invalid assignment at line ${index + 1}`);
    const key = match[1] ?? "";
    if (Object.hasOwn(values, key)) unsafe(`environment file repeats ${key}`);
    let value = (match[2] ?? "").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    if (!value) unsafe(`environment value must not be empty: ${key}`);
    values[key] = value;
  }
  for (const key of requiredKeys)
    if (!Object.hasOwn(values, key)) unsafe(`environment file is missing ${key}`);
  const unknown = Object.keys(values)
    .filter((key) => key.startsWith("BOP_RMS_") && !knownKeys.has(key))
    .sort();
  if (unknown.length) unsafe(`environment file contains unsupported keys: ${unknown.join(", ")}`);
  return values;
}

async function protectedFile(root: string, configured: string, secret: boolean): Promise<string> {
  const localRoot = path.join(root, ".local");
  let localState;
  let canonicalLocalRoot: string;
  try {
    localState = await lstat(localRoot);
    canonicalLocalRoot = await realpath(localRoot);
  } catch {
    unsafe("the .local secret boundary is not readable");
  }
  if (localState.isSymbolicLink() || !localState.isDirectory() || canonicalLocalRoot !== localRoot)
    unsafe("the .local secret boundary must be a real repository directory");
  const target = path.resolve(root, configured);
  const local = `${localRoot}${path.sep}`;
  if (!target.startsWith(local))
    unsafe(`${secret ? "password" : "CA"} file must be under the ignored .local directory`);
  let state;
  let canonical: string;
  try {
    state = await lstat(target);
    canonical = await realpath(target);
  } catch {
    unsafe(`${secret ? "password" : "CA"} file is not readable`);
  }
  const canonicalLocal = `${canonicalLocalRoot}${path.sep}`;
  if (!canonical.startsWith(canonicalLocal) || state.isSymbolicLink() || !state.isFile())
    unsafe(`${secret ? "password" : "CA"} file must be a real regular file inside .local`);
  if (
    secret &&
    ((state.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && state.uid !== process.getuid()))
  )
    unsafe("password file must be current-user-owned with mode 0600");
  if (state.size < 1 || state.size > (secret ? 4096 : 1_048_576))
    unsafe(`${secret ? "password" : "CA"} file has an unsafe size`);
  return canonical;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export async function loadMigrationConnectionConfig(
  root: string,
  envFile: string,
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<MigrationConnectionConfig> {
  if (ambient.DATABASE_URL || ambient.PGPASSWORD)
    unsafe("DATABASE_URL and PGPASSWORD are not accepted migration authorities");
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    unsafe("repository root is not readable");
  }
  // Resolve the caller-visible path before canonicalizing it. On macOS `/tmp`
  // resolves to `/private/tmp`; mixing the canonical root with the original
  // absolute env-file path incorrectly rejects a file inside that same root.
  const configuredEnvironment = path.resolve(root, envFile);
  let environmentState;
  let canonicalEnvironment: string;
  let text: string;
  try {
    environmentState = await lstat(configuredEnvironment);
    canonicalEnvironment = await realpath(configuredEnvironment);
    text = await readFile(configuredEnvironment, "utf8");
  } catch {
    unsafe("environment file is not readable");
  }
  if (
    !canonicalEnvironment.startsWith(`${canonicalRoot}${path.sep}`) ||
    environmentState.isSymbolicLink() ||
    !environmentState.isFile()
  )
    unsafe("environment file must be a real regular file inside the repository");
  const values = parseEnvironmentFile(text);
  const environment = values.BOP_RMS_ENVIRONMENT;
  if (!environment || !["local", "test", "staging", "production"].includes(environment))
    unsafe("BOP_RMS_ENVIRONMENT must be local, test, staging, or production");
  const host = values.BOP_RMS_POSTGRES_HOST ?? "";
  if (!hostname.test(host) && net.isIP(host) === 0) unsafe("PostgreSQL host is invalid");
  const portText = values.BOP_RMS_POSTGRES_PORT ?? "";
  if (!/^[0-9]+$/u.test(portText)) unsafe("PostgreSQL port must be an integer from 1 to 65535");
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65_535) unsafe("PostgreSQL port must be an integer from 1 to 65535");
  const database = values.BOP_RMS_POSTGRES_DB ?? "";
  const user = values.BOP_RMS_POSTGRES_USER ?? "";
  if (!identifier.test(database) || !identifier.test(user))
    unsafe("PostgreSQL database and user must be lowercase identifiers");
  const mode = values.BOP_RMS_POSTGRES_SSL_MODE;
  if (mode !== "disable" && mode !== "verify-full")
    unsafe("PostgreSQL SSL mode must be disable or verify-full");
  if (
    (environment === "staging" || environment === "production" || !isLoopback(host)) &&
    mode !== "verify-full"
  )
    unsafe("non-local PostgreSQL connections require verify-full TLS");
  const passwordFile = await protectedFile(
    canonicalRoot,
    values.BOP_RMS_POSTGRES_PASSWORD_FILE ?? "",
    true,
  );
  const password = await readFile(passwordFile, "utf8");
  if (/\0|\r|\n/u.test(password))
    unsafe("password file must contain one exact line without control characters");
  let ssl: MigrationConnectionConfig["ssl"] = false;
  if (mode === "verify-full") {
    const caSetting = values.BOP_RMS_POSTGRES_SSL_CA_FILE;
    if (!caSetting) unsafe("verify-full TLS requires BOP_RMS_POSTGRES_SSL_CA_FILE");
    const caFile = await protectedFile(canonicalRoot, caSetting, false);
    const ca = await readFile(caFile, "utf8");
    ssl = { ca, rejectUnauthorized: true };
  }
  return {
    database,
    environment: environment as MigrationConnectionConfig["environment"],
    host,
    password,
    port,
    ssl,
    user,
  };
}
