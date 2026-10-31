#!/usr/bin/env node
import process from "node:process";
import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeTotpSecret,
  encodeTotpSecret,
  totpProvisioningUri,
  verifyTotp,
} from "../../packages/bop/identity/src/index.ts";

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT) — TEST-ONLY authenticator secrets for the InternalTest
 * DEMO staff. Secrets live only in the private pilot runtime directory (mode 0600), never in the
 * repository, logs or error messages. Replaced by Cognito TOTP re-authentication in production.
 */
export const staffTotpFileName = "internal-test-staff-totp.json";
const label = "TEST-ONLY authenticator secrets for InternalTest DEMO staff; never commit or log";
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const selectorPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const unavailable = () => {
  throw new Error("INTERNAL_STAFF_TOTP_UNAVAILABLE");
};
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return unavailable();
}
function parseSecrets(value) {
  if (
    !exact(value, ["schemaVersion", "environment", "label", "actors"]) ||
    value.schemaVersion !== 1 ||
    value.environment !== "InternalTest" ||
    value.label !== label ||
    !Array.isArray(value.actors) ||
    value.actors.length > 16
  )
    return unavailable();
  const seen = new Set();
  return value.actors.map((entry) => {
    if (
      !exact(entry, ["selector", "actorReference", "secret"]) ||
      !selectorPattern.test(entry.selector) ||
      !referencePattern.test(entry.actorReference) ||
      seen.has(entry.actorReference) ||
      seen.has(entry.selector)
    )
      return unavailable();
    seen.add(entry.actorReference);
    seen.add(entry.selector);
    decodeTotpSecret(entry.secret);
    return Object.freeze({ ...entry });
  });
}
async function readSecrets(path) {
  try {
    await privateFile(path);
    return parseSecrets(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return unavailable();
  }
}

/** Verifier port for the Identity step-up record. Re-reads the private file on every attempt so a
 * rotated or removed secret takes effect at once. Unknown actor: not set up (throws). */
export function createInternalStaffTotpVerifier({ directory }) {
  const path = join(directory, staffTotpFileName);
  return async ({ actorReference, code, atMilliseconds }) => {
    if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
    const entry = (await readSecrets(path)).find(
      (value) => value.actorReference === actorReference,
    );
    if (!entry) return unavailable();
    return verifyTotp({ secret: decodeTotpSecret(entry.secret), code, atMilliseconds });
  };
}

async function loadRoster(directory) {
  const roster = JSON.parse(await readFile(join(directory, "internal-test-merchant.json"), "utf8"));
  if (roster?.environment !== "InternalTest") return unavailable();
  const actors =
    roster.schemaVersion === 2
      ? roster.actors
      : [{ selector: "staff", actorReference: roster.actorReference }];
  if (!Array.isArray(actors)) return unavailable();
  return new Map(
    actors
      .filter(
        (entry) =>
          selectorPattern.test(entry?.selector) && referencePattern.test(entry?.actorReference),
      )
      .map((entry) => [entry.selector, entry.actorReference]),
  );
}

/** Generates (or, with replace, rotates) a secret for each named DEMO selector. Returns the
 * otpauth URIs; the caller decides whether to print them. Writes atomically with mode 0600. */
export async function provisionInternalStaffTotp({ directory, selectors, replace = false }) {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 16)
    return unavailable();
  const roster = await loadRoster(directory);
  const path = join(directory, staffTotpFileName);
  const current = await readSecrets(path);
  const next = [...current];
  const issued = [];
  for (const selector of selectors) {
    const actorReference = roster.get(selector);
    if (!selectorPattern.test(selector) || actorReference === undefined) return unavailable();
    const index = next.findIndex((entry) => entry.actorReference === actorReference);
    if (index >= 0 && !replace) continue;
    const secret = encodeTotpSecret(randomBytes(20));
    const entry = Object.freeze({ selector, actorReference, secret });
    if (index >= 0) next[index] = entry;
    else next.push(entry);
    issued.push({
      selector,
      uri: totpProvisioningUri({
        secret: decodeTotpSecret(secret),
        issuer: "BOP RMS InternalTest",
        accountLabel: "DEMO staff " + selector,
      }),
    });
  }
  const body =
    JSON.stringify(
      { schemaVersion: 1, environment: "InternalTest", label, actors: next },
      null,
      2,
    ) + "\n";
  const temporary = path + ".tmp-" + process.pid;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await privateFile(path);
  return issued;
}

async function main(argv) {
  const selectors = [];
  let directory = null,
    printUri = false,
    replace = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--directory") directory = argv[++index] ?? null;
    else if (value === "--selector") selectors.push(argv[++index]);
    else if (value === "--print-uri") printUri = true;
    else if (value === "--replace") replace = true;
    else
      throw new Error(
        "Usage: --directory <runtime dir> --selector <name>... [--replace] [--print-uri]",
      );
  }
  if (directory === null) throw new Error("--directory is required");
  const issued = await provisionInternalStaffTotp({
    directory: resolve(directory),
    selectors,
    replace,
  });
  for (const entry of issued)
    process.stdout.write(
      printUri
        ? entry.selector + " " + entry.uri + "\n"
        : "TEST-ONLY authenticator issued for DEMO staff " + entry.selector + "\n",
    );
  if (issued.length === 0) process.stdout.write("No new authenticator issued (use --replace).\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((error) => {
    // Never print a secret: only the message of a usage or availability error.
    process.stderr.write(
      (error instanceof Error && /^(Usage|--directory|INTERNAL_)/u.test(error.message)
        ? error.message
        : "INTERNAL_STAFF_TOTP_UNAVAILABLE") + "\n",
    );
    process.exitCode = 1;
  });
