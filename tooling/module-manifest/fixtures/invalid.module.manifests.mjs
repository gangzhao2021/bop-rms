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
    name: "invalid logical module name",
    manifest: changed((value) => (value.moduleName = "Synthetic Minimal")),
    expected: "/moduleName must match pattern",
  },
  {
    name: "invalid package name",
    manifest: changed((value) => (value.packageName = "@bop-rms/synthetic-minimal")),
    expected: "/packageName must match pattern",
  },
  {
    name: "layer and package namespace mismatch",
    manifest: changed((value) => (value.packageName = "@rms/synthetic-minimal")),
    expected: "must equal @bop/synthetic-minimal for BOP module synthetic-minimal",
  },
  {
    name: "module and package slug mismatch",
    manifest: changed((value) => (value.packageName = "@bop/different-module")),
    expected: "must equal @bop/synthetic-minimal for BOP module synthetic-minimal",
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
        packageName: value.packageName,
        layer: value.layer,
      }),
    ),
    expected: "cannot depend synchronously on itself",
  },
  {
    name: "invalid dependency identity",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push({
        moduleName: "synthetic-target",
        packageName: "@bop-rms/synthetic-target",
        layer: "BOP",
      }),
    ),
    expected: "/allowedSynchronousDependencies/0/packageName must match pattern",
  },
  {
    name: "dependency layer and namespace mismatch",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push({
        moduleName: "synthetic-target",
        packageName: "@rms/synthetic-target",
        layer: "BOP",
      }),
    ),
    expected: "must equal @bop/synthetic-target for BOP module synthetic-target",
  },
  {
    name: "BOP to RMS dependency",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push({
        moduleName: "synthetic-rms-target",
        packageName: "@rms/synthetic-rms-target",
        layer: "RMS",
      }),
    ),
    expected: "BOP module cannot depend synchronously on RMS module",
  },
  {
    name: "duplicate synchronous dependency",
    manifest: changed((value) =>
      value.allowedSynchronousDependencies.push(
        {
          moduleName: "synthetic-target",
          packageName: "@bop/synthetic-target",
          layer: "BOP",
        },
        {
          moduleName: "synthetic-target",
          packageName: "@bop/synthetic-target",
          layer: "BOP",
        },
      ),
    ),
    expected: "duplicate synchronous dependency @bop/synthetic-target",
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
