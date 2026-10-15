import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import { lstat, realpath, readFile, mkdir, chmod, link, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import console from "node:console";
import { pilotCertificatePublicKeyPin } from "./pilot-tls-trust.mjs";
const execute = promisify(execFile);
const unavailable = () => {
  throw new Error("PILOT_TLS_BOOTSTRAP_UNAVAILABLE");
};
async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return unavailable();
  }
}
async function readOwnedPair(keyFile, certificateFile) {
  for (const file of [keyFile, certificateFile]) {
    const state = await lstat(file);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.uid !== process.getuid() ||
      (state.mode & 0o777) !== 0o600 ||
      (await realpath(file)) !== file
    )
      return unavailable();
  }
  const certificate = new X509Certificate(await readFile(certificateFile));
  const key = createPrivateKey(await readFile(keyFile));
  if (
    !certificate.checkPrivateKey(key) ||
    certificate.checkIP("127.0.0.1") !== "127.0.0.1" ||
    !certificate.verify(certificate.publicKey) ||
    certificate.ca
  )
    return unavailable();
  return certificate;
}
async function validatePair(keyFile, certificateFile) {
  const certificate = await readOwnedPair(keyFile, certificateFile);
  if (
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  )
    return unavailable();
}
const DEFAULT_SUBJECT = "/CN=BOP-RMS Local DEMO";
const DEFAULT_SUBJECT_ALT_NAME = "IP:127.0.0.1";
const SAFE_NAME_VALUE = /^[A-Za-z0-9 .\-_]{1,64}$/;
/** Re-expresses an existing certificate's subject and SANs for OpenSSL; refuses anything unusual. */
function certificateNames(certificate) {
  const subject = certificate.subject.split("\n").map((entry) => {
    const match = /^(CN|O|OU|C|ST|L)=(.*)$/.exec(entry);
    if (!match || !SAFE_NAME_VALUE.test(match[2])) return unavailable();
    return "/" + match[1] + "=" + match[2];
  });
  const alternativeNames = (certificate.subjectAltName ?? "").split(", ").map((entry) => {
    const match = /^(IP Address|DNS):(.*)$/.exec(entry);
    if (!match || !SAFE_NAME_VALUE.test(match[2])) return unavailable();
    return (match[1] === "DNS" ? "DNS:" : "IP:") + match[2];
  });
  return { subject: subject.join(""), subjectAltName: alternativeNames.join(",") };
}
async function generatePair(stage, { subject, subjectAltName }) {
  const key = join(stage, "key.pem"),
    certificate = join(stage, "certificate.pem");
  try {
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "30",
        "-subj",
        subject,
        "-addext",
        "subjectAltName=" + subjectAltName,
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { timeout: 30000, maxBuffer: 65536 },
    );
  } catch {
    return unavailable();
  }
  await chmod(key, 0o600);
  await chmod(certificate, 0o600);
  await validatePair(key, certificate);
  return { key, certificate };
}
async function prepareDirectory({ directory, expectedDatabaseName }) {
  if (
    process.env.NODE_ENV !== "development" ||
    typeof expectedDatabaseName !== "string" ||
    !expectedDatabaseName
  )
    return unavailable();
  const state = await lstat(directory);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid() ||
    (state.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    return unavailable();
  const profile = JSON.parse(await readFile(join(directory, "internal-test-profile.json"), "utf8"));
  if (profile.environment !== "InternalTest" || profile.database !== expectedDatabaseName)
    return unavailable();
}
/** Local demo TLS only; no trust-store installation or existing key replacement. */
export async function provisionPilotTls({ directory, expectedDatabaseName }) {
  await prepareDirectory({ directory, expectedDatabaseName });
  const lock = join(directory, ".tls-provision-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    return unavailable();
  }
  const stage = join(directory, ".tls-stage-" + randomUUID());
  let staged = false;
  try {
    const keyFile = join(directory, "customer-tls-key.pem"),
      certificateFile = join(directory, "customer-tls-cert.pem");
    const hasKey = await exists(keyFile),
      hasCertificate = await exists(certificateFile);
    if (hasKey !== hasCertificate) return unavailable();
    if (hasKey) {
      await validatePair(keyFile, certificateFile);
      return { status: "Retained", rotationPerformed: false };
    }
    await mkdir(stage, { mode: 0o700 });
    staged = true;
    const { key, certificate } = await generatePair(stage, {
      subject: DEFAULT_SUBJECT,
      subjectAltName: DEFAULT_SUBJECT_ALT_NAME,
    });
    // Hard links publish without replacing any existing target, even after a race.
    await link(key, keyFile);
    await link(certificate, certificateFile);
    return { status: "Created", rotationPerformed: false };
  } finally {
    try {
      if (staged) await rm(stage, { recursive: true, force: true });
    } finally {
      await rmdir(lock);
    }
  }
}

const DAY = 86400000;
/**
 * WP-2423: renews the local InternalTest HTTPS pair before (or after) it expires. Keeps the
 * current subject and SANs, generates a new key, keeps the previous pair as hard links in a new
 * owner-only `tls-backup-<time>` directory and only then replaces the targets. The running entry
 * keeps its old certificate until it restarts, and every device or automated browser that trusts
 * the old certificate needs the new one (see README). A pair with more than `renewWithinDays`
 * left is retained unchanged.
 */
export async function renewPilotTls({
  directory,
  expectedDatabaseName,
  renewWithinDays = 7,
  now = Date.now(),
}) {
  if (!Number.isInteger(renewWithinDays) || renewWithinDays < 0 || renewWithinDays > 30)
    return unavailable();
  if (!Number.isFinite(now)) return unavailable();
  await prepareDirectory({ directory, expectedDatabaseName });
  const lock = join(directory, ".tls-provision-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    return unavailable();
  }
  const stage = join(directory, ".tls-stage-" + randomUUID());
  let staged = false;
  try {
    const keyFile = join(directory, "customer-tls-key.pem"),
      certificateFile = join(directory, "customer-tls-cert.pem");
    // Renewal needs a complete existing pair; a missing or partial pair is provisioning/recovery.
    const current = await readOwnedPair(keyFile, certificateFile).catch(unavailable);
    const previousValidTo = new Date(Date.parse(current.validTo)).toISOString();
    if (Date.parse(current.validTo) - now > renewWithinDays * DAY)
      return { status: "Retained", renewalPerformed: false, validTo: previousValidTo };
    const names = certificateNames(current);
    await mkdir(stage, { mode: 0o700 });
    staged = true;
    const { key, certificate } = await generatePair(stage, names);
    const backupName = "tls-backup-" + new Date(now).toISOString().replace(/[-:.]/g, "");
    const backup = join(directory, backupName);
    try {
      await mkdir(backup, { mode: 0o700 });
    } catch {
      return unavailable();
    }
    await link(keyFile, join(backup, "customer-tls-key.pem"));
    await link(certificateFile, join(backup, "customer-tls-cert.pem"));
    // Same-directory renames replace each target atomically; the backup still holds the old pair.
    await rename(certificate, certificateFile);
    await rename(key, keyFile);
    const renewed = new X509Certificate(await readFile(certificateFile));
    return {
      status: "Renewed",
      renewalPerformed: true,
      previousValidTo,
      validTo: new Date(Date.parse(renewed.validTo)).toISOString(),
      backup: backupName,
      publicKeyPin: pilotCertificatePublicKeyPin(await readFile(certificateFile)),
    };
  } finally {
    try {
      if (staged) await rm(stage, { recursive: true, force: true });
    } finally {
      await rmdir(lock);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, directory, expectedDatabaseName, days] = process.argv.slice(2);
    if (mode !== "renew" || !directory || !expectedDatabaseName || process.argv.length > 6)
      throw new Error("PILOT_TLS_ARGUMENTS_INVALID");
    if (days !== undefined && !/^\d{1,2}$/.test(days))
      throw new Error("PILOT_TLS_ARGUMENTS_INVALID");
    console.log(
      JSON.stringify(
        await renewPilotTls({
          directory,
          expectedDatabaseName,
          ...(days === undefined ? {} : { renewWithinDays: Number(days) }),
        }),
      ),
    );
  } catch {
    console.error(
      "PILOT_TLS_RENEWAL_UNAVAILABLE: requires development mode, a matching InternalTest profile, a private absolute directory and a complete owner-only certificate pair. Nothing was replaced.",
    );
    process.exitCode = 1;
  }
}
