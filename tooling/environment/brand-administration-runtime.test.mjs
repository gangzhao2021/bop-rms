import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, chmod, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInternalBrandAdministrationRuntime,
  createRuntime,
} from "./brand-administration-runtime.mjs";
import { createCognitoMerchantBrandAdministrationRuntime } from "../../apps/api/dist/merchant-brand-administration-runtime.js";

// Actual private-file, stable crypto, owner configuration parsers, TLS pair and
// transaction resource; only database/API-server/application seams are controlled.
// This is not live Provider or native deployment evidence.
const ports = vi.hoisted(() => ({ database: vi.fn(), server: vi.fn(), application: vi.fn() }));
vi.mock("./pilot-connections.mjs", () => ({ createApplicationDatabase: ports.database }));
vi.mock("../../apps/api/dist/server.js", () => ({ createApiServerRuntime: ports.server }));
vi.mock("../../apps/api/dist/merchant-brand-application.js", () => ({
  createMerchantBrandApplication: ports.application,
}));
const issuer = "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_SYNTHETIC";
let tlsDirectory, directory, configuration, database, server;
const save = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
beforeAll(async () => {
  tlsDirectory = await realpath(await mkdtemp(join(tmpdir(), "bop-startup-tls-")));
  await chmod(tlsDirectory, 0o700);
  // Same installed OpenSSL command already used by the repository TLS bootstrap,
  // solely to generate ephemeral test material; startup never calls it.
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-keyout",
    join(tlsDirectory, "key.pem"),
    "-out",
    join(tlsDirectory, "cert.pem"),
  ]);
});
afterAll(async () => {
  await rm(tlsDirectory, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.clearAllMocks();
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-startup-")));
  await chmod(directory, 0o700);
  configuration = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_startup",
    exactOrigin: "https://127.0.0.1:4443",
    workforce: {
      environment: "synthetic",
      issuer,
      clientId: "syntheticworkforce",
      managedLoginOrigin: "https://synthetic.auth.ca-central-1.amazoncognito.com",
      clientSecretFile: "client-secret",
      credentialsFile: "workforce-keys.json",
    },
    tls: { keyFile: "key.pem", certificateFile: "cert.pem" },
  };
  await save("installation.json", {
    schemaVersion: 1,
    environment: "InternalTest",
    database: configuration.database,
    port: 55435,
    roles: { api: "synthetic_api", worker: "synthetic_worker" },
  });
  await save("brand-administration.json", configuration);
  await save("workforce-keys.json", {
    environment: "InternalTest",
    version: 1,
    keys: Object.fromEntries(
      [
        "guestSession",
        "guestBinding",
        "pickupDerivation",
        "pickupSelector",
        "merchantEncryption",
        "merchantSelector",
      ].map((name, i) => [name, (i + 1).toString(16).padStart(2, "0").repeat(32)]),
    ),
  });
  for (const [name, value] of [
    ["client-secret", "synthetic-client-secret"],
    ["api-password", "f".repeat(64)],
    ["key.pem", await readFile(join(tlsDirectory, "key.pem"))],
    ["cert.pem", await readFile(join(tlsDirectory, "cert.pem"))],
  ])
    await writeFile(join(directory, name), value, { mode: 0o600 });
  const connection = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  database = {
    acquire: vi.fn(async () => connection),
    probe: vi.fn(async () => "ready"),
    close: vi.fn(async () => undefined),
  };
  server = {
    server: { synthetic: true },
    healthReadiness: { synthetic: true },
    listen: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  ports.database.mockReset().mockResolvedValue(database);
  ports.server.mockReset().mockReturnValue(server);
  ports.application.mockReset().mockResolvedValue(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("composes unselected loopback HTTPS without a Brand/Store profile or implicit provisioning", async () => {
  const runtime = await createInternalBrandAdministrationRuntime({ directory, port: 4443 }),
    options = ports.server.mock.calls[0][0];
  expect(options.host).toBe("127.0.0.1");
  expect(options.tls.key).toContain("PRIVATE KEY");
  expect(options.tls.cert).toContain("CERTIFICATE");
  options.healthReadiness.completeStartup();
  expect((await options.healthReadiness.readinessSnapshot()).dependencies.database.status).toBe(
    "ready",
  );
  expect(database.probe).toHaveBeenCalledTimes(2);
  const brand = options.brandCognitoAdministrationRuntime;
  expect(createCognitoMerchantBrandAdministrationRuntime(brand).brandReference).toBe(null);
  expect(brand).not.toHaveProperty("brandReference");
  expect(brand).not.toHaveProperty("configuration");
  expect(brand).not.toHaveProperty("onboarding");
  expect(brand.identity.configuration).toMatchObject({
    environment: "synthetic",
    issuer,
    redirectUri: "https://127.0.0.1:4443/merchant/organization/brands/callback",
    logoutReturnUri: "https://127.0.0.1:4443/app/organization/brands",
  });
  expect(ports.application.mock.calls[0][0]).toMatchObject({ acceptedHost: "127.0.0.1:4443" });
  expect(ports.application.mock.calls[0][0].directory).toMatch(/apps\/merchant-web\/dist\/$/u);
  expect(brand.identity.credentials.generate()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(brand.identity.credentials.generateUuidV7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  const aad = "synthetic:controlled-startup",
    encrypted = await brand.identity.envelopes.encrypt("controlled", aad);
  expect(await brand.identity.envelopes.decrypt(encrypted, aad)).toBe("controlled");
  await brand.transactions.run(async (tx) => {
    await tx.query("SELECT 1", []);
  });
  await runtime.listen();
  await Promise.all([runtime.shutdown("SIGTERM"), runtime.shutdown("SIGINT")]);
  expect(server.shutdown).toHaveBeenCalledTimes(1);
  expect(database.close).toHaveBeenCalledTimes(1);
  await expect(runtime.listen()).rejects.toThrow("INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE");
});
const onboardingConfiguration = () => ({
  environmentReference: "0190ed60-0000-7000-8000-000000000001",
  acceptanceRoleName: "synthetic_api",
  files: {
    planPath: "onboarding-plan.json",
    approvalPath: "onboarding-approval.json",
    approvalTrustPath: "onboarding-approval-trust.json",
    relationshipPath: "onboarding-relationship.json",
    relationshipTrustPath: "onboarding-relationship-trust.json",
  },
});
it("forwards explicit onboarding files lazily to the real configured runtime", async () => {
  configuration.onboarding = onboardingConfiguration();
  await save("brand-administration.json", configuration);
  const runtime = await createInternalBrandAdministrationRuntime({ directory, port: 4443 });
  const brand = ports.server.mock.calls[0][0].brandCognitoAdministrationRuntime;
  expect(brand.onboarding).toEqual({
    ...configuration.onboarding,
    files: Object.fromEntries(
      Object.entries(configuration.onboarding.files).map(([name, file]) => [
        name,
        join(directory, file),
      ]),
    ),
  });
  expect(Object.isFrozen(brand.onboarding)).toBe(true);
  expect(Object.isFrozen(brand.onboarding.files)).toBe(true);
  const actual = createCognitoMerchantBrandAdministrationRuntime(brand);
  expect(typeof actual.service.startInvitation).toBe("function");
  // These intentionally absent files cannot confer approval at startup; their
  // real owners must read and verify them before an invitation can be accepted.
  expect(database.acquire).not.toHaveBeenCalled();
  await runtime.shutdown("SIGTERM");
});
it.each(["null", "extra", "reference", "role", "path", "collision", "duplicate"])(
  "rejects explicit malformed onboarding %s before database construction",
  async (kind) => {
    const onboarding = onboardingConfiguration();
    if (kind === "extra") onboarding.approved = true;
    if (kind === "reference") onboarding.environmentReference = "invalid";
    if (kind === "role") onboarding.acceptanceRoleName = "invalid role";
    if (kind === "path") onboarding.files.planPath = "../plan.json";
    if (kind === "collision") onboarding.files.planPath = "api-password";
    if (kind === "duplicate") onboarding.files.approvalPath = onboarding.files.planPath;
    configuration.onboarding = kind === "null" ? null : onboarding;
    await save("brand-administration.json", configuration);
    await expect(
      createInternalBrandAdministrationRuntime({ directory, port: 4443 }),
    ).rejects.toThrow(/^INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE$/u);
    expect(ports.database).not.toHaveBeenCalled();
    expect(ports.server).not.toHaveBeenCalled();
  },
);
it.each([
  "production",
  "port",
  "origin",
  "Brand",
  "environment",
  "database",
  "filename",
  "same-file",
  "secret",
  "tls",
  "permissions",
])("refuses %s before database/server construction", async (kind) => {
  if (kind === "production") vi.stubEnv("NODE_ENV", "production");
  if (kind === "port") configuration.exactOrigin = "https://127.0.0.1:4444";
  if (kind === "origin") configuration.exactOrigin = "https://remote.invalid:4443";
  if (kind === "Brand") configuration.brandReference = "not-allowed";
  if (kind === "environment") delete configuration.workforce.environment;
  if (kind === "database") configuration.database = "other";
  if (kind === "filename") configuration.workforce.clientSecretFile = "../secret";
  if (kind === "same-file")
    configuration.workforce.clientSecretFile = configuration.workforce.credentialsFile;
  if (kind === "secret") await writeFile(join(directory, "client-secret"), "secret\n");
  if (kind === "tls") await writeFile(join(directory, "cert.pem"), "invalid private certificate");
  if (kind === "permissions") await chmod(join(directory, "key.pem"), 0o644);
  await save("brand-administration.json", configuration);
  await expect(createInternalBrandAdministrationRuntime({ directory, port: 4443 })).rejects.toThrow(
    /^INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE$/u,
  );
  expect(ports.database).not.toHaveBeenCalled();
  expect(ports.server).not.toHaveBeenCalled();
});
it("refuses symlink key files and never creates missing key material", async () => {
  await rm(join(directory, "key.pem"));
  await symlink(join(tlsDirectory, "key.pem"), join(directory, "key.pem"));
  await expect(createInternalBrandAdministrationRuntime({ directory, port: 4443 })).rejects.toThrow(
    "INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE",
  );
  expect(ports.database).not.toHaveBeenCalled();
});
it.each(["probe", "application", "constructor", "listen", "shutdown"])(
  "closes the existing pool exactly once after %s failure without private error leakage",
  async (stage) => {
    const secret = new Error("private connection and certificate details");
    if (stage === "probe") database.probe.mockResolvedValue("not_ready");
    if (stage === "application") ports.application.mockRejectedValue(secret);
    if (stage === "constructor")
      ports.server.mockImplementation(() => {
        throw secret;
      });
    if (stage === "listen") server.listen.mockRejectedValue(secret);
    if (stage === "shutdown") server.shutdown.mockRejectedValue(secret);
    if (["listen", "shutdown"].includes(stage)) {
      const runtime = await createInternalBrandAdministrationRuntime({ directory, port: 4443 });
      await expect(
        stage === "listen" ? runtime.listen() : runtime.shutdown("SIGTERM"),
      ).rejects.toThrow(/^INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE$/u);
    } else
      await expect(
        createInternalBrandAdministrationRuntime({ directory, port: 4443 }),
      ).rejects.toThrow(/^INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE$/u);
    expect(database.close).toHaveBeenCalledTimes(1);
  },
);
it("uses only the mandatory private directory environment through existing process contract", async () => {
  vi.stubEnv("BOP_BRAND_ADMINISTRATION_DIRECTORY", "");
  await expect(createRuntime({ port: 4443 })).rejects.toThrow(
    "INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE",
  );
  vi.stubEnv("BOP_BRAND_ADMINISTRATION_DIRECTORY", directory);
  const runtime = await createRuntime({ port: 4443 });
  await runtime.shutdown("SIGTERM");
});
