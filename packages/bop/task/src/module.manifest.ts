import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "task",
  packageName: "@bop/task",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    { moduleName: "audit", packageName: "@bop/audit", layer: "BOP" },
    { moduleName: "identity", packageName: "@bop/identity", layer: "BOP" },
    { moduleName: "membership", packageName: "@bop/membership", layer: "BOP" },
    { moduleName: "notification", packageName: "@bop/notification", layer: "BOP" },
    { moduleName: "permission", packageName: "@bop/permission", layer: "BOP" },
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
  moduleOwner: { role: "Task Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
