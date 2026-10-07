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
      "store_setup_reference_version",
      "store_setup_reference_operation",
      "store_setup_draft_revision",
      "store_setup_draft_operation",
      "public_store_profile_version",
      "public_store_profile_timing",
      "store_configuration_version",
      "store_configuration_authoring_operation",
      "store_configuration_original_operation",
      "store_configuration_review_snapshot",
      "store_configuration_publication_content",
      "store_weekly_service_period",
      "store_service_exception",
      "store_service_exception_content",
      "store_service_exception_interval",
      "store_configuration_operation",
      "store_service_pause_content",
      "store_service_resume_content",
    ],
  },
  ownedJobs: [],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: ["indirect_identifier", "personal"],
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
