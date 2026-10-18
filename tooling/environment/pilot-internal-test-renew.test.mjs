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
  "installation.json": { schemaVersion: 1, environment: "InternalTest", database, port: 1 },
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
const options = (extra = {}) => ({
  directory,
  expectedDatabaseName: database,
  until: UNTIL,
  reason: "Continue internal testing for four weeks",
  approvedBy: "Test Owner",
  approval: "TEST: renew the internal test installation",
  now: NOW,
  ...extra,
});
const snapshot = async () => {
  const result = {};
  for (const name of (await readdir(directory)).sort())
    if (name.endsWith(".json")) result[name] = await readFile(join(directory, name), "utf8");
  return result;
};
beforeEach(async () => {
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
  ]);
  expect(result.changes.every((change) => change.from === OLD && change.to === UNTIL)).toBe(true);
  expect(result.historicalCopiesUnchanged).toEqual(["internal-test-merchant.v1-backup.json"]);
  expect(result.databaseArtefactsNotRenewed.length).toBe(4);
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
    expect(after[name]).toBe(name.includes("v1-backup") ? before[name] : changed);
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
  });
  const log = (await readFile(join(directory, "internal-test-renewal-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toEqual([expect.objectContaining({ status: "Completed", from: OLD, to: UNTIL })]);
  expect((await readdir(directory)).filter((name) => name.startsWith(".internal-test"))).toEqual(
    [],
  );
  expect((await renewInternalTestInstallation(options({ now: NOW + 1 }))).status).toBe(
    "AlreadyRenewed",
  );
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
  ];
  expect(parseRenewalArguments([...args, "--dry-run"])).toMatchObject({ dryRun: true });
  expect(() => parseRenewalArguments(args.slice(0, -2))).toThrow();
  expect(() => parseRenewalArguments([...args, "--until", UNTIL])).toThrow();
});

test("command prints the dry-run plan and fails closed with a fixed reason", async () => {
  const until = new Date(Date.now() + 10 * DAY).toISOString();
  const env = { ...process.env, NODE_ENV: "development" };
  const args = [
    script,
    directory,
    "--database",
    database,
    "--until",
    until,
    "--reason",
    "Continue internal testing for ten days",
    "--approved-by",
    "Test Owner",
    "--approval",
    "TEST: renew the internal test installation",
  ];
  const values = fixtures();
  const future = new Date(Date.now() + DAY).toISOString();
  values["internal-test-profile.json"].binding.validUntil = future;
  values["internal-test-merchant.json"].actors.forEach((actor) => (actor.validUntil = future));
  values["internal-test-dining-table.json"].validUntil = future;
  values["internal-test-task-queue.json"].effectiveUntil = future;
  values["internal-test-task-queue.json"].exceptionTaskPolicy.effectiveUntil = future;
  await install(values);
  const { stdout } = await execute(process.execPath, [...args, "--dry-run"], { env });
  expect(stdout).toContain("Planned (DRY RUN, nothing written)");
  expect(stdout).toContain(
    "internal-test-profile.json  binding.validUntil  " + future + " -> " + until,
  );
  expect(stdout).toContain("NOT renewed (database");
  await expect(
    execute(process.execPath, [...args.slice(0, 3), "other_db", ...args.slice(4)], { env }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE (database-mismatch)"),
  });
});
