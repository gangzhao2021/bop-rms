import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";
export const moduleManifest = defineModuleManifest({
  moduleName: "workflow",
  packageName: "@bop/workflow",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    { moduleName: "publishing", packageName: "@bop/publishing", layer: "BOP" },
    { moduleName: "audit", packageName: "@bop/audit", layer: "BOP" },
    { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: { schema: "bop_workflow", tables: ["workflow_definition_version"] },
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
  moduleOwner: { role: "Workflow Engineering Owner" },
});
export default moduleManifest;
