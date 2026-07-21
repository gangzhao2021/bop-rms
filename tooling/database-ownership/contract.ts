import type { ModuleIdentity, PiiClass } from "../module-manifest/module.manifest.js";

export const databaseOperations = ["read", "write", "ddl"] as const;
export type DatabaseOperation = (typeof databaseOperations)[number];
export const databaseMechanisms = [
  "repository",
  "drizzle",
  "raw-sql",
  "migration",
  "projection",
] as const;
export type DatabaseMechanism = (typeof databaseMechanisms)[number];
export const databasePrincipalKinds = [
  "module",
  "projection-builder",
  "reconciliation-job",
  "shared-infrastructure",
] as const;
export type DatabasePrincipalKind = (typeof databasePrincipalKinds)[number];
export const databaseReadPatterns = [
  "owner-repository",
  "public-query-contract",
  "owner-read-view",
  "event-projection",
  "approved-source-view",
] as const;
export type DatabaseReadPattern = (typeof databaseReadPatterns)[number];
export const tableClassifications = [
  "aggregate-root",
  "aggregate-child-entity",
  "immutable-snapshot",
  "append-only-record",
  "configuration-version",
  "relationship-assignment",
  "projection-read-model",
  "integration-record",
  "technical-control-record",
] as const;
export type TableClassification = (typeof tableClassifications)[number];
export const retentionCategories = [
  "operational",
  "transactional",
  "financial-compliance",
  "audit-security",
  "privacy-governance",
  "ephemeral-technical",
] as const;
export type RetentionCategory = (typeof retentionCategories)[number];

export interface DatabasePrincipal {
  readonly kind: DatabasePrincipalKind;
  readonly id: string;
}
export interface DatabaseTableGovernance {
  readonly table: string;
  readonly classification: TableClassification;
  readonly writeOwner: DatabasePrincipal;
  readonly allowedReadPatterns: readonly DatabaseReadPattern[];
  readonly retentionCategory: RetentionCategory;
  readonly piiClassification: readonly PiiClass[];
}
export interface DatabaseAccess {
  readonly id: string;
  readonly operation: DatabaseOperation;
  readonly mechanism: DatabaseMechanism;
  readonly target: { readonly schema: string; readonly table: string };
  readonly principal: DatabasePrincipal;
  readonly readPattern: DatabaseReadPattern | null;
  readonly source: string;
}
export interface DatabaseAccessManifest {
  readonly version: 1;
  readonly module: ModuleIdentity;
  readonly tables: readonly DatabaseTableGovernance[];
  readonly accesses: readonly DatabaseAccess[];
}
export function defineDatabaseAccessManifest<const T extends DatabaseAccessManifest>(value: T): T {
  return value;
}

export const canonicalPlatformDatabaseManifest = {
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
      schema: "platform_helpers",
      technicalOwner: "shared-infrastructure/helpers",
      allowedWriteAuthority: "migration-runner",
    },
    {
      schema: "platform_projection",
      technicalOwner: "shared-infrastructure/projection",
      allowedWriteAuthority: "projection-builder",
    },
    { schema: "public", technicalOwner: null, allowedWriteAuthority: "wp-0020-bootstrap-ddl-only" },
  ],
} as const;
export function definePlatformDatabaseManifest<
  const T extends typeof canonicalPlatformDatabaseManifest,
>(value: T): T {
  return value;
}
