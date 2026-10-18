import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  parseRenewalArguments,
  renewInternalTestInstallation,
} from "./pilot-internal-test-renew.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./pilot-internal-test-renew.mjs", import.meta.url));
const DAY = 86400000;
const OLD = "2026-10-20T02:26:31.598Z";
const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const UNTIL = "2026-11-14T02:26:31.598Z";
const database = "isolated_test";
const scope = {
  tenantReference: "0190ed16-0000-7000-8000-00000000005a",
  brandReference: "00000000-0000-7000-8000-000000000002",
  storeReference: "00000000-0000-7000-8000-000000000003",
};
const fixtures = () => ({
  "installation.json": {
    schemaVersion: 1,
    environment: "InternalTest",
    database,
    port: 1,
    roles: { api: "isolated_api", worker: "isolated_worker" },
  },
  "internal-test-menu.json": {
    environment: "InternalTest",
    database,
    skuReference: "0190fa20-0000-7000-8000-00000000000d",
    taxClassificationReference: "0190fa20-0000-7000-8000-000000000100",
  },
  "internal-test-profile.json": {
    environment: "InternalTest",
    database,
    warning: "DEMO ONLY - simulated payment; synthetic configuration, not real business approval",
    createdAt: "2026-09-20T02:26:31.598Z",
    binding: {
      ...scope,
      publicStoreReference: "00000000-0000-7000-8000-000000000001",
      lookupEvidenceReference: "00000000-0000-7000-8000-000000000004",
      validFrom: "2026-09-20T02:26:31.598Z",
      validUntil: OLD,
    },
    selection: { profileReference: "00000000-0000-7000-8000-000000000005", profileVersion: 1 },
  },
  "internal-test-merchant.json": {
    schemaVersion: 2,
    environment: "InternalTest",
    database,
    scope,
    actors: [
      {
        selector: "staff",
        actorReference: "0190fa30-0000-7000-8000-000000000100",
        validUntil: OLD,
      },
      {
        selector: "kitchen",
        actorReference: "0190fa30-0000-7000-8000-000000000200",
        validUntil: OLD,
      },
    ],
  },
  "internal-test-merchant.v1-backup.json": {
    environment: "InternalTest",
    database,
    scope,
    actorReference: "0190fa30-0000-7000-8000-000000000100",
    validUntil: OLD,
  },
  "internal-test-dining-table.json": {
    environment: "InternalTest",
    database,
    scope,
    tableReference: "0190fa49-0000-7000-8000-000000000001",
    publicTableReference: "0190fa49-0000-7000-8000-000000000003",
    label: "DEMO-01",
    qrVersion: 1,
    createdAt: "2026-09-20T02:26:31.598Z",
    validUntil: OLD,
    warning: "DEMO setup only; not actual Store approval",
  },
  "internal-test-task-queue.json": {
    environment: "InternalTest",
    database,
    ...scope,
    queueReference: "01a0bfd6-b825-709e-aafb-28e2b84a2ebc",
    effectiveFrom: "2026-09-20T17:21:55.191Z",
    effectiveUntil: OLD,
    exceptionTaskPolicy: {
      policyReference: "01a0c6c4-96a2-73f4-870e-3b34a4c2fd95",
      version: 1,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      managerQueueReference: "01a0bfd6-b825-709e-aafb-28e2b84a2ebc",
      dueAfterMilliseconds: 3600000,
      effectiveFrom: "2026-09-20T17:21:55.191Z",
      effectiveUntil: OLD,
    },
  },
  "customer-runtime.json": {
    environment: "InternalTest",
    database,
    diningTableFiles: ["internal-test-dining-table.json"],
  },
});
let directory;
async function install(values) {
  for (const [name, value] of Object.entries(values))
    await writeFile(
      join(directory, name),
      name === "internal-test-merchant.json"
        ? JSON.stringify(value, null, 2)
        : JSON.stringify(value),
      { mode: 0o600 },
    );
}
const TAX_VERSION = { versionNumber: 2, createdAt: new Date(NOW).toISOString() };
/** Stands in for the database renewal (covered by internal-test-renewal-acceptance). */
let databaseCalls;
const databaseResult = (input, status = input.dryRun ? "Planned" : "Renewed") => ({
  status,
  role: database + "_internal_test_renewal",
  readRole: input.readRole,
  from: input.from,
  to: input.to,
  membership: [],
  permission: [],
  policyVersion: null,
  liveGates: [],
  tax: {
    status: "AlreadyRenewed",
    version: { reference: "x", number: 2 },
    createdAt: TAX_VERSION.createdAt,
  },
  taxConfigurationVersion: TAX_VERSION,
  alreadyRenewed: 0,
  checks: {
    before: { at: input.to, roster: {}, launchGate: "Refused", tax: "Refused" },
    after: { at: input.to, roster: { a: 1 }, launchGate: "Accepted", tax: "Accepted" },
  },
});
const renewDatabase = async (input) => {
  databaseCalls.push(input);
  return databaseResult(input);
};
const options = (extra = {}) => ({
  directory,
  expectedDatabaseName: database,
  until: UNTIL,
  reason: "Continue internal testing for four weeks",
  approvedBy: "Test Owner",
  approval: "TEST: renew the internal test installation",
  now: NOW,
  renewDatabase,
  ...extra,
});
const snapshot = async () => {
  const result = {};
  for (const name of (await readdir(directory)).sort())
    if (name.endsWith(".json")) result[name] = await readFile(join(directory, name), "utf8");
  return result;
};
beforeEach(async () => {
  databaseCalls = [];
  vi.stubEnv("NODE_ENV", "development");
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-internal-renew-")));
  await chmod(directory, 0o700);
  await install(fixtures());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test("dry run lists every window change and writes nothing", async () => {
  const before = await snapshot();
  const result = await renewInternalTestInstallation(options({ dryRun: true }));
  expect(result.status).toBe("Planned");
  expect(result.changes.map((change) => change.file + " " + change.path)).toEqual([
    "internal-test-merchant.json actors[0].validUntil",
    "internal-test-merchant.json actors[1].validUntil",
    "internal-test-dining-table.json validUntil",
    "internal-test-task-queue.json effectiveUntil",
    "internal-test-task-queue.json exceptionTaskPolicy.effectiveUntil",
    "internal-test-profile.json binding.validUntil",
    "internal-test-profile.json taxConfigurationVersion",
  ]);
  expect(
    result.changes
      .filter((change) => change.path !== "taxConfigurationVersion")
      .every((change) => change.from === OLD && change.to === UNTIL),
  ).toBe(true);
  expect(result.changes.at(-1)).toMatchObject({ from: null, to: JSON.stringify(TAX_VERSION) });
  expect(result.historicalCopiesUnchanged).toEqual(["internal-test-merchant.v1-backup.json"]);
  expect(result.databaseArtefactsNotRenewed.length).toBe(2);
  // The database half ran as a dry run with the installation's expiry and the services' role.
  expect(databaseCalls).toEqual([
    expect.objectContaining({
      dryRun: true,
      from: OLD,
      to: UNTIL,
      now: NOW,
      readRole: "isolated_api",
      evidence: expect.objectContaining({
        approvedBy: "Test Owner",
        approval: "TEST: renew the internal test installation",
      }),
    }),
  ]);
  expect(await snapshot()).toEqual(before);
  expect((await readdir(directory)).filter((name) => name.includes("renew"))).toEqual([]);
});

test("renewal moves only the windows, keeps previous bytes and writes the record and log", async () => {
  const before = await snapshot();
  const result = await renewInternalTestInstallation(options());
  expect(result.status).toBe("Renewed");
  const after = await snapshot();
  for (const name of Object.keys(before)) {
    const changed = before[name].replaceAll(OLD, UNTIL);
    if (name === "internal-test-profile.json")
      expect(JSON.parse(after[name])).toEqual({
        ...JSON.parse(changed),
        taxConfigurationVersion: TAX_VERSION,
      });
    else expect(after[name]).toBe(name.includes("v1-backup") ? before[name] : changed);
  }
  const record = join(directory, result.record);
  for (const file of result.files) {
    expect(await readFile(join(record, file.file), "utf8")).toBe(before[file.file]);
  }
  const evidence = JSON.parse(await readFile(join(record, "renewal.json"), "utf8"));
  expect(evidence).toMatchObject({
    kind: "InternalTestRenewal",
    approvedBy: "Test Owner",
    approval: "TEST: renew the internal test installation",
    reason: "Continue internal testing for four weeks",
    previousValidUntil: OLD,
    validUntil: UNTIL,
    databaseRenewal: expect.objectContaining({ status: "Renewed" }),
  });
  const log = (await readFile(join(directory, "internal-test-renewal-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toEqual([
    expect.objectContaining({
      status: "Completed",
      from: OLD,
      to: UNTIL,
      databaseStatus: "Renewed",
    }),
  ]);
  expect((await readdir(directory)).filter((name) => name.startsWith(".internal-test"))).toEqual(
    [],
  );
  const again = await renewInternalTestInstallation(
    options({
      now: NOW + 1,
      renewDatabase: async (input) => databaseResult(input, "AlreadyRenewed"),
    }),
  );
  expect(again.status).toBe("AlreadyRenewed");
  expect(again.changes).toEqual([]);
});

test("a database refusal leaves every file as it was", async () => {
  const before = await snapshot();
  const refusal = Object.assign(new Error("PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE"), {
    reason: "internal-test-membership-not-synthetic",
  });
  await expect(
    renewInternalTestInstallation(
      options({
        renewDatabase: async () => {
          throw refusal;
        },
      }),
    ),
  ).rejects.toMatchObject({ reason: "internal-test-membership-not-synthetic" });
  expect(await snapshot()).toEqual(before);
  expect((await readdir(directory)).filter((name) => name.includes("renew"))).toEqual([]);
});

test("refuses without the database renewal and before it when a file is not synthetic", async () => {
  await expect(
    renewInternalTestInstallation(options({ renewDatabase: undefined })),
  ).rejects.toMatchObject({ reason: "database-renewal-missing" });
  const values = fixtures();
  values["internal-test-dining-table.json"].label = "Table 1";
  await install(values);
  await expect(renewInternalTestInstallation(options())).rejects.toMatchObject({
    reason: "table-not-labelled-demo",
  });
  expect(databaseCalls).toEqual([]);
});

test("an interrupted renewal (profile still old) is finished by running it again", async () => {
  const values = fixtures();
  values["internal-test-merchant.json"].actors.forEach((actor) => (actor.validUntil = UNTIL));
  await install({ "internal-test-merchant.json": values["internal-test-merchant.json"] });
  const result = await renewInternalTestInstallation(options());
  expect(result.status).toBe("Renewed");
  expect(result.files.map((file) => file.file)).not.toContain("internal-test-merchant.json");
});

test.each([
  ["a Pilot profile", (v) => (v["internal-test-profile.json"].environment = "Pilot")],
  ["a profile without the DEMO label", (v) => (v["internal-test-profile.json"].warning = "Store")],
  [
    "a real-looking Store identity",
    (v) =>
      (v["internal-test-profile.json"].binding.storeReference =
        "01a0c5df-b8f6-75fa-ace1-94ba2c15c76d"),
  ],
  [
    "a real-looking staff identity",
    (v) =>
      (v["internal-test-merchant.json"].actors[0].actorReference =
        "01a0c5df-b8f6-75fa-ace1-94ba2c15c76d"),
  ],
  [
    "a real launch gate requirement",
    (v) =>
      (v["internal-test-profile.json"].operating = { liveGateRequirementCodes: ["FOOD_LICENCE"] }),
  ],
  ["a non-DEMO table", (v) => (v["internal-test-dining-table.json"].label = "Table 1")],
  ["another Store's queue", (v) => (v["internal-test-task-queue.json"].storeReference = "x")],
  [
    "a window changed individually",
    (v) => (v["internal-test-dining-table.json"].validUntil = UNTIL.replace("11-14", "11-01")),
  ],
  ["a Pilot installation", (v) => (v["installation.json"].environment = "Pilot")],
])("refuses %s and changes nothing", async (_, change) => {
  const values = fixtures();
  change(values);
  await install(values);
  const before = await snapshot();
  await expect(renewInternalTestInstallation(options())).rejects.toThrow(
    "PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE",
  );
  expect(await snapshot()).toEqual(before);
});

test.each([
  ["beyond 30 days", { until: new Date(NOW + 31 * DAY).toISOString() }, "until-beyond-30-days"],
  ["in the past", { until: "2026-10-17T00:00:00.000Z" }, "until-not-in-future"],
  [
    "shorter than now",
    { now: Date.parse("2026-10-19T00:00:00.000Z"), until: "2026-10-19T12:00:00.000Z" },
    "until-shortens-window",
  ],
  ["non-canonical", { until: "2026-11-14" }, "until-invalid"],
  ["another database", { expectedDatabaseName: "other_db" }, "database-mismatch"],
  ["without approval wording", { approval: "" }, "approval-wording-invalid"],
  ["without a reason", { reason: "short" }, "reason-invalid"],
])("refuses an until or input %s", async (_, extra, reason) => {
  await expect(renewInternalTestInstallation(options(extra))).rejects.toMatchObject({ reason });
});

test("refuses outside development mode and for a file that is not owner-only", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await expect(renewInternalTestInstallation(options())).rejects.toMatchObject({
    reason: "not-development-mode",
  });
  vi.stubEnv("NODE_ENV", "development");
  await chmod(join(directory, "internal-test-profile.json"), 0o644);
  await expect(renewInternalTestInstallation(options())).rejects.toMatchObject({
    reason: "file-not-0600",
  });
});

test("argument parsing needs every flag once", () => {
  const args = [
    directory,
    "--database",
    database,
    "--until",
    UNTIL,
    "--reason",
    "r",
    "--approved-by",
    "a",
    "--approval",
    "w",
    "--migration-env",
    "e",
  ];
  expect(parseRenewalArguments([...args, "--dry-run"])).toMatchObject({
    dryRun: true,
    envFile: "e",
  });
  expect(() => parseRenewalArguments(args.slice(0, -2))).toThrow();
  expect(() => parseRenewalArguments([...args, "--until", UNTIL])).toThrow();
});

test("command fails closed with a fixed reason before any change", async () => {
  const env = { ...process.env, NODE_ENV: "development" };
  const loader = fileURLToPath(new URL("./register-workspace-typescript.mjs", import.meta.url));
  const args = [
    script,
    directory,
    "--database",
    database,
    "--until",
    new Date(Date.now() + 10 * DAY).toISOString(),
    "--reason",
    "Continue internal testing for ten days",
    "--approved-by",
    "Test Owner",
    "--approval",
    "TEST: renew the internal test installation",
    "--migration-env",
    join(directory, "missing.env"),
  ];
  const before = await snapshot();
  await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE (typescript-loader-missing)",
    ),
  });
  await expect(
    execute(process.execPath, ["--import", loader, ...args, "--dry-run"], { env }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE (env-file-invalid)"),
  });
  await expect(execute(process.execPath, args.slice(0, -2), { env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("(arguments-invalid)"),
  });
  expect(await snapshot()).toEqual(before);
});
