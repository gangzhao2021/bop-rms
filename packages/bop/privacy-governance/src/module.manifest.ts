import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";
const moduleManifestInput = {
  moduleName: "privacy-governance",
  packageName: "@bop/privacy-governance",
  layer: "BOP",
  lifecycle: "Later",
  publicExports: ["."],
  allowedSynchronousDependencies: [],
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
  moduleOwner: { role: "Privacy Governance Owner" },
} as const;
export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
