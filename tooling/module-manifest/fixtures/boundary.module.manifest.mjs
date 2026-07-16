export const boundaryManifest = {
  moduleName: "@bop-rms/synthetic-boundary",
  layer: "RMS",
  lifecycle: "Phase 1",
  publicExports: [".", "./contracts", "./events-v1"],
  allowedSynchronousDependencies: [
    { moduleName: "@bop-rms/synthetic-platform-contract", layer: "BOP" },
    { moduleName: "@bop-rms/synthetic-rms-contract", layer: "RMS" },
  ],
  consumedEvents: ["synthetic.platform.changed.v1"],
  publishedEvents: ["synthetic.boundary.changed.v1"],
  ownedDatabase: {
    schema: "future_synthetic_boundary",
    tables: ["future_records", "future_outbox_records"],
  },
  ownedJobs: ["synthetic-boundary-reconciliation"],
  featureFlags: ["synthetic-boundary-enabled"],
  killSwitches: ["synthetic-boundary-disable-writes"],
  piiClassification: {
    classes: ["personal"],
    handling: {
      logs: "redacted",
      urls: "prohibited",
      analytics: "deidentified",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Synthetic Boundary Steward" },
};
