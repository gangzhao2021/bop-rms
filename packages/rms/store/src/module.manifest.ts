import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "store",
  packageName: "@rms/store",
  layer: "RMS",
  lifecycle: "Phase 1",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    {
      moduleName: "effective-period",
      packageName: "@bop/effective-period",
      layer: "BOP",
    },
    { moduleName: "media", packageName: "@bop/media", layer: "BOP" },
    { moduleName: "publishing", packageName: "@bop/publishing", layer: "BOP" },
    { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: {
    schema: "rms_store",
    tables: [
      "store_configuration_version",
      "store_weekly_service_period",
      "store_service_exception",
      "store_configuration_operation",
    ],
  },
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
  moduleOwner: { role: "Store Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
