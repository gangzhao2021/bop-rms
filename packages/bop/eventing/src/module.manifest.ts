import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "eventing",
  packageName: "@bop/eventing",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [],
  consumedEvents: [],
  publishedEvents: [],
  ownedDatabase: { schema: null, tables: [] },
  ownedJobs: ["consumer-retry-schedule", "outbox-dispatch"],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: [
      "indirect_identifier",
      "personal",
      "sensitive_personal",
      "payment",
      "health",
      "credential",
    ],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Shared Eventing Infrastructure Steward" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
