import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  alignDiningExceptionWorkerAccount,
  alignStoreDiningExceptionWorkerAccount,
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

// v15 2026-11-06 (points-sweep): Stores opened before the fix named the installation Store's account
// in their dining-exception worker; the repair takes the Store's own, from its other files.
const own = "01a1a968-4484-731c-8000-000000000001",
  installationAccount = "0190fa29-0000-7000-8000-000000000001",
  storeReference = "01909a2e-1000-7000-8000-000000000010";
const storeFiles = () => ({
  installation: { environment: "InternalTest", database: "db" },
  profile: { environment: "InternalTest", binding: { storeReference } },
  businessWorker: { providerAccountReference: own },
  customerRuntime: { providerAccountReference: own },
  // The v15 shape: the merchant runtime names no Provider account.
  merchantRuntime: { environment: "InternalTest", scope: { storeReference } },
  diningExceptionWorker: {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "db",
    providerAccountReference: installationAccount,
    scope: { storeReference },
  },
  installationBusinessWorker: { providerAccountReference: installationAccount },
});
it("worker-account: aligns a Store's dining-exception worker to its own Provider account, only when its files agree", () => {
  expect(
    parseStoreOpenArguments(["worker-account", "/app/.local/pilot-v15/stores/hotpot"]),
  ).toEqual({
    command: "worker-account",
    directory: "/app/.local/pilot-v15/stores/hotpot",
    dryRun: false,
  });
  const aligned = alignDiningExceptionWorkerAccount(storeFiles());
  expect(aligned.status).toBe("Aligned");
  expect(aligned.next).toEqual({
    ...storeFiles().diningExceptionWorker,
    providerAccountReference: own,
  });
  // A merchant runtime that names an account must name the same one.
  expect(
    alignDiningExceptionWorkerAccount({
      ...storeFiles(),
      merchantRuntime: { providerAccountReference: own },
    }).status,
  ).toBe("Aligned");
  const already = storeFiles();
  already.diningExceptionWorker.providerAccountReference = own;
  expect(alignDiningExceptionWorkerAccount(already)).toEqual({ status: "AlreadyAligned" });
  for (const [change, reason] of [
    [{ customerRuntime: { providerAccountReference: installationAccount } }, "account-disagrees"],
    [{ merchantRuntime: { providerAccountReference: installationAccount } }, "account-disagrees"],
    [{ businessWorker: { providerAccountReference: "bad" } }, "account-disagrees"],
    [
      {
        businessWorker: { providerAccountReference: installationAccount },
        customerRuntime: { providerAccountReference: installationAccount },
      },
      "installation-account",
    ],
    [{ installation: { environment: "Pilot", database: "db" } }, "not-internal-test"],
    [{ profile: { environment: "Live", binding: { storeReference } } }, "not-internal-test"],
    [
      { diningExceptionWorker: { ...storeFiles().diningExceptionWorker, database: "other" } },
      "worker-invalid",
    ],
  ])
    expect(() => alignDiningExceptionWorkerAccount({ ...storeFiles(), ...change })).toThrow(
      expect.objectContaining({ reason }),
    );
});
it("worker-account: rewrites only the worker file, keeps the old one as a backup, and writes nothing when aligned", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-account-")));
  try {
    const store = join(root, "stores", "hotpot");
    await mkdir(store, { recursive: true });
    const files = storeFiles();
    const write = (folder, name, value) =>
      writeFile(join(folder, name), JSON.stringify(value), { mode: 0o600 });
    await write(root, "business-worker.json", files.installationBusinessWorker);
    for (const [name, value] of [
      ["installation.json", files.installation],
      ["internal-test-profile.json", files.profile],
      ["business-worker.json", files.businessWorker],
      ["customer-runtime.json", files.customerRuntime],
      ["merchant-runtime.json", files.merchantRuntime],
      ["dining-exception-worker.json", files.diningExceptionWorker],
    ])
      await write(store, name, value);
    const before = await readFile(join(store, "dining-exception-worker.json"), "utf8");
    expect(await alignStoreDiningExceptionWorkerAccount({ directory: store })).toEqual({
      status: "Aligned",
    });
    const after = JSON.parse(await readFile(join(store, "dining-exception-worker.json"), "utf8"));
    expect(after).toEqual({ ...files.diningExceptionWorker, providerAccountReference: own });
    expect((await stat(join(store, "dining-exception-worker.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(store, "dining-exception-worker.v1-backup.json"), "utf8")).toBe(
      before,
    );
    const listed = (await readdir(store)).sort();
    expect(await alignStoreDiningExceptionWorkerAccount({ directory: store })).toEqual({
      status: "AlreadyAligned",
    });
    expect((await readdir(store)).sort()).toEqual(listed);
    // The installation's own directory is not a Store's.
    await expect(alignStoreDiningExceptionWorkerAccount({ directory: root })).rejects.toMatchObject(
      {
        reason: "not-a-store-directory",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
