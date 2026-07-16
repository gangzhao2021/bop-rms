import { defineModuleManifest, type ModuleLayer } from "./module.manifest.js";

const typedManifest = defineModuleManifest({
  moduleName: "@bop-rms/synthetic-type-contract",
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
    classes: ["none"],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Synthetic Type Contract Steward" },
});

const exactLayer: "BOP" = typedManifest.layer;
const acceptedLayer: ModuleLayer = exactLayer;
void acceptedLayer;

defineModuleManifest({
  ...typedManifest,
  // @ts-expect-error invalid layers are rejected at authoring time
  layer: "PLATFORM",
});
