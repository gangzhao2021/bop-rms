import {
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { CatalogError, parseCatalogReference } from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { parseCatalogOptionSetEditorContent } from "../../contracts/option-set-editor-content.js";
import {
  createCatalogOptionSetAuthoringIdentity,
  parseCatalogOptionSetAuthoringIdentity,
  parseCatalogOptionSetAuthoringResolutionCommand,
} from "../../contracts/option-set-authoring-resolution.js";
import { parseFullOptionSetCreateCommand } from "../../contracts/option-set-full-create.js";
import { parseFullOptionSetEditCommand } from "../../contracts/option-set-full-edit.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return fail();
  return d.value.map((raw: unknown) => {
    const v = copyCategoryPersistenceValue(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
    return v as Record<string, unknown>;
  });
}
const identitySql = `SELECT i.identity_json,s.snapshot_json,
 (i.source_operation_id=s.operation_id AND i.tenant_id=s.tenant_id AND i.brand_id=s.brand_id
 AND i.option_set_id=s.option_set_id AND i.option_set_version_id=s.option_set_version_id
 AND i.source_action_code=s.action_code AND i.intent_digest=s.intent_digest AND i.result_aggregate_version=s.result_aggregate_version
 AND i.original_occurred_at=s.occurred_at AND i.source_digest=s.source_digest AND i.content_digest=s.content_digest AND i.configuration_digest=s.configuration_digest
 AND i.identity_json->>'digest'=i.identity_digest AND i.data_classification='ConfigurationMetadata') coherent
 FROM rms_catalog.option_set_authoring_identity i LEFT JOIN rms_catalog.option_set_draft_content_snapshot s ON s.operation_id=i.source_operation_id
 WHERE i.tenant_id=$1 AND i.brand_id=$2 AND i.operation_id=$3 LIMIT 2`;
/** Internal owning fact construction. No permission, transaction or eligibility
 * is supplied here: the actual writer holds those and calls under its global lock. */
export function prepareOptionSetAuthoringIdentityIntent(scope: Scope, value: unknown) {
  const tenant = parseCatalogReference(scope.tenantReference),
    brand = parseCatalogReference(scope.brandReference),
    actor = parseCatalogReference(scope.actorReference);
  const raw = copyCategoryPersistenceValue(value);
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 2 ||
    !("action" in raw) ||
    !("command" in raw)
  )
    return fail("CATALOG_INPUT_INVALID");
  const original = raw as Record<string, unknown>;
  if (original.action !== "Create" && original.action !== "Edit")
    return fail("CATALOG_INPUT_INVALID");
  const full =
      original.action === "Create"
        ? parseFullOptionSetCreateCommand(original.command)
        : parseFullOptionSetEditCommand(original.command),
    c = parseCatalogOptionSetAuthoringResolutionCommand({
      profile: "CatalogOptionSetAuthoringResolutionCommandV1",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      action: original.action,
      reasonCode: full.reasonCode,
      operationReference: full.operationReference,
      optionSetReference: "optionSetReference" in full ? full.optionSetReference : null,
      expectedAggregateVersion:
        "expectedAggregateVersion" in full ? full.expectedAggregateVersion : null,
    }),
    intentDigest =
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          profile:
            original.action === "Create"
              ? "CatalogFullOptionSetCreateV1"
              : "CatalogFullOptionSetEditV1",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          command: full,
        }),
      );
  return { full, command: c, intentDigest };
}
/** Mandatory append after this transaction's original snapshot and verified
 * Audit append. Never backfills legacy records, starts a transaction or appends Audit. */
