export const minimalManifest = {
  moduleName: "@bop-rms/synthetic-minimal",
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
  moduleOwner: { role: "Synthetic Module Steward" },
};
