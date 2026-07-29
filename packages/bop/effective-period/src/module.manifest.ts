import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "effective-period",
  packageName: "@bop/effective-period",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    { moduleName: "audit", packageName: "@bop/audit", layer: "BOP" },
    { moduleName: "permission", packageName: "@bop/permission", layer: "BOP" },
    { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: { schema: null, tables: [] },
  ownedJobs: [],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: ["indirect_identifier"],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Effective Period Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
