import { definePlatformDatabaseManifest } from "./contract.js";

const platformDatabaseManifestInput = {
  version: 1,
  schemas: [
    {
      schema: "platform_audit",
      technicalOwner: "shared-infrastructure/audit",
      allowedWriteAuthority: "audit-infrastructure",
    },
    {
      schema: "platform_core",
      technicalOwner: "shared-infrastructure/platform-core",
      allowedWriteAuthority: "migration-runner",
    },
    {
      schema: "platform_eventing",
      technicalOwner: "shared-infrastructure/eventing",
      allowedWriteAuthority: "eventing-infrastructure",
    },
    {
      schema: "platform_jobs",
      technicalOwner: "shared-infrastructure/jobs",
      allowedWriteAuthority: "job-infrastructure",
    },
    {
      schema: "platform_projection",
      technicalOwner: "shared-infrastructure/projection",
      allowedWriteAuthority: "projection-builder",
    },
    { schema: "public", technicalOwner: null, allowedWriteAuthority: "wp-0020-bootstrap-ddl-only" },
  ],
} as const;

export const platformDatabaseManifest = definePlatformDatabaseManifest(
  platformDatabaseManifestInput,
);
