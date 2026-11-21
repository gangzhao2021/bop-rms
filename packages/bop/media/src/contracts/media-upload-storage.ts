import {
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  MediaContractError,
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
  parseMediaIdempotencyKey,
  parseMediaInstant,
  parseMediaReferenceId,
  parseMediaVersion,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaIdempotencyKey,
  type MediaScope,
  type UploadSession,
} from "./media.js";

export type MediaUploadStorageCommand = {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
} & (
  | {
      readonly action: "CreateUpload";
      readonly input: {
        readonly idempotencyKey: MediaIdempotencyKey;
        readonly session: UploadSession;
        readonly audit: AppendAuditRecordInput;
      };
    }
  | {
      readonly action: "FinalizeAsset";
      readonly input: {
        readonly idempotencyKey: MediaIdempotencyKey;
        readonly expectedSessionVersion: number;
        readonly closedSession: UploadSession;
        readonly asset: MediaAsset;
        readonly assetVersion: MediaAssetVersion;
        readonly audit: AppendAuditRecordInput;
      };
    }
);
export type MediaUploadStorageResult =
  | { readonly session: UploadSession }
  | {
      readonly session: UploadSession;
      readonly asset: MediaAsset;
      readonly assetVersion: MediaAssetVersion;
    };
const fail = (): never => {
  throw new MediaContractError("MEDIA_INPUT_INVALID");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Capture untrusted UoW/SQL input without invoking accessors or retaining mutable
 * caller objects. Bounds cover only the existing metadata and Audit contract. */
export function copyMediaUploadStorageValue(value: unknown): unknown {
  let remaining = 10000;
  const copy = (input: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 12) return fail();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return input.length <= 32768 ? input : fail();
    if (typeof input === "number") return Number.isFinite(input) ? input : fail();
    if (!input || typeof input !== "object") return fail();
    if (Array.isArray(input)) {
      if (
        input.length > 10000 ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: input.length }, (_, index) => {
          const d = Object.getOwnPropertyDescriptor(input, String(index));
          return d?.enumerable && "value" in d ? copy(d.value, depth + 1) : fail();
        }),
      );
    }
    if (Object.getPrototypeOf(input) !== Object.prototype) return fail();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || key === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      result[key] = copy(d.value, depth + 1);
    }
    return Object.freeze(result);
  };
  return copy(value, 0);
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}
export function parseMediaUploadStorageCommand(value: unknown): MediaUploadStorageCommand {
  const r = closed(copyMediaUploadStorageValue(value), [
      "tenantReference",
      "scope",
      "actorReference",
      "action",
      "input",
    ]),
    tenantReference = parseMediaReferenceId(r.tenantReference),
    scope = createMediaScope(r.scope as MediaScope),
    actorReference = parseMediaReferenceId(r.actorReference);
  if (r.action !== "CreateUpload" && r.action !== "FinalizeAsset") return fail();
  const q = closed(
      r.input,
      r.action === "CreateUpload"
        ? ["idempotencyKey", "session", "audit"]
        : [
            "idempotencyKey",
            "expectedSessionVersion",
            "closedSession",
            "asset",
            "assetVersion",
            "audit",
          ],
    ),
    idempotencyKey = parseMediaIdempotencyKey(q.idempotencyKey),
    session = createUploadSession(
      (r.action === "CreateUpload" ? q.session : q.closedSession) as UploadSession,
    ),
    auditAt = parseMediaInstant((q.audit as Record<string, unknown> | null)?.occurredAt),
    audit = validateAuditRecord(q.audit, Date.parse(auditAt)),
    actionCode = r.action === "CreateUpload" ? "MEDIA_UPLOAD_CREATED" : "MEDIA_ASSET_FINALIZED";
  if (
    !equal(session.scope, scope) ||
    session.actorReference !== actorReference ||
    audit.brandId !== scope.brandReference ||
    (audit.storeId ?? null) !== scope.storeReference ||
    audit.actor.type !== "User" ||
    audit.actor.reference !== actorReference ||
    audit.actionCode !== actionCode ||
    audit.reasonCode !== actionCode ||
    typeof audit.sourceChannel !== "string" ||
    audit.dataClassification !== "Confidential" ||
    audit.retentionPolicyCode !== "MEDIA_OPERATION_AUDIT" ||
    audit.retentionPolicyVersion !== 1 ||
    audit.correctsAuditId !== undefined ||
    audit.beforeSummary !== undefined ||
    audit.afterSummary !== undefined ||
    audit.deviceNetworkReference !== undefined
  )
    return fail();
  if (r.action === "CreateUpload") {
    if (
      session.state !== "Pending" ||
      session.version !== 1 ||
      audit.targetType !== "MediaUploadSession" ||
      audit.targetId !== session.uploadSessionId ||
      auditAt !== session.createdAt
    )
      return fail();
    return Object.freeze({
      tenantReference,
      scope,
      actorReference,
      action: r.action,
      input: Object.freeze({ idempotencyKey, session, audit }),
    });
  }
  const expectedSessionVersion = parseMediaVersion(q.expectedSessionVersion),
    asset = createMediaAsset(q.asset as MediaAsset),
    assetVersion = createMediaAssetVersion(q.assetVersion as MediaAssetVersion);
  if (
    expectedSessionVersion !== 1 ||
    session.state !== "Finalized" ||
    session.version !== expectedSessionVersion + 1 ||
    asset.version !== 1 ||
    asset.currentVersionReference !== null ||
    !equal(asset.scope, session.scope) ||
    asset.purpose !== session.purpose ||
    asset.mediaKind !== session.mediaKind ||
    asset.ownerType !== session.ownerType ||
    asset.ownerReference !== session.ownerReference ||
    asset.classification !== session.classification ||
    assetVersion.assetId !== asset.assetId ||
    assetVersion.version !== 1 ||
    assetVersion.checkState !== "Quarantined" ||
    assetVersion.readinessState !== "Pending" ||
    assetVersion.byteSize !== session.declaredByteSize ||
    assetVersion.contentType !== session.declaredContentType ||
    assetVersion.createdAt !== auditAt ||
    auditAt < session.createdAt ||
    auditAt >= session.expiresAt ||
    audit.targetType !== "MediaAsset" ||
    audit.targetId !== asset.assetId
  )
    return fail();
  return Object.freeze({
    tenantReference,
    scope,
    actorReference,
    action: r.action,
    input: Object.freeze({
      idempotencyKey,
      expectedSessionVersion,
      closedSession: session,
      asset,
      assetVersion,
      audit,
    }),
  });
}
export const mediaUploadStorageIntentDigest = (command: MediaUploadStorageCommand): string =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parseMediaUploadStorageCommand(command)));
export function mediaUploadStorageResult(
  command: MediaUploadStorageCommand,
): MediaUploadStorageResult {
  return command.action === "CreateUpload"
    ? Object.freeze({ session: command.input.session })
    : Object.freeze({
        session: command.input.closedSession,
        asset: command.input.asset,
        assetVersion: command.input.assetVersion,
      });
}
