import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "permission",
  packageName: "@bop/permission",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    {
      moduleName: "tenant",
      packageName: "@bop/tenant",
      layer: "BOP",
    },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: { schema: null, tables: [] },
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