export async function appendOptionSetAuthoringIdentity(
  tx: Transaction,
  scope: Scope,
  value: unknown,
  sourceValue: unknown,
  auditValue: AppendAuditRecordInput,
) {
  const tenant = parseCatalogReference(scope.tenantReference),
    brand = parseCatalogReference(scope.brandReference),
    actor = parseCatalogReference(scope.actorReference);
  const { full, command: c, intentDigest } = prepareOptionSetAuthoringIdentityIntent(scope, value);
  const copied = copyCategoryPersistenceValue(sourceValue);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
  const { sourceAggregate, ...details } = copied as Record<string, unknown>,
    prepared = parseCatalogOptionSetEditorContent(sourceAggregate, details),
    root = prepared.content.sourceAggregate,
    audit = validateAuditRecord(copyCategoryPersistenceValue(auditValue));
  if (
    audit.actor.type !== "User" ||
    audit.actor.reference !== actor ||
    audit.brandId !== brand ||
    audit.storeId !== undefined ||
    audit.reasonCode !== c.reasonCode ||
    audit.correlationId !== c.operationReference ||
    audit.occurredAt !== root.updatedAt ||
    full.occurredAt !== root.updatedAt ||
    audit.targetType !== "CatalogOptionSet" ||
    audit.targetId !== root.optionSetReference ||
    audit.actionCode !==
      (c.action === "Create" ? "CATALOG_OPTION_SET_CREATE" : "CATALOG_OPTION_SET_REPLACEDRAFT") ||
    root.brandReference !== brand ||
    (c.action === "Create" &&
      (root.createdByActorReference !== actor || root.createdAt !== full.occurredAt))
  )
    return fail();
  const identity = createCatalogOptionSetAuthoringIdentity({
    command: c,
    sourceOperationReference: c.operationReference,
    optionSetReference: root.optionSetReference,
    versionReference: root.draft.versionReference,
    aggregateVersion: root.aggregateVersion,
    originalOccurredAt: root.updatedAt,
    auditReference: parseCatalogReference(audit.auditId),
    originalIntentDigest: intentDigest,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  });
  const existing = rows(await tx.query(identitySql, [tenant, brand, c.operationReference]))[0];
  if (existing) {
    if (
      existing.coherent !== true ||
      !equal(parseCatalogOptionSetAuthoringIdentity(existing.identity_json), identity)
    )
      return fail("CATALOG_IDEMPOTENCY_CONFLICT");
    return identity;
  }
  const result = await tx.query(
    "INSERT INTO rms_catalog.option_set_authoring_identity(operation_id,tenant_id,brand_id,actor_id,action_code,reason_code,requested_option_set_id,expected_aggregate_version,option_set_id,option_set_version_id,source_operation_id,source_action_code,intent_digest,result_aggregate_version,original_occurred_at,audit_id,source_digest,content_digest,configuration_digest,identity_json,identity_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$1,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)",
    [
      c.operationReference,
      tenant,
      brand,
      actor,
      c.action,
      c.reasonCode,
      c.optionSetReference,
      c.expectedAggregateVersion,
      identity.optionSetReference,
      identity.versionReference,
      c.action === "Create" ? "Create" : "ReplaceDraft",
      intentDigest,
      identity.aggregateVersion,
      identity.originalOccurredAt,
      identity.auditReference,
      identity.sourceDigest,
      identity.contentDigest,
      identity.configurationDigest,
      canonicalizeRfc8785(identity),
      identity.digest,
    ],
  );
  if (result.rowCount !== 1) return fail();
  return identity;
}
/** Invoke only after the original global operation lock and absent receipt. */
export async function requireOptionSetAuthoringOperationAvailable(
  tx: Transaction,
  operationReference: string,
) {
  const result = rows(
    await tx.query("SELECT rms_catalog.option_set_authoring_operation_available($1) available", [
      parseCatalogReference(operationReference),
    ]),
  );
  if (result[0]?.available !== true) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
}
/** Original metadata read only: no backfill, Audit read or current eligibility. */
export async function requireOriginalOptionSetAuthoringIdentity(
  tx: Transaction,
  scope: Scope,
  value: unknown,
  sourceValue: unknown,
) {
  const { full, command: c, intentDigest } = prepareOptionSetAuthoringIdentityIntent(scope, value);
  const row = rows(
    await tx.query(identitySql, [c.tenantReference, c.brandReference, c.operationReference]),
  )[0];
  if (!row || row.coherent !== true) return fail();
  const identity = parseCatalogOptionSetAuthoringIdentity(row.identity_json);
  if (identity.command.actorReference !== c.actorReference)
    return fail("CATALOG_PERMISSION_DENIED");
  if (!equal(identity.command, c) || identity.originalIntentDigest !== intentDigest)
    return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  const copied = copyCategoryPersistenceValue(sourceValue);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
  const { sourceAggregate, ...details } = copied as Record<string, unknown>,
    prepared = parseCatalogOptionSetEditorContent(sourceAggregate, details),
    root = prepared.content.sourceAggregate;
  if (
    identity.optionSetReference !== root.optionSetReference ||
    identity.versionReference !== root.draft.versionReference ||
    identity.aggregateVersion !== root.aggregateVersion ||
    identity.originalOccurredAt !== full.occurredAt ||
    identity.originalOccurredAt !== root.updatedAt ||
    identity.sourceDigest !== prepared.sourceDigest ||
    identity.contentDigest !== prepared.contentDigest ||
    identity.configurationDigest !== prepared.configurationDigest ||
    !equal(row.snapshot_json, prepared.content)
  )
    return fail();
  return identity;
}
