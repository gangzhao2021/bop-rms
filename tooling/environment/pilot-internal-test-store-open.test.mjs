import { expect, it } from "vitest";
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
