import { expect, it } from "vitest";
import { parseStoreOpenArguments } from "./pilot-internal-test-store-open.mjs";

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
  expect(
    parseStoreOpenArguments([
      "directory",
      "/app/.local/pilot-v15",
      "--store",
      "01909a2e-1000-7000-8000-000000000010",
      "--name",
      "demo-2",
    ]),
  ).toMatchObject({ command: "directory", name: "demo-2", dryRun: false });
  for (const bad of [
    [],
    ["open", "/dir"],
    ["directory", "/dir", "--store", "x"],
    ["directory", "/dir", "--store", "x", "--name", "y", "--dry-run"],
    ["directory", "/dir", "--store", "x", "--store", "y", "--name", "z"],
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
