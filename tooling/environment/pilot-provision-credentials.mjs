import process from "node:process";
import { readFile, lstat, realpath, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
const unavailable = () => {
  throw new Error("PILOT_CREDENTIAL_BOOTSTRAP_UNAVAILABLE");
};
/** Explicit local provisioning. Never replaces keys or changes database authority. */
export async function provisionPilotCredentials({ directory, expectedDatabaseName }) {
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
  const loadProfile = async () =>
    JSON.parse(await readFile(join(directory, "internal-test-profile.json"), "utf8"));
  const profile = await loadProfile();
  if (profile.environment !== "InternalTest" || profile.database !== expectedDatabaseName)
    return unavailable();
  const common = { loadProfile, expectedDatabaseName };
  const application = await createInternalCredentialLoaders({
    ...common,
    file: join(directory, "internal-test-keys.json"),
  }).provisionInternalTestCredentials();
  await createInternalDiningCredentialLoaders({
    path: join(directory, "internal-test-dining-key"),
  }).provisionInternalDiningCredentials();
  await createInternalQrLoaders({
    ...common,
    file: join(directory, "internal-test-qr-key.pem"),
  }).provisionInternalQr();
  const pepper = join(directory, "guest-abuse-pepper");
  let handle;
  try {
    handle = await open(pepper, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") return unavailable();
  }
  if (handle) {
    try {
      await handle.writeFile(randomBytes(32).toString("hex"));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const stored = await lstat(pepper);
  if (
    !stored.isFile() ||
    stored.isSymbolicLink() ||
    stored.uid !== process.getuid() ||
    (stored.mode & 0o777) !== 0o600 ||
    (await realpath(pepper)) !== pepper ||
    !/^[a-f0-9]{64}$/u.test(await readFile(pepper, "utf8"))
  )
    return unavailable();
  return Object.freeze({ status: "Ready", application, rotationPerformed: false });
}
