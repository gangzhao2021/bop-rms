import { minimalManifest } from "./minimal.module.manifest.mjs";

function changed(mutator) {
  const manifest = JSON.parse(JSON.stringify(minimalManifest));
  mutator(manifest);
  return manifest;
}

export const invalidManifestFixtures = [
  {
    name: "missing required field",
    manifest: changed((value) => delete value.moduleOwner),
    expected: "required property 'moduleOwner'",
  },
  {
    name: "invalid layer enum",
    manifest: changed((value) => (value.layer = "PLATFORM")),
    expected: "must be equal to one of the allowed values",
  },
  {
    name: "invalid lifecycle enum",
    manifest: changed((value) => (value.lifecycle = "Phase 2")),
    expected: "must be equal to one of the allowed values",
  },
  {
    name: "duplicate declaration",
    manifest: changed((value) => value.publicExports.push(".")),
    expected: "must NOT have duplicate items",
  },
  {
    name: "self dependency",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push({
        moduleName: value.moduleName,
        layer: value.layer,
      }),
    ),
    expected: "cannot depend synchronously on itself",
  },
  {
    name: "BOP to RMS dependency",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push({
        moduleName: "@bop-rms/synthetic-rms-target",
        layer: "RMS",
      }),
    ),
    expected: "BOP module cannot depend synchronously on RMS module",
  },
  {
    name: "private path export",
    manifest: changed((value) => value.publicExports.push("./internal")),
    expected: "exposes private path segment",
  },
  {
    name: "unsafe data classification",
    manifest: changed((value) => {
      value.piiClassification.classes = ["payment"];
      value.piiClassification.handling.logs = "redacted";
    }),
    expected: "sensitive classifications require prohibited logs and analytics",
  },
];
