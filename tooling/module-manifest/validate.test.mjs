import { describe, expect, it } from "vitest";
import { boundaryManifest } from "./fixtures/boundary.module.manifest.mjs";
import { invalidManifestFixtures } from "./fixtures/invalid.module.manifests.mjs";
import { minimalManifest } from "./fixtures/minimal.module.manifest.mjs";
import { validateModuleManifest, verifyCommittedFixtures } from "./validate.mjs";

describe("Module Manifest validation", () => {
  it.each([
    ["minimal", minimalManifest],
    ["boundary", boundaryManifest],
  ])("accepts the %s legal fixture", (_name, manifest) => {
    expect(validateModuleManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it.each(invalidManifestFixtures)("rejects $name", ({ expected, manifest }) => {
    const result = validateModuleManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(expected);
  });

  it("keeps the CLI fixture contract deterministic", () => {
    expect(verifyCommittedFixtures()).toEqual([]);
  });
});
