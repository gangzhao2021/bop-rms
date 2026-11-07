import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionPilotCredentials } from "./pilot-provision-credentials.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
let directory;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-credential-bootstrap-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const profile = () =>
  writeFile(
    join(directory, "internal-test-profile.json"),
    JSON.stringify({ environment: "InternalTest", database: "isolated_test" }),
    { mode: 0o600 },
  );
test("fresh keys are private and a retry preserves every byte", async () => {
  await profile();
  const options = { directory, expectedDatabaseName: "isolated_test" };
  expect(await provisionPilotCredentials(options)).toEqual({
    status: "Ready",
    application: "Created",
    rotationPerformed: false,
  });
  const files = [
    "internal-test-keys.json",
    "internal-test-dining-key",
    "internal-test-qr-key.pem",
    "guest-abuse-pepper",
  ];
  const before = await Promise.all(files.map((name) => readFile(join(directory, name))));
  for (const name of files) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  expect((await provisionPilotCredentials(options)).application).toBe("Retained");
  const after = await Promise.all(files.map((name) => readFile(join(directory, name))));
  expect(before.every((value, index) => value.equals(after[index]))).toBe(true);
});
test("mismatched profile refuses before generating credentials", async () => {
  await profile();
  await expect(
    provisionPilotCredentials({ directory, expectedDatabaseName: "other" }),
  ).rejects.toThrow("PILOT_CREDENTIAL_BOOTSTRAP_UNAVAILABLE");
  expect(await readdir(directory)).toEqual(["internal-test-profile.json"]);
});

test("Catalog cursors use a stable purpose-separated key without changing persisted keys", async () => {
  await profile();
  await provisionPilotCredentials({ directory, expectedDatabaseName: "isolated_test" });
  const file = join(directory, "internal-test-keys.json"),
    before = await readFile(file),
    options = {
      file,
      expectedDatabaseName: "isolated_test",
      loadProfile: async () => ({ environment: "InternalTest", database: "isolated_test" }),
    },
    first = await createInternalCredentialLoaders(options).createInternalCatalogCursorKey(),
    restarted = await createInternalCredentialLoaders(options).createInternalCatalogCursorKey();
  expect(first.byteLength).toBe(32);
  expect(first.equals(restarted)).toBe(true);
  const saved = JSON.parse(before.toString("utf8"));
  expect(first.toString("hex") === saved.keys.merchantEncryption).toBe(false);
  expect(first.toString("hex") === saved.keys.merchantSelector).toBe(false);
  first.fill(0);
  expect(
    (await createInternalCredentialLoaders(options).createInternalCatalogCursorKey()).equals(
      restarted,
    ),
  ).toBe(true);
  expect((await readFile(file)).equals(before)).toBe(true);
});

test("a missing Catalog cursor key source never provisions a new credential", async () => {
  await profile();
  const file = join(directory, "internal-test-keys.json");
  await expect(
    createInternalCredentialLoaders({
      file,
      expectedDatabaseName: "isolated_test",
      loadProfile: async () => ({ environment: "InternalTest", database: "isolated_test" }),
    }).createInternalCatalogCursorKey(),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual(["internal-test-profile.json"]);
});
