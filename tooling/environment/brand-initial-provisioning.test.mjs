import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { Buffer } from "node:buffer";
import { runInternalBrandInitialProvisioning } from "./brand-initial-provisioning.mjs";

// Controlled composition seams only. The actual installation reader, crypto
// loader, owner plan/config/cookie parsers and administration transaction resource
// run here; real PostgreSQL/Identity/approval proof belongs to native acceptance.
const ports = vi.hoisted(() => ({ database: vi.fn(), factory: vi.fn(), execute: vi.fn() }));
vi.mock("./pilot-connections.mjs", () => ({ createApplicationDatabase: ports.database }));
vi.mock("../../apps/api/dist/brand-initial-provisioning.js", () => ({
  createAuthenticatedBrandInitialProvisioning: ports.factory,
}));
const id = (n) => `018f4f8a-9c2d-7a11-8d01-${String(n).padStart(12, "0")}`;
const cookie = "A".repeat(43);
const issuer = "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_SYNTHETIC";
const errorCode = /^INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE$/u;
let directory, database, configuration, plan;
const save = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
const config = () => ({
  schemaVersion: 1,
  environment: "InternalTest",
  database: "synthetic_initial_brand",
  operator: {
    configuration: {
      environment: "synthetic",
      issuer,
      clientId: "syntheticplatform",
      redirectUri: "https://synthetic.invalid/platform/auth/callback",
      allowedPostLoginPaths: ["/platform/tenants"],
    },
    credentialsFile: "platform-keys.json",
    cookieFile: "platform-cookie",
  },
  workforce: {
    configuration: { environment: "synthetic", issuer, clientIds: ["syntheticworkforce"] },
    credentialsFile: "workforce-keys.json",
    relationships: {
      trustPath: "relationship-trust.json",
      qualifications: [{ actorReference: id(11), qualificationPath: "relationship.json" }],
    },
  },
  approvalFiles: { approvalPath: "approval.json", trustPath: "approval-trust.json" },
  planFile: "plan.json",
});
const staticPlan = () => ({
  profile: "BrandInitialProvisioningPlanV1",
  purposeCode: "BRAND_INITIAL_PROVISIONING",
  environmentReference: id(1),
  operationReference: id(2),
  operatorReference: id(3),
  approvedByReference: id(4),
  approvalEvidenceReference: id(5),
  brand: {
    brandReference: id(6),
    code: "SYNTHETIC",
    displayName: "Controlled test Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
  },
  brandAuditReference: id(7),
  membershipAuditReference: id(8),
  policyAuditReference: id(9),
  policySnapshotReference: id(10),
  recipients: [
    {
      actorReference: id(11),
      membershipReference: id(12),
      workforceRelationshipReference: id(13),
      relationshipEvidenceReference: id(14),
      invitationEvidenceReference: id(15),
      membershipEffectiveUntil: "2027-01-01T00:00:00.000Z",
      roleEffectiveUntil: "2027-01-01T00:00:00.000Z",
      roleReference: id(16),
      roleCode: "initial_admin",
      assignmentReference: id(17),
      grants: [
        { grantReference: id(18), permissionReference: id(19), action: "organization.manage" },
      ],
    },
  ],
});
const keys = (offset) => ({
  version: 1,
  environment: "InternalTest",
  keys: Object.fromEntries(
    [
      "guestSession",
      "guestBinding",
      "pickupDerivation",
      "pickupSelector",
      "merchantEncryption",
      "merchantSelector",
    ].map((name, i) => [name, (i + offset).toString(16).padStart(2, "0").repeat(32)]),
  ),
});
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.clearAllMocks();
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-initial-entry-")));
  await chmod(directory, 0o700);
  configuration = config();
  plan = staticPlan();
  await save("installation.json", {
    schemaVersion: 1,
    environment: "InternalTest",
    database: configuration.database,
    port: 55435,
    roles: { api: "synthetic_api", worker: "synthetic_worker" },
  });
  await save("brand-initial-provisioning.json", configuration);
  await save("platform-keys.json", keys(1));
  await save("workforce-keys.json", keys(10));
  await save("plan.json", plan);
  for (const name of [
    "approval.json",
    "approval-trust.json",
    "relationship-trust.json",
    "relationship.json",
  ])
    await save(name, { synthetic: true });
  await writeFile(join(directory, "platform-cookie"), cookie, { mode: 0o600 });
  await writeFile(join(directory, "api-password"), "f".repeat(64), { mode: 0o600 });
  const connection = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  database = { acquire: vi.fn(async () => connection), close: vi.fn(async () => undefined) };
  ports.database.mockReset().mockResolvedValue(database);
  ports.execute.mockReset().mockResolvedValue({
    profile: "BrandInitialProvisioningResultV1",
    status: "Applied",
    operation: { sensitive: cookie },
  });
  ports.factory.mockReset().mockReturnValue({ execute: ports.execute });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each(["Applied", "AlreadyApplied"])(
  "runs actual local composition and returns only bounded %s",
  async (status) => {
    ports.execute.mockImplementation(async () => {
      const options = ports.factory.mock.calls[0][0];
      await options.transactions.run(async (tx) => {
        await tx.query("SELECT 1 AS synthetic");
      });
      return {
        profile: "BrandInitialProvisioningResultV1",
        status,
        operation: { sensitive: cookie, actorReference: id(3) },
      };
    });
    expect(await runInternalBrandInitialProvisioning({ directory })).toEqual({
      environment: "InternalTest",
      status,
    });
    expect(ports.database).toHaveBeenCalledExactlyOnceWith(
      "api",
      expect.objectContaining({
        host: "127.0.0.1",
        database: configuration.database,
        port: 55435,
      }),
    );
    expect(ports.execute).toHaveBeenCalledExactlyOnceWith(plan);
    const actual = ports.factory.mock.calls[0][0];
    expect(Object.keys(actual).sort()).toEqual([
      "approvalFiles",
      "clock",
      "operator",
      "transactions",
      "workforce",
    ]);
    expect(actual.operator.configuration).toEqual(configuration.operator.configuration);
    expect(actual.operator.cookie).toBe(cookie);
    expect(actual.workforce.configuration).toEqual(configuration.workforce.configuration);
    expect(actual.workforce.relationships).toEqual({
      trustPath: join(directory, "relationship-trust.json"),
      qualifications: [
        { actorReference: id(11), qualificationPath: join(directory, "relationship.json") },
      ],
    });
    expect(actual.approvalFiles).toEqual({
      approvalPath: join(directory, "approval.json"),
      trustPath: join(directory, "approval-trust.json"),
    });
    expect(actual.operator.hasher.hash("synthetic")).not.toBe(
      actual.workforce.hasher.hash("synthetic"),
    );
    const envelope = await actual.operator.envelopes.encrypt("synthetic", "synthetic-context");
    expect(await actual.operator.envelopes.decrypt(envelope, "synthetic-context")).toBe(
      "synthetic",
    );
    await expect(
      actual.workforce.envelopes.decrypt(envelope, "synthetic-context"),
    ).rejects.toThrow();
    const observed = actual.clock.now();
    expect(new Date(observed).toISOString()).toBe(observed);
    const connection = await database.acquire.mock.results[0].value;
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "SET LOCAL statement_timeout = '5s'",
      "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL idle_in_transaction_session_timeout = '5s'",
      "SELECT 1 AS synthetic",
      "COMMIT",
    ]);
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(database.close).toHaveBeenCalledTimes(1);
    // No existing profile/Brand/Store file has been provided or read.
    expect(await readFile(join(directory, "platform-keys.json"), "utf8")).toBe(
      JSON.stringify(keys(1)),
    );
  },
);

