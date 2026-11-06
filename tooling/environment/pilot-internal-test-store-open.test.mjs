import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  issueStoreDirectoryWithOwnSite,
  parseStoreOpenArguments,
} from "./pilot-internal-test-store-open.mjs";

it("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: takes exactly the setup or directory arguments", () => {
  const setup = parseStoreOpenArguments([
    "setup",
    "/app/.local/pilot-v15",
    "--database",
    "bop_rms_pilot_v15",
    "--migration-env",
    ".local/migrate-v14/migrate-v15.env",
    "--store",
    "01909a2e-1000-7000-8000-000000000010",
    "--approver",
    "0190fa30-0000-7000-8000-000000000200",
    "--reason",
    "Multi-store live check",
    "--approved-by",
    "Owner",
    "--approval",
    "Coordinator 2026-10-30",
    "--dry-run",
  ]);
  expect(setup).toMatchObject({ command: "setup", dryRun: true, approvedBy: "Owner" });
  expect(setup).not.toHaveProperty("name");
  const directoryArgs = [
    "directory",
    "/app/.local/pilot-v15",
    "--database",
    "bop_rms_pilot_v15",
    "--migration-env",
    ".local/migrate-v14/migrate-v15.env",
    "--store",
    "01909a2e-1000-7000-8000-000000000010",
    "--name",
    "demo-2",
  ];
  // v15 2026-10-31 (option B): the Store's own default stock site is read from the database.
  expect(parseStoreOpenArguments(directoryArgs)).toMatchObject({
    command: "directory",
    name: "demo-2",
    expectedDatabaseName: "bop_rms_pilot_v15",
    dryRun: false,
  });
  expect(parseStoreOpenArguments(directoryArgs)).not.toHaveProperty("stockSiteReference");
  expect(
    parseStoreOpenArguments([
      ...directoryArgs,
      "--stock-site",
      "01909a2e-5000-7000-8000-000000000002",
    ]),
  ).toMatchObject({ stockSiteReference: "01909a2e-5000-7000-8000-000000000002" });
  expect(
    parseStoreOpenArguments([
      "stock-site",
      "/app/.local/pilot-v15",
      "--database",
      "bop_rms_pilot_v15",
      "--migration-env",
      ".local/migrate-v14/migrate-v15.env",
      "--store",
      "01909a2e-1000-7000-8000-000000000010",
      "--approver",
      "01909a2e-1000-7000-8000-000000000020",
      "--reason",
      "Stock site",
      "--approved-by",
      "Owner",
      "--approval",
      "yes",
    ]),
  ).toMatchObject({ command: "stock-site", approvedBy: "Owner" });
  for (const bad of [
    [],
    ["open", "/dir"],
    ["directory", "/dir", "--store", "x"],
    ["directory", "/dir", "--store", "x", "--name", "y"],
    [...directoryArgs, "--dry-run"],
    [...directoryArgs, "--store", "y"],
    ["stock-site", "/dir", "--store", "x"],
  ])
    expect(() => parseStoreOpenArguments(bad)).toThrow(
      "PILOT_INTERNAL_TEST_STORE_OPEN_UNAVAILABLE",
    );
  expect(
    parseStoreOpenArguments([
      "renew",
      "/app/.local/pilot-v15/stores/demo-2",
      "--database",
      "bop_rms_pilot_v15",
      "--migration-env",
      ".local/migrate-v14/migrate-v15.env",
      "--until",
      "2026-12-20T02:26:31.598Z",
      "--reason",
      "Continue testing",
      "--approved-by",
      "Owner",
      "--approval",
      "批准",
      "--dry-run",
    ]),
  ).toMatchObject({ command: "renew", dryRun: true, until: "2026-12-20T02:26:31.598Z" });
});
it("v15 2026-10-31: the directory uses the Store's own default stock site, never another Store's", async () => {
  const own = "01909a2e-5000-7000-8000-000000000002";
  const options = {
    directory: "/app/.local/pilot-v15",
    name: "demo-2",
    storeReference: "01909a2e-1000-7000-8000-000000000010",
  };
  const issued = [];
  const issue = async (input) => {
    issued.push(input);
    return { directory: "stores/demo-2" };
  };
  await expect(issueStoreDirectoryWithOwnSite(options, own, issue)).resolves.toEqual({
    directory: "stores/demo-2",
  });
  expect(issued).toEqual([
    {
      ...options,
      operationReference: options.storeReference,
      stockSiteReference: own,
    },
  ]);
  // None yet: run `stock-site` first. Another Store's site named on the command line: refused.
  expect(() => issueStoreDirectoryWithOwnSite(options, null, issue)).toThrow(
    expect.objectContaining({ reason: "stock-site-missing-run-stock-site-first" }),
  );
  expect(() =>
    issueStoreDirectoryWithOwnSite(
      { ...options, stockSiteReference: "0190fa30-0000-7000-8000-000000000001" },
      own,
      issue,
    ),
  ).toThrow(expect.objectContaining({ reason: "stock-site-not-this-store" }));
  expect(issued).toHaveLength(1);
});

// WP-2423 (settlement-coverage): the optional record is the Store's first business day, even when
// it is written days late; a rerun is safe and a different record is never overwritten.
it("settlement records the Store's first business day, rerun-safe, and never overwrites", async () => {
  const { recordSettlementCoverage } = await import("./pilot-internal-test-store-open.mjs");
  const { mkdtemp, readFile: read, stat, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "store-open-settlement-"));
  const id = (n) => "018f5000-0000-7000-8000-" + String(n).padStart(12, "0");
  const firstDay = {
    brandReference: id(2),
    storeReference: id(3),
    businessDate: "2026-11-04",
    startsAt: "2026-11-04T09:00:00.000Z",
    endsAt: "2026-11-05T09:00:00.000Z",
    opensAt: "2026-11-05T01:13:00.000Z",
    configurationReference: id(9),
    configurationVersion: 1,
    contentDigest: "sha256:" + "a".repeat(64),
  };
  const base = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "bop_rms_pilot_v15",
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  };
  const first = vi.fn(async () => firstDay);
  try {
    expect(await recordSettlementCoverage({ directory, first, base })).toEqual({
      status: "Recorded",
      firstBusinessDate: "2026-11-04",
    });
    const file = join(directory, "daily-settlement-coverage.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const written = JSON.parse(await read(file, "utf8"));
    expect(written.firstWindow).toEqual({
      businessDate: "2026-11-04",
      startsAt: "2026-11-04T09:00:00.000Z",
      endsAt: "2026-11-05T09:00:00.000Z",
      configurationReference: id(9),
      configurationVersion: 1,
      contentDigest: "sha256:" + "a".repeat(64),
    });
    expect(await recordSettlementCoverage({ directory, first, base })).toEqual({
      status: "AlreadyRecorded",
      firstBusinessDate: "2026-11-04",
    });
    const other = {
      ...written,
      firstWindow: { ...written.firstWindow, businessDate: "2026-11-05" },
    };
    await writeFile(file, JSON.stringify(other), { mode: 0o600 });
    await expect(recordSettlementCoverage({ directory, first, base })).rejects.toMatchObject({
      reason: "coverage-differs",
    });
    expect(JSON.parse(await read(file, "utf8"))).toEqual(other);
    await rm(file);
    await expect(
      recordSettlementCoverage({ directory, first: async () => null, base }),
    ).rejects.toMatchObject({ reason: "no-closed-business-day" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
