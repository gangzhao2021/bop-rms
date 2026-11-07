import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import { MediaServiceError } from "../../application/media-service.js";
import type { MediaUnitOfWorkPort } from "../../application/ports/media-ports.js";
import {
  createMediaScope,
  createUploadSession,
  parseMediaInstant,
  parseMediaOwnerType,
  parseMediaPurposeCode,
  parseMediaReferenceId,
  type MediaScope,
  type UploadSession,
} from "../../contracts/media.js";
import {
  copyMediaUploadStorageValue,
  parseMediaUploadStorageCommand,
  mediaUploadStorageIntentDigest,
  mediaUploadStorageResult,
  type MediaUploadStorageCommand,
} from "../../contracts/media-upload-storage.js";

export interface MediaPersistenceTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}
export const mediaPersistenceRequiredFields = Object.freeze([
  "uploadSession",
  "grantReference",
  "purpose",
  "scope",
  "actorReference",
  "ownerType",
  "ownerReference",
  "classification",
  "declaredContentType",
  "declaredByteSize",
  "asset",
  "assetVersion",
  "objectEvidenceReference",
  "providerObjectVersion",
  "checksum",
  "operationReceipt",
] as const);
export interface MediaPersistenceAuthorityInput {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly actorKind: "User";
  readonly phase: "Intent" | "Apply" | "Replay";
  readonly action: "media.upload.create" | "media.asset.finalize";
  readonly purposeCode: string;
  readonly ownerType: string;
  readonly ownerReference: string;
  readonly operationReference: string;
  readonly originalIntentDigest: string;
  readonly requiredFields: typeof mediaPersistenceRequiredFields;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface PostgresMediaUnitOfWorkOptions {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: MediaPersistenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: MediaPersistenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: MediaPersistenceAuthorityInput,
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
}
/** Private owning composition only: preparation receives the guarded transaction
 * after the original operation lock. No Provider or mapping port is public. */
export interface PreparedMediaUploadOperation {
  readonly action: MediaUploadStorageCommand["action"];
  readonly operationReference: string;
  readonly purposeCode: string;
  readonly ownerType: string;
  readonly ownerReference: string;
  readonly originalIntentDigest: string;
  readonly prepare: (tx: MediaPersistenceTransaction) => Promise<MediaUploadStorageCommand>;
  readonly persist: (
    tx: MediaPersistenceTransaction,
    command: MediaUploadStorageCommand,
    recordedAt: string,
  ) => Promise<void>;
}
type OperationIdentity = Pick<
  PreparedMediaUploadOperation,
  | "action"
  | "operationReference"
  | "purposeCode"
  | "ownerType"
  | "ownerReference"
  | "originalIntentDigest"
>;
const fail = (): never => {
  throw new MediaServiceError("MEDIA_COMMIT_FAILED");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function rows(value: unknown): readonly unknown[] {
  const descriptor =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  const found: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (
    !Array.isArray(found) ||
    Object.getPrototypeOf(found) !== Array.prototype ||
    found.length > 1 ||
    Reflect.ownKeys(found).length !== found.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let index = 0; index < found.length; index++) {
    const d = Object.getOwnPropertyDescriptor(found, String(index));
    if (!d?.enumerable || !("value" in d)) return fail();
    result.push(d.value);
  }
  return result;
}
function inserted(value: unknown): void {
  const d =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")
      : undefined;
  if (!d || !("value" in d) || d.value !== 1) return fail();
}
function preparedOperation(value: unknown): PreparedMediaUploadOperation {
  const r = closed(value, [
    "action",
    "operationReference",
    "purposeCode",
    "ownerType",
    "ownerReference",
    "originalIntentDigest",
    "prepare",
    "persist",
  ]);
  if (
    (r.action !== "CreateUpload" && r.action !== "FinalizeAsset") ||
    typeof r.originalIntentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(r.originalIntentDigest) ||
    typeof r.prepare !== "function" ||
    typeof r.persist !== "function"
  )
    return fail();
  return Object.freeze({
    action: r.action,
    operationReference: parseMediaReferenceId(r.operationReference),
    purposeCode: parseMediaPurposeCode(r.purposeCode),
    ownerType: parseMediaOwnerType(r.ownerType),
    ownerReference: parseMediaReferenceId(r.ownerReference),
    originalIntentDigest: r.originalIntentDigest,
    prepare: (r.prepare as PreparedMediaUploadOperation["prepare"]).bind(value),
    persist: (r.persist as PreparedMediaUploadOperation["persist"]).bind(value),
  });
}
function commandIdentity(command: MediaUploadStorageCommand): OperationIdentity {
  const session =
    command.action === "CreateUpload" ? command.input.session : command.input.closedSession;
  return Object.freeze({
    action: command.action,
    operationReference: command.input.idempotencyKey,
    purposeCode: session.purpose,
    ownerType: session.ownerType,
    ownerReference: session.ownerReference,
    originalIntentDigest: mediaUploadStorageIntentDigest(command),
  });
}
const originalSql = `SELECT command_json command,result_json result,
 to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at,
 (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND operation_id=$4 AND actor_id=$5
 AND action_code=$6 AND intent_digest=$7 AND upload_session_id=$8
 AND asset_id IS NOT DISTINCT FROM $9::uuid AND asset_version_id IS NOT DISTINCT FROM $10::uuid AND audit_id=$11) IS TRUE coherent
 FROM bop_media.operation_record WHERE operation_id=$4 LIMIT 2`;
const sessionSql = `SELECT snapshot_json snapshot,
 (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND upload_session_id=$4
 AND actor_id::text=snapshot_json->>'actorReference' AND version=(snapshot_json->>'version')::bigint
 AND state=snapshot_json->>'state' AND expires_at=(snapshot_json->>'expiresAt')::timestamptz) IS TRUE coherent
 FROM bop_media.upload_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND upload_session_id=$4 FOR UPDATE`;

function createMediaUploadCommitKernel(
  options: PostgresMediaUnitOfWorkOptions,
  protocol: "Legacy" | "Prepared",
) {
  let tenantReference: string, scope: MediaScope, actorReference: string;
  try {
    tenantReference = parseMediaReferenceId(options.tenantReference);
    scope = createMediaScope(copyMediaUploadStorageValue(options.scope) as MediaScope);
    actorReference = parseMediaReferenceId(options.actorReference);
    if (
      typeof options.clock?.now !== "function" ||
      typeof options.transactions?.run !== "function" ||
      typeof options.registerBeforeCommit !== "function" ||
      typeof options.authority?.holdUntilTransactionCompletes !== "function"
    )
      return fail();
  } catch {
    return fail();
  }
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    register = options.registerBeforeCommit.bind(options),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  async function commit(
    action: MediaUploadStorageCommand["action"] | null,
    value: unknown,
  ): Promise<MediaUploadStorageCommand> {
    let command: MediaUploadStorageCommand | undefined,
      entryAt: string | undefined,
      prepared: PreparedMediaUploadOperation | undefined,
      identity: OperationIdentity | undefined;
    try {
      entryAt = parseMediaInstant(now());
    } catch {
      /* Install the actual transaction guard before reporting clock failure. */
    }
    try {
      if (protocol === "Prepared") {
        prepared = preparedOperation(value);
        identity = prepared;
      } else {
        command = parseMediaUploadStorageCommand({
          tenantReference,
          scope,
          actorReference,
          action,
          input: value,
        });
        identity = commandIdentity(command);
      }
    } catch {
      /* Guard the actual transaction before reporting malformed input. */
    }
    let txValue: MediaPersistenceTransaction | undefined,
      entered = false,
      calls = 0,
      complete = false,
      guardCompleted = false,
      finalCompleted = false;
    try {
      const result = await run(async (tx) => {
        if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
        txValue = tx;
        if (++calls !== 1 || failed.has(tx) || active.has(tx)) {
          failed.add(tx);
          return fail();
        }
        active.add(tx);
        entered = true;
        const originalQuery = tx.query,
          rawQuery = originalQuery.bind(tx);
        let observedAt = "",
          latest = "",
          deadline = "",
          ready = false,
          guardCalls = 0,
          finalCalls = 0,
          phase: MediaPersistenceAuthorityInput["phase"] = "Intent";
        const poison = (): never => {
          failed.add(tx);
          return fail();
        };
        const check = (): string => {
          try {
            const at = parseMediaInstant(now());
            if (
              failed.has(tx) ||
              tx.query !== originalQuery ||
              !deadline ||
              at < latest ||
              at >= deadline
            )
              return poison();
            latest = at;
            return at;
          } catch {
            return poison();
          }
        };
        const query: MediaPersistenceTransaction["query"] = async <Row>(
          sql: string,
          values: readonly unknown[],
        ) => {
          check();
          try {
            const result = await rawQuery<Row>(sql, values);
            check();
            return result;
          } catch (error) {
            failed.add(tx);
            throw error;
          }
        };
        let callbackOpen = false,
          callbackQueries = 0;
        const callbackTx: MediaPersistenceTransaction = Object.freeze({
          query: async <Row>(sql: string, values: readonly unknown[]) => {
            if (!callbackOpen) return poison();
            callbackQueries++;
            try {
              return await query<Row>(sql, values);
            } finally {
              callbackQueries--;
            }
          },
        });
        const callback = async <T>(work: () => Promise<T>): Promise<T> => {
          check();
          if (callbackOpen || callbackQueries !== 0) return poison();
          callbackOpen = true;
          try {
            const value = await work();
            check();
            if (callbackQueries !== 0) return poison();
            return value;
          } catch {
            return poison();
          } finally {
            callbackOpen = false;
          }
        };
        const authorize = async () => {
          if (!identity) return poison();
          check();
          const lease = closed(
              await hold(
                tx,
                Object.freeze({
                  tenantReference,
                  scope,
                  actorReference,
                  actorKind: "User" as const,
                  phase,
                  action:
                    identity.action === "CreateUpload"
                      ? ("media.upload.create" as const)
                      : ("media.asset.finalize" as const),
                  purposeCode: identity.purposeCode,
                  ownerType: identity.ownerType,
                  ownerReference: identity.ownerReference,
                  operationReference: identity.operationReference,
                  originalIntentDigest: identity.originalIntentDigest,
                  requiredFields: mediaPersistenceRequiredFields,
                  observedAt,
                  validUntil: deadline,
                }),
              ),
              ["observedAt", "validUntil"],
            ),
            until = parseMediaInstant(lease.validUntil);
          if (
            parseMediaInstant(lease.observedAt) !== observedAt ||
            until > deadline ||
            until <= check()
          )
            return poison();
          deadline = until;
          check();
        };
        try {
          if (
            (await register(
              tx,
              async () => {
                try {
                  if (++guardCalls !== 1 || !ready) return poison();
                  await authorize();
                  check();
                  guardCompleted = true;
                } catch {
                  return poison();
                }
              },
              () => {
                if (++finalCalls !== 1 || guardCalls !== 1 || !guardCompleted || !ready)
                  return poison();
                check();
                finalCompleted = true;
              },
            )) !== undefined
          )
            return poison();
          if (!identity || !entryAt) return poison();
          observedAt = latest = entryAt;
          deadline = new Date(Date.parse(observedAt) + 30000).toISOString();
          await authorize();
          const isolation = rows(
            await query("SELECT current_setting('transaction_isolation') AS isolation", []),
          );
          if (
            isolation.length !== 1 ||
            closed(isolation[0], ["isolation"]).isolation !== "read committed"
          )
            return poison();
          await query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenantReference, scope.brandReference, scope.storeReference ?? ""],
          );
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "MediaOperation:" + identity.operationReference,
          ]);
          if (prepared) {
            const operation = prepared;
            command = await callback(async () =>
              parseMediaUploadStorageCommand(await operation.prepare(callbackTx)),
            );
            const returned = commandIdentity(command);
            if (
              command.tenantReference !== tenantReference ||
              !equal(command.scope, scope) ||
              command.actorReference !== actorReference ||
              returned.action !== identity.action ||
              returned.operationReference !== identity.operationReference ||
              returned.purposeCode !== identity.purposeCode ||
              returned.ownerType !== identity.ownerType ||
              returned.ownerReference !== identity.ownerReference
            )
              return poison();
          }
          if (!command) return poison();
          const c = command,
            input = c.input,
            session = c.action === "CreateUpload" ? c.input.session : c.input.closedSession,
            digest = mediaUploadStorageIntentDigest(c),
            expectedResult = mediaUploadStorageResult(c),
            assetId = c.action === "FinalizeAsset" ? c.input.asset.assetId : null,
            versionId = c.action === "FinalizeAsset" ? c.input.assetVersion.assetVersionId : null;
          const original = rows(
            await query(originalSql, [
              tenantReference,
              scope.brandReference,
              scope.storeReference,
              input.idempotencyKey,
              actorReference,
              c.action,
              digest,
              session.uploadSessionId,
              assetId,
              versionId,
              input.audit.auditId,
            ]),
          );
          if (original.length !== 0) {
            const record = closed(original[0], ["command", "result", "recorded_at", "coherent"]),
              originalCommand = parseMediaUploadStorageCommand(record.command),
              recordedAt = parseMediaInstant(record.recorded_at);
            if (
              record.coherent !== true ||
              !equal(originalCommand, c) ||
              !equal(copyMediaUploadStorageValue(record.result), expectedResult) ||
              recordedAt < input.audit.occurredAt ||
              recordedAt > check()
            )
              return poison();
            phase = "Replay";
            await authorize();
            ready = complete = true;
            return;
          }
          // Original receipt recovery deliberately precedes today's expiry/CAS.
          if (
            input.audit.occurredAt > observedAt ||
            observedAt < session.createdAt ||
            check() >= session.expiresAt
          )
            return poison();
          if (session.expiresAt < deadline) deadline = session.expiresAt;
          phase = "Apply";
          await authorize();
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "MediaUploadSession:" + session.uploadSessionId,
          ]);
          const existing = rows(
            await query(sessionSql, [
              tenantReference,
              scope.brandReference,
              scope.storeReference,
              session.uploadSessionId,
            ]),
          );
          if (c.action === "CreateUpload") {
            if (existing.length !== 0) return poison();
          } else {
            if (existing.length !== 1) return poison();
            const row = closed(existing[0], ["snapshot", "coherent"]),
              current = createUploadSession(
                copyMediaUploadStorageValue(row.snapshot) as UploadSession,
              );
            if (
              row.coherent !== true ||
              current.state !== "Pending" ||
              current.version !== c.input.expectedSessionVersion ||
              !equal(current, {
                ...session,
                state: "Pending",
                version: c.input.expectedSessionVersion,
              })
            )
              return poison();
          }
          const recordedAt = check();
          await query("SAVEPOINT media_upload_storage", []);
          try {
            if (c.action === "CreateUpload") {
              inserted(
                await query(
                  "INSERT INTO bop_media.upload_session(upload_session_id,tenant_id,brand_id,store_id,actor_id,version,state,expires_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
                  [
                    session.uploadSessionId,
                    tenantReference,
                    scope.brandReference,
                    scope.storeReference,
                    actorReference,
                    session.version,
                    session.state,
                    session.expiresAt,
                    canonicalizeRfc8785(session),
                  ],
                ),
              );
            } else {
              inserted(
                await query(
                  "UPDATE bop_media.upload_session SET version=$6,state='Finalized',snapshot_json=$7::jsonb WHERE upload_session_id=$1 AND tenant_id=$2 AND brand_id=$3 AND store_id IS NOT DISTINCT FROM $4 AND version=$5 AND state='Pending'",
                  [
                    session.uploadSessionId,
                    tenantReference,
                    scope.brandReference,
                    scope.storeReference,
                    c.input.expectedSessionVersion,
                    session.version,
                    canonicalizeRfc8785(session),
                  ],
                ),
              );
              inserted(
                await query(
                  "INSERT INTO bop_media.asset(asset_id,tenant_id,brand_id,store_id,version,current_version_id,snapshot_json) VALUES($1,$2,$3,$4,$5,NULL,$6::jsonb)",
                  [
                    c.input.asset.assetId,
                    tenantReference,
                    scope.brandReference,
                    scope.storeReference,
                    c.input.asset.version,
                    canonicalizeRfc8785(c.input.asset),
                  ],
                ),
              );
              inserted(
                await query(
                  "INSERT INTO bop_media.asset_version(asset_version_id,tenant_id,brand_id,store_id,asset_id,upload_session_id,version,created_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
                  [
                    c.input.assetVersion.assetVersionId,
                    tenantReference,
                    scope.brandReference,
                    scope.storeReference,
                    c.input.asset.assetId,
                    session.uploadSessionId,
                    c.input.assetVersion.version,
                    c.input.assetVersion.createdAt,
                    canonicalizeRfc8785(c.input.assetVersion),
                  ],
                ),
              );
            }
            inserted(
              await query(
                prepared
                  ? "INSERT INTO bop_media.operation_record(operation_id,tenant_id,brand_id,store_id,actor_id,action_code,intent_digest,upload_session_id,asset_id,asset_version_id,recorded_at,command_json,result_json,audit_id,object_binding_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,true)"
                  : "INSERT INTO bop_media.operation_record(operation_id,tenant_id,brand_id,store_id,actor_id,action_code,intent_digest,upload_session_id,asset_id,asset_version_id,recorded_at,command_json,result_json,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)",
                [
                  input.idempotencyKey,
                  tenantReference,
                  scope.brandReference,
                  scope.storeReference,
                  actorReference,
                  c.action,
                  digest,
                  session.uploadSessionId,
                  assetId,
                  versionId,
                  recordedAt,
                  canonicalizeRfc8785(c),
                  canonicalizeRfc8785(expectedResult),
                  input.audit.auditId,
                ],
              ),
            );
            if (prepared) {
              const operation = prepared;
              if (
                (await callback(() => operation.persist(callbackTx, c, recordedAt))) !== undefined
              )
                return poison();
            }
            await appendAuditRecordInTransaction({ query }, input.audit);
            check();
            await authorize();
            check();
          } catch (error) {
            failed.add(tx);
            await rawQuery("ROLLBACK TO SAVEPOINT media_upload_storage", []);
            await rawQuery("RELEASE SAVEPOINT media_upload_storage", []);
            throw error;
          }
          await query("RELEASE SAVEPOINT media_upload_storage", []);
          ready = complete = true;
        } catch {
          failed.add(tx);
          return fail();
        }
      });
      if (
        result !== undefined ||
        calls !== 1 ||
        !complete ||
        !guardCompleted ||
        !finalCompleted ||
        !txValue ||
        failed.has(txValue)
      )
        return fail();
      if (!command) return fail();
      return command;
    } catch {
      if (txValue) failed.add(txValue);
      return fail();
    } finally {
      if (txValue && entered) active.delete(txValue);
    }
  }
  return commit;
}

/** Existing Media service UoW, backed by immutable original receipts and a
 * quarantine-only store. No Provider verification or Clean/Ready is supplied. */
export function createPostgresMediaUnitOfWork(
  options: PostgresMediaUnitOfWorkOptions,
): MediaUnitOfWorkPort {
  const commit = createMediaUploadCommitKernel(options, "Legacy");
  return Object.freeze({
    commitCreateUpload: async (input: Parameters<MediaUnitOfWorkPort["commitCreateUpload"]>[0]) => {
      await commit("CreateUpload", input);
    },
    commitFinalizeAsset: async (
      input: Parameters<MediaUnitOfWorkPort["commitFinalizeAsset"]>[0],
    ) => {
      await commit("FinalizeAsset", input);
    },
  });
}

/** Private fixed preparation path. The original descriptor digest authorizes
 * preparation; the immutable operation receipt still hashes its full command. */
export function createPreparedPostgresMediaUploadCommitter(
  options: PostgresMediaUnitOfWorkOptions,
): (operation: PreparedMediaUploadOperation) => Promise<MediaUploadStorageCommand> {
  const commit = createMediaUploadCommitKernel(options, "Prepared");
  return (operation) => commit(null, operation);
}
