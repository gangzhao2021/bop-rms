import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { chmod, mkdtemp, writeFile, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionPilotTls, renewPilotTls } from "./pilot-provision-tls.mjs";
import { pilotCertificatePublicKeyPin } from "./pilot-tls-trust.mjs";
const execute = promisify(execFile);
const script = fileURLToPath(new URL("./pilot-provision-tls.mjs", import.meta.url));
let directory;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-tls-bootstrap-")));
  await writeFile(
    join(directory, "internal-test-profile.json"),
    JSON.stringify({ environment: "InternalTest", database: "isolated_test" }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
test("creates valid loopback TLS and retains exact bytes on retry", async () => {
  const options = { directory, expectedDatabaseName: "isolated_test" };
  expect((await provisionPilotTls(options)).status).toBe("Created");
  const key = await readFile(join(directory, "customer-tls-key.pem")),
    cert = await readFile(join(directory, "customer-tls-cert.pem"));
  expect(await provisionPilotTls(options)).toEqual({
    status: "Retained",
    rotationPerformed: false,
  });
  expect(key.equals(await readFile(join(directory, "customer-tls-key.pem")))).toBe(true);
  expect(cert.equals(await readFile(join(directory, "customer-tls-cert.pem")))).toBe(true);
  expect((await readdir(directory)).filter((name) => name.startsWith(".tls-"))).toEqual([]);
});
test("DEC-PILOT-RUNTIME-ENVIRONMENT: a Pilot Store issues its local entry pair; environments never mix", async () => {
  const options = { directory, expectedDatabaseName: "isolated_test" };
  // An InternalTest profile in a Pilot process, or production without the Pilot declaration: refused.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  await expect(provisionPilotTls(options)).rejects.toMatchObject({ reason: "not-pilot-process" });
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  await expect(provisionPilotTls(options)).rejects.toMatchObject({
    reason: "profile-environment-mismatch",
  });
  await writeFile(
    join(directory, "internal-test-profile.json"),
    JSON.stringify({ environment: "Pilot", database: "isolated_test" }),
    { mode: 0o600 },
  );
  expect((await provisionPilotTls(options)).status).toBe("Created");
  const certificate = new X509Certificate(await readFile(join(directory, "customer-tls-cert.pem")));
  expect(certificate.subject).toBe("CN=BOP-RMS Store local entry");
  expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
  expect(certificate.ca).toBe(false);
  expect((await renewPilotTls(options)).status).toBe("Retained");
});
test("incomplete pair is preserved and refused", async () => {
  const file = join(directory, "customer-tls-key.pem");
  await writeFile(file, "existing-invalid-key", { mode: 0o600 });
  await expect(
    provisionPilotTls({ directory, expectedDatabaseName: "isolated_test" }),
  ).rejects.toThrow("PILOT_TLS_BOOTSTRAP_UNAVAILABLE");
  expect(await readFile(file, "utf8")).toBe("existing-invalid-key");
  expect((await readdir(directory)).sort()).toEqual([
    "customer-tls-key.pem",
    "internal-test-profile.json",
  ]);
});

const DAY = 86400000;
test("renewal retains a pair with time left and refuses without a complete pair", async () => {
  const dir = directory;
  const options = { directory: dir, expectedDatabaseName: "isolated_test" };
  await expect(renewPilotTls(options)).rejects.toThrow("PILOT_TLS_BOOTSTRAP_UNAVAILABLE");
  expect(await readdir(dir)).toEqual(["internal-test-profile.json"]);
  await provisionPilotTls(options);
  const cert = await readFile(join(dir, "customer-tls-cert.pem"));
  const result = await renewPilotTls({ ...options, renewWithinDays: 7 });
  expect(result).toMatchObject({ status: "Retained", renewalPerformed: false });
  expect(cert.equals(await readFile(join(dir, "customer-tls-cert.pem")))).toBe(true);
  await expect(renewPilotTls({ ...options, expectedDatabaseName: "other" })).rejects.toThrow(
    "PILOT_TLS_BOOTSTRAP_UNAVAILABLE",
  );
  await expect(renewPilotTls({ ...options, renewWithinDays: 31 })).rejects.toThrow(
    "PILOT_TLS_BOOTSTRAP_UNAVAILABLE",
  );
});
test("renewal near or after expiry keeps names, backs up the old pair and replaces it", async () => {
  const dir = directory;
  const options = { directory: dir, expectedDatabaseName: "isolated_test" };
  await provisionPilotTls(options);
  const oldKey = await readFile(join(dir, "customer-tls-key.pem"));
  const oldCert = await readFile(join(dir, "customer-tls-cert.pem"));
  const previous = new X509Certificate(oldCert);
  // Evaluated as if 40 days later: the current pair has already expired.
  const now = Date.now() + 40 * DAY;
  const result = await renewPilotTls({ ...options, now });
  expect(result).toMatchObject({ status: "Renewed", renewalPerformed: true });
  const renewed = new X509Certificate(await readFile(join(dir, "customer-tls-cert.pem")));
  expect(renewed.subject).toBe(previous.subject);
  expect(renewed.subjectAltName).toBe(previous.subjectAltName);
  expect(renewed.fingerprint256).not.toBe(previous.fingerprint256);
  expect(oldKey.equals(await readFile(join(dir, "customer-tls-key.pem")))).toBe(false);
  expect(result.publicKeyPin).toBe(pilotCertificatePublicKeyPin(renewed.toString()));
  expect(result.publicKeyPin).not.toBe(pilotCertificatePublicKeyPin(oldCert));
  expect(Date.parse(result.validTo)).toBeGreaterThan(Date.now() + 29 * DAY);
  expect(result.previousValidTo).toBe(new Date(Date.parse(previous.validTo)).toISOString());
  const backup = join(dir, result.backup);
  expect((await stat(backup)).mode & 0o777).toBe(0o700);
  expect(oldKey.equals(await readFile(join(backup, "customer-tls-key.pem")))).toBe(true);
  expect(oldCert.equals(await readFile(join(backup, "customer-tls-cert.pem")))).toBe(true);
  for (const name of ["customer-tls-key.pem", "customer-tls-cert.pem"])
    expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
  // The renewed pair is accepted by ordinary provisioning, and no stage or lock remains.
  expect(await provisionPilotTls(options)).toEqual({
    status: "Retained",
    rotationPerformed: false,
  });
  expect((await readdir(dir)).filter((name) => name.startsWith(".tls-"))).toEqual([]);
  // A second renewal in the same instant refuses rather than overwrite the backup.
  await expect(renewPilotTls({ ...options, now, renewWithinDays: 30 })).rejects.toThrow(
    "PILOT_TLS_BOOTSTRAP_UNAVAILABLE",
  );
  expect(oldCert.equals(await readFile(join(backup, "customer-tls-cert.pem")))).toBe(true);
});

// Reproduces the real v14/v15 runtime layout: a profile with binding/selection fields and a
// self-signed `CN=127.0.0.1` pair issued with the OpenSSL default `CA:TRUE` constraint.
async function writeLegacyRuntimePair(dir) {
  await writeFile(
    join(dir, "internal-test-profile.json"),
    JSON.stringify({
      environment: "InternalTest",
      database: "isolated_test",
      warning: "DEMO ONLY - simulated payment; synthetic configuration, not real business approval",
      binding: { tenantReference: "synthetic", validUntil: "2026-10-20T02:26:31.598Z" },
      selection: { profileVersion: 1 },
    }),
    { mode: 0o600 },
  );
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
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      join(dir, "customer-tls-key.pem"),
      "-out",
      join(dir, "customer-tls-cert.pem"),
    ],
    { timeout: 30000 },
  );
  for (const name of ["customer-tls-key.pem", "customer-tls-cert.pem"])
    await chmod(join(dir, name), 0o600);
  await chmod(dir, 0o700);
}
test("renewal replaces the real runtime layout's legacy CA:TRUE pair with a CA:FALSE leaf", async () => {
  await writeLegacyRuntimePair(directory);
  const options = { directory, expectedDatabaseName: "isolated_test" };
  const oldCert = await readFile(join(directory, "customer-tls-cert.pem"));
  expect(new X509Certificate(oldCert).ca).toBe(true);
  // Ordinary provisioning still refuses to retain a CA certificate, and says why.
  await expect(provisionPilotTls(options)).rejects.toMatchObject({ reason: "certificate-is-ca" });
  // With 30 days left it is retained; inside the window it is renewed.
  expect(await renewPilotTls(options)).toMatchObject({ status: "Retained" });
  const result = await renewPilotTls({ ...options, renewWithinDays: 30 });
  expect(result).toMatchObject({ status: "Renewed", renewalPerformed: true });
  const renewed = new X509Certificate(await readFile(join(directory, "customer-tls-cert.pem")));
  expect(renewed.ca).toBe(false);
  expect(renewed.subject).toBe("CN=127.0.0.1");
  expect(renewed.subjectAltName).toBe("IP Address:127.0.0.1");
  expect(
    oldCert.equals(await readFile(join(directory, result.backup, "customer-tls-cert.pem"))),
  ).toBe(true);
  expect(await provisionPilotTls(options)).toMatchObject({ status: "Retained" });
});
test("command-line refusal names the failed requirement without key material", async () => {
  await writeLegacyRuntimePair(directory);
  await chmod(join(directory, "customer-tls-key.pem"), 0o644);
  const key = await readFile(join(directory, "customer-tls-key.pem"), "utf8");
  const run = await execute(process.execPath, [script, "renew", directory, "isolated_test", "30"], {
    env: { ...process.env, NODE_ENV: "development" },
  }).catch((error) => error);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("PILOT_TLS_RENEWAL_UNAVAILABLE (pair-file-not-0600)");
  expect(run.stderr).not.toContain(key.split("\n")[1]);
  expect(run.stdout).toBe("");
  const wrong = await execute(process.execPath, [script, "renew", directory, "other_db"], {
    env: { ...process.env, NODE_ENV: "development" },
  }).catch((error) => error);
  expect(wrong.stderr).toContain("(profile-database-mismatch)");
});
