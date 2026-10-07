import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "media",
  packageName: "@bop/media",
  layer: "BOP",
  lifecycle: "Phase 1",
  publicExports: [".", "./worker"],
  allowedSynchronousDependencies: [
    {
      moduleName: "audit",
      packageName: "@bop/audit",
      layer: "BOP",
    },
    {
      moduleName: "permission",
      packageName: "@bop/permission",
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
    schema: "bop_media",
    tables: [
      "upload_session",
      "asset",
      "asset_version",
      "operation_record",
      "upload_object_binding",
      "finalized_object_binding",
      "image_processing_intent",
      "image_processing_completion",
      "image_rendition",
      "image_scan_admission",
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
  moduleOwner: { role: "Media Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
