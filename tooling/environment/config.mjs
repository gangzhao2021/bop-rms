import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const EXPECTED = {
  node: "v24.18.0",
  corepack: "0.35.0",
  pnpm: "11.13.0",
  turbo: "2.10.5",
};

const REQUIRED_KEYS = [
  "BOP_RMS_COMPOSE_PROJECT",
  "BOP_RMS_POSTGRES_PASSWORD_FILE",
  "BOP_RMS_POSTGRES_PORT",
  "BOP_RMS_POSTGRES_DB",
  "BOP_RMS_POSTGRES_USER",
  "BOP_RMS_API_PORT",
  "BOP_RMS_MERCHANT_WEB_PORT",
  "BOP_RMS_CUSTOMER_PWA_PORT",
];

const PORT_KEYS = [
  "BOP_RMS_POSTGRES_PORT",
  "BOP_RMS_API_PORT",
  "BOP_RMS_MERCHANT_WEB_PORT",
  "BOP_RMS_CUSTOMER_PWA_PORT",
];

function fail(message) {
  throw new Error(message);
}

export function parseEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`Environment file is not readable: ${file} (${error.code ?? "unknown error"})`);
  }
  const values = {};
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) fail(`Invalid environment assignment at line ${index + 1}`);
    const [, key, rawValue] = match;
    if (Object.hasOwn(values, key)) fail(`Duplicate environment variable: ${key}`);
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    if (!value) fail(`Environment variable must not be empty: ${key}`);
    values[key] = value;
  }
  for (const key of REQUIRED_KEYS)
    if (!Object.hasOwn(values, key)) fail(`Missing required environment variable: ${key}`);
  const unknown = Object.keys(values).filter(
    (key) => key.startsWith("BOP_RMS_") && !REQUIRED_KEYS.includes(key),
  );
  if (unknown.length) fail(`Unsupported BOP-RMS environment variable: ${unknown.join(", ")}`);
  return values;
}

function validateIdentifier(value, key) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    fail(`${key} must be a lowercase PostgreSQL identifier`);
}

function validateProjectName(value) {
  if (!/^bop-rms-[a-z0-9][a-z0-9-]{0,48}$/u.test(value))
    fail(
      "BOP_RMS_COMPOSE_PROJECT must start with bop-rms- and use lowercase letters, digits, or hyphens",
    );
}

function parsePort(value, key) {
  if (!/^[0-9]+$/u.test(value)) fail(`${key} must be an integer from 1 to 65535`);
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) fail(`${key} must be an integer from 1 to 65535`);
  return port;
}

function validateSecret(root, value) {
  const secretFile = path.resolve(root, value);
  const localDirectory = `${path.join(root, ".local")}${path.sep}`;
  if (!secretFile.startsWith(localDirectory))
    fail("PostgreSQL secret file must be stored under the ignored .local directory");
  let stat;
  let lstat;
  let realSecretFile;
  try {
    lstat = fs.lstatSync(secretFile);
    stat = fs.statSync(secretFile);
    realSecretFile = fs.realpathSync(secretFile);
    const realLocalDirectory = `${fs.realpathSync(path.join(root, ".local"))}${path.sep}`;
    if (!realSecretFile.startsWith(realLocalDirectory))
      fail("PostgreSQL secret file must resolve inside the ignored .local directory");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PostgreSQL secret file must resolve"))
      throw error;
    fail(`PostgreSQL secret file is not readable (${error.code ?? "unknown error"})`);
  }
  if (lstat.isSymbolicLink()) fail("PostgreSQL secret file must not be a symbolic link");
  if (!stat.isFile()) fail("PostgreSQL secret path must be a regular file");
  if ((stat.mode & 0o777) !== 0o600) fail("PostgreSQL secret file mode must be 0600");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    fail("PostgreSQL secret file must be owned by the current Linux user");
  if (stat.size < 1 || stat.size > 4096)
    fail("PostgreSQL secret file must contain 1 to 4096 bytes");
  return secretFile;
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  fail(`Required executable is missing from PATH: ${name}`);
}

