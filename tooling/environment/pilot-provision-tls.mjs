import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import { lstat, realpath, readFile, mkdir, chmod, link, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
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
async function validatePair(keyFile, certificateFile) {
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
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now() ||
    certificate.ca
  )
    return unavailable();
}
/** Local demo TLS only; no trust-store installation or existing key replacement. */
export async function provisionPilotTls({ directory, expectedDatabaseName }) {
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
          "/CN=BOP-RMS Local DEMO",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
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
