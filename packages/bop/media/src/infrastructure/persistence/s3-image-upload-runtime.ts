import { randomBytes } from "node:crypto";
import { v7 as uuidV7 } from "uuid";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createUpload,
  finalizeAsset,
  MediaServiceError,
  type CreateUploadInput,
  type FinalizeAssetInput,
} from "../../application/media-service.js";
import type { MediaAuthorizationPort, MediaPorts } from "../../application/ports/media-ports.js";
import {
  parseMediaChecksum,
  parseMediaReferenceId,
  parseObjectEvidenceReference,
  parseMediaInstant,
  parseUploadGrantReference,
  type MediaChecksum,
} from "../../contracts/media.js";
import {
  copyMediaUploadStorageValue,
  mediaUploadStorageIntentDigest,
  mediaUploadStorageResult,
  parseMediaUploadStorageCommand,
  type MediaUploadStorageCommand,
} from "../../contracts/media-upload-storage.js";
import {
  createPreparedPostgresMediaUploadCommitter,
  type MediaPersistenceTransaction,
  type PostgresMediaUnitOfWorkOptions,
} from "./media-upload-store.js";
import {
  parseS3QuarantineImageConfig,
  quarantineImageObjectNameBytes,
  quarantineImageObjectNamePattern,
  type S3QuarantineImageConfig,
} from "../provider/s3-quarantine-image-source.js";
import { createS3ImageUploadProvider } from "../provider/s3-image-upload-provider.js";

type CreateCommand = Extract<MediaUploadStorageCommand, { action: "CreateUpload" }>;
type FinalizeCommand = Extract<MediaUploadStorageCommand, { action: "FinalizeAsset" }>;
interface UploadBinding {
  readonly profile: "S3_IMAGE_UPLOAD_V1";
  readonly requestDigest: string;
  readonly commandDigest: string;
  readonly config: S3QuarantineImageConfig;
  readonly key: string;
  readonly checksum: MediaChecksum;
}
interface FinalBinding {
  readonly profile: "S3_IMAGE_FINALIZED_V1";
  readonly requestDigest: string;
  readonly commandDigest: string;
  readonly uploadBindingDigest: string;
  readonly object: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly etag: string;
    readonly objectEvidenceReference: string;
    readonly providerObjectVersion: string;
  };
  readonly observedAt: string;
}
export interface S3ImageUploadRuntimeOptions extends PostgresMediaUnitOfWorkOptions {
  readonly config: S3QuarantineImageConfig;
  readonly authorization: MediaAuthorizationPort;
  readonly provider?: ReturnType<typeof createS3ImageUploadProvider>;
}
const fail = (): never => {
  throw new MediaServiceError("MEDIA_UPLOAD_UNAVAILABLE");
};
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copyMediaUploadStorageValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
function one(value: { readonly rows: readonly unknown[] }): Record<string, unknown> | null {
  const found = copyMediaUploadStorageValue(value.rows);
  if (!Array.isArray(found) || found.length > 1) return fail();
  return found.length === 0 ? null : (found[0] as Record<string, unknown>);
}
function inserted(value: { readonly rowCount?: number | null }): void {
  if (value.rowCount !== 1) return fail();
}
export function uploadBinding(
  value: unknown,
  command: CreateCommand,
  config: S3QuarantineImageConfig,
): UploadBinding {
  const r = closed(value, [
    "profile",
    "requestDigest",
    "commandDigest",
    "config",
    "key",
    "checksum",
  ]);
  const c = parseS3QuarantineImageConfig(r.config);
  if (
    r.profile !== "S3_IMAGE_UPLOAD_V1" ||
    !equal(c, config) ||
    !equal(c.scope, command.scope) ||
    c.tenantReference !== command.tenantReference ||
    r.commandDigest !== mediaUploadStorageIntentDigest(command) ||
    typeof r.requestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(r.requestDigest) ||
    typeof r.key !== "string" ||
    !r.key.startsWith(c.quarantinePrefix) ||
    !quarantineImageObjectNamePattern.test(r.key.slice(c.quarantinePrefix.length)) ||
    command.input.session.mediaKind !== "Image" ||
    !["image/jpeg", "image/png", "image/webp"].includes(
      command.input.session.declaredContentType,
    ) ||
    command.input.session.declaredByteSize > 10 * 1024 * 1024
  )
    return fail();
  return Object.freeze({
    profile: "S3_IMAGE_UPLOAD_V1",
    requestDigest: r.requestDigest,
    commandDigest: r.commandDigest,
    config: c,
    key: r.key,
    checksum: parseMediaChecksum(r.checksum),
  });
}
export function finalBinding(
  value: unknown,
  command: FinalizeCommand,
  upload: UploadBinding,
): FinalBinding {
  const r = closed(value, [
    "profile",
    "requestDigest",
    "commandDigest",
    "uploadBindingDigest",
    "object",
    "observedAt",
  ]);
  const o = closed(r.object, [
      "bucket",
      "key",
      "versionId",
      "etag",
      "objectEvidenceReference",
      "providerObjectVersion",
    ]),
    s = command.input.closedSession,
    v = command.input.assetVersion;
  const observedAt = parseMediaInstant(r.observedAt);
  if (
    r.profile !== "S3_IMAGE_FINALIZED_V1" ||
    typeof r.requestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(r.requestDigest) ||
    r.commandDigest !== mediaUploadStorageIntentDigest(command) ||
    r.uploadBindingDigest !== digest(upload) ||
    o.bucket !== upload.config.bucket ||
    o.key !== upload.key ||
    typeof o.versionId !== "string" ||
    !/^[\x21-\x7e]{1,1024}$/u.test(o.versionId) ||
    o.versionId === "null" ||
    typeof o.etag !== "string" ||
    !/^[\x21-\x7e]{1,128}$/u.test(o.etag) ||
    o.etag.includes('"') ||
    o.etag.includes("\\") ||
    o.objectEvidenceReference !== v.objectEvidenceReference ||
    o.providerObjectVersion !== v.providerObjectVersion ||
    v.checksum !== upload.checksum ||
    observedAt < s.createdAt ||
    observedAt >= s.expiresAt
  )
    return fail();
  return Object.freeze({
    profile: "S3_IMAGE_FINALIZED_V1",
    requestDigest: r.requestDigest,
    commandDigest: r.commandDigest,
    uploadBindingDigest: r.uploadBindingDigest,
    object: Object.freeze({
      bucket: o.bucket as string,
      key: o.key as string,
      versionId: o.versionId,
      etag: o.etag,
      objectEvidenceReference: v.objectEvidenceReference,
      providerObjectVersion: v.providerObjectVersion,
    }),
    observedAt,
  });
}

