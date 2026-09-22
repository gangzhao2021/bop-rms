import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionPilotTls } from "./pilot-provision-tls.mjs";
let directory;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  directory = await mkdtemp(join(tmpdir(), "bop-tls-bootstrap-"));
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
