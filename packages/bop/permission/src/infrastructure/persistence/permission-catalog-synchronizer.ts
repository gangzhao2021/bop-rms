import { createHash } from "node:crypto";
import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import {
  legacyPermissionReplacements,
  storePermissionCatalog,
  storePermissionCatalogVersion,
  storeRoleTemplateActions,
  storeRoleTemplateCodes,
  storeRoleTemplateProfiles,
} from "../../catalog/store-permission-catalog.js";

/**
 * WP-2423 / DEC-PERM-CATALOG: release-time installation of the Store permission catalog into
 * `permission_definition`. Insert-only and idempotent per catalog version: a code is never deleted,
 * renamed or silently revived, and a changed catalog must carry a new catalog version. The legacy
 * consolidated codes stay defined until every module has moved to their replacements.
 */
export interface PermissionCatalogTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface PermissionCatalogSyncInput {
  readonly operationReference: string;
  /** Platform release operator performing the installation. */
  readonly operatorReference: string;
  /** Independent Platform approver of the release; never the operator. */
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly nextPermissionReference: () => string;
}
export interface PermissionCatalogSyncResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly catalogVersion: number;
  readonly catalogDigest: string;
  readonly definitionCount: number;
  readonly addedCount: number;
}
export class PermissionCatalogSyncError extends Error {
  constructor(
    readonly code:
      | "PERMISSION_CATALOG_INPUT_INVALID"
      | "PERMISSION_CATALOG_VERSION_CONFLICT"
      | "PERMISSION_CATALOG_RETIRED_CODE"
      | "PERMISSION_CATALOG_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "PermissionCatalogSyncError";
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const purpose = "PERMISSION_CATALOG";

/** Every code the release must define: the catalog plus the still-checked legacy codes. */
export function permissionCatalogInstallationCodes(): readonly string[] {
  return [
    ...new Set([
      ...storePermissionCatalog().map((entry) => entry.code),
      ...Object.keys(legacyPermissionReplacements),
    ]),
  ].sort();
}
export function permissionCatalogDigest(): string {
  const body = canonicalizeRfc8785({
    catalogVersion: storePermissionCatalogVersion,
    definitions: storePermissionCatalog()
      .map(({ code, module, risk }) => ({ code, module, risk }))
      .sort((a, b) => (a.code < b.code ? -1 : 1)),
    legacy: legacyPermissionReplacements,
    templates: storeRoleTemplateCodes.map((template) => ({
      template,
      ...storeRoleTemplateProfiles[template],
      actions: storeRoleTemplateActions(template),
    })),
  });
  return "sha256:" + createHash("sha256").update(body).digest("hex");
}

function parse(input: PermissionCatalogSyncInput): PermissionCatalogSyncInput {
  const references = [
    input.operationReference,
    input.operatorReference,
    input.approvedByReference,
    input.approvalEvidenceReference,
    input.auditReference,
  ];
  if (
    references.some((value) => typeof value !== "string" || !uuidV7.test(value)) ||
    input.operatorReference === input.approvedByReference ||
    typeof input.occurredAt !== "string" ||
    !instant.test(input.occurredAt) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt ||
    typeof input.nextPermissionReference !== "function"
  )
    throw new PermissionCatalogSyncError("PERMISSION_CATALOG_INPUT_INVALID");
  return input;
}

/** Caller owns BEGIN/COMMIT and the release database principal. */
export async function synchronizePermissionCatalog(
  tx: PermissionCatalogTransaction,
  rawInput: PermissionCatalogSyncInput,
): Promise<PermissionCatalogSyncResult> {
  const input = parse(rawInput);
  const codes = permissionCatalogInstallationCodes(),
    digest = permissionCatalogDigest(),
    version = storePermissionCatalogVersion;
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('bop_permission.catalog',0))", []);
  const prior = (
    await tx.query(
      `SELECT catalog_digest,operation_id::text operation_reference,definition_count,added_count
       FROM bop_permission.permission_catalog_revision WHERE catalog_version=$1`,
      [version],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (prior.catalog_digest !== digest)
      throw new PermissionCatalogSyncError("PERMISSION_CATALOG_VERSION_CONFLICT");
    return Object.freeze({
      status: "AlreadyApplied",
      catalogVersion: version,
      catalogDigest: digest,
      definitionCount: Number(prior.definition_count),
      addedCount: Number(prior.added_count),
    });
  }
  const reused = await tx.query(
    "SELECT 1 FROM bop_permission.permission_catalog_revision WHERE operation_id=$1",
    [input.operationReference],
  );
  if (reused.rows.length > 0)
    throw new PermissionCatalogSyncError("PERMISSION_CATALOG_IDEMPOTENCY_CONFLICT");
  const existing = new Map(
    (
      await tx.query(
        "SELECT action_code,lifecycle FROM bop_permission.permission_definition WHERE action_code=ANY($1::text[])",
        [codes],
      )
    ).rows.map((row) => [String(row.action_code), String(row.lifecycle)]),
  );
  if ([...existing.values()].some((lifecycle) => lifecycle !== "Active"))
    throw new PermissionCatalogSyncError("PERMISSION_CATALOG_RETIRED_CODE");
  const missing = codes.filter((code) => !existing.has(code));
  for (const code of missing)
    await tx.query(
      "INSERT INTO bop_permission.permission_definition(permission_id,action_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,'Active',1,$3,$3)",
      [input.nextPermissionReference(), code, input.occurredAt],
    );
  await tx.query(
    "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
    [input.operatorReference, purpose],
  );
  await appendPlatformAuditRecordInTransaction(tx, {
    auditReference: input.auditReference,
    actorReference: input.operatorReference,
    purposeCode: purpose,
    actionCode: "PERMISSION_CATALOG_INSTALLED",
    targetType: "PermissionCatalogRevision",
    targetReference: input.operationReference,
    operationReference: input.operationReference,
    intentDigest: digest,
    occurredAt: input.occurredAt,
    reasonCode: "RELEASE_PERMISSION_CATALOG",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  await tx.query(
    `INSERT INTO bop_permission.permission_catalog_revision(catalog_version,catalog_digest,operation_id,operator_id,approved_by,
       approval_evidence_id,audit_id,definition_count,added_count,applied_at,data_classification)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ConfigurationMetadata')`,
    [
      version,
      digest,
      input.operationReference,
      input.operatorReference,
      input.approvedByReference,
      input.approvalEvidenceReference,
      input.auditReference,
      codes.length,
      missing.length,
      input.occurredAt,
    ],
  );
  return Object.freeze({
    status: "Applied",
    catalogVersion: version,
    catalogDigest: digest,
    definitionCount: codes.length,
    addedCount: missing.length,
  });
}
