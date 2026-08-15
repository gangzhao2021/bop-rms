import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "operating-entity",
  packageName: "@bop/operating-entity",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    { moduleName: "tenant", packageName: "@bop/tenant", layer: "BOP" },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: {
    schema: "bop_operating_entity",
    tables: [
      "brand_operating_entity_assignment",
      "business_function_assignment_decision",
      "operating_entity",
      "operating_entity_admin_operation",
      "operating_entity_approval_decision",
      "operating_entity_authority_version",
      "operating_entity_profile_version",
      "store_operating_entity_assignment",
    ],
  },
  ownedJobs: [],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: ["indirect_identifier", "personal", "sensitive_personal", "payment"],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Operating Entity Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