it.each(["production", "Live", ""])(
  "refuses non-local process environment %s before resources",
  async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
    expect(ports.database).not.toHaveBeenCalled();
  },
);
it("preserves original replay before deferred relationship-file admission", async () => {
  await rm(join(directory, "relationship.json"));
  await rm(join(directory, "relationship-trust.json"));
  ports.execute.mockResolvedValue({
    profile: "BrandInitialProvisioningResultV1",
    status: "AlreadyApplied",
    operation: {},
  });
  expect(await runInternalBrandInitialProvisioning({ directory })).toEqual({
    environment: "InternalTest",
    status: "AlreadyApplied",
  });
  expect(ports.execute).toHaveBeenCalledExactlyOnceWith(plan);
  // A fresh execution must still ask the actual owner reader for these paths;
  // this seam verifies only that the entry does not replace that arbitration.
  ports.execute.mockRejectedValue(new Error("SYNTHETIC_OWNING_RELATIONSHIP_UNAVAILABLE"));
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  expect(database.close).toHaveBeenCalledTimes(2);
});
it.each([
  (c) => {
    c.extra = true;
  },
  (c) => {
    c.environment = "Production";
  },
  (c) => {
    c.database = "different";
  },
  (c) => {
    c.operator.currentActor = true;
  },
  (c) => {
    c.participants = {};
  },
  (c) => {
    c.operator.configuration.allow = true;
  },
  (c) => {
    c.operator.configuration.redirectUri = "http://synthetic.invalid/platform/auth/callback";
  },
  (c) => {
    c.operator.configuration.redirectUri =
      "https://synthetic.invalid/platform/auth/callback?cookie=secret";
  },
  (c) => {
    c.operator.configuration.allowedPostLoginPaths = ["//foreign.invalid"];
  },
  (c) => {
    c.workforce.configuration.accountKind = "Platform";
  },
  (c) => {
    c.workforce.relationships.qualifications[0].actorReference = id(99);
  },
  (c) => {
    c.workforce.relationships.qualifications.push(c.workforce.relationships.qualifications[0]);
  },
  (c) => {
    c.workforce.credentialsFile = c.operator.credentialsFile;
  },
  (c) => {
    c.planFile = "../plan.json";
  },
  (c) => {
    c.planFile = "/tmp/plan.json";
  },
  (c) => {
    c.approvalFiles.trustPath = "subdir/trust.json";
  },
])("refuses unsafe or injected configuration before opening pool %#", async (change) => {
  change(configuration);
  await save("brand-initial-provisioning.json", configuration);
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  expect(ports.database).not.toHaveBeenCalled();
  expect(ports.factory).not.toHaveBeenCalled();
});
it("rejects malformed owning plan and raw-cookie header/newline rather than forwarding them", async () => {
  plan.recipients[0].grants[0].action = "commerce.manage";
  await save("plan.json", plan);
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  await save("plan.json", staticPlan());
  for (const value of [cookie + "\n", "__Host-bop-platform=" + cookie, JSON.stringify(cookie)]) {
    await writeFile(join(directory, "platform-cookie"), value);
    await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  }
  expect(ports.database).not.toHaveBeenCalled();
});
it("rejects public directory, file modes, hardlinks and symlinks without following secrets", async () => {
  await chmod(directory, 0o755);
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  await chmod(directory, 0o700);
  for (const name of [
    "brand-initial-provisioning.json",
    "platform-cookie",
    "platform-keys.json",
    "approval.json",
    "api-password",
  ]) {
    await chmod(join(directory, name), 0o644);
    await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
    await chmod(join(directory, name), 0o600);
  }
  await link(join(directory, "platform-cookie"), join(directory, "cookie-hardlink"));
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  await rm(join(directory, "cookie-hardlink"));
  await rename(join(directory, "platform-cookie"), join(directory, "cookie-target"));
  await symlink(join(directory, "cookie-target"), join(directory, "platform-cookie"));
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  expect(ports.database).not.toHaveBeenCalled();
});
it("bounds file bytes and UTF-8/JSON failures, and never replaces missing credential files", async () => {
  const path = join(directory, "approval.json");
  for (const bytes of [
    "x".repeat(65537),
    "synthetic-secret-invalid-json",
    Buffer.from([0xff, 0xfe]),
  ]) {
    await writeFile(path, bytes);
    await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  }
  await save("approval.json", {});
  await rm(join(directory, "platform-keys.json"));
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  await expect(readFile(join(directory, "platform-keys.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(ports.database).not.toHaveBeenCalled();
});
it("denies an extra input or accessor without invoking it", async () => {
  const getter = vi.fn(() => directory);
  await expect(
    runInternalBrandInitialProvisioning({
      get directory() {
        return getter();
      },
    }),
  ).rejects.toThrow(errorCode);
  await expect(runInternalBrandInitialProvisioning({ directory, allow: true })).rejects.toThrow(
    errorCode,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(ports.database).not.toHaveBeenCalled();
});
it.each(["factory", "execute", "result", "resource", "close"])(
  "closes acquired pool and hides errors at %s",
  async (failure) => {
    if (failure === "factory")
      ports.factory.mockImplementation(() => {
        throw new Error(cookie);
      });
    if (failure === "execute") ports.execute.mockRejectedValue(new Error(cookie));
    if (failure === "result")
      ports.execute.mockResolvedValue({
        profile: "BrandInitialProvisioningResultV1",
        status: cookie,
      });
    if (failure === "resource") database.acquire = undefined;
    if (failure === "close") database.close.mockRejectedValue(new Error(cookie));
    await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
    expect(database.close).toHaveBeenCalledTimes(1);
  },
);
it("bounds pool creation failure without attempting to close a nonexistent pool", async () => {
  ports.database.mockRejectedValue(new Error(cookie));
  await expect(runInternalBrandInitialProvisioning({ directory })).rejects.toThrow(errorCode);
  expect(database.close).not.toHaveBeenCalled();
});
it.each([
  { args: [] },
  { args: ["--directory"] },
  { args: ["--directory", "relative"] },
  { args: ["--directory", "/tmp", "--allow"] },
  { args: ["--cookie", "synthetic-argv"] },
])("CLI refuses malformed invocation with only one fixed error %#", async ({ args }) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "./tooling/environment/register-workspace-typescript.mjs",
      "./tooling/environment/brand-initial-provisioning.mjs",
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      timeout: 30000,
      encoding: "utf8",
    },
  ).then(
    (value) => ({ ...value, code: 0 }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE\n",
  });
});
