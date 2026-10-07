import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "tenant",
  packageName: "@bop/tenant",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [
    {
      moduleName: "identity",
      packageName: "@bop/identity",
      layer: "BOP",
    },
  ],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: {
    schema: "bop_tenant",
    tables: [
      "brand",
      "brand_admin_operation",
      "brand_configuration_version",
      "brand_configuration_authoring_revision",
      "brand_configuration_authoring_operation",
      "platform_brand_template_revision",
      "platform_brand_template_operation",
      "brand_store_membership_record",
      "brand_store_topology_draft_revision",
      "brand_store_topology_draft_operation",
      "store",
      "store_reference_generation",
      "store_reference_projection",
      "tenant_administration_operation",
      "tenant_administration_version",
      "tenant_capability_metadata_reference",
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
  moduleOwner: { role: "Tenant and Organization Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
