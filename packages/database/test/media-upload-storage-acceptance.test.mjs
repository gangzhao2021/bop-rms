import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import pg from "pg";
import { it } from "vitest";
import {
  createMediaScope,
  createUpload,
  finalizeAsset,
  MediaServiceError,
} from "../../bop/media/src/index.ts";
import {
  createPostgresMediaUnitOfWork,
  mediaPersistenceRequiredFields,
} from "../../bop/media/src/infrastructure/persistence/media-upload-store.ts";
import {
  createPostgresMediaPublicationReadSource,
  createPostgresMediaOptionSetPublicationReadSource,
} from "../../bop/media/src/infrastructure/persistence/media-publication-read-store.ts";
import {
  mediaPublicationReadFields,
  parseMediaPublicationReadRequest,
  parseMediaPublicationReadSnapshot,
  parseMediaOptionSetPublicationReadRequest,
  parseMediaOptionSetPublicationReadSnapshot,
} from "../../bop/media/src/contracts/media-publication-read.ts";
import {
  evaluatePermission,
  buildSystemMediaImagePromotionAuthorizationDecision,
  createPostgresSystemMediaImagePromotionAuthorizationSource,
  createPostgresSystemMediaImagePromotionProvisioner,
  systemMediaImagePromotionRequiredFields,
} from "../../bop/permission/src/index.ts";
import { createMediaImageWorkerTransactions } from "../../../apps/worker/src/media-image-transactions.ts";
import { createPostgresMediaImageScanAdmissionStore } from "../../bop/media/src/infrastructure/persistence/media-image-scan-admission-store.ts";
import {
  createMediaImageWorkerRuntime,
  mediaImageWorkerConfigurationDigest,
} from "../../bop/media/src/infrastructure/persistence/media-image-worker-runtime.ts";
import { createFreshSqsImageScanQueue } from "../../bop/media/src/infrastructure/provider/sqs-image-scan-ingress.ts";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import { resolveMediaImageProcessingSource } from "../../bop/media/src/infrastructure/persistence/media-image-processing-source.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createS3ImageUploadRuntime } from "../../bop/media/src/infrastructure/persistence/s3-image-upload-runtime.ts";
import { createS3ImageUploadProvider } from "../../bop/media/src/infrastructure/provider/s3-image-upload-provider.ts";
import { createS3QuarantineImageSource } from "../../bop/media/src/infrastructure/provider/s3-quarantine-image-source.ts";
import { createS3ImagePromotionWriter } from "../../bop/media/src/infrastructure/provider/s3-image-promotion-writer.ts";
import {
  createMediaImageProcessingStore,
  createMediaImageProcessingRuntime,
} from "../../bop/media/src/infrastructure/persistence/media-image-processing-store.ts";

