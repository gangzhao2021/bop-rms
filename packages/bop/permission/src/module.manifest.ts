import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "permission",
  packageName: "@bop/permission",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    {
      moduleName: "identity",
      packageName: "@bop/identity",
      layer: "BOP",
    },
    {
      moduleName: "membership",
      packageName: "@bop/membership",
      layer: "BOP",
    },
    {
      moduleName: "tenant",
      packageName: "@bop/tenant",
      layer: "BOP",
    },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: {
    schema: "bop_permission",
    tables: [
      "policy_state",
      "permission_definition",
      "role",
      "role_assignment",
      "permission_grant",
      "permission_override",
    ],
  },
  ownedJobs: [],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: ["indirect_identifier", "sensitive_personal"],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Permission Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