function ensureLinuxExecutable(name) {
  const executable = findExecutable(name);
  const dockerDesktopWslBridge =
    name === "docker" && executable.startsWith("/mnt/wsl/docker-desktop/cli-tools/");
  if (
    (executable.startsWith("/mnt/") && !dockerDesktopWslBridge) ||
    executable.toLowerCase().endsWith(".exe")
  )
    fail(`${name} must resolve to a Linux executable, not ${executable}`);
  return executable;
}

function version(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .trim()
      .split("\n")[0];
    fail(`Unable to execute ${path.basename(executable)}: ${detail}`);
  }
}

export function validateToolchain(root) {
  if (process.platform !== "linux") fail("BOP-RMS repository commands require Linux/WSL2");
  const realRoot = fs.realpathSync(root);
  if (realRoot.startsWith("/mnt/"))
    fail("Repository must be in the WSL/Linux filesystem, not /mnt/*");
  if (process.version !== EXPECTED.node)
    fail(`Node.js must be ${EXPECTED.node}; received ${process.version}`);
  if (process.execPath.startsWith("/mnt/") || process.execPath.toLowerCase().endsWith(".exe"))
    fail(`Node.js must resolve to a Linux executable, not ${process.execPath}`);

  const executables = {
    git: ensureLinuxExecutable("git"),
    corepack: ensureLinuxExecutable("corepack"),
    pnpm: ensureLinuxExecutable("pnpm"),
    docker: ensureLinuxExecutable("docker"),
  };
  const actual = {
    corepack: version(executables.corepack, ["--version"]),
    pnpm: version(executables.pnpm, ["--version"]),
    turbo: version(executables.pnpm, ["exec", "turbo", "--version"]),
  };
  for (const key of Object.keys(actual))
    if (actual[key] !== EXPECTED[key])
      fail(`${key} must be ${EXPECTED[key]}; received ${actual[key]}`);
  version(executables.git, ["--version"]);
  const dockerOs = version(executables.docker, ["info", "--format", "{{.OSType}}"]);
  if (dockerOs !== "linux") fail(`Docker Engine must use Linux containers; received ${dockerOs}`);
  version(executables.docker, ["compose", "version", "--short"]);
  return { actual: { node: process.version, ...actual }, executables, realRoot };
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

export async function loadEnvironment({ checkPorts = false, envFile, root }) {
  const toolchain = validateToolchain(root);
  const absoluteEnvFile = path.resolve(root, envFile);
  const values = parseEnvFile(absoluteEnvFile);
  validateProjectName(values.BOP_RMS_COMPOSE_PROJECT);
  validateIdentifier(values.BOP_RMS_POSTGRES_DB, "BOP_RMS_POSTGRES_DB");
  validateIdentifier(values.BOP_RMS_POSTGRES_USER, "BOP_RMS_POSTGRES_USER");
  const ports = Object.fromEntries(PORT_KEYS.map((key) => [key, parsePort(values[key], key)]));
  const duplicates = Object.values(ports).filter((port, index, all) => all.indexOf(port) !== index);
  if (duplicates.length) fail("Configured localhost ports must be unique");
  const secretFile = validateSecret(root, values.BOP_RMS_POSTGRES_PASSWORD_FILE);
  if (checkPorts) {
    for (const [key, port] of Object.entries(ports))
      if (!(await portAvailable(port))) fail(`${key} port ${port} is already in use`);
  }
  return {
    envFile: absoluteEnvFile,
    projectName: values.BOP_RMS_COMPOSE_PROJECT,
    root: toolchain.realRoot,
    secretFile,
    toolchain,
    values,
    ports: {
      api: ports.BOP_RMS_API_PORT,
      customerPwa: ports.BOP_RMS_CUSTOMER_PWA_PORT,
      merchantWeb: ports.BOP_RMS_MERCHANT_WEB_PORT,
      postgres: ports.BOP_RMS_POSTGRES_PORT,
    },
  };
}

export function runtimeFile(config) {
  return path.join(config.root, ".local", "environment", `${config.projectName}.json`);
}
