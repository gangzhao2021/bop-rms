import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStandardRefundRoleMapping,
  standardRefundRoleMapping,
  validateRefundRoleMapping,
} from "./pilot-refund-role-mapping.mjs";

let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pilot-refund-roles-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("WP-2423 Q5: maps the real Store/Brand roles; Finance stays empty until a finance role exists", () => {
  expect(standardRefundRoleMapping).toEqual({
    Manager: ["store_manager", "area_manager"],
    Owner: ["store_owner", "brand_owner"],
    Finance: [],
  });
  expect(validateRefundRoleMapping({ ...standardRefundRoleMapping })).toEqual(
    standardRefundRoleMapping,
  );
  for (const bad of [
    { Manager: ["synthetic_acceptance_0190fa30"], Owner: [], Finance: [] },
    { Manager: ["store_owner"], Owner: ["store_owner"], Finance: [] },
    { Manager: ["store_manager", "store_manager"], Owner: [], Finance: [] },
    { Manager: [], Owner: [] },
    { Manager: [], Owner: [], Finance: [], Admin: [] },
    { Manager: "store_manager", Owner: [], Finance: [] },
  ])
    expect(() => validateRefundRoleMapping(bad)).toThrow("PILOT_REFUND_ROLE_MAPPING_INVALID");
});

it("WP-2423 Q5: rewrites only roleMapping of merchant-runtime.json, keeping its mode", async () => {
  const path = join(directory, "merchant-runtime.json");
  const runtime = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic",
    scope: { tenantReference: "t", brandReference: "b", storeReference: "s" },
    roleMapping: { Manager: ["synthetic_acceptance_0190fa30"], Owner: [], Finance: [] },
    workstation: { deviceReference: "d", pickupLocationReference: "p" },
  };
  await writeFile(path, JSON.stringify(runtime));
  await chmod(path, 0o600);
  const dry = await applyStandardRefundRoleMapping({ directory, write: false });
  expect(dry).toMatchObject({ changed: true, written: false });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(runtime);
  const applied = await applyStandardRefundRoleMapping({ directory, write: true });
  expect(applied).toMatchObject({ changed: true, written: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    ...runtime,
    roleMapping: standardRefundRoleMapping,
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await applyStandardRefundRoleMapping({ directory, write: true })).toMatchObject({
    changed: false,
    written: false,
  });
});