/** Private owning composition. Business recovery never contacts S3 or regenerates
 * a grant. POST delivery is a separate currently authorized read of that grant.
 * Quarantined finalization supplies neither a scan result nor Clean/Ready state. */
export function createS3ImageUploadRuntime(options: S3ImageUploadRuntimeOptions) {
  const config = parseS3QuarantineImageConfig(options.config);
  if (config.tenantReference !== options.tenantReference || !equal(config.scope, options.scope))
    return fail();
  const commit = createPreparedPostgresMediaUploadCommitter(options),
    now = options.clock.now.bind(options.clock);
  const authorization = Object.freeze({
    authorize: options.authorization.authorize.bind(options.authorization),
  });
  const source = options.provider ?? createS3ImageUploadProvider({ config, clock: { now } });
  const provider = Object.freeze({
    signUpload: source.signUpload.bind(source),
    verifyUpload: source.verifyUpload.bind(source),
  });
  const identity = Object.freeze({
    tenantReference: config.tenantReference,
    scope: config.scope,
    actorReference: options.actorReference,
  });
  const params = (operation: string) => [
    identity.tenantReference,
    config.scope.brandReference,
    config.scope.storeReference,
    operation,
    identity.actorReference,
  ];
  async function original(
    tx: MediaPersistenceTransaction,
    operation: string,
  ): Promise<MediaUploadStorageCommand | null> {
    const row = one(
      await tx.query(
        `SELECT command_json command,object_binding_required required,(tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND actor_id=$5) IS TRUE coherent FROM bop_media.operation_record WHERE operation_id=$4 LIMIT 2`,
        params(operation),
      ),
    );
    if (!row) return null;
    if (row.required !== true || row.coherent !== true) return fail();
    const command = parseMediaUploadStorageCommand(row.command);
    if (
      command.tenantReference !== identity.tenantReference ||
      !equal(command.scope, identity.scope) ||
      command.actorReference !== identity.actorReference ||
      command.input.idempotencyKey !== operation
    )
      return fail();
    return command;
  }
  async function loadUpload(
    tx: MediaPersistenceTransaction,
    session: string,
  ): Promise<{ command: CreateCommand; binding: UploadBinding }> {
    const row = one(
      await tx.query(
        `SELECT b.binding_json binding,b.binding_digest digest,o.command_json command,
      (b.tenant_id=$1 AND b.brand_id=$2 AND b.store_id IS NOT DISTINCT FROM $3 AND b.actor_id=$5
       AND b.operation_id=o.operation_id AND o.object_binding_required AND b.upload_session_id=o.upload_session_id
       AND b.grant_reference::text=o.result_json#>>'{session,grantReference}' AND b.bucket=b.binding_json#>>'{config,bucket}'
       AND b.key=b.binding_json->>'key' AND b.recorded_at=o.recorded_at) IS TRUE coherent
      FROM bop_media.upload_object_binding b JOIN bop_media.operation_record o ON o.operation_id=b.operation_id
      WHERE b.tenant_id=$1 AND b.brand_id=$2 AND b.store_id IS NOT DISTINCT FROM $3 AND b.upload_session_id=$4 AND b.actor_id=$5 LIMIT 2`,
        params(session),
      ),
    );
    if (!row || row.coherent !== true) return fail();
    const command = parseMediaUploadStorageCommand(row.command);
    if (
      command.action !== "CreateUpload" ||
      command.input.session.uploadSessionId !== session ||
      !equal(command.scope, identity.scope) ||
      command.tenantReference !== identity.tenantReference ||
      command.actorReference !== identity.actorReference
    )
      return fail();
    const binding = uploadBinding(row.binding, command, config);
    if (digest(binding) !== row.digest) return fail();
    return { command, binding };
  }
  async function loadFinal(
    tx: MediaPersistenceTransaction,
    command: FinalizeCommand,
    upload: UploadBinding,
  ): Promise<FinalBinding> {
    const row = one(
      await tx.query(
        `SELECT b.binding_json binding,b.binding_digest digest,
      (b.asset_version_id=$6 AND b.upload_session_id=$7 AND b.asset_id=$8
       AND b.object_evidence_reference=$9 AND b.provider_object_version=$10
       AND b.bucket=b.binding_json#>>'{object,bucket}' AND b.key=b.binding_json#>>'{object,key}'
       AND b.version_id=b.binding_json#>>'{object,versionId}' AND b.etag=b.binding_json#>>'{object,etag}'
       AND b.recorded_at=o.recorded_at AND (b.binding_json->>'observedAt')::timestamptz<=b.recorded_at) IS TRUE coherent
      FROM bop_media.finalized_object_binding b JOIN bop_media.operation_record o ON o.operation_id=b.operation_id
      WHERE b.tenant_id=$1 AND b.brand_id=$2 AND b.store_id IS NOT DISTINCT FROM $3 AND b.operation_id=$4 AND b.actor_id=$5 LIMIT 2`,
        [
          ...params(command.input.idempotencyKey),
          command.input.assetVersion.assetVersionId,
          command.input.closedSession.uploadSessionId,
          command.input.asset.assetId,
          command.input.assetVersion.objectEvidenceReference,
          command.input.assetVersion.providerObjectVersion,
        ],
      ),
    );
    if (!row || row.coherent !== true) return fail();
    const binding = finalBinding(row.binding, command, upload);
    if (digest(binding) !== row.digest) return fail();
    return binding;
  }
  function ports(
    capture: (c: MediaUploadStorageCommand) => void,
    grant: () => Promise<string>,
    evidence: MediaPorts["uploadEvidence"]["verify"],
  ): MediaPorts {
    return {
      authorization,
      uploadGrant: { create: async () => parseUploadGrantReference(await grant()) },
      uploadEvidence: { verify: evidence },
      unitOfWork: {
        commitCreateUpload: async (input) => {
          capture(parseMediaUploadStorageCommand({ ...identity, action: "CreateUpload", input }));
        },
        commitFinalizeAsset: async (input) => {
          capture(parseMediaUploadStorageCommand({ ...identity, action: "FinalizeAsset", input }));
        },
      },
      read: {
        loadAsset: async () => fail(),
        loadVersions: async () => fail(),
        loadVersion: async () => fail(),
      },
    };
  }
  async function runCreate(
    value: { readonly command: CreateUploadInput; readonly checksum: MediaChecksum },
    issue: boolean,
  ) {
    const v = closed(value, ["command", "checksum"]),
      checksum = parseMediaChecksum(v.checksum);
    const r = closed(v.command, [
      "tenantContext",
      "scope",
      "uploadSessionId",
      "purpose",
      "mediaKind",
      "declaredContentType",
      "declaredByteSize",
      "ownerType",
      "ownerReference",
      "classification",
      "createdAt",
      "expiresAt",
      "idempotencyKey",
      "auditId",
      "correlationId",
      "sourceChannel",
    ]);
    const input = r as unknown as CreateUploadInput;
    const logical = Object.fromEntries(
      Object.entries(r).filter(([key]) => key !== "tenantContext"),
    );
    const requestDigest = digest({
      profile: "S3_IMAGE_CREATE_REQUEST_V1",
      ...identity,
      command: logical,
      config,
      checksum,
    });
    let binding: UploadBinding | undefined,
      post: Awaited<ReturnType<typeof provider.signUpload>> | undefined;
    const committed = await commit({
      action: "CreateUpload",
      operationReference: input.idempotencyKey,
      purposeCode: input.purpose,
      ownerType: input.ownerType,
      ownerReference: input.ownerReference,
      originalIntentDigest: requestDigest,
      prepare: async (tx) => {
        const old = await original(tx, input.idempotencyKey);
        if (old && old.action !== "CreateUpload") return fail();
        if (issue && !old) return fail();
        if (old) {
          const saved = await loadUpload(tx, old.input.session.uploadSessionId);
          binding = saved.binding;
          if (!equal(saved.command, old) || binding.requestDigest !== requestDigest) return fail();
        } else {
          const at = parseMediaInstant(now());
          if (at < input.createdAt || at >= input.expiresAt) return fail();
        }
        let command: MediaUploadStorageCommand | undefined;
        await createUpload(
          input,
          ports(
            (c) => {
              command = c;
            },
            async () => (old ? old.input.session.grantReference : uuidV7()),
            async () => fail(),
          ),
        );
        if (!command || command.action !== "CreateUpload") return fail();
        binding ??= uploadBinding(
          {
            profile: "S3_IMAGE_UPLOAD_V1",
            requestDigest,
            commandDigest: mediaUploadStorageIntentDigest(command),
            config,
            key:
              config.quarantinePrefix + randomBytes(quarantineImageObjectNameBytes).toString("hex"),
            checksum,
          },
          command,
          config,
        );
        if (binding.commandDigest !== mediaUploadStorageIntentDigest(command)) return fail();
        if (issue) {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "MediaUploadSession:" + command.input.session.uploadSessionId,
          ]);
          const active = one(
            await tx.query(
              "SELECT snapshot_json snapshot FROM bop_media.upload_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND upload_session_id=$4 AND actor_id=$5 FOR UPDATE",
              params(command.input.session.uploadSessionId),
            ),
          );
          if (
            !active ||
            !equal(active.snapshot, command.input.session) ||
            parseMediaInstant(now()) >= command.input.session.expiresAt
          )
            return fail();
          post = await provider.signUpload({
            session: command.input.session,
            key: binding.key,
            checksum,
          });
        }
        return command;
      },
      persist: async (tx, command, recordedAt) => {
        if (!binding || command.action !== "CreateUpload") return fail();
        inserted(
          await tx.query(
            `INSERT INTO bop_media.upload_object_binding(upload_session_id,operation_id,tenant_id,brand_id,store_id,actor_id,grant_reference,bucket,key,binding_digest,binding_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
            [
              command.input.session.uploadSessionId,
              command.input.idempotencyKey,
              identity.tenantReference,
              config.scope.brandReference,
              config.scope.storeReference,
              identity.actorReference,
              command.input.session.grantReference,
              config.bucket,
              binding.key,
              digest(binding),
              canonicalizeRfc8785(binding),
              recordedAt,
            ],
          ),
        );
      },
    });
    if (committed.action !== "CreateUpload") return fail();
    return { session: committed.input.session, post };
  }
  async function runFinalize(value: FinalizeAssetInput, recoveryOnly: boolean) {
    const r = closed(value, [
      "tenantContext",
      "session",
      "assetId",
      "assetVersionId",
      "occurredAt",
      "idempotencyKey",
      "auditId",
      "correlationId",
      "sourceChannel",
    ]);
    const input = r as unknown as FinalizeAssetInput;
    const logical = Object.fromEntries(
      Object.entries(r).filter(([key]) => key !== "tenantContext"),
    );
    const requestDigest = digest({
      profile: "S3_IMAGE_FINALIZE_REQUEST_V1",
      ...identity,
      command: logical,
      config,
    });
    let binding: FinalBinding | undefined;
    const committed = await commit({
      action: "FinalizeAsset",
      operationReference: input.idempotencyKey,
      purposeCode: input.session.purpose,
      ownerType: input.session.ownerType,
      ownerReference: input.session.ownerReference,
      originalIntentDigest: requestDigest,
      prepare: async (tx) => {
        const old = await original(tx, input.idempotencyKey);
        if (old && old.action !== "FinalizeAsset") return fail();
        if (recoveryOnly && !old) return fail();
        const saved = await loadUpload(tx, input.session.uploadSessionId);
        if (!equal(saved.command.input.session, input.session)) return fail();
        if (old) {
          binding = await loadFinal(tx, old, saved.binding);
          if (binding.requestDigest !== requestDigest) return fail();
        } else {
          const at = parseMediaInstant(now());
          if (at < input.session.createdAt || at >= input.session.expiresAt) return fail();
        }
        let command: MediaUploadStorageCommand | undefined;
        await finalizeAsset(
          input,
          ports(
            (c) => {
              command = c;
            },
            async () => fail(),
            async () => {
              if (old) return old.input.assetVersion;
              const verified = await provider.verifyUpload({
                session: input.session,
                key: saved.binding.key,
                checksum: saved.binding.checksum,
              });
              const objectEvidenceReference = parseObjectEvidenceReference(uuidV7()),
                providerObjectVersion = parseMediaReferenceId(uuidV7());
              binding = {
                profile: "S3_IMAGE_FINALIZED_V1",
                requestDigest,
                commandDigest: "",
                uploadBindingDigest: digest(saved.binding),
                object: {
                  bucket: config.bucket,
                  key: saved.binding.key,
                  versionId: verified.versionId,
                  etag: verified.etag,
                  objectEvidenceReference,
                  providerObjectVersion,
                },
                observedAt: verified.observedAt,
              };
              return {
                byteSize: verified.byteSize,
                checksum: verified.checksum,
                contentType: verified.contentType,
                objectEvidenceReference,
                providerObjectVersion,
              };
            },
          ),
        );
        if (!command || command.action !== "FinalizeAsset" || !binding) return fail();
        binding = finalBinding(
          {
            ...binding,
            commandDigest: old ? binding.commandDigest : mediaUploadStorageIntentDigest(command),
          },
          command,
          saved.binding,
        );
        return command;
      },
      persist: async (tx, command, recordedAt) => {
        if (!binding || command.action !== "FinalizeAsset" || binding.observedAt > recordedAt)
          return fail();
        const o = binding.object;
        inserted(
          await tx.query(
            `INSERT INTO bop_media.finalized_object_binding(asset_version_id,operation_id,upload_session_id,asset_id,tenant_id,brand_id,store_id,actor_id,object_evidence_reference,provider_object_version,bucket,key,version_id,etag,binding_digest,binding_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
            [
              command.input.assetVersion.assetVersionId,
              command.input.idempotencyKey,
              command.input.closedSession.uploadSessionId,
              command.input.asset.assetId,
              identity.tenantReference,
              config.scope.brandReference,
              config.scope.storeReference,
              identity.actorReference,
              o.objectEvidenceReference,
              o.providerObjectVersion,
              o.bucket,
              o.key,
              o.versionId,
              o.etag,
              digest(binding),
              canonicalizeRfc8785(binding),
              recordedAt,
            ],
          ),
        );
      },
    });
    if (committed.action !== "FinalizeAsset" || !binding) return fail();
    return { ...mediaUploadStorageResult(committed), object: binding.object };
  }
  return Object.freeze({
    createUpload: async (input: {
      readonly command: CreateUploadInput;
      readonly checksum: MediaChecksum;
    }) => (await runCreate(input, false)).session,
    issueUploadPost: async (input: {
      readonly command: CreateUploadInput;
      readonly checksum: MediaChecksum;
    }) => {
      const result = await runCreate(input, true);
      return result.post ?? fail();
    },
    finalizeAsset: async (input: FinalizeAssetInput) => {
      const result = await runFinalize(input, false);
      if (!("asset" in result)) return fail();
      return Object.freeze({
        session: result.session,
        asset: result.asset,
        assetVersion: result.assetVersion,
      });
    },
    // Owning User recovery only. A trusted System scan worker needs its own
    // held authority/ingress; this method does not manufacture either.
    recoverFinalizedUpload: async (input: FinalizeAssetInput) =>
      Object.freeze(await runFinalize(input, true)),
  });
}
