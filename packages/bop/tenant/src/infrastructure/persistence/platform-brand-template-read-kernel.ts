import {
  PlatformBrandTemplateError,
  copyPlatformBrandTemplateValue,
  assertPlatformBrandTemplateRevisionDigests,
  parsePlatformBrandTemplateReceipt,
  type PlatformBrandTemplateCodec,
} from "../../contracts/platform-brand-template.js";
const fail = (): never => {
  throw new PlatformBrandTemplateError("PLATFORM_TEMPLATE_DEPENDENCY_UNAVAILABLE");
};
export function platformBrandTemplateStoredRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const copy = copyPlatformBrandTemplateValue(value);
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    Reflect.ownKeys(copy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copy, key))
  )
    return fail();
  return copy as Record<string, unknown>;
}
export function decodePlatformBrandTemplateOperation(
  value: unknown,
  actor: string,
  operation: string,
  codec: PlatformBrandTemplateCodec,
  observedAt: string,
) {
  const row = platformBrandTemplateStoredRecord(value, [
    "actor_id",
    "purpose_code",
    "operation_id",
    "intent_digest",
    "receipt_json",
    "receipt_digest",
    "precise",
  ]);
  const receipt = parsePlatformBrandTemplateReceipt(row.receipt_json, codec);
  if (
    row.precise !== true ||
    row.actor_id !== actor ||
    row.purpose_code !== "PLATFORM_BRAND_TEMPLATE" ||
    row.operation_id !== operation ||
    row.intent_digest !== receipt.intentDigest ||
    row.receipt_digest !== codec.hashIntent(codec.canonicalize(receipt)) ||
    receipt.actorReference !== actor ||
    receipt.operationReference !== operation ||
    receipt.occurredAt > observedAt ||
    codec.canonicalize(receipt) !== codec.canonicalize(row.receipt_json)
  )
    return fail();
  return receipt;
}
export function decodePlatformBrandTemplateRevision(
  value: unknown,
  codec: PlatformBrandTemplateCodec,
  observedAt: string,
) {
  const row = platformBrandTemplateStoredRecord(value, [
    "template_id",
    "version_id",
    "revision",
    "code",
    "actor_id",
    "operation_id",
    "audit_id",
    "content_digest",
    "source_digest",
    "snapshot_json",
    "precise",
  ]);
  const snapshot = assertPlatformBrandTemplateRevisionDigests(row.snapshot_json, codec);
  if (
    row.precise !== true ||
    row.template_id !== snapshot.templateReference ||
    row.version_id !== snapshot.templateVersionReference ||
    row.revision !== String(snapshot.revision) ||
    row.code !== snapshot.content.code ||
    row.actor_id !== snapshot.authoredByReference ||
    row.operation_id !== snapshot.operationReference ||
    row.audit_id !== snapshot.auditReference ||
    row.content_digest !== snapshot.contentDigest ||
    row.source_digest !== snapshot.sourceDigest ||
    snapshot.recordedAt > observedAt ||
    codec.canonicalize(snapshot) !== codec.canonicalize(row.snapshot_json)
  )
    return fail();
  return snapshot;
}
