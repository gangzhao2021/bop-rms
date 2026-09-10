import { defineModuleManifest } from "../../../../tooling/module-manifest/module.manifest.js";

const moduleManifestInput = {
  moduleName: "identity",
  packageName: "@bop/identity",
  layer: "BOP",
  lifecycle: "Phase 0",
  publicExports: ["."],
  allowedSynchronousDependencies: [],
  consumedEvents: [],
  publishedEvents: ["identity.credential-compromised.v1", "identity.session-revoked.v1"],
  ownedDatabase: {
    schema: "bop_identity",
    tables: [
      "api_client",
      "api_client_access_version",
      "api_client_credential_metadata",
      "api_client_operation",
      "authentication_session",
      "guest_binding_preparation",
      "guest_dining_binding_preparation",
      "guest_session",
      "guest_session_operation",
      "oidc_authorization_transaction",
      "session_revocation_request",
      "workforce_invitation",
      "workforce_mfa_status",
      "workforce_recovery_case",
    ],
  },
  ownedJobs: [],
  featureFlags: [],
  killSwitches: [],
  piiClassification: {
    classes: ["indirect_identifier", "personal", "sensitive_personal", "credential"],
    handling: {
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
      fixtures: "synthetic-only",
    },
  },
  moduleOwner: { role: "Identity Engineering Owner" },
} as const;

export const moduleManifest = defineModuleManifest(moduleManifestInput);
export default moduleManifest;