const id = (n) => `01902473-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const tables = [
  "upload_session",
  "asset",
  "asset_version",
  "operation_record",
  "upload_object_binding",
  "finalized_object_binding",
];
const snapshotSql = `SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY upload_session_id),'[]'::jsonb) FROM bop_media.upload_session s) sessions,
  (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY asset_id),'[]'::jsonb) FROM bop_media.asset a) assets,
  (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY asset_version_id),'[]'::jsonb) FROM bop_media.asset_version v) versions,
  (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY operation_id),'[]'::jsonb) FROM bop_media.operation_record o) operations,
  (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY upload_session_id),'[]'::jsonb) FROM bop_media.upload_object_binding b) uploads,
  (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY asset_version_id),'[]'::jsonb) FROM bop_media.finalized_object_binding b) objects,
  (SELECT count(*)::int FROM platform_audit.audit_record) audits,
  (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY brand_id,scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Provider grants, verified object metadata and current User permission inputs are
 * controlled synthetic collaborators. Public createUpload/finalizeAsset, Media
 * persistence, PostgreSQL constraints/RLS, Audit and outer commit guards are real.
 * No network, scanner result, clean object or publication readiness is asserted. */
it("persists Media upload finalization with quarantine-only history, exact replay, scoped CAS and atomic late rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_media_upload" }, async (database) => {
    const admin = new pg.Client(database.clientConfig);
    await admin.connect();
    const role = "wp2421_media_upload_" + database.runId;
    assert.match(role, /^wp2421_media_upload_[a-f0-9]+$/u);
    const tenant = id(1),
      brand = id(2),
      store = id(3),
      actor = id(4);
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const time = (offset) => new Date(Date.parse(at) + offset).toISOString();
    const scope = createMediaScope({ kind: "Store", brandReference: brand, storeReference: store });
    const brandScope = createMediaScope({
      kind: "Brand",
      brandReference: brand,
      storeReference: null,
    });
    const transactionsByIdentity = new WeakMap();
    const commits = new Map();
    const authorityCalls = [];
    let clock = at,
      allowed = true,
      skipBinding = false,
      failure = null,
      afterWork = null;
    let tentative,
      lastFinalError,
      outerCommits = 0,
      grantCalls = 0,
      verifierCalls = 0;
    let countReplaySessionReads = false,
      replaySessionReads = 0;
    let skipProcessing = null;
    let lastSqlFailure = null,
      processingTrace = null;
    let sequence = 10000;
    const snapshot = async (connection = admin) => (await connection.query(snapshotSql)).rows[0];
    function tenantContext(mediaScope) {
      const actualBrand = createBrand({
        brandReference: mediaScope.brandReference,
        code: "SYNTHETIC_MEDIA_BRAND",
        displayName: "Synthetic Media Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const actualStore =
        mediaScope.storeReference === null
          ? null
          : createStore({
              storeReference: mediaScope.storeReference,
              brandReference: mediaScope.brandReference,
              code: "SYNTHETIC_MEDIA_STORE",
              displayName: "Synthetic Media Store",
              timeZone: "America/Toronto",
              locale: "en-CA",
              currencyCode: "CAD",
              lifecycle: "Active",
              version: 1,
              createdAt: at,
              updatedAt: at,
            });
      return createTenantContext(
        {
          actorType: "User",
          accountKind: "Workforce",
          actorReference: actor,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: at,
          recentMfaAt: null,
        },
        actualBrand,
        actualStore,
        at,
      );
    }
    async function registerBeforeCommit(tx, guard, finalAssert) {
      const pending = transactionsByIdentity.get(tx);
      assert(pending, "Media must register against its actual open transaction");
      assert.equal(pending.phase, "work");
      assert.equal(typeof guard, "function");
      assert.equal(typeof finalAssert, "function");
      pending.guards.push({ guard, finalAssert });
    }
    const transactions = {
      async run(work) {
        const client = new pg.Client({ ...database.clientConfig, query_timeout: 5000 });
        await client.connect();
        let tx;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          tx = {
            async query(sql, values = []) {
              const pending = transactionsByIdentity.get(tx);
              assert(
                pending && pending.phase !== "final",
                "No SQL during synchronous final checks",
              );
              if (countReplaySessionReads && /\bFROM bop_media\.upload_session\b/u.test(sql))
                replaySessionReads++;
              if (skipBinding && sql.includes("INSERT INTO bop_media.upload_object_binding"))
                return { rows: [], rowCount: 1 };
              if (skipProcessing && sql.includes("INSERT INTO bop_media." + skipProcessing)) {
                skipProcessing = null;
                return { rows: [], rowCount: 1 };
              }
              if (failure === "audit" && sql.includes("INSERT INTO platform_audit.audit_record")) {
                tentative = await snapshot(client);
                throw new Error("SYNTHETIC_MEDIA_AUDIT_FAILURE");
              }
              try {
                const response = await client.query(sql, [...values]);
                if (processingTrace)
                  processingTrace.push({
                    kind: sql.slice(0, sql.indexOf(" ")),
                    tables: [...sql.matchAll(/bop_media\.([a-z_]+)/gu)].map((m) => m[1]),
                    rows: response.rowCount,
                    coherent: response.rows[0]?.coherent,
                  });
                return response;
              } catch (error) {
                lastSqlFailure = {
                  code: error.code,
                  routine: error.routine,
                  constraint: error.constraint,
                };
                throw error;
              }
            },
          };
          const pending = { phase: "work", guards: [] };
          transactionsByIdentity.set(tx, pending);
          const result = await work(tx);
          const hook = afterWork;
          if (hook !== null) {
            afterWork = null;
            await hook(tx, client, pending);
          }
          pending.phase = "guards";
          for (const { guard } of pending.guards) assert.equal(await guard(), undefined);
          pending.phase = "final";
          for (const { finalAssert } of pending.guards) {
            try {
              assert.equal(finalAssert(), undefined);
            } catch (error) {
              lastFinalError = error;
              throw error;
            }
          }
          await client.query("COMMIT");
          outerCommits++;
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          if (tx) transactionsByIdentity.delete(tx);
          await client.end();
        }
      },
    };
    const authority = {
      async holdUntilTransactionCompletes(tx, request) {
        assert(transactionsByIdentity.has(tx));
        assert.equal(request.tenantReference, tenant);
        assert.equal(request.actorReference, actor);
        assert.equal(request.actorKind, "User");
        assert.equal(request.purposeCode, "PRODUCT_IMAGE");
        assert.equal(request.ownerType, "PRODUCT");
        assert.equal(request.scope.brandReference, brand);
        assert.deepEqual(request.requiredFields, mediaPersistenceRequiredFields);
        assert.match(request.originalIntentDigest, /^sha256:[0-9a-f]{64}$/u);
        assert(["Intent", "Apply", "Replay"].includes(request.phase));
        assert(["media.upload.create", "media.asset.finalize"].includes(request.action));
        authorityCalls.push({ phase: request.phase, operation: request.operationReference });
        if (!allowed) throw new MediaServiceError("MEDIA_PERMISSION_DENIED");
        return {
          observedAt: request.observedAt,
          validUntil: new Date(
            Math.min(Date.parse(request.validUntil), Date.parse(request.observedAt) + 5000),
          ).toISOString(),
        };
      },
    };
    function owner(mediaScope = scope, ownerTransactions = transactions) {
      return createPostgresMediaUnitOfWork({
        tenantReference: tenant,
        scope: mediaScope,
        actorReference: actor,
        clock: { now: () => clock },
        transactions: ownerTransactions,
        registerBeforeCommit,
        authority,
      });
    }
    function ports(mediaScope = scope, ownerTransactions = transactions) {
      const actualOwner = owner(mediaScope, ownerTransactions);
      return {
        authorization: {
          async authorize(request) {
            return evaluatePermission({
              tenantContext: request.tenantContext,
              action: request.action,
              resourceScope: request.resourceScope,
              policySnapshotReference: id(80),
              policyVersion: 1,
              evidence: [
                {
                  source: "ExplicitAllow",
                  evidenceReference: id(81),
                  action: request.action,
                  actorReference: actor,
                  roleReference: null,
                  brandReference: request.resourceScope.brandReference,
                  storeReference: request.resourceScope.storeReference,
                  effectiveFrom: at,
                  effectiveUntil: time(86_400_000),
                },
              ],
            });
          },
        },
        uploadGrant: {
          async create(request) {
            grantCalls++;
            // The synthetic provider is idempotent for the supplied operation.
            return request.idempotencyKey;
          },
        },
        uploadEvidence: {
          async verify(session) {
            verifierCalls++;
            return {
              objectEvidenceReference: session.uploadSessionId,
              providerObjectVersion: session.grantReference,
              byteSize: session.declaredByteSize,
              checksum: "sha256:" + "a".repeat(64),
              contentType: session.declaredContentType,
            };
          },
        },
        unitOfWork: {
          async commitCreateUpload(input) {
            commits.set(input.idempotencyKey, input);
            return actualOwner.commitCreateUpload(input);
          },
          async commitFinalizeAsset(input) {
            commits.set(input.idempotencyKey, input);
            return actualOwner.commitFinalizeAsset(input);
          },
        },
        // These existing service operations must not consult a fabricated read source.
        read: {
          async loadAsset() {
            throw new Error("UNEXPECTED_MEDIA_READ");
          },
          async loadVersion() {
            throw new Error("UNEXPECTED_MEDIA_READ");
          },
          async loadVersions() {
            throw new Error("UNEXPECTED_MEDIA_READ");
          },
        },
      };
    }
    function createInput(base, mediaScope = scope) {
      return {
        tenantContext: tenantContext(mediaScope),
        scope: mediaScope,
        uploadSessionId: id(base),
        purpose: "PRODUCT_IMAGE",
        mediaKind: "Image",
        declaredContentType: "image/png",
        declaredByteSize: 1024,
        ownerType: "PRODUCT",
        ownerReference: id(90),
        classification: "Internal",
        createdAt: clock,
        expiresAt: new Date(Date.parse(clock) + 900_000).toISOString(),
        idempotencyKey: id(base + 1),
        auditId: id(base + 2),
        correlationId: id(base + 3),
        sourceChannel: "API",
      };
    }
    function finalizeInput(session, base, mediaScope = scope) {
      return {
        tenantContext: tenantContext(mediaScope),
        session,
        assetId: id(base),
        assetVersionId: id(base + 1),
        occurredAt: clock,
        idempotencyKey: id(base + 2),
        auditId: id(base + 3),
        correlationId: id(base + 4),
        sourceChannel: "API",
      };
    }
    async function inScope(scopeValues, work) {
      const client = new pg.Client(database.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          scopeValues,
        );
        const value = await work(client);
        await client.query("ROLLBACK");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_media,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON bop_media.upload_session TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON bop_media.asset,bop_media.asset_version,bop_media.operation_record,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON bop_media.upload_object_binding,bop_media.finalized_object_binding TO " +
          role,
      );

      const schema = await admin.query(
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='bop_media'::regnamespace AND relkind='r' ORDER BY relname",
      );
      assert.deepEqual(
        schema.rows,
        [
          ...tables,
          "image_processing_intent",
          "image_processing_completion",
          "image_rendition",
          "image_scan_admission",
        ]
          .sort()
          .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
      );
      const acl = await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='bop_media'::regnamespace AND c.relkind='r' AND a.grantee=0) AS unsafe",
      );
      assert.equal(acl.rows[0].unsafe, false);

      const upload = createInput(100);
      const pending = await createUpload(upload, ports());
      assert.equal(pending.state, "Pending");
      assert.equal(pending.version, 1);
      let saved = await snapshot();
      assert.equal(saved.sessions.length, 1);
      assert.deepEqual(saved.sessions[0].snapshot_json, pending);
      assert.equal(saved.operations.length, 1);
      assert.equal(saved.audits, 1);
      assert.equal(saved.assets.length, 0);
      const originalCreateBytes = JSON.stringify(saved.operations[0]);
      clock = time(1000);
      const finalize = finalizeInput(pending, 200);
      const finalized = await finalizeAsset(finalize, ports());
      assert.equal(finalized.session.state, "Finalized");
      assert.equal(finalized.session.version, 2);
      assert.equal(finalized.asset.currentVersionReference, null);
      assert.equal(finalized.assetVersion.checkState, "Quarantined");
      assert.equal(finalized.assetVersion.readinessState, "Pending");
      saved = await snapshot();
      assert.deepEqual(saved.sessions[0].snapshot_json, finalized.session);
      assert.deepEqual(saved.assets[0].snapshot_json, finalized.asset);
      assert.deepEqual(saved.versions[0].snapshot_json, finalized.assetVersion);
      assert.equal(saved.assets[0].current_version_id, null);
      assert.equal(saved.operations.length, 2);
      assert.equal(saved.audits, 2);
      assert.equal(
        JSON.stringify(saved.operations.find((row) => row.operation_id === upload.idempotencyKey)),
        originalCreateBytes,
      );
      const immutableAfterFinalize = await snapshot();

      // Original public service retries remain compatible; its existing provider
      // calls are deliberately observable, not represented as source-free replay.
      assert.deepEqual(await createUpload(upload, ports()), pending);
      assert.deepEqual(await finalizeAsset(finalize, ports()), finalized);
      assert.deepEqual(await snapshot(), immutableAfterFinalize);
      assert.equal(grantCalls, 2);
      assert.equal(verifierCalls, 2);
      const originalCreate = commits.get(upload.idempotencyKey);
      const originalFinalize = commits.get(finalize.idempotencyKey);
      assert(originalCreate && originalFinalize);
      clock = time(901_000);
      countReplaySessionReads = true;
      await owner().commitCreateUpload(originalCreate);
      await owner().commitFinalizeAsset(originalFinalize);
      countReplaySessionReads = false;
      assert.equal(
        replaySessionReads,
        0,
        "Original receipt must recover before reading the mutable session",
      );
      assert.deepEqual(await snapshot(), immutableAfterFinalize);
      assert(
        authorityCalls.some(
          (entry) => entry.phase === "Replay" && entry.operation === finalize.idempotencyKey,
        ),
      );
      assert.equal(verifierCalls, 2, "Owning original replay must not refresh provider evidence");
      await assert.rejects(
        owner().commitCreateUpload({
          ...originalCreate,
          session: { ...originalCreate.session, declaredByteSize: 2048 },
        }),
        { code: "MEDIA_COMMIT_FAILED" },
      );
      await assert.rejects(
        owner().commitFinalizeAsset({
          ...originalFinalize,
          assetVersion: { ...originalFinalize.assetVersion, checksum: "sha256:" + "b".repeat(64) },
        }),
        { code: "MEDIA_COMMIT_FAILED" },
      );
      assert.deepEqual(await snapshot(), immutableAfterFinalize);
      allowed = false;
      await assert.rejects(owner().commitFinalizeAsset(originalFinalize));
      allowed = true;
      assert.deepEqual(await snapshot(), immutableAfterFinalize);

      clock = time(902_000);
      const racePending = await createUpload(createInput(300), ports());
      clock = time(903_000);
      const candidates = [finalizeInput(racePending, 400), finalizeInput(racePending, 500)];
      const beforeRace = await snapshot();
      const race = await Promise.allSettled(
        candidates.map((input) => finalizeAsset(input, ports())),
      );
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      const loser = race.find((result) => result.status === "rejected");
      assert(loser);
      assert.equal(loser.reason.code, "MEDIA_COMMIT_FAILED");
      const afterRace = await snapshot();
      assert.equal(afterRace.assets.length, beforeRace.assets.length + 1);
      assert.equal(afterRace.versions.length, beforeRace.versions.length + 1);
      assert.equal(afterRace.operations.length, beforeRace.operations.length + 1);
      assert.equal(afterRace.audits, beforeRace.audits + 1);
      assert.equal(
        afterRace.sessions.find((row) => row.upload_session_id === racePending.uploadSessionId)
          .snapshot_json.version,
        2,
      );

      const brandPending = await createUpload(createInput(600, brandScope), ports(brandScope));
      const storeVisible = await inScope([tenant, brand, store], snapshot);
      assert.equal(storeVisible.sessions.length, 2);
      const brandVisible = await inScope([tenant, brand, ""], snapshot);
      assert.deepEqual(
        brandVisible.sessions.map((row) => row.upload_session_id),
        [brandPending.uploadSessionId],
      );
      assert.equal(brandVisible.assets.length, 0);
      for (const hiddenScope of [
        [id(800), brand, store],
        [tenant, id(801), store],
        [tenant, brand, id(802)],
        ["", "", ""],
      ]) {
        await inScope(hiddenScope, async (client) => {
          for (const table of tables)
            assert.equal(
              (await client.query("SELECT count(*)::int n FROM bop_media." + table)).rows[0].n,
              0,
            );
        });
      }
      const forbiddenInsert = globalThis.structuredClone((await snapshot()).sessions[0]);
      forbiddenInsert.upload_session_id = id(810);
      forbiddenInsert.snapshot_json.uploadSessionId = id(810);
      forbiddenInsert.snapshot_json.state = "Pending";
      forbiddenInsert.snapshot_json.version = 1;
      forbiddenInsert.version = 1;
      forbiddenInsert.state = "Pending";
      await assert.rejects(
        inScope([id(800), brand, store], (client) =>
          client.query(
            "INSERT INTO bop_media.upload_session SELECT (jsonb_populate_record(NULL::bop_media.upload_session,$1::jsonb)).*",
            [JSON.stringify(forbiddenInsert)],
          ),
        ),
        { code: "42501" },
      );
      await assert.rejects(
        inScope([tenant, brand, store], async (client) => {
          await client.query(
            "INSERT INTO bop_media.upload_session SELECT (jsonb_populate_record(NULL::bop_media.upload_session,$1::jsonb)).*",
            [JSON.stringify(forbiddenInsert)],
          );
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        }),
        { code: "23514", message: "MEDIA_UPLOAD_ORIGIN_INVALID" },
      );

      // These admin probes deliberately have SQL privileges. Failures therefore
      // prove owning immutable/quarantine constraints, not only absent grants.
      const immutable = await snapshot();
      for (const table of ["asset", "asset_version", "operation_record"]) {
        const column = table === "operation_record" ? "result_json" : "snapshot_json";
        await assert.rejects(admin.query(`UPDATE bop_media.${table} SET ${column}=${column}`), {
          code: "55000",
        });
        await assert.rejects(admin.query(`DELETE FROM bop_media.${table}`), { code: "55000" });
      }
      await assert.rejects(admin.query("DELETE FROM bop_media.upload_session"), { code: "55000" });
      await assert.rejects(
        admin.query(
          "TRUNCATE " +
            [
              ...tables,
              "image_processing_intent",
              "image_processing_completion",
              "image_rendition",
              "image_scan_admission",
            ]
              .map((table) => "bop_media." + table)
              .join(","),
        ),
        { code: "55000" },
      );
      const forbiddenVersion = globalThis.structuredClone(immutable.versions[0]);
      forbiddenVersion.asset_version_id = id(820);
      forbiddenVersion.snapshot_json.assetVersionId = id(820);
      forbiddenVersion.snapshot_json.checkState = "Clean";
      forbiddenVersion.snapshot_json.readinessState = "Ready";
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_media.asset_version SELECT (jsonb_populate_record(NULL::bop_media.asset_version,$1::jsonb)).*",
          [JSON.stringify(forbiddenVersion)],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        admin.query(
          "UPDATE bop_media.asset SET current_version_id=$1::uuid,snapshot_json=jsonb_set(snapshot_json,'{currentVersionReference}',to_jsonb($1::uuid::text)) WHERE asset_id=$2",
          [finalized.assetVersion.assetVersionId, finalized.asset.assetId],
        ),
        { code: "55000" },
      );
      assert.deepEqual(await snapshot(), immutable);

      for (const mode of ["late-authority", "final-expiry", "audit"]) {
        clock = time(910_000 + sequence);
        const rollbackPending = await createUpload(createInput(sequence), ports());
        sequence += 20;
        const input = finalizeInput(rollbackPending, sequence);
        sequence += 20;
        const before = await snapshot();
        const beforeVisible = await inScope([tenant, brand, store], snapshot);
        const commitCount = outerCommits;
        const deadline = new Date(Date.parse(clock) + 5000).toISOString();
        tentative = null;
        lastFinalError = null;
        if (mode === "audit") failure = "audit";
        else
          afterWork = async (tx, client, pendingGuards) => {
            tentative = await snapshot(client);
            if (mode === "late-authority") allowed = false;
            else {
              // A later owner consumes the Media lease AFTER Media's async guard.
              // Only the final synchronous phase may catch this exact expiry.
              assert(pendingGuards.guards.length > 0);
              await registerBeforeCommit(
                tx,
                async () => {
                  clock = deadline;
                },
                () => undefined,
              );
            }
          };
        await assert.rejects(finalizeAsset(input, ports()), { code: "MEDIA_COMMIT_FAILED" });
        failure = null;
        allowed = true;
        afterWork = null;
        assert(tentative, `${mode} must observe actual tentative Media writes`);
        assert.equal(tentative.assets.length, beforeVisible.assets.length + 1);
        assert.equal(tentative.versions.length, beforeVisible.versions.length + 1);
        assert.equal(
          tentative.sessions.find(
            (row) => row.upload_session_id === rollbackPending.uploadSessionId,
          ).snapshot_json.state,
          "Finalized",
        );
        if (mode !== "audit") {
          assert.equal(tentative.operations.length, beforeVisible.operations.length + 1);
          assert.equal(tentative.audits, beforeVisible.audits + 1);
        }
        if (mode === "final-expiry")
          assert(lastFinalError, "Original Media final guard must reject after all async guards");
        assert.equal(outerCommits, commitCount);
        assert.deepEqual(await snapshot(), before);
      }

      // Real S3 runtime, owning SQL and SDK commands; Provider responses and
      // current User authority are explicitly synthetic, with no AWS network.
      const config = {
        tenantReference: tenant,
        scope,
        region: "ca-central-1",
        accountId: "111122223333",
        bucket: "synthetic-media-quarantine",
        quarantinePrefix: "quarantine/",
        kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        protectionPlanArn:
          "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
      };
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPQSFnQgA8zDAUFAOzoUEEicwajAAAAAElFTkSuQmCC",
        "base64",
      );
      const checksum = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      let headCalls = 0,
        postCalls = 0,
        currentVersion = "synthetic-pinned-version-1",
        providerSession;
      const etag = "a".repeat(32);
      const metadata = () => ({
        "bop-tenant-reference": tenant,
        "bop-brand-reference": brand,
        "bop-store-reference": store,
        "bop-upload-session-reference": providerSession.uploadSessionId,
        "bop-actor-reference": actor,
        "bop-purpose": providerSession.purpose,
        "bop-owner-type": providerSession.ownerType,
        "bop-owner-reference": providerSession.ownerReference,
        "bop-classification": providerSession.classification,
      });
      const headers = (versionId) => ({
        $metadata: { httpStatusCode: 200 },
        VersionId: versionId,
        ETag: '"' + etag + '"',
        ContentLength: bytes.length,
        ContentType: "image/png",
        ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        ChecksumType: "FULL_OBJECT",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: config.kmsKeyArn,
        Metadata: metadata(),
      });
      const actualProvider = createS3ImageUploadProvider({
        config,
        clock: { now: () => clock },
        sdk: {
          async send(command) {
            headCalls++;
            assert.equal(command.constructor.name, "HeadObjectCommand");
            assert.equal(command.input.ExpectedBucketOwner, config.accountId);
            assert.equal(command.input.ChecksumMode, "ENABLED");
            const record = (await snapshot()).uploads.find(
              (row) => row.upload_session_id === providerSession.uploadSessionId,
            );
            assert(record, "Destination must be durably committed before S3 verification");
            assert.equal(command.input.Key, record.key);
            return headers(command.input.VersionId ?? currentVersion);
          },
        },
      });
      const runtime = createS3ImageUploadRuntime({
        tenantReference: tenant,
        scope,
        actorReference: actor,
        clock: { now: () => clock },
        transactions,
        registerBeforeCommit,
        authority,
        authorization: ports().authorization,
        config,
        provider: {
          verifyUpload: actualProvider.verifyUpload,
          async signUpload(input) {
            postCalls++;
            assert.equal(input.session.uploadSessionId, providerSession.uploadSessionId);
            return {
              url: "https://synthetic-media-quarantine.s3.ca-central-1.amazonaws.com/",
              fields: { key: input.key },
              expiresAt: input.session.expiresAt,
            };
          },
        },
      });
      clock = time(2_000_000);
      const request = {
        command: { ...createInput(20000), declaredByteSize: bytes.length },
        checksum,
      };
      const createdOutcomes = await Promise.allSettled([
        runtime.createUpload(request),
        runtime.createUpload(request),
      ]);
      assert(
        createdOutcomes.every((result) => result.status === "fulfilled"),
        JSON.stringify({ stage: "create-replay", lastSqlFailure }),
      );
      const created = createdOutcomes.map((result) => result.value);
      assert.deepEqual(created[0], created[1], "Same-operation concurrent creation has one grant");
      providerSession = created[0];
      const uploadRows = (await snapshot()).uploads;
      assert.equal(uploadRows.length, 1);
      assert.match(uploadRows[0].key, /^quarantine\/[a-f0-9]{64}$/u);
      assert.equal(uploadRows[0].grant_reference, providerSession.grantReference);
      assert.equal(headCalls, 0);
      assert.equal(postCalls, 0);
      const post = await runtime.issueUploadPost(request);
      assert.equal(post.fields.key, uploadRows[0].key);
      assert.equal(postCalls, 1);
      assert(
        !JSON.stringify(await snapshot()).includes('"fields"'),
        "Signed material is not persisted",
      );
      clock = time(2_001_000);
      const finalRequest = finalizeInput(providerSession, 20100);
      const finalOutcomes = await Promise.allSettled([
        runtime.finalizeAsset(finalRequest),
        runtime.finalizeAsset(finalRequest),
      ]);
      assert(
        finalOutcomes.every((result) => result.status === "fulfilled"),
        JSON.stringify({ stage: "finalize-replay", lastSqlFailure }),
      );
      const finals = finalOutcomes.map((result) => result.value);
      assert.deepEqual(finals[0], finals[1]);
      assert.equal(
        headCalls,
        2,
        "One current Head plus one explicit version Head, once per committed operation",
      );
      const persisted = await snapshot();
      assert.equal(persisted.objects.length, 1);
      assert.equal(persisted.objects[0].version_id, currentVersion);
      assert.equal(finals[0].assetVersion.readinessState, "Pending");
      await assert.rejects(runtime.issueUploadPost(request), { code: "MEDIA_COMMIT_FAILED" });
      assert.equal(postCalls, 1, "Finalized session cannot issue another form even before expiry");
      currentVersion = "synthetic-later-overwrite";
      clock = time(2_901_000);
      assert.deepEqual(await runtime.createUpload(request), providerSession);
      assert.deepEqual(await runtime.finalizeAsset(finalRequest), finals[0]);
      const recovered = await runtime.recoverFinalizedUpload(finalRequest);
      assert.equal(recovered.object.versionId, "synthetic-pinned-version-1");
      assert.equal(headCalls, 2);
      assert.equal(postCalls, 1);
      await assert.rejects(
        runtime.createUpload({ ...request, checksum: "sha256:" + "b".repeat(64) }),
      );
      await assert.rejects(runtime.finalizeAsset({ ...finalRequest, assetId: id(20500) }));
      allowed = false;
      await assert.rejects(runtime.recoverFinalizedUpload(finalRequest));
      allowed = true;
      assert.deepEqual(await snapshot(), persisted);

      const event = {
        version: "0",
        id: "72c7d362-737a-6dce-fc78-9e27a0171419",
        "detail-type": "GuardDuty Malware Protection Object Scan Result",
        source: "aws.guardduty",
        account: config.accountId,
        time: finalRequest.occurredAt,
        region: config.region,
        resources: [config.protectionPlanArn],
        detail: {
          schemaVersion: "1.0",
          scanStatus: "COMPLETED",
          resourceType: "S3_OBJECT",
          s3ObjectDetails: {
            bucketName: recovered.object.bucket,
            objectKey: recovered.object.key,
            eTag: recovered.object.etag,
            versionId: recovered.object.versionId,
            s3Throttled: false,
          },
          scanResultDetails: {
            scanResultStatus: "NO_THREATS_FOUND",
            threats: null,
            statusReasons: null,
          },
        },
      };
      const source = createS3QuarantineImageSource({
        config,
        sdk: {
          async send(command) {
            assert.equal(
              command.input.VersionId,
              recovered.object.versionId,
              "Only persisted version may be read after overwrite",
            );
            if (command.constructor.name === "GetObjectTaggingCommand")
              return {
                $metadata: { httpStatusCode: 200 },
                VersionId: recovered.object.versionId,
                TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
              };
            return {
              ...headers(recovered.object.versionId),
              ...(command.constructor.name === "GetObjectCommand"
                ? { Body: Readable.from([bytes]) }
                : {}),
            };
          },
        },
      });
      const sourceResult = await source.read({
        tenantReference: tenant,
        ...recovered,
        scanEvent: event,
      });
      assert.deepEqual(Buffer.from(sourceResult.bytes), bytes);
      assert.deepEqual(await snapshot(), persisted, "Read/scanning evidence never promotes Ready");
      for (const hiddenScope of [
        [id(800), brand, store],
        [tenant, id(801), store],
        [tenant, brand, id(802)],
        [tenant, brand, ""],
      ])
        await inScope(hiddenScope, async (client) => {
          for (const table of ["upload_object_binding", "finalized_object_binding"])
            assert.equal(
              (await client.query("SELECT count(*)::int n FROM bop_media." + table)).rows[0].n,
              0,
            );
        });
      for (const table of ["upload_object_binding", "finalized_object_binding"]) {
        await assert.rejects(
          admin.query(`UPDATE bop_media.${table} SET binding_json=binding_json`),
          { code: "55000" },
        );
        await assert.rejects(admin.query(`DELETE FROM bop_media.${table}`), { code: "55000" });
      }
      // Required mapping cannot be omitted even if raw SQL has all old receipts.
      clock = time(2_902_000);
      skipBinding = true;
      await assert.rejects(
        runtime.createUpload({
          command: { ...createInput(20600), declaredByteSize: bytes.length },
          checksum,
        }),
        { code: "MEDIA_COMMIT_FAILED" },
      );
      skipBinding = false;
      assert.deepEqual(
        await snapshot(),
        persisted,
        "Deferred origin refuses missing binding and rolls back all rows",
      );

      for (const mode of ["late-authority", "final-expiry", "audit"]) {
        clock = time(3_000_000 + sequence);
        const next = {
          command: { ...createInput(sequence), declaredByteSize: bytes.length },
          checksum,
        };
        sequence += 20;
        providerSession = await runtime.createUpload(next);
        const input = finalizeInput(providerSession, sequence);
        sequence += 20;
        const before = await snapshot();
        const deadline = new Date(Date.parse(clock) + 5000).toISOString();
        if (mode === "audit") failure = "audit";
        else
          afterWork = async (tx, client, pendingGuards) => {
            const row = await client.query(
              "SELECT count(*)::int n FROM bop_media.finalized_object_binding WHERE asset_version_id=$1",
              [input.assetVersionId],
            );
            assert.equal(row.rows[0].n, 1, "Tentative binding must be written before late failure");
            if (mode === "late-authority") allowed = false;
            else {
              assert(pendingGuards.guards.length > 0);
              await registerBeforeCommit(
                tx,
                async () => {
                  clock = deadline;
                },
                () => undefined,
              );
            }
          };
        await assert.rejects(runtime.finalizeAsset(input), { code: "MEDIA_COMMIT_FAILED" });
        failure = null;
        allowed = true;
        afterWork = null;
        assert.deepEqual(
          await snapshot(),
          before,
          "Binding, core rows, receipt and Audit rollback together",
        );
      }

      // Actual Worker host and Permission provisioner are established before any
      // new processing intent. Delivery/SDK values remain explicitly controlled
      // fixtures; all admissions, Permission decisions and Audit writes are real.
      const provisionRole = "wp2421_media_provision_" + database.runId,
        permissionTables = [
          "system_media_image_promotion_authorization",
          "system_media_image_promotion_authorization_decision",
        ],
        workloadIdentity = {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          workloadReference: id(30003),
          deploymentConfigurationDigest: "sha256:" + "d".repeat(64),
        };
      assert.match(provisionRole, /^wp2421_media_provision_[a-f0-9]+$/u);
      await admin.query(
        "CREATE ROLE " +
          provisionRole +
          " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
      );
      await admin.query("GRANT USAGE ON SCHEMA bop_permission TO " + role);
      await admin.query(
        "GRANT SELECT ON bop_permission.system_media_image_promotion_authorization,bop_permission.system_media_image_promotion_authorization_decision TO " +
          role,
      );
      await admin.query(
        "GRANT UPDATE(lock_token) ON bop_permission.system_media_image_promotion_authorization TO " +
          role,
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_permission,platform_helpers,platform_audit TO " + provisionRole,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + provisionRole);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          provisionRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_permission.system_media_image_promotion_authorization TO " +
          provisionRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON bop_permission.system_media_image_promotion_authorization_decision,platform_audit.audit_record TO " +
          provisionRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + provisionRole,
      );
      const permissionSnapshot = async (connection = admin) =>
        (
          await connection.query(`SELECT
        (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY workload_id),'[]'::jsonb) FROM bop_permission.system_media_image_promotion_authorization r) roots,
        (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY workload_id,version),'[]'::jsonb) FROM bop_permission.system_media_image_promotion_authorization_decision d) decisions,
        (SELECT count(*)::int FROM platform_audit.audit_record) audits,
        (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY brand_id,scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`)
        ).rows[0];
      let loseCompletionAcknowledgement = false,
        loseAdmissionAcknowledgement = false,
        failProvisionAudit = false,
        tentativeProvision = null,
        expireWorkerCompletion = false,
        tentativeWorkerCompletion = null;
      const workerReleases = [],
        actualAuthorityObservations = [],
        registeredExpiry = new WeakSet();
      function actualHost(sessionRole, hostTenant = tenant) {
        return createMediaImageWorkerTransactions({
          tenantReference: hostTenant,
          scope,
          async acquire() {
            const client = new pg.Client(database.clientConfig);
            await client.connect();
            try {
              // Trusted fixture admin changes the actual login identity before
              // BEGIN; no SET ROLE shortcut can satisfy the provisioner check.
              await client.query("SET SESSION AUTHORIZATION " + sessionRole);
              assert.deepEqual(
                (await client.query("SELECT session_user::text s,current_user::text c")).rows[0],
                { s: sessionRole, c: sessionRole },
              );
            } catch (error) {
              await client.end();
              throw error;
            }
            let completedWrite = false,
              admissionWrite = false;
            return {
              async query(sql, values) {
                if (
                  sessionRole === provisionRole &&
                  failProvisionAudit &&
                  sql.includes("INSERT INTO platform_audit.audit_record")
                ) {
                  tentativeProvision = await permissionSnapshot(client);
                  throw Error("SYNTHETIC_PROVISION_AUDIT_FAILURE");
                }
                let answer;
                try {
                  answer = await client.query(sql, [...values]);
                } catch (error) {
                  lastSqlFailure = { code: error.code, constraint: error.constraint ?? null };
                  throw error;
                }
                if (sql.includes("INSERT INTO bop_media.image_processing_completion"))
                  completedWrite = true;
                if (sql.includes("INSERT INTO bop_media.image_scan_admission"))
                  admissionWrite = true;
                if (
                  sql === "COMMIT" &&
                  sessionRole === role &&
                  admissionWrite &&
                  loseAdmissionAcknowledgement
                ) {
                  loseAdmissionAcknowledgement = false;
                  throw Error("SYNTHETIC_LOST_ADMISSION_COMMIT_ACKNOWLEDGEMENT");
                }
                if (
                  sql === "COMMIT" &&
                  sessionRole === role &&
                  completedWrite &&
                  loseCompletionAcknowledgement
                ) {
                  loseCompletionAcknowledgement = false;
                  throw Error("SYNTHETIC_LOST_COMMIT_ACKNOWLEDGEMENT");
                }
                return answer;
              },
              async release(discard) {
                workerReleases.push({ sessionRole, discard });
                await client.end();
              },
            };
          },
        });
      }
      const workerHost = actualHost(role),
        provisioningHost = actualHost(provisionRole),
        permissionSource = createPostgresSystemMediaImagePromotionAuthorizationSource({
          ...workloadIdentity,
          clock: { now: () => clock },
          registerBeforeCommit: workerHost.registerBeforeCommit,
        }),
        provisioner = createPostgresSystemMediaImagePromotionProvisioner({
          ...workloadIdentity,
          provisioningRoleName: provisionRole,
          clock: { now: () => clock },
          transactions: provisioningHost.transactions,
          registerBeforeCommit: provisioningHost.registerBeforeCommit,
        });
      const authorizationRequest = () => ({
        actorKind: "System",
        action: "media.asset.promote",
        purposeCode: "MEDIA_IMAGE_PROMOTION",
        requiredFields: systemMediaImagePromotionRequiredFields,
        observedAt: clock,
        validUntil: new Date(Date.parse(clock) + 5000).toISOString(),
      });
      function decisionInput(version, enabled) {
        return {
          decision: buildSystemMediaImagePromotionAuthorizationDecision({
            ...workloadIdentity,
            profile: "MEDIA_IMAGE_PROMOTION_V1",
            decisionReference: id(31000 + version),
            version,
            action: "media.asset.promote",
            purposeCode: "MEDIA_IMAGE_PROMOTION",
            requiredFields: systemMediaImagePromotionRequiredFields,
            enabled,
            effectiveFrom: at,
            effectiveUntil: null,
            recordedAt: clock,
            auditReference: id(31100 + version),
          }),
          correlationReference: id(31200 + version),
        };
      }
      // Only now grant the processing tables: all preceding legacy/quarantine
      // paths ran without those grants after the additive migration.
      await admin.query(
        "GRANT SELECT,INSERT ON bop_media.image_processing_intent,bop_media.image_processing_completion,bop_media.image_rendition,bop_media.image_scan_admission TO " +
          role,
      );
      await admin.query("GRANT UPDATE ON bop_media.asset TO " + role);
      const processingSnapshot = async () => ({
        core: await snapshot(),
        processing: (
          await admin.query(`SELECT
        (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY operation_id),'[]'::jsonb) FROM bop_media.image_processing_intent i) intents,
        (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY operation_id),'[]'::jsonb) FROM bop_media.image_processing_completion c) completions,
        (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY asset_version_id,width,content_type),'[]'::jsonb) FROM bop_media.image_rendition r) renditions,
        (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY admission_id),'[]'::jsonb) FROM bop_media.image_scan_admission a) admissions`)
        ).rows[0],
      });
      clock = time(3_100_000);
      providerSession = created[0];
      const systemActor = id(30000),
        destination = {
          accountId: config.accountId,
          bucket: "synthetic-media-clean",
          cleanPrefix: "clean/images/",
          kmsKeyArn: config.kmsKeyArn,
        };
      const prefixIdentity = { ...workloadIdentity, workloadReference: systemActor },
        prefixProvisioner = createPostgresSystemMediaImagePromotionProvisioner({
          ...prefixIdentity,
          provisioningRoleName: provisionRole,
          clock: { now: () => clock },
          transactions: provisioningHost.transactions,
          registerBeforeCommit: provisioningHost.registerBeforeCommit,
        });
      await prefixProvisioner.provision({
        decision: buildSystemMediaImagePromotionAuthorizationDecision({
          ...prefixIdentity,
          profile: "MEDIA_IMAGE_PROMOTION_V1",
          decisionReference: id(32001),
          version: 1,
          action: "media.asset.promote",
          purposeCode: "MEDIA_IMAGE_PROMOTION",
          requiredFields: systemMediaImagePromotionRequiredFields,
          enabled: true,
          effectiveFrom: at,
          effectiveUntil: null,
          recordedAt: clock,
          auditReference: id(32101),
        }),
        correlationReference: id(32201),
      });
      const registeredAdmissions = new Map();
      const controlledDelivery = (
        scanEvent,
        configurationDigest = workloadIdentity.deploymentConfigurationDigest,
      ) => ({
        scanEvent,
        transport: {
          profile: "GUARDDUTY_SQS_DELIVERY_V1",
          deploymentConfigurationDigest: configurationDigest,
          queueArn: `arn:aws:sqs:ca-central-1:${config.accountId}:synthetic-native-scan`,
          queueCreatedAt: at,
          queuePolicyDigest: "sha256:" + "b".repeat(64),
          bodyDigest:
            "sha256:" + createHash("sha256").update(JSON.stringify(scanEvent)).digest("hex"),
          messageId: "synthetic-" + scanEvent.id,
          sentAt: clock,
          receivedAt: clock,
        },
      });
      const admissionOptions = {
        tenantReference: tenant,
        scope,
        workloadReference: systemActor,
        deploymentConfigurationDigest: prefixIdentity.deploymentConfigurationDigest,
        quarantineConfig: config,
        clock: { now: () => clock },
        transactions: workerHost.transactions,
        registerBeforeCommit: workerHost.registerBeforeCommit,
      };
      const prefixAdmission = createPostgresMediaImageScanAdmissionStore(admissionOptions);
      async function admittedInput(owner, scanEvent) {
        const input = await owner.admit(controlledDelivery(scanEvent));
        registeredAdmissions.set(
          input.admissionReference,
          "sha256:" + createHash("sha256").update(canonicalizeRfc8785(scanEvent)).digest("hex"),
        );
        return input;
      }
      let systemAllowed = true;
      const processingOptions = {
        tenantReference: tenant,
        scope,
        systemActorReference: systemActor,
        clock: { now: () => clock },
        transactions,
        registerBeforeCommit,
        quarantineConfig: config,
        destination,
        authority: {
          async holdUntilTransactionCompletes(tx, request) {
            assert(transactionsByIdentity.has(tx));
            assert.equal(request.actorKind, "System");
            assert.equal(request.systemActorReference, systemActor);
            assert.equal(request.action, "media.asset.promote");
            assert.equal(
              request.scanEventDigest,
              registeredAdmissions.get(request.admissionReference),
            );
            assert.equal(
              request.sourceAssetVersionReference,
              recovered.assetVersion.assetVersionId,
            );
            assert.match(request.scanEventDigest, /^sha256:[a-f0-9]{64}$/u);
            if (!systemAllowed) throw Error("Synthetic current System permission denied");
            return { observedAt: request.observedAt, validUntil: request.validUntil };
          },
        },
      };
      const processing = createMediaImageProcessingStore(processingOptions),
        processInput = await admittedInput(prefixAdmission, event);
      lastSqlFailure = null;
      processingTrace = [];
      const planned = await processing
          .plan(processInput)
          .catch(() =>
            assert.fail(
              JSON.stringify({ stage: "processing-plan", lastSqlFailure, processingTrace }),
            ),
          ),
        plannedSnapshot = await processingSnapshot();
      assert.equal(planned.completion, null);
      assert.deepEqual(await processing.plan(processInput), planned);
      assert.deepEqual(
        await processingSnapshot(),
        plannedSnapshot,
        "Duplicate scan preserves original random keys and audit",
      );
      assert.equal(planned.intent.admissionReference, processInput.admissionReference);
      assert.equal(
        plannedSnapshot.processing.intents[0].scan_admission_id,
        processInput.admissionReference,
      );
      assert.equal(plannedSnapshot.processing.admissions.length, 1);
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_media.image_processing_intent SELECT (jsonb_populate_record(NULL::bop_media.image_processing_intent,$1::jsonb)).*",
          [JSON.stringify({ ...plannedSnapshot.processing.intents[0], scan_admission_id: null })],
        ),
        { code: "23514", constraint: "media_image_processing_admission_required" },
      );
      assert.deepEqual(await processingSnapshot(), plannedSnapshot);
      const objects = new Map(),
        writeCommands = [],
        allCommands = [];
      const sdk = {
        async send(command) {
          allCommands.push(command);
          const input = command.input,
            kind = command.constructor.name;
          if (input.Bucket === config.bucket) {
            assert.equal(input.VersionId, recovered.object.versionId);
            assert.equal(input.Key, recovered.object.key);
            if (kind === "GetObjectTaggingCommand")
              return {
                $metadata: { httpStatusCode: 200 },
                VersionId: recovered.object.versionId,
                TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
              };
            return {
              ...headers(recovered.object.versionId),
              ...(kind === "GetObjectCommand" ? { Body: Readable.from([bytes]) } : {}),
            };
          }
          if (kind === "HeadObjectCommand") {
            const stored = objects.get(input.Key);
            if (!stored)
              throw Object.assign(Error("Synthetic absent"), {
                name: "NotFound",
                $metadata: { httpStatusCode: 404 },
              });
            if (input.VersionId) {
              assert.equal(input.VersionId, stored.VersionId);
              assert.equal(input.IfMatch, stored.ETag);
            }
            return stored;
          }
          assert(["CopyObjectCommand", "PutObjectCommand"].includes(kind));
          writeCommands.push(command);
          const body = kind === "CopyObjectCommand" ? bytes : Buffer.from(input.Body),
            target = {
              $metadata: { httpStatusCode: 200 },
              VersionId: "clean-version-" + writeCommands.length,
              ETag: '"clean-etag-' + writeCommands.length + '"',
              ContentType: input.ContentType,
              ContentLength: body.length,
              ChecksumType: "FULL_OBJECT",
              ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
              ServerSideEncryption: input.ServerSideEncryption,
              SSEKMSKeyId: input.SSEKMSKeyId,
              Metadata: input.Metadata,
              ...(input.ContentDisposition ? { ContentDisposition: input.ContentDisposition } : {}),
            };
          if (kind === "PutObjectCommand") {
            assert.equal(input.IfNoneMatch, "*");
            assert.equal(input.ChecksumSHA256, target.ChecksumSHA256);
          }
          objects.set(input.Key, target);
          return kind === "CopyObjectCommand"
            ? {
                $metadata: { httpStatusCode: 200 },
                VersionId: target.VersionId,
                CopySourceVersionId: recovered.object.versionId,
                CopyObjectResult: { ETag: target.ETag, ChecksumSHA256: target.ChecksumSHA256 },
                ServerSideEncryption: target.ServerSideEncryption,
                SSEKMSKeyId: target.SSEKMSKeyId,
              }
            : target;
        },
      };
      const writer = createS3ImagePromotionWriter({
          quarantineConfig: config,
          clock: { now: () => clock },
          sdk,
        }),
        result = await writer.process({ source: planned.intent.source, plan: planned.intent.plan });
      assert.equal(
        writeCommands.length,
        7,
        "Actual PNG decode produces six encoded uploads and one private copy",
      );
      // Product command/hash metadata and current User grants below are explicit
      // controls. Pins, 013 admission, completion, six renditions, SQL/RLS and
      // consumer writes are real; this is not a full Product qualification run.
      let mediaReadAllowed = true,
        mediaReadSequence = 810100;
      const mediaReadCalls = [];
      function mediaReadRequest(versionReference, overrides = {}) {
        return parseMediaPublicationReadRequest({
          profile: "MediaPublicationReadRequestV1",
          intentKind: "PublicationV2",
          tenantReference: tenant,
          scope,
          actorReference: actor,
          actorKind: "User",
          operationReference: id(++mediaReadSequence),
          originalIntentDigest: "sha256:" + "1".repeat(64),
          productReference: recovered.asset.ownerReference,
          versionReference: id(810001),
          aggregateSnapshotDigest: "sha256:" + "2".repeat(64),
          contentDigest: "sha256:" + "3".repeat(64),
          configurationDigest: "sha256:" + "4".repeat(64),
          replacementIntentDigest: "sha256:" + "5".repeat(64),
          references: [
            {
              mediaReference: id(810002),
              assetReference: recovered.asset.assetId,
              assetVersionReference: versionReference,
              cropReference: null,
              focusReference: null,
            },
          ],
          observedAt: clock,
          validUntil: new Date(Date.parse(clock) + 5000).toISOString(),
          ...overrides,
        });
      }
      function mediaReader(readRequest) {
        return createPostgresMediaPublicationReadSource({
          tenantReference: readRequest.tenantReference,
          scope: readRequest.scope,
          actorReference: actor,
          actorKind: "User",
          clock: { now: () => clock },
          registerBeforeCommit,
          authority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert(transactionsByIdentity.has(tx));
              assert.deepEqual(input.request, readRequest);
              assert.equal(input.action, "media.asset.access");
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ");
              assert.deepEqual(input.requiredFields, mediaPublicationReadFields);
              mediaReadCalls.push(input.request.operationReference);
              if (!mediaReadAllowed) throw new MediaServiceError("MEDIA_PERMISSION_DENIED");
              const permission = evaluatePermission({
                tenantContext: tenantContext(readRequest.scope),
                action: input.action,
                resourceScope: {
                  kind: readRequest.scope.kind,
                  brandReference: readRequest.scope.brandReference,
                  storeReference: readRequest.scope.storeReference,
                },
                policySnapshotReference: id(810003),
                policyVersion: 1,
                evidence: [
                  {
                    source: "ExplicitAllow",
                    evidenceReference: id(810004),
                    action: input.action,
                    actorReference: actor,
                    roleReference: null,
                    brandReference: readRequest.scope.brandReference,
                    storeReference: readRequest.scope.storeReference,
                    effectiveFrom: at,
                    effectiveUntil: time(86400000),
                  },
                ],
              });
              assert.equal(permission.effect, "Allow");
              return { observedAt: readRequest.observedAt, validUntil: readRequest.validUntil };
            },
          },
        });
      }
      async function setReadScope(tx, readRequest) {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [
            readRequest.tenantReference,
            readRequest.scope.brandReference,
            readRequest.scope.storeReference ?? "",
          ],
        );
      }
      function readMedia(readRequest) {
        const reader = mediaReader(readRequest);
        return transactions.run(async (tx) => {
          await setReadScope(tx, readRequest);
          return reader.withCurrentReferences(tx, readRequest, async (proof, actualTx) => {
            assert.equal(actualTx, tx);
            assert.deepEqual(parseMediaPublicationReadSnapshot(proof), proof);
            return proof;
          });
        });
      }
      for (const mode of ["late-authority", "final-expiry", "audit"]) {
        const before = await processingSnapshot(),
          originalClock = clock;
        if (mode === "audit") failure = "audit";
        else
          afterWork = async (tx, client) => {
            assert.equal(
              (await client.query("SELECT count(*)::int n FROM bop_media.image_rendition")).rows[0]
                .n,
              6,
            );
            if (mode === "late-authority") systemAllowed = false;
            else
              await registerBeforeCommit(
                tx,
                async () => {
                  clock = new Date(Date.parse(originalClock) + 5000).toISOString();
                },
                () => undefined,
              );
          };
        await assert.rejects(processing.complete({ intent: planned.intent, result }));
        clock = originalClock;
        failure = null;
        systemAllowed = true;
        afterWork = null;
        assert.deepEqual(
          await processingSnapshot(),
          before,
          "Version/root/renditions/completion/Audit rollback together",
        );
      }
      for (const table of ["image_rendition", "image_processing_completion"]) {
        const before = await processingSnapshot();
        skipProcessing = table;
        await assert.rejects(processing.complete({ intent: planned.intent, result }));
        assert.equal(
          skipProcessing,
          null,
          "The selected omission occurred inside the real transaction",
        );
        assert.deepEqual(
          await processingSnapshot(),
          before,
          "Deferred origin rejects missing companions/completion atomically",
        );
      }
      {
        const before = await processingSnapshot(),
          request = mediaReadRequest(planned.intent.plan.targetAssetVersionReference),
          reader = mediaReader(request);
        let missingRows = null,
          readError = null,
          consumers = 0,
          traceStart = 0;
        skipProcessing = "image_rendition";
        afterWork = async (tx, client) => {
          missingRows = (
            await client.query(
              "SELECT count(*)::int n FROM bop_media.image_rendition WHERE asset_version_id=$1",
              [request.references[0].assetVersionReference],
            )
          ).rows[0].n;
          traceStart = processingTrace.length;
          try {
            await reader.withCurrentReferences(tx, request, async () => {
              consumers++;
            });
          } catch (error) {
            readError = error;
            throw error;
          }
        };
        await assert.rejects(processing.complete({ intent: planned.intent, result }));
        afterWork = null;
        assert.equal(skipProcessing, null);
        assert.equal(Number.isInteger(missingRows) && missingRows >= 0 && missingRows < 6, true);
        assert.equal(readError?.code, "MEDIA_PUBLICATION_READ_UNAVAILABLE");
        assert.equal(consumers, 0);
        assert(
          processingTrace
            .slice(traceStart)
            .some((entry) => entry.kind === "SELECT" && entry.tables.includes("image_rendition")),
          "Reader must actually observe the incomplete stored rendition set",
        );
        assert.deepEqual(
          await processingSnapshot(),
          before,
          "Claimed Ready without all renditions fails before consumer and rolls back actual tentative completion",
        );
      }
      const completed = await processing.complete({ intent: planned.intent, result });
      assert.equal(completed.asset.version, 2);
      assert.equal(completed.assetVersion.checkState, "Clean");
      assert.equal(completed.assetVersion.readinessState, "Ready");
      assert.equal(completed.assetVersion.contentType, "image/jpeg");
      assert.equal(
        completed.assetVersion.objectEvidenceReference,
        result.renditions[4].objectEvidenceReference,
      );
      assert.notEqual(
        completed.assetVersion.objectEvidenceReference,
        result.original.objectEvidenceReference,
      );
      const beforePinnedRead = await processingSnapshot(),
        readProviderCalls = allCommands.length,
        originalPinnedRead = await readMedia(
          mediaReadRequest(completed.assetVersion.assetVersionId),
        );
      assert.equal(originalPinnedRead.references[0].status, "Ready");
      assert.deepEqual(originalPinnedRead.references[0].assetVersion, completed.assetVersion);
      assert.equal(originalPinnedRead.references[0].renditions.length, 6);
      assert.equal(
        Object.hasOwn(originalPinnedRead.references[0].asset, "currentVersionReference"),
        false,
      );
      assert.equal(JSON.stringify(originalPinnedRead).includes(config.bucket), false);
      assert.equal(JSON.stringify(originalPinnedRead).includes(destination.bucket), false);
      assert.equal(
        allCommands.length,
        readProviderCalls,
        "Publication metadata read never calls S3",
      );
      assert.deepEqual(await processingSnapshot(), beforePinnedRead);
      // Catalog identities/digests and User permission are explicit controlled
      // inputs. The nonempty Media pin, processing provenance, six stored
      // renditions, RLS and original outer transaction are real owner facts.
      let optionReadAllowed = true;
      const optionReadCalls = [];
      function optionReadRequest(overrides = {}) {
        return parseMediaOptionSetPublicationReadRequest({
          profile: "MediaOptionSetPublicationReadRequestV1",
          tenantReference: tenant,
          scope,
          actorReference: actor,
          actorKind: "User",
          operationReference: id(++mediaReadSequence),
          originalIntentDigest: "sha256:" + "6".repeat(64),
          optionSetReference: id(820001),
          versionReference: id(820002),
          expectedAggregateVersion: 2,
          sourceDigest: "sha256:" + "7".repeat(64),
          contentDigest: "sha256:" + "8".repeat(64),
          configurationDigest: "sha256:" + "9".repeat(64),
          graphDigest: "sha256:" + "a".repeat(64),
          activationAt: clock,
          references: [
            {
              mediaReference: id(820003),
              assetReference: recovered.asset.assetId,
              assetVersionReference: completed.assetVersion.assetVersionId,
              cropReference: null,
              focusReference: null,
            },
          ],
          observedAt: clock,
          validUntil: new Date(Date.parse(clock) + 5000).toISOString(),
          ...overrides,
        });
      }
      function readOptionMedia(request, work = async (proof) => proof) {
        const reader = createPostgresMediaOptionSetPublicationReadSource({
          tenantReference: request.tenantReference,
          scope: request.scope,
          actorReference: actor,
          actorKind: "User",
          clock: { now: () => clock },
          registerBeforeCommit,
          authority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert(transactionsByIdentity.has(tx));
              assert.deepEqual(input.request, request);
              assert.equal(input.action, "media.asset.access");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ");
              assert.deepEqual(input.requiredFields, mediaPublicationReadFields);
              optionReadCalls.push(input.request.operationReference);
              if (!optionReadAllowed) throw new MediaServiceError("MEDIA_PERMISSION_DENIED");
              const decision = evaluatePermission({
                tenantContext: tenantContext(request.scope),
                action: input.action,
                resourceScope: {
                  kind: request.scope.kind,
                  brandReference: request.scope.brandReference,
                  storeReference: request.scope.storeReference,
                },
                policySnapshotReference: id(820004),
                policyVersion: 1,
                evidence: [
                  {
                    source: "ExplicitAllow",
                    evidenceReference: id(820005),
                    action: input.action,
                    actorReference: actor,
                    roleReference: null,
                    brandReference: request.scope.brandReference,
                    storeReference: request.scope.storeReference,
                    effectiveFrom: at,
                    effectiveUntil: time(86400000),
                  },
                ],
              });
              assert.equal(decision.effect, "Allow");
              return { observedAt: request.observedAt, validUntil: request.validUntil };
            },
          },
        });
        return transactions.run(async (tx) => {
          await setReadScope(tx, request);
          return reader.withCurrentReferences(tx, request, async (proof, actualTx) => {
            assert.equal(actualTx, tx);
            assert.deepEqual(parseMediaOptionSetPublicationReadSnapshot(proof), proof);
            assert.deepEqual(proof.request, request);
            return work(proof);
          });
        });
      }
      const optionBefore = await processingSnapshot(),
        optionProviderCalls = allCommands.length,
        optionTraceStart = processingTrace.length,
        optionRequest = optionReadRequest(),
        optionProof = await readOptionMedia(optionRequest);
      assert.equal(optionProof.references[0].status, "Ready");
      assert.deepEqual(optionProof.references[0].assetVersion, completed.assetVersion);
      assert.equal(optionProof.references[0].renditions.length, 6);
      assert.deepEqual(optionProof.references[0], {
        ...originalPinnedRead.references[0],
        mediaReference: id(820003),
      });
      const optionTrace = processingTrace.slice(optionTraceStart);
      assert(
        optionTrace.some(
          (entry) =>
            entry.kind === "SELECT" &&
            entry.tables.includes("image_processing_completion") &&
            entry.rows === 1,
        ),
        "Option source must execute the actual coherent completion/provenance SQL",
      );
      assert(
        optionTrace.some(
          (entry) =>
            entry.kind === "SELECT" && entry.tables.includes("image_rendition") && entry.rows === 6,
        ),
        "Option source must read all six persisted renditions",
      );
      assert.equal(Object.hasOwn(optionProof.request, "productReference"), false);
      assert.equal(Object.hasOwn(optionProof.request, "replacementIntentDigest"), false);
      assert.equal(JSON.stringify(optionProof).includes(config.bucket), false);
      assert.equal(JSON.stringify(optionProof).includes(destination.bucket), false);
      assert.equal(allCommands.length, optionProviderCalls);
      assert.deepEqual(await processingSnapshot(), optionBefore);
      const hiddenOption = await readOptionMedia(
        optionReadRequest({
          scope: createMediaScope({
            kind: "Store",
            brandReference: brand,
            storeReference: id(820006),
          }),
        }),
      );
      assert.deepEqual(
        hiddenOption.references.map(({ status, reason }) => ({ status, reason })),
        [{ status: "Unavailable", reason: "NotFound" }],
      );
      const optionBeforeDenial = await processingSnapshot(),
        optionCommits = outerCommits,
        optionCallsBefore = optionReadCalls.length;
      let optionConsumerEntered = 0;
      afterWork = async () => {
        optionReadAllowed = false;
      };
      try {
        await assert.rejects(
          readOptionMedia(optionReadRequest(), async (proof) => {
            assert.equal(proof.references[0].status, "Ready");
            optionConsumerEntered++;
            return proof;
          }),
          { code: "MEDIA_PUBLICATION_READ_UNAVAILABLE" },
        );
      } finally {
        afterWork = null;
        optionReadAllowed = true;
      }
      assert.equal(
        optionConsumerEntered,
        1,
        "Actual Ready SQL must reach the consumer before late withdrawal",
      );
      assert.equal(
        optionReadCalls.length,
        optionCallsBefore + 2,
        "Initial and original before-commit permission both execute",
      );
      assert.equal(
        outerCommits,
        optionCommits,
        "Late permission withdrawal prevents the real outer COMMIT",
      );
      assert.deepEqual(
        await processingSnapshot(),
        optionBeforeDenial,
        "Read-only rollback preserves actual Media, Audit and history counts",
      );
      assert.equal(allCommands.length, optionProviderCalls);
      const committed = await processingSnapshot(),
        commandsBeforeReplay = allCommands.length;
      assert.deepEqual(
        await createMediaImageProcessingRuntime({ ...processingOptions, sdk }).process(
          processInput,
        ),
        completed,
      );
      assert.equal(
        allCommands.length,
        commandsBeforeReplay,
        "Completed original operation never recontacts S3",
      );
      assert.deepEqual(await processingSnapshot(), committed);
      assert.deepEqual(
        committed.core.versions.find(
          (v) => v.asset_version_id === recovered.assetVersion.assetVersionId,
        ).snapshot_json,
        recovered.assetVersion,
      );
      assert.deepEqual(
        committed.core.operations,
        plannedSnapshot.core.operations,
        "User upload/finalize receipts remain unchanged",
      );
      for (const hiddenScope of [
        [id(800), brand, store],
        [tenant, id(801), store],
        [tenant, brand, id(802)],
        [tenant, brand, ""],
      ])
        await inScope(hiddenScope, async (client) => {
          for (const table of [
            "image_processing_intent",
            "image_processing_completion",
            "image_rendition",
            "image_scan_admission",
          ])
            assert.equal(
              (await client.query("SELECT count(*)::int n FROM bop_media." + table)).rows[0].n,
              0,
            );
        });
      for (const table of [
        "image_processing_intent",
        "image_processing_completion",
        "image_rendition",
        "image_scan_admission",
      ])
        await assert.rejects(
          admin.query("UPDATE bop_media." + table + " SET tenant_id=tenant_id"),
          { code: "55000" },
        );
      // A second scan creates a new history version; old receipts remain usable.
      const secondInput = await admittedInput(prefixAdmission, {
          ...event,
          id: "synthetic-second-scan",
        }),
        second = await createMediaImageProcessingRuntime({ ...processingOptions, sdk }).process(
          secondInput,
        );
      assert.equal(second.asset.version, 3);
      assert.deepEqual(await processing.plan(processInput), {
        intent: planned.intent,
        completion: completed,
      });
      assert.equal((await processingSnapshot()).processing.renditions.length, 12);
      const historicalPinnedRead = await readMedia(
        mediaReadRequest(completed.assetVersion.assetVersionId, {
          intentKind: "WarningAcknowledgementV1",
        }),
      );
      assert.equal(historicalPinnedRead.references[0].status, "Ready");
      assert.deepEqual(historicalPinnedRead.references, originalPinnedRead.references);
      assert.equal(
        historicalPinnedRead.relevantReferenceDigest,
        originalPinnedRead.relevantReferenceDigest,
        "New current root/version cannot change an immutable historical pin fingerprint",
      );
      assert.notEqual(
        historicalPinnedRead.digest,
        originalPinnedRead.digest,
        "Full snapshot retains the actual distinct Ack request",
      );
      assert.equal(
        allCommands.length > readProviderCalls,
        true,
        "Second actual processing used the Provider fixture",
      );
      const beforeNegativeReads = await processingSnapshot(),
        providerCallsBeforeNegatives = allCommands.length,
        quarantinedRead = await readMedia(mediaReadRequest(recovered.assetVersion.assetVersionId));
      assert.deepEqual(
        quarantinedRead.references.map(({ status, reason }) => ({ status, reason })),
        [{ status: "Unavailable", reason: "NotReady" }],
      );
      for (const [readTenant, readScope] of [
        [id(800), scope],
        [
          tenant,
          createMediaScope({ kind: "Store", brandReference: id(801), storeReference: store }),
        ],
        [
          tenant,
          createMediaScope({ kind: "Store", brandReference: brand, storeReference: id(802) }),
        ],
        [tenant, brandScope],
      ]) {
        const hidden = await readMedia(
          mediaReadRequest(completed.assetVersion.assetVersionId, {
            tenantReference: readTenant,
            scope: readScope,
          }),
        );
        assert.deepEqual(
          hidden.references.map(({ status, reason }) => ({ status, reason })),
          [{ status: "Unavailable", reason: "NotFound" }],
        );
      }
      const adjustedRequest = mediaReadRequest(completed.assetVersion.assetVersionId);
      const adjusted = await readMedia(
        parseMediaPublicationReadRequest({
          ...adjustedRequest,
          references: [{ ...adjustedRequest.references[0], cropReference: id(810005) }],
        }),
      );
      assert.equal(adjusted.references[0].reason, "UnsupportedAdjustment");
      assert.equal(allCommands.length, providerCallsBeforeNegatives);
      assert.deepEqual(await processingSnapshot(), beforeNegativeReads);

      for (const mode of ["reader-late-authority", "reader-final-expiry"]) {
        const before = await snapshot(),
          beforeVisible = await inScope([tenant, brand, store], snapshot),
          originalClock = clock,
          commitCount = outerCommits,
          readRequest = mediaReadRequest(completed.assetVersion.assetVersionId),
          reader = mediaReader(readRequest),
          callsBefore = mediaReadCalls.length,
          consumerInput = createInput(mediaReadSequence + 1000);
        mediaReadSequence += 20;
        let consumerEntered = 0,
          readerTentative = null;
        lastFinalError = null;
        afterWork = async (tx, client) => {
          readerTentative = await snapshot(client);
          if (mode === "reader-late-authority") mediaReadAllowed = false;
          else
            await registerBeforeCommit(
              tx,
              async () => {
                clock = readRequest.validUntil;
              },
              () => undefined,
            );
        };
        // The UoW owns the outer runner. Wrap its actual SQL work in the held
        // reader, so its own async/final guards complete before UoW.run returns.
        const guardedTransactions = {
          run: (work) =>
            transactions.run(async (tx) => {
              await setReadScope(tx, readRequest);
              return reader.withCurrentReferences(tx, readRequest, async (proof, actualTx) => {
                assert.equal(actualTx, tx);
                assert.equal(proof.references[0].status, "Ready");
                consumerEntered++;
                return work(actualTx);
              });
            }),
        };
        await assert.rejects(createUpload(consumerInput, ports(scope, guardedTransactions)), {
          code: "MEDIA_COMMIT_FAILED",
        });
        afterWork = null;
        mediaReadAllowed = true;
        clock = originalClock;
        assert.equal(consumerEntered, 1);
        assert(readerTentative, "Late read failure must follow real consumer writes");
        assert.equal(readerTentative.sessions.length, beforeVisible.sessions.length + 1);
        assert(
          readerTentative.operations.some(
            (row) => row.operation_id === consumerInput.idempotencyKey,
          ),
        );
        assert.equal(readerTentative.audits, beforeVisible.audits + 1);
        assert(
          mediaReadCalls.length >= callsBefore + 2,
          "Current read authority is rechecked at outer commit",
        );
        if (mode === "reader-final-expiry")
          assert.equal(lastFinalError?.code, "MEDIA_PUBLICATION_READ_UNAVAILABLE");
        assert.equal(outerCommits, commitCount);
        assert.deepEqual(
          await snapshot(),
          before,
          "Reader denial/expiry rolls back actual consumer session, operation and Audit atomically",
        );
      }

      const workerOptions = {
        ...processingOptions,
        systemActorReference: workloadIdentity.workloadReference,
        transactions: workerHost.transactions,
        registerBeforeCommit: workerHost.registerBeforeCommit,
        authority: {
          async holdUntilTransactionCompletes(tx, request) {
            assert.equal(request.tenantReference, tenant);
            assert.deepEqual(request.scope, scope);
            assert.equal(request.systemActorReference, workloadIdentity.workloadReference);
            assert.equal(request.actorKind, "System");
            assert.equal(request.action, "media.asset.promote");
            assert.equal(request.purposeCode, "MEDIA_IMAGE_PROMOTION");
            assert.deepEqual(request.requiredFields, systemMediaImagePromotionRequiredFields);
            assert.equal(
              request.sourceAssetVersionReference,
              recovered.assetVersion.assetVersionId,
            );
            if (registeredAdmissions.has(request.admissionReference))
              assert.equal(
                request.scanEventDigest,
                registeredAdmissions.get(request.admissionReference),
              );
            assert.match(request.scanEventDigest, /^sha256:[a-f0-9]{64}$/u);
            const current = await permissionSource.holdUntilTransactionCompletes(tx, {
              actorKind: request.actorKind,
              action: request.action,
              purposeCode: request.purposeCode,
              requiredFields: request.requiredFields,
              observedAt: request.observedAt,
              validUntil: request.validUntil,
            });
            actualAuthorityObservations.push(current);
            if (current.effect !== "Allow")
              throw Error("SYNTHETIC_ADAPTER_REQUIRES_ACTUAL_PERMISSION_ALLOW");
            if (
              expireWorkerCompletion &&
              request.phase === "Complete" &&
              !registeredExpiry.has(tx)
            ) {
              registeredExpiry.add(tx);
              await workerHost.registerBeforeCommit(
                tx,
                async () => {
                  tentativeWorkerCompletion = (
                    await tx.query(
                      `SELECT
                  (SELECT count(*)::int FROM bop_media.image_processing_completion) completions,
                  (SELECT count(*)::int FROM bop_media.image_rendition) renditions`,
                      [],
                    )
                  ).rows[0];
                  clock = request.validUntil;
                },
                () => undefined,
              );
            }
            return { observedAt: current.observedAt, validUntil: current.validUntil };
          },
        },
      };
      const workerRuntime = createMediaImageProcessingRuntime({ ...workerOptions, sdk }),
        workerStore = createMediaImageProcessingStore(workerOptions),
        workerAdmission = createPostgresMediaImageScanAdmissionStore({
          ...admissionOptions,
          workloadReference: workloadIdentity.workloadReference,
        });
      let workerInput = {
        ...processInput,
        scanEvent: { ...event, id: "synthetic-worker-permission-scan" },
        admissionReference: id(30001),
      };
      const beforeMissing = await processingSnapshot(),
        providerBeforeMissing = allCommands.length;
      await assert.rejects(workerRuntime.process(workerInput), { code: "MEDIA_COMMIT_FAILED" });
      assert.equal(actualAuthorityObservations.at(-1).reason, "MISSING_WORKLOAD_AUTHORIZATION");
      assert.equal(allCommands.length, providerBeforeMissing);
      assert.deepEqual(await processingSnapshot(), beforeMissing);

      const firstDecision = decisionInput(1, true),
        beforeProvision = await permissionSnapshot();
      lastSqlFailure = null;
      assert.deepEqual(
        await provisioner
          .provision(firstDecision)
          .catch(() =>
            assert.fail(JSON.stringify({ stage: "actual-permission-provision", lastSqlFailure })),
          ),
        firstDecision.decision,
      );
      const afterProvision = await permissionSnapshot();
      assert.equal(afterProvision.roots.length, beforeProvision.roots.length + 1);
      assert.equal(afterProvision.decisions.length, beforeProvision.decisions.length + 1);
      assert.equal(afterProvision.audits, beforeProvision.audits + 1);
      assert.equal(
        afterProvision.roots.find((v) => v.workload_id === workloadIdentity.workloadReference)
          .decision_id,
        firstDecision.decision.decisionReference,
      );
      assert.deepEqual(await provisioner.provision(firstDecision), firstDecision.decision);
      assert.deepEqual(
        await permissionSnapshot(),
        afterProvision,
        "Original provisioning replay does not append a second Audit",
      );
      const ownerRole = (
        await admin.query(
          "SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='bop_permission.system_media_image_promotion_authorization'::regclass",
        )
      ).rows[0].name;
      assert.match(ownerRole, /^[a-z][a-z0-9_]{0,62}$/u);
      for (const membership of ["INHERIT TRUE, SET FALSE", "INHERIT FALSE, SET TRUE"]) {
        await admin.query(`GRANT ${ownerRole} TO ${provisionRole} WITH ${membership}`);
        try {
          await assert.rejects(provisioner.provision(firstDecision), {
            code: "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_UNAVAILABLE",
          });
          assert.deepEqual(await permissionSnapshot(), afterProvision);
        } finally {
          await admin.query(`REVOKE ${ownerRole} FROM ${provisionRole}`);
        }
      }
      const forbiddenProvisioner = createPostgresSystemMediaImagePromotionProvisioner({
        ...workloadIdentity,
        provisioningRoleName: provisionRole,
        clock: { now: () => clock },
        transactions: workerHost.transactions,
        registerBeforeCommit: workerHost.registerBeforeCommit,
      });
      await assert.rejects(forbiddenProvisioner.provision(firstDecision), {
        code: "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_UNAVAILABLE",
      });
      assert.deepEqual(await permissionSnapshot(), afterProvision);
      for (const sql of [
        "INSERT INTO bop_permission.system_media_image_promotion_authorization_decision SELECT * FROM bop_permission.system_media_image_promotion_authorization_decision",
        "UPDATE bop_permission.system_media_image_promotion_authorization SET version=version+1",
      ])
        await assert.rejects(
          inScope([tenant, brand, store], (client) => client.query(sql)),
          { code: "42501" },
        );
      await assert.rejects(
        inScope([tenant, brand, store], (client) =>
          client.query(
            "UPDATE bop_permission.system_media_image_promotion_authorization SET lock_token=lock_token",
          ),
        ),
        { code: "23514" },
      );
      assert.deepEqual(await permissionSnapshot(), afterProvision);

      for (const [changes, expectedReason] of [
        [
          { deploymentConfigurationDigest: "sha256:" + "e".repeat(64) },
          "DEPLOYMENT_CONFIGURATION_MISMATCH",
        ],
        [{ tenantReference: id(31300) }, "MISSING_WORKLOAD_AUTHORIZATION"],
      ]) {
        const source = createPostgresSystemMediaImagePromotionAuthorizationSource({
          ...workloadIdentity,
          ...changes,
          clock: { now: () => clock },
          registerBeforeCommit: workerHost.registerBeforeCommit,
        });
        let denied;
        await assert.rejects(
          workerHost.transactions.run(async (tx) => {
            denied = await source.holdUntilTransactionCompletes(tx, authorizationRequest());
          }),
        );
        assert.equal(denied.effect, "Deny");
        assert.equal(denied.reason, expectedReason);
      }
      for (const hidden of [
        [id(31300), brand, store],
        [tenant, brand, id(31301)],
        [tenant, brand, ""],
      ]) {
        await inScope(hidden, async (client) => {
          for (const table of permissionTables)
            assert.equal(
              (await client.query("SELECT count(*)::int n FROM bop_permission." + table)).rows[0].n,
              0,
            );
        });
      }
      workerInput = await admittedInput(workerAdmission, workerInput.scanEvent);
      const resolved = await workerHost.transactions.run(async (tx) => {
        const held = await permissionSource.holdUntilTransactionCompletes(
          tx,
          authorizationRequest(),
        );
        assert.equal(held.effect, "Allow");
        return resolveMediaImageProcessingSource(tx, config, workerInput.scanEvent);
      });
      assert.equal(
        resolved.source.assetVersion.assetVersionId,
        recovered.assetVersion.assetVersionId,
      );
      assert.deepEqual(
        resolved.source.asset,
        recovered.asset,
        "Object lookup preserves original Finalize asset v1 after root v3",
      );
      assert.deepEqual(resolved.source.object, recovered.object);
      const workerCompleted = await workerRuntime.process({
        ...workerInput,
        sourceAssetVersionReference: resolved.source.assetVersion.assetVersionId,
      });
      assert.equal(workerCompleted.asset.version, 4);
      assert.equal(workerCompleted.assetVersion.readinessState, "Ready");
      assert(
        actualAuthorityObservations.some(
          (v) =>
            v.effect === "Allow" &&
            v.decisionReference === firstDecision.decision.decisionReference,
        ),
      );

      const revokeInput = await admittedInput(workerAdmission, {
          ...event,
          id: "synthetic-worker-revoked-after-provider",
        }),
        revokePlan = await workerStore.plan(revokeInput),
        revokeResult = await writer.process({
          source: revokePlan.intent.source,
          plan: revokePlan.intent.plan,
        }),
        revoked = decisionInput(2, false);
      assert.deepEqual(await provisioner.provision(revoked), revoked.decision);
      const afterRevoke = await processingSnapshot();
      await assert.rejects(
        workerStore.complete({ intent: revokePlan.intent, result: revokeResult }),
        { code: "MEDIA_COMMIT_FAILED" },
      );
      assert.equal(actualAuthorityObservations.at(-1).reason, "WORKLOAD_DISABLED");
      assert.deepEqual(
        await processingSnapshot(),
        afterRevoke,
        "Real current revocation prevents new completion/root/renditions/Audit",
      );
      const enabledAgain = decisionInput(3, true);
      await provisioner.provision(enabledAgain);
      const beforeExpiry = await processingSnapshot(),
        beforeExpiryClock = clock;
      expireWorkerCompletion = true;
      await assert.rejects(
        workerStore.complete({ intent: revokePlan.intent, result: revokeResult }),
        { code: "MEDIA_COMMIT_FAILED" },
      );
      expireWorkerCompletion = false;
      clock = beforeExpiryClock;
      assert.equal(
        tentativeWorkerCompletion.completions,
        beforeExpiry.processing.completions.length + 1,
      );
      assert.equal(
        tentativeWorkerCompletion.renditions,
        beforeExpiry.processing.renditions.length + 6,
      );
      assert.deepEqual(
        await processingSnapshot(),
        beforeExpiry,
        "Actual host final phase rejects a later async guard exhausting the retained lease",
      );
      const completedAfterRenewedGrant = await workerStore.complete({
        intent: revokePlan.intent,
        result: revokeResult,
      });
      assert.equal(completedAfterRenewedGrant.asset.version, 5);

      const unknownInput = await admittedInput(workerAdmission, {
          ...event,
          id: "synthetic-worker-lost-commit-ack",
        }),
        unknownPlan = await workerStore.plan(unknownInput),
        unknownResult = await writer.process({
          source: unknownPlan.intent.source,
          plan: unknownPlan.intent.plan,
        }),
        beforeUnknown = await processingSnapshot();
      loseCompletionAcknowledgement = true;
      await assert.rejects(
        workerStore.complete({ intent: unknownPlan.intent, result: unknownResult }),
        { code: "MEDIA_COMMIT_OUTCOME_UNKNOWN" },
      );
      assert.equal(
        loseCompletionAcknowledgement,
        false,
        "The actual COMMIT completed before its acknowledgement was lost",
      );
      assert.deepEqual(workerReleases.at(-1), { sessionRole: role, discard: true });
      const afterUnknown = await processingSnapshot(),
        beforeUnknownReplaySdk = allCommands.length;
      assert.equal(
        afterUnknown.processing.completions.length,
        beforeUnknown.processing.completions.length + 1,
      );
      assert.equal(
        afterUnknown.processing.renditions.length,
        beforeUnknown.processing.renditions.length + 6,
      );
      const recoveredUnknown = await workerRuntime.process(unknownInput);
      assert.equal(recoveredUnknown.asset.version, 6);
      assert.equal(
        allCommands.length,
        beforeUnknownReplaySdk,
        "Unknown commit recovery reads original completion without S3 work",
      );
      assert.deepEqual(await processingSnapshot(), afterUnknown);

      const beforeAuditFault = await permissionSnapshot(),
        nextDecision = decisionInput(4, false);
      failProvisionAudit = true;
      await assert.rejects(provisioner.provision(nextDecision), {
        code: "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_UNAVAILABLE",
      });
      failProvisionAudit = false;
      assert.equal(
        tentativeProvision.roots.find((v) => v.workload_id === workloadIdentity.workloadReference)
          .version,
        4,
      );
      assert.equal(tentativeProvision.decisions.length, beforeAuditFault.decisions.length + 1);
      assert.deepEqual(
        await permissionSnapshot(),
        beforeAuditFault,
        "Provisioning root/decision and Audit rollback atomically",
      );
      for (const sql of [
        "UPDATE bop_permission.system_media_image_promotion_authorization_decision SET enabled=enabled",
        "DELETE FROM bop_permission.system_media_image_promotion_authorization_decision",
        "TRUNCATE bop_permission.system_media_image_promotion_authorization,bop_permission.system_media_image_promotion_authorization_decision",
      ])
        await assert.rejects(admin.query(sql), { code: "55000" });
      assert.deepEqual(await permissionSnapshot(), beforeAuditFault);

      // Full private Worker entry with actual PostgreSQL/Permission/Audit and
      // actual AWS command classes. All AWS responses below are controlled;
      // this is no real queue deployment, scanner or cloud evidence.
      const deployment = {
        region: config.region,
        accountId: config.accountId,
        kmsKeyArn: config.kmsKeyArn,
        workerRoleArn: `arn:aws:iam::${config.accountId}:role/production/media-worker`,
        workerRoleId: "AROA" + "A".repeat(17),
        deploymentRoleArn: `arn:aws:iam::${config.accountId}:role/deployment/media-provisioner`,
        deploymentRoleId: "AROA" + "B".repeat(17),
        eventRuleArn: `arn:aws:events:ca-central-1:${config.accountId}:rule/media-clean-scans`,
        eventTargetId: "media-scan-queue",
        quarantineBucket: config.bucket,
        protectionPlanArn: config.protectionPlanArn,
        operationReference: id(33001),
      };
      const cloud = {
        phase: "deployment",
        queueArn: null,
        queueUrl: null,
        attributes: null,
        payload: null,
        deleteFails: false,
        badPolicy: false,
        calls: [],
        deleteAttempts: 0,
        deleted: 0,
      };
      const ingressMetadata = { httpStatusCode: 200 };
      const ingressSdk = {
        sqs: {
          async send(command, options) {
            assert(options.abortSignal instanceof globalThis.AbortSignal);
            const kind = command.constructor.name;
            cloud.calls.push(kind);
            if (kind === "GetQueueUrlCommand")
              throw Object.assign(Error("Synthetic new queue is absent"), {
                name: "QueueDoesNotExist",
                $metadata: { httpStatusCode: 400 },
              });
            if (kind === "CreateQueueCommand") {
              cloud.queueArn = `arn:aws:sqs:ca-central-1:${config.accountId}:${command.input.QueueName}`;
              cloud.queueUrl = `https://sqs.ca-central-1.amazonaws.com/${config.accountId}/${command.input.QueueName}`;
              cloud.attributes = {
                ...command.input.Attributes,
                QueueArn: cloud.queueArn,
                CreatedTimestamp: String(Math.floor(Date.parse(clock) / 1000)),
              };
              assert(
                JSON.parse(command.input.Attributes.Policy).Statement.some(
                  (v) => v.Sid === "DenyOtherSenders",
                ),
              );
              return { $metadata: ingressMetadata, QueueUrl: cloud.queueUrl };
            }
            assert.equal(command.input.QueueUrl, cloud.queueUrl);
            if (kind === "GetQueueAttributesCommand")
              return {
                $metadata: ingressMetadata,
                Attributes: { ...cloud.attributes, ...(cloud.badPolicy ? { Policy: "{}" } : {}) },
              };
            if (kind === "ReceiveMessageCommand") {
              assert.equal(command.input.MaxNumberOfMessages, 1);
              return {
                $metadata: ingressMetadata,
                Messages: cloud.payload === null ? [] : [globalThis.structuredClone(cloud.payload)],
              };
            }
            assert.equal(kind, "DeleteMessageCommand");
            cloud.deleteAttempts++;
            assert.equal(command.input.ReceiptHandle, cloud.payload.ReceiptHandle);
            if (cloud.deleteFails) throw Error("SYNTHETIC_SQS_DELETE_FAILURE");
            cloud.deleted++;
            return { $metadata: ingressMetadata };
          },
        },
        sts: {
          async send(command) {
            assert.equal(command.constructor.name, "GetCallerIdentityCommand");
            cloud.calls.push(command.constructor.name);
            const provision = cloud.phase === "deployment";
            return {
              $metadata: ingressMetadata,
              Account: config.accountId,
              Arn: `arn:aws:sts::${config.accountId}:assumed-role/${provision ? "media-provisioner" : "media-worker"}/synthetic-session`,
              UserId:
                (provision ? deployment.deploymentRoleId : deployment.workerRoleId) +
                ":synthetic-session",
            };
          },
        },
        eventBridge: {
          async send(command) {
            const kind = command.constructor.name;
            cloud.calls.push(kind);
            if (kind === "DescribeRuleCommand")
              return {
                $metadata: ingressMetadata,
                Arn: deployment.eventRuleArn,
                Name: "media-clean-scans",
                State: "ENABLED",
                EventBusName: "default",
                EventPattern: JSON.stringify({
                  source: ["aws.guardduty"],
                  "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
                  account: [config.accountId],
                  region: [config.region],
                  resources: [config.protectionPlanArn],
                  detail: {
                    schemaVersion: ["1.0"],
                    scanStatus: ["COMPLETED"],
                    resourceType: ["S3_OBJECT"],
                    s3ObjectDetails: { bucketName: [config.bucket], s3Throttled: [false] },
                    scanResultDetails: { scanResultStatus: ["NO_THREATS_FOUND"] },
                  },
                }),
              };
            assert.equal(kind, "ListTargetsByRuleCommand");
            return {
              $metadata: ingressMetadata,
              Targets: [{ Id: deployment.eventTargetId, Arn: cloud.queueArn }],
            };
          },
        },
      };
      const ingressConfig = await createFreshSqsImageScanQueue({
        deployment,
        clock: { now: () => clock },
        sdk: ingressSdk,
      });
      assert.equal(cloud.calls.filter((v) => v === "CreateQueueCommand").length, 1);
      const fullConfig = {
          profile: "MEDIA_IMAGE_WORKER_V1",
          workloadReference: id(33002),
          quarantineConfig: config,
          destination,
          ingress: ingressConfig,
        },
        fullIdentity = {
          ...workloadIdentity,
          workloadReference: fullConfig.workloadReference,
          deploymentConfigurationDigest: mediaImageWorkerConfigurationDigest(fullConfig),
        },
        fullProvisioner = createPostgresSystemMediaImagePromotionProvisioner({
          ...fullIdentity,
          provisioningRoleName: provisionRole,
          clock: { now: () => clock },
          transactions: provisioningHost.transactions,
          registerBeforeCommit: provisioningHost.registerBeforeCommit,
        });
      await fullProvisioner.provision({
        decision: buildSystemMediaImagePromotionAuthorizationDecision({
          ...fullIdentity,
          profile: "MEDIA_IMAGE_PROMOTION_V1",
          decisionReference: id(33003),
          version: 1,
          action: "media.asset.promote",
          purposeCode: "MEDIA_IMAGE_PROMOTION",
          requiredFields: systemMediaImagePromotionRequiredFields,
          enabled: true,
          effectiveFrom: at,
          effectiveUntil: null,
          recordedAt: clock,
          auditReference: id(33004),
        }),
        correlationReference: id(33005),
      });
      cloud.phase = "worker";
      const fullRuntime = createMediaImageWorkerRuntime({
        config: fullConfig,
        clock: { now: () => clock },
        transactions: workerHost.transactions,
        registerBeforeCommit: workerHost.registerBeforeCommit,
        ingressSdk,
        storageSdk: sdk,
      });
      function queued(scanEvent, suffix = "1") {
        const body = JSON.stringify(scanEvent);
        cloud.payload = {
          MessageId: "synthetic-message-" + suffix,
          ReceiptHandle: "synthetic-private-handle-" + suffix,
          Body: body,
          MD5OfBody: createHash("md5").update(body).digest("hex"),
          Attributes: { SentTimestamp: String(Date.parse(clock)) },
        };
      }
      const fullEvent = { ...event, id: "synthetic-full-worker" };
      try {
        const beforeFull = await processingSnapshot(),
          writesBeforeFull = writeCommands.length;
        queued(fullEvent);
        assert.equal(await fullRuntime.processNext(), 1);
        const afterFull = await processingSnapshot();
        assert.equal(
          afterFull.processing.admissions.length,
          beforeFull.processing.admissions.length + 1,
        );
        assert.equal(afterFull.processing.intents.length, beforeFull.processing.intents.length + 1);
        assert.equal(
          afterFull.processing.completions.length,
          beforeFull.processing.completions.length + 1,
        );
        assert.equal(
          afterFull.processing.renditions.length,
          beforeFull.processing.renditions.length + 6,
        );
        assert.equal(writeCommands.length, writesBeforeFull + 7);
        assert.equal(cloud.deleted, 1);
        const originalAdmission = afterFull.processing.admissions.find(
          (v) => v.event_id === fullEvent.id,
        );
        assert(originalAdmission);
        const originalIntent = afterFull.processing.intents.find(
          (v) => v.scan_admission_id === originalAdmission.admission_id,
        );
        assert(originalIntent);
        assert.equal(originalAdmission.workload_id, fullConfig.workloadReference);
        assert.equal(
          originalAdmission.deployment_config_digest,
          fullIdentity.deploymentConfigurationDigest,
        );
        assert.equal(originalIntent.intent_json.admissionReference, originalAdmission.admission_id);
        const beforeRedeliveryS3 = allCommands.length;
        queued(fullEvent, "redelivery");
        assert.equal(await fullRuntime.processNext(), 1);
        assert.equal(
          allCommands.length,
          beforeRedeliveryS3,
          "Redelivery recovers original admission/completion without S3",
        );
        assert.deepEqual(await processingSnapshot(), afterFull);
        assert.equal(cloud.deleted, 2);

        // A failed Delete never converts an acknowledged database completion
        // into rollback. A new SQS receipt retries the original completion.
        const deleteEvent = { ...event, id: "synthetic-full-delete-failure" };
        queued(deleteEvent, "delete-failure");
        cloud.deleteFails = true;
        const deletesBeforeFailure = cloud.deleted;
        await assert.rejects(fullRuntime.processNext(), { code: "MEDIA_SCAN_INGRESS_UNAVAILABLE" });
        assert.equal(cloud.deleteAttempts, deletesBeforeFailure + 1);
        const afterDeleteFailure = await processingSnapshot(),
          s3AfterDeleteFailure = allCommands.length;
        assert.equal(
          afterDeleteFailure.processing.completions.length,
          afterFull.processing.completions.length + 1,
        );
        assert.equal(cloud.deleted, deletesBeforeFailure);
        cloud.deleteFails = false;
        queued(deleteEvent, "delete-retry");
        assert.equal(await fullRuntime.processNext(), 1);
        assert.equal(allCommands.length, s3AfterDeleteFailure);
        assert.deepEqual(await processingSnapshot(), afterDeleteFailure);

        for (const phase of ["admission", "completion"]) {
          const scan = { ...event, id: "synthetic-full-unknown-" + phase };
          queued(scan, "unknown-" + phase);
          const before = await processingSnapshot(),
            deletes = cloud.deleteAttempts;
          if (phase === "admission") loseAdmissionAcknowledgement = true;
          else loseCompletionAcknowledgement = true;
          await assert.rejects(fullRuntime.processNext(), {
            code:
              phase === "admission"
                ? "MEDIA_IMAGE_SCAN_ADMISSION_OUTCOME_UNKNOWN"
                : "MEDIA_COMMIT_OUTCOME_UNKNOWN",
          });
          assert.equal(
            phase === "admission" ? loseAdmissionAcknowledgement : loseCompletionAcknowledgement,
            false,
            "Real COMMIT completed before its acknowledgement was deliberately lost",
          );
          assert.equal(
            cloud.deleteAttempts,
            deletes,
            "Unknown database commit must not acknowledge SQS",
          );
          const committedUnknown = await processingSnapshot(),
            s3AtUnknown = allCommands.length;
          assert.equal(
            committedUnknown.processing.admissions.length,
            before.processing.admissions.length + 1,
          );
          assert.equal(
            committedUnknown.processing.completions.length,
            before.processing.completions.length + (phase === "completion" ? 1 : 0),
          );
          queued(scan, "unknown-retry-" + phase);
          assert.equal(await fullRuntime.processNext(), 1);
          const recoveredUnknownState = await processingSnapshot();
          assert.equal(
            recoveredUnknownState.processing.admissions.length,
            committedUnknown.processing.admissions.length,
          );
          assert.deepEqual(
            recoveredUnknownState.processing.admissions,
            committedUnknown.processing.admissions,
          );
          if (phase === "completion") {
            assert.equal(allCommands.length, s3AtUnknown);
            assert.deepEqual(recoveredUnknownState, committedUnknown);
          } else
            assert.equal(
              recoveredUnknownState.processing.completions.length,
              before.processing.completions.length + 1,
            );
        }
        for (const mode of ["event-conflict", "foreign-event", "policy-conflict"]) {
          const before = await processingSnapshot(),
            deletes = cloud.deleteAttempts,
            s3 = allCommands.length;
          queued(
            mode === "event-conflict"
              ? { ...fullEvent, time: new Date(Date.parse(fullEvent.time) + 1).toISOString() }
              : mode === "foreign-event"
                ? { ...event, id: "synthetic-foreign", account: "999999999999" }
                : fullEvent,
            mode,
          );
          cloud.badPolicy = mode === "policy-conflict";
          await assert.rejects(fullRuntime.processNext(), {
            code:
              mode === "event-conflict"
                ? "MEDIA_IMAGE_SCAN_ADMISSION_UNAVAILABLE"
                : "MEDIA_SCAN_INGRESS_UNAVAILABLE",
          });
          cloud.badPolicy = false;
          assert.equal(cloud.deleteAttempts, deletes);
          assert.equal(allCommands.length, s3);
          assert.deepEqual(
            await processingSnapshot(),
            before,
            "Conflicting delivery cannot write or acknowledge",
          );
        }
        cloud.payload = null;
        const beforeEmpty = await processingSnapshot(),
          deletes = cloud.deleteAttempts;
        assert.equal(await fullRuntime.processNext(), 0);
        assert.equal(cloud.deleteAttempts, deletes);
        assert.deepEqual(await processingSnapshot(), beforeEmpty);
      } finally {
        fullRuntime.close();
      }
      for (const sql of [
        "UPDATE bop_media.image_scan_admission SET snapshot_json=snapshot_json",
        "DELETE FROM bop_media.image_scan_admission",
        "TRUNCATE " +
          [
            ...tables,
            "image_scan_admission",
            "image_processing_intent",
            "image_processing_completion",
            "image_rendition",
          ]
            .map((table) => "bop_media." + table)
            .join(","),
      ])
        await assert.rejects(admin.query(sql), { code: "55000" });
    } finally {
      await admin.end();
    }
  });
});
