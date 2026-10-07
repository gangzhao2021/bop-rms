import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import pg from "pg";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { exerciseStoreConfigurationOrdinaryRuntimeHttp } from "./store-configuration-ordinary-runtime-http.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createUnconfiguredStoreSetupDraftContent,
  createPostgresStoreSetupDraftStore,
  parseStoreSetupOperationReceipt,
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferencesCurrent,
} from "../../rms/store/src/index.ts";
import {
  createPostgresProductTaxClassificationRegistryStore,
  taxClassificationRegistryFields,
} from "../../rms/catalog/src/index.ts";
import { createMerchantBrandScope } from "../../../apps/api/dist/merchant-brand-scope.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
import { createMerchantRuntime } from "../../../apps/api/dist/merchant-runtime.js";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { bindMerchantStoreSetupCommand } from "../../../apps/api/dist/merchant-store-setup-command.js";
import { bindMerchantStoreSetupReferenceCommand } from "../../../apps/api/dist/merchant-store-setup-reference-command.js";
import { bindMerchantReceiptTemplateLifecycleCommand } from "../../../apps/api/dist/merchant-receipt-template-lifecycle-command.js";
import { bindMerchantReceiptTemplateSubmitCommand } from "../../../apps/api/dist/merchant-receipt-template-submit-command.js";
import {
  parseDigitalReceiptTemplatePublishedCurrent,
  parseDigitalReceiptTemplateLifecycleReceipt,
  parseDigitalReceiptTemplateVersion,
  parseDigitalReceiptTemplateSubmitReceipt,
  parseDigitalReceiptTemplateReviewCurrent,
  parseDigitalReceiptTemplateSubmission,
} from "../../rms/printing-device/src/index.ts";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
} from "../../bop/publishing/src/index.ts";
import { bindMerchantReceiptTemplateDraftCommand } from "../../../apps/api/dist/merchant-receipt-template-draft-command.js";
import {
  parseDigitalReceiptTemplateDraftReceipt,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftRoster,
} from "../../rms/printing-device/src/index.ts";
import { bindMerchantReceiptTemplateArtifactCommand } from "../../../apps/api/dist/merchant-receipt-template-artifact-command.js";
import {
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactCurrent,
} from "../../rms/printing-device/src/index.ts";
import { bindMerchantStorePaymentConfigurationCommand } from "../../../apps/api/dist/merchant-store-payment-configuration-command.js";
import {
  parseStorePaymentConfigurationCurrent,
  parseStorePaymentConfigurationReceipt,
} from "../../rms/payment/src/index.ts";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const id = (n) => `01902421-1019-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Real runtime/BFF/HTTP and isolated PostgreSQL owners, encrypted Sessions,
 * current Membership/Permission and Audit. Only fixture identities/OIDC/Tenant
 * association origin are synthetic. Receipt review/publication below exercises
 * actual software qualification, not professional/legal compliance, provider,
 * live Store or complete Store configuration acceptance. */
export async function exerciseStoreSetupRuntimeHttp(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_setup_http_" + context.runId;
  let roleCreated = false,
    stage = "Seed",
    sqlFailure = null,
    httpStatus = "NONE",
    httpCode = "NONE";
  const tenant = id(1),
    brand = id(2),
    store = id(3),
    actor = id(4);
  const now = () => new Date().toISOString(),
    at = now();
  const scope = {
    tenantReference: tenant,
    brandReference: brand,
    storeReference: store,
    actorReference: actor,
  };
  let reference = 100;
  await admin.connect();
  const ownerHooks = new WeakMap();
  let lateFeePermissionGrant = null;
  const transactions = {
    async run(work) {
      const client = new pg.Client({
        ...context.clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
      });
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        const tx = {
          async query(sql, values = []) {
            try {
              const result = await client.query(sql, values);
              if (
                lateFeePermissionGrant !== null &&
                sql.startsWith("INSERT INTO rms_store.store_setup_draft_operation") &&
                result.rowCount === 1
              ) {
                const grant = lateFeePermissionGrant;
                lateFeePermissionGrant = null;
                await client.query("RESET ROLE");
                assert.equal(
                  (
                    await client.query(
                      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                      [grant],
                    )
                  ).rowCount,
                  1,
                );
                await client.query("SET LOCAL ROLE " + role);
              }
              return result;
            } catch (error) {
              sqlFailure = {
                code: /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : "NONE",
                family: sql.includes("bop_publishing.")
                  ? "Publishing"
                  : sql.includes("rms_device.")
                    ? "Device"
                    : sql.includes("platform_audit.")
                      ? "Audit"
                      : sql.includes("rms_store.")
                        ? "Store"
                        : sql.includes("bop_permission.")
                          ? "Permission"
                          : sql.includes("bop_tenant.")
                            ? "Tenant"
                            : "Other",
              };
              throw error;
            }
          },
        };
        const hooks = [];
        ownerHooks.set(tx, hooks);
        const result = await work(tx);
        for (const hook of hooks) await hook.guard();
        for (const hook of hooks) hook.final();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
        for (const hook of hooks) hook.afterCommit?.();
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const artifactCounts = async () => {
    const result = await admin.query(`SELECT
      (SELECT count(*)::text FROM rms_store.store_setup_draft_revision) revisions,
      (SELECT count(*)::text FROM rms_store.store_setup_draft_operation) operations,
      (SELECT count(*)::text FROM rms_store.store_setup_reference_version) "referenceVersions",
      (SELECT count(*)::text FROM rms_store.store_setup_reference_operation) "referenceOperations",
      (SELECT count(*)::text FROM platform_audit.audit_record) audits,
      (SELECT count(*)::text FROM platform_eventing.outbox_event) events`);
    return result.rows[0];
  };
  const unused = () => {
    throw new Error("STORE_SETUP_UNRELATED_CONFIGURATION_NOT_CONFIGURED");
  };
  const runtimeFor = (session) =>
    createMerchantRuntime({
      persistence: {
        ...session.persistence,
        transactions,
        now,
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: [],
        },
      },
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
      serviceAudit: {
        reasonCode: "AUTHORIZED_OPERATION",
        retentionPolicyCode: "OPERATIONAL",
        retentionPolicyVersion: 1,
      },
      configuration: {
        actionPermissions: {
          saveDraft: "store.service.save-draft",
          validate: "store.service.validate",
          submit: "store.service.submit",
          approve: "store.service.approve",
          publish: "store.service.publish",
        },
        configure: unused,
      },
      storeSetup: {
        nextReference: () => id(++reference),
        receiptTemplateReviewValidityMs: 72 * 60 * 60 * 1000,
      },
    });
  async function withHttp(runtime, session, work) {
    const app = express();
    app.use("/merchant", createMerchantBffRouter(runtime));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const send = (
        method,
        body,
        {
          selected = scope,
          csrf = session.csrf,
          expectedStore = store,
          dropReply = false,
          referenceKind = null,
          paymentConfiguration = false,
          feeContextClassifications = false,
          artifactKind = null,
          receiptTemplateDraft = false,
          receiptTemplateSubmit = false,
          receiptTemplateLifecycle = false,
          receiptTemplatePublished = false,
          locale = null,
          receiptTemplateReview = false,
          receiptTemplateDraftRoster = false,
          afterTemplate = null,
          templateReference = null,
        } = {},
      ) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body);
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port: address.port,
              path:
                "/merchant/store-setup" +
                (feeContextClassifications
                  ? "/fee-context-classifications"
                  : receiptTemplatePublished
                    ? "/receipt-template-published"
                    : receiptTemplateLifecycle
                      ? "/receipt-template-lifecycle"
                      : receiptTemplateReview
                        ? "/receipt-template-review"
                        : receiptTemplateSubmit
                          ? "/receipt-template-submit"
                          : receiptTemplateDraftRoster
                            ? "/receipt-template-drafts"
                            : receiptTemplateDraft
                              ? "/receipt-template-draft"
                              : artifactKind !== null
                                ? "/receipt-artifacts" +
                                  (method === "GET" ? "" : "/" + artifactKind.toLowerCase())
                                : paymentConfiguration
                                  ? "/payment-configuration"
                                  : referenceKind === null
                                    ? ""
                                    : "/references" +
                                      (method === "GET" ? "" : "/" + referenceKind.toLowerCase())) +
                (method === "GET"
                  ? "?storeReference=" +
                    expectedStore +
                    ((receiptTemplateDraft || receiptTemplateReview || receiptTemplatePublished) &&
                    templateReference !== null
                      ? "&templateReference=" + templateReference
                      : "") +
                    (receiptTemplatePublished && locale !== null
                      ? "&locale=" + encodeURIComponent(locale)
                      : "") +
                    (receiptTemplateDraftRoster && afterTemplate !== null
                      ? "&afterTemplate=" + afterTemplate
                      : "")
                  : ""),
              method,
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + session.sessionCookie,
                ...(feeContextClassifications || receiptTemplateReview || receiptTemplatePublished
                  ? {
                      "x-bop-store-setup-scope": Buffer.from(
                        canonicalizeRfc8785(selected),
                      ).toString("base64url"),
                    }
                  : {}),
                ...(method === "POST"
                  ? {
                      "x-bop-csrf": csrf,
                      "x-bop-store-setup-scope": Buffer.from(
                        canonicalizeRfc8785(selected),
                      ).toString("base64url"),
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(bytes),
                    }
                  : {}),
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.once("error", reject);
              response.once("end", () => {
                try {
                  assert.equal(response.headers["cache-control"], "no-store");
                  if (dropReply) {
                    assert.equal(
                      response.statusCode,
                      200,
                      "confirmed owning write must precede synthetic response loss",
                    );
                    return resolve({ replyLost: true });
                  }
                  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  httpStatus = String(response.statusCode);
                  httpCode =
                    typeof body?.error === "string" &&
                    /^(?:request_denied|store_setup_(?:reference_)?(?:invalid|conflict|unavailable)|receipt_template_(?:artifact|draft|submit)_(?:invalid|conflict|unavailable))$/u.test(
                      body.error,
                    )
                      ? body.error
                      : "NONE";
                  resolve({ status: response.statusCode, body });
                } catch {
                  reject(new Error("STORE_SETUP_HTTP_RESPONSE_UNAVAILABLE"));
                }
              });
            },
          );
          request.setTimeout(10000, () => request.destroy(new Error("STORE_SETUP_HTTP_TIMEOUT")));
          request.once("error", reject);
          request.end(bytes ?? undefined);
        });
      return await work(send);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    const session = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions,
      scope,
      actor,
      at,
      referencePrefix: "01902431",
      sessionReferencePrefix: "01902432",
    });
    const managerActor = id(9);
    const manager = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions,
      scope,
      actor: managerActor,
      at,
      referencePrefix: "01902433",
      sessionReferencePrefix: "01902434",
    });
    // Actual Tenant owner metadata; no inline configured Store or fabricated live proof.
    await admin.query(
      "UPDATE bop_tenant.store SET locale='fr-CA',version=version+1 WHERE store_id=$1",
      [store],
    );
    const from = new Date(Date.parse(at) - 60000).toISOString(),
      until = new Date(Date.parse(at) + 3600000).toISOString();
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'organization.manage','Active',1,$2,$2)",
      [id(30), from],
    );
    for (const [index, prefix] of ["01902431", "01902433"].entries()) {
      const roleId = prefix + "-0000-7000-8000-000000000004";
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [id(31 + index), roleId, id(30), brand, store, from, until],
      );
    }
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'integration.manage','Active',1,$2,$2)",
      [id(4000), from],
    );
    for (const [index, prefix] of ["01902431", "01902433"].entries()) {
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [
          id(4001 + index),
          prefix + "-0000-7000-8000-000000000004",
          id(4000),
          brand,
          store,
          from,
          until,
        ],
      );
    }
    for (const [actionIndex, action] of [
      "publishing.draft.create",
      "publishing.review.submit",
    ].entries()) {
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [id(4100 + actionIndex), action, from],
      );
      for (const [roleIndex, prefix] of ["01902431", "01902433"].entries()) {
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [
            id(4200 + roleIndex * 2 + actionIndex),
            prefix + "-0000-7000-8000-000000000004",
            id(4100 + actionIndex),
            brand,
            store,
            from,
            until,
          ],
        );
      }
    }
    for (const [actionIndex, action] of [
      "publishing.review.approve",
      "publishing.release.publish",
    ].entries()) {
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [id(4500 + actionIndex), action, from],
      );
      for (const [roleIndex, prefix] of ["01902431", "01902433"].entries()) {
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [
            id(4600 + roleIndex * 2 + actionIndex),
            prefix + "-0000-7000-8000-000000000004",
            id(4500 + actionIndex),
            brand,
            store,
            from,
            until,
          ],
        );
      }
    }
    await admin.query(
      "GRANT USAGE ON SCHEMA platform_helpers,bop_identity,bop_tenant,bop_membership,bop_permission,rms_store,rms_payment,rms_device,bop_publishing,platform_audit TO " +
        role,
    );
    await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,UPDATE ON bop_identity.authentication_session,bop_tenant.brand,bop_tenant.store,bop_membership.membership,bop_membership.store_assignment,bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_definition,bop_permission.permission_grant,bop_permission.permission_override TO " +
        role,
    );
    await admin.query("GRANT SELECT ON bop_identity.browser_session_selection TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON rms_store.store_setup_draft_revision,rms_store.store_setup_draft_operation,rms_store.store_setup_reference_version,rms_store.store_setup_reference_operation,rms_payment.store_payment_configuration_version,rms_payment.store_payment_configuration_operation,rms_device.digital_receipt_template_artifact_version,rms_device.digital_receipt_template_artifact_operation,rms_device.digital_receipt_template_draft_revision,rms_device.digital_receipt_template_draft_operation,platform_audit.audit_record TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_device.digital_receipt_template_version TO " + role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_device.digital_receipt_template_submission,rms_device.digital_receipt_template_submit_operation,rms_device.digital_receipt_template_lifecycle_operation TO " +
        role,
    );
    // Actual Publishing SHARE/SRE owner locking requires UPDATE ACL; append-only history triggers reject mutation.
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    // Legacy public complete-authoring reader's table SHARE lock requires UPDATE ACL;
    // immutable trigger still refuses updates. No complete configuration is seeded.
    await admin.query(
      "GRANT SELECT,UPDATE ON rms_store.store_configuration_authoring_operation TO " + role,
    );
    assert.deepEqual(await artifactCounts(), {
      revisions: "0",
      operations: "0",
      audits: "0",
      events: "0",
      referenceVersions: "0",
      referenceOperations: "0",
    });
    const runtime = runtimeFor(session),
      managerRuntime = runtimeFor(manager);
    await withHttp(runtime, session, async (send) => {
      stage = "EmptyCurrent";
      const empty = await send("GET");
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.scope, scope);
      assert.equal(empty.body.setup.snapshot, null);
      assert.equal(empty.body.store.locale, "fr-CA");
      assert.equal(empty.body.store.currencyCode, "CAD");
      assert.equal(empty.body.setup.businessReferenceValidation, "NotEvaluated");
      assert.ok(Date.parse(empty.body.setup.validUntil) > Date.parse(empty.body.setup.observedAt));
      assert.ok(
        Date.parse(empty.body.setup.validUntil) - Date.parse(empty.body.setup.observedAt) <= 5000,
      );
      assert.deepEqual(await artifactCounts(), {
        revisions: "0",
        operations: "0",
        audits: "0",
        events: "0",
        referenceVersions: "0",
        referenceOperations: "0",
      });
      const content = {
        ...createUnconfiguredStoreSetupDraftContent(),
        timeZone: { state: "Configured", value: "America/Toronto" },
        capacityConfigurationReference: { state: "Configured", value: null },
        effectiveUntil: { state: "Configured", value: null },
        enabledServiceModes: { state: "Configured", value: ["DineIn", "Pickup"] },
      };
      const first = {
        command: "SaveDraft",
        operationReference: id(40),
        expectedSetupReference: null,
        expectedRevision: 0,
        content,
      };
      const original = bindMerchantStoreSetupCommand(first, scope).command,
        intentDigest = hash(original);
      stage = "SaveLostReply";
      assert.deepEqual(await send("POST", first, { dropReply: true }), { replyLost: true });
      const savedCounts = await artifactCounts();
      assert.deepEqual(savedCounts, {
        revisions: "1",
        operations: "1",
        audits: "1",
        events: "0",
        referenceVersions: "0",
        referenceOperations: "0",
      });
      stage = "ResolveCommitted";
      const resolution = await send("POST", {
        command: "ResolveOriginal",
        operationReference: first.operationReference,
        expectedSetupReference: null,
        expectedRevision: 0,
        intentDigest,
      });
      assert.equal(resolution.status, 200);
      const receipt = parseStoreSetupOperationReceipt(resolution.body);
      assert.equal(receipt.outcome, "Committed");
      assert.equal(receipt.intentDigest, intentDigest);
      assert.equal(receipt.snapshot.revision, 1);
      assert.equal(receipt.snapshot.defaultLocale, "fr-CA");
      assert.equal(receipt.snapshot.baseConfigurationReference, null);
      assert.deepEqual(receipt.snapshot.content, content);
      assert.deepEqual(await artifactCounts(), savedCounts);
      stage = "ExactReplay";
      const replay = await send("POST", first);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, receipt);
      assert.deepEqual(await artifactCounts(), savedCounts);
      const current = await send("GET");
      assert.equal(current.status, 200);
      assert.deepEqual(current.body.setup.snapshot, receipt.snapshot);
      stage = "ExactStorePreparationOrigin";
      // Real committed HTTP-origin rows and RLS queries; the direct owning
      // source below uses controlled authority. It is not new IAM/API evidence.
      const sourceSelector = {
        setupDraftReference: receipt.snapshot.setupDraftReference,
        sourceRevision: receipt.snapshot.revision,
        sourceSnapshotDigest: hash(receipt.snapshot),
      };
      const readPreparation = async (selector) => {
        const read = await transactions.run(async (tx) => {
          const guards = [],
            finals = [],
            observedAt = now();
          const source = createPostgresStoreSetupDraftStore({
            ...scope,
            transaction: tx,
            clock: { now },
            originalObservedAt: observedAt,
            originalValidUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
            registerBeforeCommit(actual, guard, final) {
              assert.equal(actual, tx);
              guards.push(guard);
              finals.push(final);
            },
            authority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.equal(input.mode, "Read");
                assert.equal(input.permission, "organization.manage");
                return { validUntil: input.validUntil };
              },
            },
            references: {
              canonicalize: canonicalizeRfc8785,
              hashIntent: (value) => "sha256:" + sha256Hex(value),
              nextReference: unused,
            },
            appendAudit: unused,
            withCurrentSaveScope: unused,
          });
          const historical = await source.readServiceModePreparationVersion(selector),
            actualCurrent = await source.readServiceModePreparation();
          for (const guard of guards) await guard();
          return { source, tx, finals, historical, actualCurrent };
        });
        for (const final of read.finals) final();
        read.source.assertFinalized(read.tx);
        return read;
      };
      const preparation = await readPreparation(sourceSelector);
      assert.equal(preparation.historical.sourceBasis, "RecordedDraftRevision");
      assert.equal(
        preparation.historical.preparation.sourceSnapshotDigest,
        sourceSelector.sourceSnapshotDigest,
      );
      assert.deepEqual(preparation.historical.preparation.serviceModes, ["DineIn", "Pickup"]);
      assert.equal(
        preparation.actualCurrent.semanticDigest,
        preparation.historical.preparation.semanticDigest,
      );
      assert.equal(preparation.historical.preparation.publicationStatus, "NotPublished");
      assert.deepEqual(await artifactCounts(), savedCounts);
      for (const change of [
        { sourceRevision: 2 },
        { setupDraftReference: id(999) },
        { sourceSnapshotDigest: "sha256:" + "a".repeat(64) },
      ]) {
        await assert.rejects(
          readPreparation({ ...sourceSelector, ...change }),
          (error) => error?.code === "STORE_SETUP_OPERATION_VERSION_CONFLICT",
        );
        assert.deepEqual(await artifactCounts(), savedCounts);
      }
      stage = "CASConflict";
      const conflict = await send("POST", { ...first, operationReference: id(41) });
      assert.equal(conflict.status, 409);
      assert.deepEqual(await artifactCounts(), savedCounts);
      stage = "ScopePins";
      for (const selected of [
        { ...scope, storeReference: id(99) },
        { ...scope, actorReference: managerActor },
      ]) {
        assert.equal(
          (await send("POST", { ...first, operationReference: id(42) }, { selected })).status,
          403,
        );
        assert.deepEqual(await artifactCounts(), savedCounts);
      }
      assert.equal((await send("GET", undefined, { expectedStore: id(99) })).status, 403);
      stage = "CSRF";
      assert.equal(
        (await send("POST", { ...first, operationReference: id(43) }, { csrf: "A".repeat(43) }))
          .status,
        403,
      );
      assert.deepEqual(await artifactCounts(), savedCounts);
      stage = "AbsentAbandoned";
      const absent = {
        ...first,
        operationReference: id(44),
        expectedSetupReference: receipt.snapshot.setupDraftReference,
        expectedRevision: 1,
      };
      const absentDigest = hash(bindMerchantStoreSetupCommand(absent, scope).command);
      const abandoned = await send("POST", {
        command: "ResolveOriginal",
        operationReference: absent.operationReference,
        expectedSetupReference: absent.expectedSetupReference,
        expectedRevision: 1,
        intentDigest: absentDigest,
      });
      assert.equal(abandoned.status, 200);
      assert.equal(abandoned.body.outcome, "Abandoned");
      assert.equal(abandoned.body.snapshot, null);
      const absentCounts = await artifactCounts();
      assert.deepEqual(absentCounts, {
        revisions: "1",
        operations: "2",
        audits: "2",
        events: "0",
        referenceVersions: "0",
        referenceOperations: "0",
      });
      const late = await send("POST", absent);
      assert.equal(late.status, 200);
      assert.deepEqual(late.body, abandoned.body);
      assert.deepEqual(await artifactCounts(), absentCounts);
      stage = "ManagerResume";
      await withHttp(managerRuntime, manager, async (second) => {
        const managerScope = { ...scope, actorReference: managerActor };
        const resume = await second("GET");
        assert.equal(resume.status, 200);
        assert.equal(resume.body.setup.readerActorReference, managerActor);
        assert.equal(resume.body.setup.snapshot.authoredByReference, actor);
        const update = await second(
          "POST",
          {
            ...absent,
            operationReference: id(45),
            content: {
              ...content,
              businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
            },
          },
          { selected: managerScope },
        );
        assert.equal(update.status, 200);
        assert.equal(update.body.snapshot.revision, 2);
        assert.equal(update.body.snapshot.authoredByReference, managerActor);
        assert.equal(update.body.snapshot.createdAt, receipt.snapshot.createdAt);
      });
      const finalCounts = await artifactCounts();
      assert.deepEqual(finalCounts, {
        revisions: "2",
        operations: "3",
        audits: "3",
        events: "0",
        referenceVersions: "0",
        referenceOperations: "0",
      });
      stage = "StorePreparationOriginAfterSuccessor";
      const afterSuccessor = await readPreparation(sourceSelector);
      assert.equal(afterSuccessor.historical.preparation.sourceRevision, 1);
      assert.equal(
        afterSuccessor.historical.preparation.sourceSnapshotDigest,
        sourceSelector.sourceSnapshotDigest,
      );
      assert.equal(afterSuccessor.actualCurrent.sourceRevision, 2);
      assert.notEqual(
        afterSuccessor.actualCurrent.sourceSnapshotDigest,
        sourceSelector.sourceSnapshotDigest,
      );
      assert.equal(
        afterSuccessor.actualCurrent.semanticDigest,
        afterSuccessor.historical.preparation.semanticDigest,
      );
      assert.deepEqual(await artifactCounts(), finalCounts);
      stage = "ReferenceEmptyCurrent";
      const referenceRead = await send("GET", undefined, { referenceKind: "Address" });
      assert.equal(referenceRead.status, 200);
      const referenceCurrent = parseStoreSetupReferencesCurrent(referenceRead.body);
      assert.equal(referenceCurrent.address, null);
      assert.equal(referenceCurrent.contact, null);
      assert.equal(referenceCurrent.actorReference, actor);
      const addressContent = {
        countryCode: "CA",
        regionCode: "ON",
        locality: "Synthetic locality",
        postalCode: "A1A 1A1",
        addressLines: ["1 Synthetic Way"],
      };
      const contactContent = {
        contactName: "Synthetic Store contact",
        businessPhone: "+14165550100",
        website: "https://example.invalid/",
      };
      const addressSave = {
        command: "SaveReference",
        operationReference: id(50),
        expectedReference: null,
        expectedRevision: 0,
        content: addressContent,
      };
      const addressDigest = hash(
        bindMerchantStoreSetupReferenceCommand(addressSave, scope, "Address").command,
      );
      stage = "ReferenceAddressLostReply";
      assert.deepEqual(
        await send("POST", addressSave, { referenceKind: "Address", dropReply: true }),
        { replyLost: true },
      );
      const addressCounts = await artifactCounts();
      assert.deepEqual(addressCounts, {
        revisions: "2",
        operations: "3",
        audits: "4",
        events: "0",
        referenceVersions: "1",
        referenceOperations: "1",
      });
      const addressResolve = {
        command: "ResolveOriginal",
        operationReference: addressSave.operationReference,
        expectedReference: null,
        expectedRevision: 0,
        intentDigest: addressDigest,
      };
      stage = "ReferenceResolveCommitted";
      const addressResolved = await send("POST", addressResolve, { referenceKind: "Address" });
      assert.equal(addressResolved.status, 200);
      const addressReceipt = parseStoreSetupReferenceReceipt(addressResolved.body);
      assert.equal(addressReceipt.outcome, "Committed");
      assert.equal(addressReceipt.intentDigest, addressDigest);
      assert.deepEqual(addressReceipt.snapshot.content, addressContent);
      const addressReplay = await send("POST", addressSave, { referenceKind: "Address" });
      assert.equal(addressReplay.status, 200);
      assert.deepEqual(addressReplay.body, addressReceipt);
      assert.deepEqual(await artifactCounts(), addressCounts);
      const currentAddress = await send("GET", undefined, { referenceKind: "Address" });
      assert.equal(currentAddress.status, 200);
      assert.deepEqual(currentAddress.body.address, addressReceipt.snapshot);
      stage = "ReferenceContactSave";
      const contactSave = {
        command: "SaveReference",
        operationReference: id(51),
        expectedReference: null,
        expectedRevision: 0,
        content: contactContent,
      };
      const contactSaved = await send("POST", contactSave, { referenceKind: "Contact" });
      assert.equal(contactSaved.status, 200);
      const contactReceipt = parseStoreSetupReferenceReceipt(contactSaved.body);
      assert.deepEqual(contactReceipt.snapshot.content, contactContent);
      const contactCounts = await artifactCounts();
      assert.deepEqual(contactCounts, {
        ...addressCounts,
        audits: "5",
        referenceVersions: "2",
        referenceOperations: "2",
      });
      const currentBoth = await send("GET", undefined, { referenceKind: "Contact" });
      assert.equal(currentBoth.status, 200);
      assert.deepEqual(currentBoth.body.address, addressReceipt.snapshot);
      assert.deepEqual(currentBoth.body.contact, contactReceipt.snapshot);
      stage = "ReferenceRefusals";
      assert.equal(
        (
          await send(
            "POST",
            { ...addressSave, operationReference: id(52) },
            { referenceKind: "Address" },
          )
        ).status,
        409,
      );
      for (const selected of [
        { ...scope, tenantReference: id(99) },
        { ...scope, brandReference: id(99) },
        { ...scope, storeReference: id(99) },
        { ...scope, actorReference: managerActor },
      ])
        assert.equal(
          (
            await send(
              "POST",
              { ...addressSave, operationReference: id(53) },
              { referenceKind: "Address", selected },
            )
          ).status,
          403,
        );
      assert.equal(
        (
          await send(
            "POST",
            { ...addressSave, operationReference: id(54) },
            { referenceKind: "Address", csrf: "A".repeat(43) },
          )
        ).status,
        403,
      );
      assert.deepEqual(await artifactCounts(), contactCounts);
      stage = "ReferenceAbandonedLateSave";
      const abandonedSave = {
        ...addressSave,
        operationReference: id(55),
        expectedReference: addressReceipt.snapshot.reference,
        expectedRevision: 1,
      };
      const abandonedDigest = hash(
        bindMerchantStoreSetupReferenceCommand(abandonedSave, scope, "Address").command,
      );
      const abandonedReference = await send(
        "POST",
        {
          command: "ResolveOriginal",
          operationReference: abandonedSave.operationReference,
          expectedReference: abandonedSave.expectedReference,
          expectedRevision: 1,
          intentDigest: abandonedDigest,
        },
        { referenceKind: "Address" },
      );
      assert.equal(abandonedReference.status, 200);
      assert.equal(abandonedReference.body.outcome, "Abandoned");
      assert.equal(abandonedReference.body.snapshot, null);
      const abandonedReferenceCounts = await artifactCounts();
      assert.deepEqual(abandonedReferenceCounts, {
        ...contactCounts,
        audits: "6",
        referenceOperations: "3",
      });
      const lateReference = await send("POST", abandonedSave, { referenceKind: "Address" });
      assert.equal(lateReference.status, 200);
      assert.deepEqual(lateReference.body, abandonedReference.body);
      assert.deepEqual(await artifactCounts(), abandonedReferenceCounts);
      stage = "ReferenceManagerSuccessor";
      let addressSuccessor;
      await withHttp(managerRuntime, manager, async (second) => {
        const managerScope = { ...scope, actorReference: managerActor };
        const beforeForeignResolve = await artifactCounts();
        assert.equal(
          (
            await second("POST", addressResolve, {
              referenceKind: "Address",
              selected: managerScope,
            })
          ).status,
          403,
        );
        assert.deepEqual(await artifactCounts(), beforeForeignResolve);
        const historical = await second("GET", undefined, { referenceKind: "Address" });
        assert.equal(historical.status, 200);
        assert.equal(historical.body.actorReference, managerActor);
        assert.equal(historical.body.address.authoredByReference, actor);
        const successor = await second(
          "POST",
          {
            ...abandonedSave,
            operationReference: id(56),
            content: { ...addressContent, addressLines: ["2 Synthetic Way"] },
          },
          { referenceKind: "Address", selected: managerScope },
        );
        assert.equal(successor.status, 200);
        addressSuccessor = parseStoreSetupReferenceReceipt(successor.body).snapshot;
        assert.equal(addressSuccessor.revision, 2);
        assert.notEqual(addressSuccessor.reference, addressReceipt.snapshot.reference);
        assert.equal(addressSuccessor.previousReference, addressReceipt.snapshot.reference);
        assert.equal(addressSuccessor.createdAt, addressReceipt.snapshot.createdAt);
        assert.equal(addressSuccessor.authoredByReference, managerActor);
      });
      assert.ok(addressSuccessor);
      const historicalRows = (
        await admin.query(
          "SELECT snapshot_json FROM rms_store.store_setup_reference_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reference_kind='Address' ORDER BY revision",
          [tenant, brand, store],
        )
      ).rows;
      assert.deepEqual(
        historicalRows.map((row) => row.snapshot_json),
        [addressReceipt.snapshot, addressSuccessor],
      );
      const afterSuccessorReplay = await send("POST", addressSave, { referenceKind: "Address" });
      assert.equal(afterSuccessorReplay.status, 200);
      assert.deepEqual(afterSuccessorReplay.body, addressReceipt);
      stage = "ReferenceExplicitPartialBinding";
      const selectedReferences = {
        ...createUnconfiguredStoreSetupDraftContent(),
        addressReference: { state: "Configured", value: addressSuccessor.reference },
        contactReference: { state: "Configured", value: contactReceipt.snapshot.reference },
      };
      const boundPartial = await send("POST", {
        command: "SaveDraft",
        operationReference: id(57),
        expectedSetupReference: receipt.snapshot.setupDraftReference,
        expectedRevision: 2,
        content: selectedReferences,
      });
      assert.equal(boundPartial.status, 200);
      assert.equal(boundPartial.body.snapshot.revision, 3);
      const readBoundPartial = await send("GET");
      assert.equal(readBoundPartial.status, 200);
      assert.deepEqual(readBoundPartial.body.setup.snapshot.content, selectedReferences);
      const referenceAudits = (
        await admin.query(
          "SELECT after_summary_json,before_summary_json FROM platform_audit.audit_record WHERE target_type='StoreSetupReference'",
        )
      ).rows;
      assert.equal(referenceAudits.length, 4);
      for (const audit of referenceAudits) {
        assert.deepEqual(Object.keys(audit.after_summary_json), ["intentDigest"]);
        assert.match(audit.after_summary_json.intentDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(audit.before_summary_json, {});
      }
      assert.deepEqual(await artifactCounts(), {
        revisions: "3",
        operations: "4",
        audits: "8",
        events: "0",
        referenceVersions: "3",
        referenceOperations: "4",
      });
      stage = "PaymentEmptyCurrent";
      const paymentTransport = { paymentConfiguration: true };
      const paymentRead = await send("GET", undefined, paymentTransport);
      assert.equal(paymentRead.status, 200);
      assert.equal(parseStorePaymentConfigurationCurrent(paymentRead.body).snapshot, null);
      const paymentSave = {
        command: "SaveConfiguration",
        operationReference: id(70),
        expectedConfigurationReference: null,
        expectedRevision: 0,
        content: {
          customerOnlineCardEnabled: true,
          staffTerminalCardPresentEnabled: false,
          staffTerminalInteracEnabled: false,
        },
      };
      const paymentIntent = hash(
        bindMerchantStorePaymentConfigurationCommand(paymentSave, scope).command,
      );
      stage = "PaymentLostReply";
      assert.deepEqual(await send("POST", paymentSave, { ...paymentTransport, dropReply: true }), {
        replyLost: true,
      });
      const paymentResolve = {
        command: "ResolveOriginal",
        operationReference: paymentSave.operationReference,
        expectedConfigurationReference: null,
        expectedRevision: 0,
        intentDigest: paymentIntent,
      };
      const originalPayment = await send("POST", paymentResolve, paymentTransport);
      assert.equal(originalPayment.status, 200);
      const paymentReceipt = parseStorePaymentConfigurationReceipt(originalPayment.body);
      assert.equal(paymentReceipt.outcome, "Committed");
      assert.ok(paymentReceipt.snapshot);
      assert.deepEqual(paymentReceipt.snapshot.content, paymentSave.content);
      assert.deepEqual((await send("POST", paymentSave, paymentTransport)).body, paymentReceipt);
      const currentPayment = await send("GET", undefined, paymentTransport);
      assert.equal(currentPayment.status, 200);
      assert.deepEqual(
        parseStorePaymentConfigurationCurrent(currentPayment.body).snapshot,
        paymentReceipt.snapshot,
      );
      const paymentCounts = async () =>
        (
          await admin.query(`SELECT
          (SELECT count(*)::text FROM rms_payment.store_payment_configuration_version) versions,
          (SELECT count(*)::text FROM rms_payment.store_payment_configuration_operation) operations`)
        ).rows[0];
      stage = "PaymentDeniedNoArtifacts";
      const beforeDenied = await artifactCounts();
      for (const selected of [
        { ...scope, tenantReference: id(80) },
        { ...scope, brandReference: id(81) },
        { ...scope, storeReference: id(82) },
        { ...scope, actorReference: id(83) },
      ]) {
        assert.equal(
          (
            await send(
              "POST",
              { ...paymentSave, operationReference: id(84) },
              {
                ...paymentTransport,
                selected,
              },
            )
          ).status,
          403,
        );
      }
      assert.equal(
        (await send("POST", { ...paymentSave, operationReference: id(85) }, paymentTransport))
          .status,
        409,
      );
      assert.equal(
        (await send("POST", paymentResolve, { ...paymentTransport, csrf: "A".repeat(43) })).status,
        403,
      );
      assert.deepEqual(await artifactCounts(), beforeDenied);
      assert.deepEqual(await paymentCounts(), { versions: "1", operations: "1" });
      stage = "PaymentTerminalAbandoned";
      const latePayment = { ...paymentSave, operationReference: id(86) };
      const abandonedPayment = await send(
        "POST",
        {
          ...paymentResolve,
          operationReference: latePayment.operationReference,
          intentDigest: hash(
            bindMerchantStorePaymentConfigurationCommand(latePayment, scope).command,
          ),
        },
        paymentTransport,
      );
      assert.equal(abandonedPayment.status, 200);
      assert.equal(
        parseStorePaymentConfigurationReceipt(abandonedPayment.body).outcome,
        "Abandoned",
      );
      assert.deepEqual(
        (await send("POST", latePayment, paymentTransport)).body,
        abandonedPayment.body,
      );
      stage = "PaymentIndependentManagerSuccessor";
      let successorPayment;
      await withHttp(managerRuntime, manager, async (second) => {
        const previous = await second("GET", undefined, paymentTransport);
        assert.equal(previous.status, 200);
        assert.equal(previous.body.actorReference, managerActor);
        assert.equal(previous.body.snapshot.authoredByReference, actor);
        const saved = await second(
          "POST",
          {
            ...paymentSave,
            operationReference: id(87),
            expectedConfigurationReference: paymentReceipt.snapshot.configurationReference,
            expectedRevision: 1,
            content: {
              customerOnlineCardEnabled: false,
              staffTerminalCardPresentEnabled: false,
              staffTerminalInteracEnabled: false,
            },
          },
          { ...paymentTransport, selected: { ...scope, actorReference: managerActor } },
        );
        assert.equal(saved.status, 200);
        successorPayment = parseStorePaymentConfigurationReceipt(saved.body).snapshot;
        assert.ok(successorPayment);
        assert.equal(successorPayment.revision, 2);
        assert.equal(successorPayment.authoredByReference, managerActor);
        assert.equal(successorPayment.createdAt, paymentReceipt.snapshot.createdAt);
        assert.equal(
          successorPayment.previousConfigurationReference,
          paymentReceipt.snapshot.configurationReference,
        );
        assert.notEqual(
          successorPayment.configurationReference,
          paymentReceipt.snapshot.configurationReference,
        );
      });
      assert.deepEqual((await send("POST", paymentResolve, paymentTransport)).body, paymentReceipt);
      const paymentHistory = (
        await admin.query(
          "SELECT snapshot_json FROM rms_payment.store_payment_configuration_version ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        paymentHistory.map((row) => row.snapshot_json),
        [paymentReceipt.snapshot, successorPayment],
      );
      stage = "PaymentExplicitPartialBinding";
      const paymentSelected = {
        ...selectedReferences,
        paymentConfigurationReference: {
          state: "Configured",
          value: paymentReceipt.snapshot.configurationReference,
        },
      };
      const paymentPartial = await send("POST", {
        command: "SaveDraft",
        operationReference: id(88),
        expectedSetupReference: boundPartial.body.snapshot.setupDraftReference,
        expectedRevision: 3,
        content: paymentSelected,
      });
      assert.equal(paymentPartial.status, 200);
      assert.deepEqual((await send("GET")).body.setup.snapshot.content, paymentSelected);
      assert.equal(
        (await send("GET", undefined, paymentTransport)).body.providerReadiness,
        "NotEvaluated",
      );
      const paymentAudits = (
        await admin.query(
          "SELECT after_summary_json,before_summary_json FROM platform_audit.audit_record WHERE target_type='StorePaymentConfiguration'",
        )
      ).rows;
      assert.equal(paymentAudits.length, 3);
      for (const audit of paymentAudits) {
        assert.deepEqual(Object.keys(audit.after_summary_json), ["intentDigest"]);
        assert.match(audit.after_summary_json.intentDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(audit.before_summary_json, {});
      }
      stage = "ReceiptArtifacts";
      const artifactTransport = { artifactKind: "Layout" };
      const emptyArtifacts = await send("GET", undefined, artifactTransport);
      assert.equal(emptyArtifacts.status, 200);
      const artifactEmpty = parseDigitalReceiptTemplateArtifactCurrent(emptyArtifacts.body);
      assert.equal(artifactEmpty.layout, null);
      assert.equal(artifactEmpty.compliance, null);
      assert.equal(artifactEmpty.actorReference, actor);
      assert.ok(Date.parse(artifactEmpty.validUntil) > Date.parse(artifactEmpty.observedAt));
      assert.ok(
        Date.parse(artifactEmpty.validUntil) - Date.parse(artifactEmpty.observedAt) <= 5000,
      );
      const requiredFields = [
        "Issuer",
        "Store",
        "OrderNumber",
        "IssuedAt",
        "Items",
        "Subtotal",
        "Discount",
        "Fee",
        "Tax",
        "Tip",
        "Total",
        "PaymentStatus",
        "RefundedTotal",
      ];
      const layoutSave = {
        command: "SaveArtifact",
        operationReference: id(3000),
        expectedArtifactReference: null,
        expectedRevision: 0,
        content: {
          profile: "AccessibleDigitalReceiptLayoutV1",
          dataContractVersion: 1,
          renderEngineVersion: 1,
          outputProfile: "AccessibleDigitalReceipt",
          requiredFields,
        },
      };
      const layoutIntent = hash(
        bindMerchantReceiptTemplateArtifactCommand(layoutSave, scope, "Layout").command,
      );
      assert.deepEqual(await send("POST", layoutSave, { ...artifactTransport, dropReply: true }), {
        replyLost: true,
      });
      const layoutResolve = {
        command: "ResolveOriginal",
        operationReference: layoutSave.operationReference,
        expectedArtifactReference: null,
        expectedRevision: 0,
        intentDigest: layoutIntent,
      };
      const resolvedLayout = await send("POST", layoutResolve, artifactTransport);
      assert.equal(resolvedLayout.status, 200);
      const layoutReceipt = parseDigitalReceiptTemplateArtifactReceipt(resolvedLayout.body);
      assert.equal(layoutReceipt.outcome, "Committed");
      assert.ok(layoutReceipt.snapshot);
      assert.deepEqual(layoutReceipt.snapshot.content, layoutSave.content);
      const layoutOriginal = (
        await admin.query(
          "SELECT actor_id,intent_digest,occurred_at FROM rms_device.digital_receipt_template_artifact_operation WHERE operation_id=$1",
          [layoutSave.operationReference],
        )
      ).rows;
      assert.equal(layoutOriginal.length, 1);
      assert.equal(layoutOriginal[0].actor_id, actor);
      assert.equal(layoutOriginal[0].intent_digest, layoutIntent);
      assert.equal(layoutOriginal[0].occurred_at.toISOString(), layoutReceipt.occurredAt);
      assert.equal(layoutReceipt.snapshot.updatedAt, layoutReceipt.occurredAt);
      assert.deepEqual((await send("POST", layoutSave, artifactTransport)).body, layoutReceipt);
      const complianceSave = {
        command: "SaveArtifact",
        operationReference: id(3001),
        expectedArtifactReference: null,
        expectedRevision: 0,
        content: {
          profile: "DigitalReceiptRequiredFieldRuleV1",
          dataContractVersion: 1,
          requiredFields,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        },
      };
      const complianceResponse = await send("POST", complianceSave, { artifactKind: "Compliance" });
      assert.equal(complianceResponse.status, 200);
      const complianceReceipt = parseDigitalReceiptTemplateArtifactReceipt(complianceResponse.body);
      assert.ok(complianceReceipt.snapshot);
      const artifactCurrent = await send("GET", undefined, artifactTransport);
      assert.equal(artifactCurrent.status, 200);
      const bothArtifacts = parseDigitalReceiptTemplateArtifactCurrent(artifactCurrent.body);
      assert.deepEqual(bothArtifacts.layout, layoutReceipt.snapshot);
      assert.deepEqual(bothArtifacts.compliance, complianceReceipt.snapshot);
      const receiptArtifactCounts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_artifact_version) versions,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_artifact_operation) operations`)
        ).rows[0];
      const artifactBeforeRejected = await artifactCounts();
      assert.deepEqual(await receiptArtifactCounts(), { versions: "2", operations: "2" });
      assert.equal(
        (await send("POST", { ...layoutSave, operationReference: id(3002) }, artifactTransport))
          .status,
        409,
      );
      assert.equal(
        (
          await send("POST", layoutResolve, {
            ...artifactTransport,
            selected: { ...scope, actorReference: managerActor },
          })
        ).status,
        403,
      );
      assert.equal(
        (await send("POST", layoutResolve, { ...artifactTransport, csrf: "A".repeat(43) })).status,
        403,
      );
      assert.deepEqual(await artifactCounts(), artifactBeforeRejected);
      assert.deepEqual(await receiptArtifactCounts(), { versions: "2", operations: "2" });
      const absentArtifactSave = {
        ...layoutSave,
        operationReference: id(3003),
        expectedArtifactReference: layoutReceipt.snapshot.artifactReference,
        expectedRevision: 1,
      };
      const absentArtifactResolve = {
        command: "ResolveOriginal",
        operationReference: absentArtifactSave.operationReference,
        expectedArtifactReference: absentArtifactSave.expectedArtifactReference,
        expectedRevision: 1,
        intentDigest: hash(
          bindMerchantReceiptTemplateArtifactCommand(absentArtifactSave, scope, "Layout").command,
        ),
      };
      const abandonedArtifact = await send("POST", absentArtifactResolve, artifactTransport);
      assert.equal(abandonedArtifact.status, 200);
      const artifactAbandoned = parseDigitalReceiptTemplateArtifactReceipt(abandonedArtifact.body);
      assert.equal(artifactAbandoned.outcome, "Abandoned");
      assert.equal(artifactAbandoned.snapshot, null);
      const afterArtifactAbandoned = await artifactCounts();
      assert.deepEqual(
        (await send("POST", absentArtifactSave, artifactTransport)).body,
        artifactAbandoned,
      );
      assert.deepEqual(await artifactCounts(), afterArtifactAbandoned);
      let layoutSuccessor;
      await withHttp(managerRuntime, manager, async (second) => {
        const managerScope = { ...scope, actorReference: managerActor };
        const previous = await second("GET", undefined, artifactTransport);
        assert.equal(previous.status, 200);
        const managerCurrent = parseDigitalReceiptTemplateArtifactCurrent(previous.body);
        assert.equal(managerCurrent.actorReference, managerActor);
        assert.deepEqual(managerCurrent.layout, layoutReceipt.snapshot);
        assert.equal(managerCurrent.layout.authoredByReference, actor);
        const saved = await second(
          "POST",
          {
            ...layoutSave,
            operationReference: id(3004),
            expectedArtifactReference: layoutReceipt.snapshot.artifactReference,
            expectedRevision: 1,
          },
          { ...artifactTransport, selected: managerScope },
        );
        assert.equal(saved.status, 200);
        layoutSuccessor = parseDigitalReceiptTemplateArtifactReceipt(saved.body).snapshot;
        assert.ok(layoutSuccessor);
        assert.equal(layoutSuccessor.revision, 2);
        assert.equal(layoutSuccessor.authoredByReference, managerActor);
        assert.equal(layoutSuccessor.createdAt, layoutReceipt.snapshot.createdAt);
        assert.equal(
          layoutSuccessor.previousArtifactReference,
          layoutReceipt.snapshot.artifactReference,
        );
        assert.notEqual(
          layoutSuccessor.artifactReference,
          layoutReceipt.snapshot.artifactReference,
        );
      });
      const artifactHistory = (
        await admin.query(
          "SELECT snapshot_json FROM rms_device.digital_receipt_template_artifact_version WHERE artifact_kind='Layout' ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        artifactHistory.map((row) => row.snapshot_json),
        [layoutReceipt.snapshot, layoutSuccessor],
      );
      assert.deepEqual((await send("POST", layoutResolve, artifactTransport)).body, layoutReceipt);
      assert.deepEqual((await send("POST", layoutSave, artifactTransport)).body, layoutReceipt);
      const successorCurrent = await send("GET", undefined, artifactTransport);
      assert.equal(successorCurrent.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplateArtifactCurrent(successorCurrent.body).layout,
        layoutSuccessor,
      );
      const artifactAudits = (
        await admin.query(
          "SELECT after_summary_json,before_summary_json FROM platform_audit.audit_record WHERE target_type='DigitalReceiptTemplateArtifact'",
        )
      ).rows;
      assert.equal(artifactAudits.length, 4);
      for (const audit of artifactAudits) {
        assert.deepEqual(Object.keys(audit.after_summary_json), ["intentDigest"]);
        assert.match(audit.after_summary_json.intentDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(audit.before_summary_json, {});
      }
      assert.deepEqual(await receiptArtifactCounts(), { versions: "3", operations: "4" });
      stage = "ReceiptTemplateDraft";
      const draftTransport = { receiptTemplateDraft: true };
      const emptyDraft = await send("GET", undefined, draftTransport);
      assert.equal(emptyDraft.status, 200);
      const draftEmpty = parseDigitalReceiptTemplateDraftCurrent(emptyDraft.body);
      assert.equal(draftEmpty.templateReference, null);
      assert.equal(draftEmpty.snapshot, null);
      assert.equal(draftEmpty.sourceQualification, "NotEvaluated");
      const receiptStoreWorkspace = await send("GET");
      assert.equal(receiptStoreWorkspace.status, 200);
      assert.deepEqual(receiptStoreWorkspace.body.scope, scope);
      const receiptStoreLocale = receiptStoreWorkspace.body.store.locale;
      assert.equal(receiptStoreLocale, "fr-CA");
      const draftSave = {
        command: "SaveDraft",
        operationReference: id(3100),
        templateReference: null,
        expectedVersionReference: null,
        expectedRevision: 0,
        fields: {
          locale: receiptStoreLocale,
          layoutDefinitionReference: layoutReceipt.snapshot.artifactReference,
          complianceRuleReference: complianceReceipt.snapshot.artifactReference,
          activation: { mode: "Immediate" },
          effectiveUntil: null,
        },
      };
      const draftIntent = hash(bindMerchantReceiptTemplateDraftCommand(draftSave, scope).command);
      assert.deepEqual(await send("POST", draftSave, { ...draftTransport, dropReply: true }), {
        replyLost: true,
      });
      const draftResolve = {
        command: "ResolveOriginal",
        operationReference: draftSave.operationReference,
        templateReference: null,
        expectedVersionReference: null,
        expectedRevision: 0,
        intentDigest: draftIntent,
      };
      const draftResolved = await send("POST", draftResolve, draftTransport);
      assert.equal(draftResolved.status, 200);
      const draftReceipt = parseDigitalReceiptTemplateDraftReceipt(draftResolved.body);
      assert.equal(draftReceipt.outcome, "Committed");
      assert.equal(draftReceipt.templateReference, null);
      assert.ok(draftReceipt.snapshot);
      const draftFirst = draftReceipt.snapshot;
      assert.equal(draftFirst.revision, 1);
      assert.equal(draftFirst.previousVersionReference, null);
      assert.equal(draftFirst.content.versionNumber, 1);
      assert.equal(draftFirst.content.versionCode, "RECEIPT_1");
      assert.equal(
        draftFirst.content.layoutDefinitionReference,
        layoutReceipt.snapshot.artifactReference,
      );
      assert.notEqual(
        draftFirst.content.layoutDefinitionReference,
        layoutSuccessor.artifactReference,
      );
      assert.equal(
        draftFirst.content.complianceRuleReference,
        complianceReceipt.snapshot.artifactReference,
      );
      assert.notEqual(draftFirst.content.templateReference, draftFirst.content.versionReference);
      assert.notEqual(draftFirst.familyReference, draftFirst.content.templateReference);
      assert.equal(draftFirst.authoredByReference, actor);
      assert.equal(draftFirst.updatedAt, draftReceipt.occurredAt);
      const draftOriginal = (
        await admin.query(
          "SELECT actor_id,template_id,intent_digest,occurred_at FROM rms_device.digital_receipt_template_draft_operation WHERE operation_id=$1",
          [draftSave.operationReference],
        )
      ).rows;
      assert.equal(draftOriginal.length, 1);
      assert.equal(draftOriginal[0].actor_id, actor);
      assert.equal(draftOriginal[0].template_id, null);
      assert.equal(draftOriginal[0].intent_digest, draftIntent);
      assert.equal(draftOriginal[0].occurred_at.toISOString(), draftReceipt.occurredAt);
      assert.deepEqual((await send("POST", draftSave, draftTransport)).body, draftReceipt);
      const selectedDraftTransport = {
        ...draftTransport,
        templateReference: draftFirst.content.templateReference,
      };
      const selectedDraft = await send("GET", undefined, selectedDraftTransport);
      assert.equal(selectedDraft.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplateDraftCurrent(selectedDraft.body).snapshot,
        draftFirst,
      );
      const draftRosterTransport = { receiptTemplateDraftRoster: true };
      const firstRoster = await send("GET", undefined, draftRosterTransport);
      assert.equal(firstRoster.status, 200);
      const firstRosterView = parseDigitalReceiptTemplateDraftRoster(firstRoster.body);
      assert.equal(firstRosterView.actorReference, actor);
      assert.equal(firstRosterView.afterTemplate, null);
      assert.equal(firstRosterView.nextAfter, null);
      assert.deepEqual(firstRosterView.entries, [draftFirst]);
      assert.equal(
        (await send("GET", undefined, { ...draftRosterTransport, expectedStore: id(99) })).status,
        403,
      );
      const draftCounts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_draft_revision) revisions,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_draft_operation) operations,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_version) published`)
        ).rows[0];
      assert.deepEqual(await draftCounts(), { revisions: "1", operations: "1", published: "0" });
      const beforeDraftDenied = await artifactCounts();
      assert.equal(
        (
          await send("POST", draftResolve, {
            ...draftTransport,
            selected: { ...scope, actorReference: managerActor },
          })
        ).status,
        403,
      );
      assert.equal(
        (await send("POST", draftResolve, { ...draftTransport, csrf: "A".repeat(43) })).status,
        403,
      );
      const staleDraftSave = {
        ...draftSave,
        operationReference: id(3101),
        templateReference: draftFirst.content.templateReference,
        expectedVersionReference: draftFirst.content.versionReference,
        expectedRevision: 1,
      };
      let draftSecond;
      await withHttp(managerRuntime, manager, async (second) => {
        const managerScope = { ...scope, actorReference: managerActor };
        const oldCurrent = await second("GET", undefined, selectedDraftTransport);
        assert.equal(oldCurrent.status, 200);
        const current = parseDigitalReceiptTemplateDraftCurrent(oldCurrent.body);
        assert.equal(current.actorReference, managerActor);
        assert.deepEqual(current.snapshot, draftFirst);
        const update = await second(
          "POST",
          {
            ...staleDraftSave,
            operationReference: id(3102),
            fields: { ...draftSave.fields },
          },
          { ...draftTransport, selected: managerScope },
        );
        assert.equal(update.status, 200);
        draftSecond = parseDigitalReceiptTemplateDraftReceipt(update.body).snapshot;
        assert.ok(draftSecond);
        assert.equal(draftSecond.authoredByReference, managerActor);
        assert.equal(draftSecond.revision, 2);
        assert.equal(draftSecond.content.locale, receiptStoreLocale);
        assert.equal(draftFirst.content.locale, receiptStoreLocale);
        assert.equal(draftSecond.content.versionNumber, 1);
        assert.equal(draftSecond.content.versionCode, "RECEIPT_1");
        assert.equal(draftSecond.content.templateReference, draftFirst.content.templateReference);
        assert.equal(draftSecond.familyReference, draftFirst.familyReference);
        assert.equal(draftSecond.createdAt, draftFirst.createdAt);
        assert.equal(draftSecond.previousVersionReference, draftFirst.content.versionReference);
        assert.notEqual(draftSecond.content.versionReference, draftFirst.content.versionReference);
        assert.equal(
          draftSecond.content.layoutDefinitionReference,
          layoutReceipt.snapshot.artifactReference,
        );
        assert.equal(
          draftSecond.content.complianceRuleReference,
          complianceReceipt.snapshot.artifactReference,
        );
      });
      assert.equal((await send("POST", staleDraftSave, draftTransport)).status, 409);
      assert.equal(Number((await artifactCounts()).audits), Number(beforeDraftDenied.audits) + 1);
      assert.deepEqual((await send("POST", draftSave, draftTransport)).body, draftReceipt);
      assert.deepEqual((await send("POST", draftResolve, draftTransport)).body, draftReceipt);
      const refreshedDraft = await send("GET", undefined, selectedDraftTransport);
      assert.equal(refreshedDraft.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplateDraftCurrent(refreshedDraft.body).snapshot,
        draftSecond,
      );
      const successorRoster = await send("GET", undefined, draftRosterTransport);
      assert.equal(successorRoster.status, 200);
      const successorRosterView = parseDigitalReceiptTemplateDraftRoster(successorRoster.body);
      assert.equal(successorRosterView.actorReference, actor);
      assert.deepEqual(successorRosterView.entries, [draftSecond]);
      assert.equal(successorRosterView.entries[0].authoredByReference, managerActor);
      assert.equal(successorRosterView.entries[0].familyReference, draftFirst.familyReference);
      assert.equal(
        successorRosterView.entries[0].content.layoutDefinitionReference,
        layoutReceipt.snapshot.artifactReference,
      );
      await withHttp(managerRuntime, manager, async (second) => {
        const roster = await second("GET", undefined, draftRosterTransport);
        assert.equal(roster.status, 200);
        const view = parseDigitalReceiptTemplateDraftRoster(roster.body);
        assert.equal(view.actorReference, managerActor);
        assert.deepEqual(view.entries, [draftSecond]);
      });
      const afterRoster = await send("GET", undefined, {
        ...draftRosterTransport,
        afterTemplate: draftFirst.content.templateReference,
      });
      assert.equal(afterRoster.status, 200);
      const afterView = parseDigitalReceiptTemplateDraftRoster(afterRoster.body);
      assert.equal(afterView.afterTemplate, draftFirst.content.templateReference);
      assert.deepEqual(afterView.entries, []);
      assert.equal(afterView.nextAfter, null);
      const draftHistory = (
        await admin.query(
          "SELECT snapshot_json FROM rms_device.digital_receipt_template_draft_revision ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        draftHistory.map((row) => row.snapshot_json),
        [draftFirst, draftSecond],
      );
      const lateDraftSave = {
        ...staleDraftSave,
        operationReference: id(3103),
        expectedVersionReference: draftSecond.content.versionReference,
        expectedRevision: 2,
      };
      const absentDraftResolve = {
        command: "ResolveOriginal",
        operationReference: lateDraftSave.operationReference,
        templateReference: lateDraftSave.templateReference,
        expectedVersionReference: lateDraftSave.expectedVersionReference,
        expectedRevision: 2,
        intentDigest: hash(bindMerchantReceiptTemplateDraftCommand(lateDraftSave, scope).command),
      };
      const abandonedDraft = await send("POST", absentDraftResolve, draftTransport);
      assert.equal(abandonedDraft.status, 200);
      const draftAbandoned = parseDigitalReceiptTemplateDraftReceipt(abandonedDraft.body);
      assert.equal(draftAbandoned.outcome, "Abandoned");
      assert.equal(draftAbandoned.snapshot, null);
      const beforeLateDraft = await artifactCounts();
      assert.deepEqual((await send("POST", lateDraftSave, draftTransport)).body, draftAbandoned);
      assert.deepEqual(await artifactCounts(), beforeLateDraft);
      assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "0" });
      const draftAudits = (
        await admin.query(
          "SELECT after_summary_json,before_summary_json FROM platform_audit.audit_record WHERE target_type='DigitalReceiptTemplateDraft'",
        )
      ).rows;
      assert.equal(draftAudits.length, 3);
      for (const audit of draftAudits) {
        assert.deepEqual(Object.keys(audit.after_summary_json), ["intentDigest"]);
        assert.match(audit.after_summary_json.intentDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(audit.before_summary_json, {});
      }
      stage = "SubmitReceiptTemplate";
      const submitTransport = { receiptTemplateSubmit: true };
      const submitCounts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::text FROM bop_publishing.publishing_mutation_record) mutations,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_submission) submissions,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_submit_operation) originals`)
        ).rows[0];
      assert.deepEqual(await submitCounts(), { mutations: "0", submissions: "0", originals: "0" });
      const beforeSubmitCounts = await artifactCounts();
      await withHttp(managerRuntime, manager, async (second) => {
        const managerScope = { ...scope, actorReference: managerActor };
        const transport = { ...submitTransport, selected: managerScope };
        const submit = {
          command: "SubmitReview",
          operationReference: id(3200),
          templateReference: draftSecond.content.templateReference,
          expectedVersionReference: draftSecond.content.versionReference,
          expectedRevision: draftSecond.revision,
        };
        const intentDigest = hash(
          bindMerchantReceiptTemplateSubmitCommand(submit, managerScope).command,
        );
        const resolve = { ...submit, command: "ResolveOriginal", intentDigest };
        const reviewTransport = {
          receiptTemplateReview: true,
          templateReference: draftSecond.content.templateReference,
          selected: managerScope,
        };
        assert.equal(
          (
            await second("GET", undefined, {
              ...reviewTransport,
              selected: { ...managerScope, actorReference: actor },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await second("GET", undefined, {
              ...reviewTransport,
              selected: { ...managerScope, brandReference: id(99) },
            })
          ).status,
          403,
        );
        assert.equal(
          (await second("GET", undefined, { ...reviewTransport, templateReference: id(3210) }))
            .status,
          409,
        );
        const notSubmitted = await second("GET", undefined, reviewTransport);
        assert.equal(notSubmitted.status, 200);
        const initialReview = parseDigitalReceiptTemplateReviewCurrent(notSubmitted.body);
        assert.equal(initialReview.submission, null);
        assert.equal(initialReview.lifecycle, null);
        assert.equal(
          initialReview.currentDraft.versionReference,
          draftSecond.content.versionReference,
        );
        stage = "SubmitReceiptTemplateDenied";
        assert.equal(
          (await second("POST", submit, { ...transport, csrf: "A".repeat(43) })).status,
          403,
        );
        assert.equal(
          (
            await second("POST", submit, {
              ...transport,
              selected: { ...managerScope, storeReference: id(99) },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await second("POST", submit, {
              ...transport,
              selected: { ...managerScope, actorReference: actor },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await second(
              "POST",
              {
                ...submit,
                operationReference: id(3201),
                expectedVersionReference: draftFirst.content.versionReference,
                expectedRevision: 1,
              },
              transport,
            )
          ).status,
          409,
        );
        assert.deepEqual(await submitCounts(), {
          mutations: "0",
          submissions: "0",
          originals: "0",
        });
        assert.deepEqual(await artifactCounts(), beforeSubmitCounts);
        stage = "ConcurrentReceiptTemplateSubmitLostReply";
        const [lostReply, duplicateSubmit] = await Promise.all([
          second("POST", submit, { ...transport, dropReply: true }),
          second("POST", submit, transport),
        ]);
        assert.deepEqual(lostReply, { replyLost: true });
        assert.equal(duplicateSubmit.status, 200);
        stage = "ResolveReceiptTemplateCommitted";
        const recovery = await second("POST", resolve, transport);
        assert.equal(recovery.status, 200);
        const receipt = parseDigitalReceiptTemplateSubmitReceipt(recovery.body);
        assert.deepEqual(duplicateSubmit.body, receipt);
        assert.equal(receipt.outcome, "Committed");
        assert.equal(receipt.actorReference, managerActor);
        assert.equal(receipt.intentDigest, intentDigest);
        const submission = parseDigitalReceiptTemplateSubmission(receipt.submission);
        assert.equal(submission.authoredByReference, managerActor);
        assert.equal(submission.submittedByReference, managerActor);
        assert.equal(submission.versionReference, draftSecond.content.versionReference);
        assert.equal(submission.draftRevision, 2);
        assert.equal(submission.familyReference, draftSecond.familyReference);
        assert.equal(submission.contentDigest, draftSecond.contentDigest);
        // Explicit configured development business period, never the five-second authority lease.
        const remainingBusinessPeriod =
          Date.parse(submission.validationValidUntil) - Date.parse(submission.checkedAt);
        assert.ok(
          remainingBusinessPeriod <= 72 * 60 * 60 * 1000 &&
            remainingBusinessPeriod >= 72 * 60 * 60 * 1000 - 5000,
        );
        assert.equal(receipt.auditReference, submission.auditReference);
        assert.equal(receipt.occurredAt, submission.submittedAt);
        const mutationRows = (
          await admin.query(
            "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record ORDER BY lifecycle_version",
          )
        ).rows;
        assert.equal(mutationRows.length, 2);
        const mutations = mutationRows.map((row) => {
          const m = parseRecordedPublishingMutation(row.mutation_json);
          assert.equal(row.intent_hash, publishingRecordedMutationDigest(m));
          return m;
        });
        const create = mutations[0],
          review = mutations[1];
        assert.equal(create.operation, "CreateDraft");
        assert.notEqual(create.idempotencyKey, submit.operationReference);
        assert.equal(review.operation, "SubmitReview");
        assert.equal(review.idempotencyKey, submit.operationReference);
        assert.deepEqual(review.current, create.next);
        assert.equal(review.next.lifecycleId, submission.reviewLifecycleReference);
        assert.equal(review.next.state, "InReview");
        assert.equal(review.next.version, submission.reviewVersion);
        assert.equal(review.audit.auditId, submission.auditReference);
        assert.deepEqual(review.audit.actor, { type: "User", reference: managerActor });
        assert.ok(review.validationEvidence);
        assert.equal(
          review.validationEvidence.evidenceReference,
          submission.validationEvidenceReference,
        );
        assert.equal(review.validationEvidence.checkedAt, submission.checkedAt);
        assert.equal(review.validationEvidence.validUntil, submission.validationValidUntil);
        assert.deepEqual(review.validationEvidence.checkCodes, [
          "DATA_CONTRACT",
          "DIGITAL_RENDERER",
        ]);
        const storedSubmission = (
          await admin.query(
            "SELECT record_json FROM rms_device.digital_receipt_template_submission",
          )
        ).rows;
        assert.deepEqual(
          storedSubmission.map((row) => row.record_json),
          [submission],
        );
        assert.deepEqual(await submitCounts(), {
          mutations: "2",
          submissions: "1",
          originals: "1",
        });
        const beforeReplay = await artifactCounts();
        assert.equal(Number(beforeReplay.audits), Number(beforeSubmitCounts.audits) + 2);
        assert.deepEqual((await second("POST", submit, transport)).body, receipt);
        assert.deepEqual((await second("POST", resolve, transport)).body, receipt);
        assert.deepEqual(await artifactCounts(), beforeReplay);
        const current = await second("GET", undefined, selectedDraftTransport);
        assert.equal(current.status, 200);
        assert.deepEqual(
          parseDigitalReceiptTemplateDraftCurrent(current.body).snapshot,
          draftSecond,
        );
        assert.deepEqual(
          (
            await admin.query(
              "SELECT snapshot_json FROM rms_device.digital_receipt_template_draft_revision ORDER BY revision",
            )
          ).rows.map((row) => row.snapshot_json),
          [draftFirst, draftSecond],
        );
        const reviewCurrent = await second("GET", undefined, reviewTransport);
        assert.equal(reviewCurrent.status, 200);
        const actualReview = parseDigitalReceiptTemplateReviewCurrent(reviewCurrent.body);
        assert.deepEqual(actualReview.submission, submission);
        assert.equal(actualReview.lifecycle.state, "InReview");
        assert.equal(
          actualReview.lifecycle.lifecycleReference,
          submission.reviewLifecycleReference,
        );
        assert.equal(
          actualReview.lifecycle.latestMutationOperationReference,
          submission.operationReference,
        );
        assert.equal(
          actualReview.currentDraft.versionReference,
          draftSecond.content.versionReference,
        );
        assert.deepEqual(await artifactCounts(), beforeReplay);
        stage = "SubmittedReceiptTemplateEditingFrozen";
        const beforeFrozenSave = await artifactCounts();
        const frozenSave = await second(
          "POST",
          {
            ...staleDraftSave,
            operationReference: id(3105),
            expectedVersionReference: draftSecond.content.versionReference,
            expectedRevision: draftSecond.revision,
            fields: { ...draftSave.fields, locale: "fr-CA" },
          },
          { ...draftTransport, selected: managerScope },
        );
        assert.equal(frozenSave.status, 409);
        assert.deepEqual(await artifactCounts(), beforeFrozenSave);
        assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "0" });
        stage = "ResolveReceiptTemplateAbsent";
        const lateSubmit = { ...submit, operationReference: id(3202) },
          absent = {
            ...lateSubmit,
            command: "ResolveOriginal",
            intentDigest: hash(
              bindMerchantReceiptTemplateSubmitCommand(lateSubmit, managerScope).command,
            ),
          };
        const terminal = await second("POST", absent, transport);
        assert.equal(terminal.status, 200);
        const abandoned = parseDigitalReceiptTemplateSubmitReceipt(terminal.body);
        assert.equal(abandoned.outcome, "Abandoned");
        assert.equal(abandoned.submission, null);
        const beforeLate = await artifactCounts();
        assert.equal(Number(beforeLate.audits), Number(beforeReplay.audits) + 1);
        assert.deepEqual((await second("POST", lateSubmit, transport)).body, abandoned);
        assert.deepEqual((await second("POST", absent, transport)).body, abandoned);
        assert.deepEqual(await artifactCounts(), beforeLate);
        assert.deepEqual(await submitCounts(), {
          mutations: "2",
          submissions: "1",
          originals: "2",
        });
        stage = "RevokeReceiptTemplateSubmit";
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [id(4203)],
        );
        assert.equal((await second("POST", resolve, transport)).status, 403);
        assert.equal((await second("POST", submit, transport)).status, 403);
        const readAfterSubmitRevoked = await second("GET", undefined, reviewTransport);
        assert.equal(readAfterSubmitRevoked.status, 200);
        assert.deepEqual(
          parseDigitalReceiptTemplateReviewCurrent(readAfterSubmitRevoked.body).submission,
          submission,
        );
        const readable = await second("GET", undefined, selectedDraftTransport);
        assert.equal(readable.status, 200);
        assert.deepEqual(
          parseDigitalReceiptTemplateDraftCurrent(readable.body).snapshot,
          draftSecond,
        );
        assert.deepEqual(await artifactCounts(), beforeLate);
        assert.deepEqual(await submitCounts(), {
          mutations: "2",
          submissions: "1",
          originals: "2",
        });
      });
      stage = "RevokeArtifactWriteOnly";
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(4001)],
      );
      const beforeRevokedArtifact = await artifactCounts();
      const readableArtifacts = await send("GET", undefined, artifactTransport);
      assert.equal(readableArtifacts.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplateArtifactCurrent(readableArtifacts.body).layout,
        layoutSuccessor,
      );
      assert.equal((await send("POST", layoutSave, artifactTransport)).status, 403);
      assert.equal(
        (
          await send(
            "POST",
            {
              ...layoutSave,
              operationReference: id(3005),
              expectedArtifactReference: layoutSuccessor.artifactReference,
              expectedRevision: 2,
            },
            artifactTransport,
          )
        ).status,
        403,
      );
      assert.equal((await send("POST", layoutResolve, artifactTransport)).status, 403);
      assert.equal(
        (await send("POST", complianceSave, { artifactKind: "Compliance" })).status,
        403,
      );
      assert.deepEqual(await artifactCounts(), beforeRevokedArtifact);
      assert.deepEqual(await receiptArtifactCounts(), { versions: "3", operations: "4" });
      const readableDraft = await send("GET", undefined, selectedDraftTransport);
      assert.equal(readableDraft.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplateDraftCurrent(readableDraft.body).snapshot,
        draftSecond,
      );
      const readableRoster = await send("GET", undefined, draftRosterTransport);
      assert.equal(readableRoster.status, 200);
      assert.deepEqual(parseDigitalReceiptTemplateDraftRoster(readableRoster.body).entries, [
        draftSecond,
      ]);
      assert.equal((await send("POST", draftSave, draftTransport)).status, 403);
      assert.equal((await send("POST", draftResolve, draftTransport)).status, 403);
      assert.equal(
        (await send("POST", { ...lateDraftSave, operationReference: id(3104) }, draftTransport))
          .status,
        403,
      );
      assert.deepEqual(await artifactCounts(), beforeRevokedArtifact);
      assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "0" });
      const overallCounts = await artifactCounts();
      assert.deepEqual(overallCounts, {
        revisions: "4",
        operations: "5",
        audits: "22",
        events: "0",
        referenceVersions: "3",
        referenceOperations: "4",
      });
      assert.deepEqual(await paymentCounts(), { versions: "2", operations: "3" });
      stage = "RevokeOrganizationManage";
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(31)],
      );
      assert.equal((await send("GET")).status, 403);
      assert.equal((await send("POST", first)).status, 403);
      assert.equal(
        (
          await send("POST", {
            command: "ResolveOriginal",
            operationReference: first.operationReference,
            expectedSetupReference: null,
            expectedRevision: 0,
            intentDigest,
          })
        ).status,
        403,
      );
      assert.equal((await send("GET", undefined, { referenceKind: "Address" })).status, 403);
      assert.equal((await send("POST", addressSave, { referenceKind: "Address" })).status, 403);
      assert.equal((await send("POST", addressResolve, { referenceKind: "Address" })).status, 403);
      assert.equal((await send("GET", undefined, draftRosterTransport)).status, 403);
      assert.equal((await send("GET", undefined, selectedDraftTransport)).status, 403);
      assert.equal((await send("POST", draftResolve, draftTransport)).status, 403);
      assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "0" });
      assert.equal((await send("GET", undefined, artifactTransport)).status, 403);
      assert.equal((await send("POST", layoutResolve, artifactTransport)).status, 403);
      assert.deepEqual(await receiptArtifactCounts(), { versions: "3", operations: "4" });
      assert.equal((await send("GET", undefined, paymentTransport)).status, 403);
      assert.equal((await send("POST", paymentSave, paymentTransport)).status, 403);
      assert.equal((await send("POST", paymentResolve, paymentTransport)).status, 403);
      assert.deepEqual(await artifactCounts(), overallCounts);
      assert.deepEqual(await paymentCounts(), { versions: "2", operations: "3" });
      assert.deepEqual(await submitCounts(), { mutations: "2", submissions: "1", originals: "2" });
      // The previous denial and exact 22-Audit assertions remain unchanged above.
      // Restore only those deliberately withdrawn fixture grants for this separate
      // actual independent approval/publication continuation.
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=ANY($1::uuid[])",
        [[id(31), id(4001)]],
      );
      stage = "ReceiptLifecycleOriginalSetup";
      const historicalSubmissionRows = (
        await admin.query("SELECT record_json FROM rms_device.digital_receipt_template_submission")
      ).rows;
      assert.equal(historicalSubmissionRows.length, 1);
      const lifecycleSubmission = parseDigitalReceiptTemplateSubmission(
        historicalSubmissionRows[0].record_json,
      );
      const lifecycleTransport = { receiptTemplateLifecycle: true, selected: scope };
      const currentReviewTransport = {
        receiptTemplateReview: true,
        templateReference: lifecycleSubmission.templateReference,
        selected: scope,
      };
      const approve = {
        command: "Approve",
        operationReference: id(3300),
        templateReference: lifecycleSubmission.templateReference,
        expectedVersionReference: lifecycleSubmission.versionReference,
        expectedRevision: lifecycleSubmission.draftRevision,
        reviewLifecycleReference: lifecycleSubmission.reviewLifecycleReference,
        expectedReviewVersion: lifecycleSubmission.reviewVersion,
        expectedReviewOperationReference: lifecycleSubmission.operationReference,
      };
      const originalResolve = (body, actualScope) => ({
        ...body,
        command: "ResolveOriginal",
        action: body.command,
        intentDigest: hash(bindMerchantReceiptTemplateLifecycleCommand(body, actualScope).command),
      });
      const lifecycleCounts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::text FROM bop_publishing.publishing_mutation_record) mutations,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_lifecycle_operation) originals,
        (SELECT count(*)::text FROM rms_device.digital_receipt_template_version) versions,
        (SELECT count(*)::text FROM platform_audit.audit_record) audits,
        (SELECT count(*)::text FROM platform_eventing.outbox_event) events`)
        ).rows[0];
      const beforeLifecycle = await lifecycleCounts();
      assert.deepEqual(beforeLifecycle, {
        mutations: "2",
        originals: "0",
        versions: "0",
        audits: "22",
        events: "0",
      });
      stage = "ReceiptLifecycleSelfApprovalDenied";
      await withHttp(managerRuntime, manager, async (managerSend) => {
        const managerScope = { ...scope, actorReference: managerActor };
        assert.equal(
          (
            await managerSend(
              "POST",
              { ...approve, operationReference: id(3301) },
              { receiptTemplateLifecycle: true, selected: managerScope },
            )
          ).status,
          409,
        );
      });
      assert.deepEqual(await lifecycleCounts(), beforeLifecycle);
      stage = "ReceiptLifecycleStaleReviewDenied";
      assert.equal(
        (
          await send(
            "POST",
            {
              ...approve,
              operationReference: id(3302),
              expectedReviewVersion: lifecycleSubmission.reviewVersion + 1,
            },
            lifecycleTransport,
          )
        ).status,
        409,
      );
      assert.deepEqual(await lifecycleCounts(), beforeLifecycle);
      stage = "ReceiptLifecycleApproveLostReply";
      assert.deepEqual(await send("POST", approve, { ...lifecycleTransport, dropReply: true }), {
        replyLost: true,
      });
      const approveResolve = originalResolve(approve, scope);
      const approveRecovery = await send("POST", approveResolve, lifecycleTransport);
      assert.equal(approveRecovery.status, 200);
      const approved = parseDigitalReceiptTemplateLifecycleReceipt(approveRecovery.body);
      assert.equal(approved.outcome, "Committed");
      assert.equal(approved.action, "Approve");
      assert.equal(approved.result.approvedByReference, actor);
      assert.notEqual(approved.result.approvedByReference, lifecycleSubmission.authoredByReference);
      assert.notEqual(
        approved.result.approvedByReference,
        lifecycleSubmission.submittedByReference,
      );
      assert.equal(approved.result.lifecycleVersion, lifecycleSubmission.reviewVersion + 1);
      assert.equal(approved.result.publishedVersion, null);
      assert.ok(
        Date.parse(approved.result.approvalValidUntil) <=
          Date.parse(lifecycleSubmission.validationValidUntil),
      );
      assert.ok(
        Date.parse(approved.result.approvalValidUntil) - Date.parse(approved.result.approvedAt) <=
          24 * 60 * 60 * 1000,
      );
      assert.equal(
        approved.result.approvalValidUntil,
        new Date(
          Math.min(
            Date.parse(approved.result.approvedAt) + 24 * 60 * 60 * 1000,
            Date.parse(lifecycleSubmission.validationValidUntil),
          ),
        ).toISOString(),
      );
      const afterApprove = await lifecycleCounts();
      assert.deepEqual(afterApprove, {
        mutations: "3",
        originals: "1",
        versions: "0",
        audits: "23",
        events: "0",
      });
      const approvedCurrent = await send("GET", undefined, currentReviewTransport);
      assert.equal(approvedCurrent.status, 200);
      const observedApproved = parseDigitalReceiptTemplateReviewCurrent(approvedCurrent.body);
      assert.equal(observedApproved.lifecycle.state, "Approved");
      assert.equal(
        observedApproved.lifecycle.latestMutationOperationReference,
        approved.operationReference,
      );
      assert.equal(observedApproved.sourceQualification, "NotEvaluated");
      stage = "ReceiptLifecycleConcurrentApproveOriginals";
      const concurrentApproval = await Promise.all([
        send("POST", approve, lifecycleTransport),
        send("POST", approveResolve, lifecycleTransport),
      ]);
      for (const answer of concurrentApproval) {
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body, approved);
      }
      assert.deepEqual(await lifecycleCounts(), afterApprove);
      stage = "ReceiptLifecyclePublishLostReply";
      const publish = {
        ...approve,
        command: "Publish",
        operationReference: id(3303),
        expectedReviewVersion: approved.result.lifecycleVersion,
        expectedReviewOperationReference: approved.operationReference,
      };
      assert.deepEqual(await send("POST", publish, { ...lifecycleTransport, dropReply: true }), {
        replyLost: true,
      });
      const publishResolve = originalResolve(publish, scope),
        publishedRecovery = await send("POST", publishResolve, lifecycleTransport);
      assert.equal(publishedRecovery.status, 200);
      const published = parseDigitalReceiptTemplateLifecycleReceipt(publishedRecovery.body);
      assert.equal(published.outcome, "Committed");
      assert.equal(published.result.state, "Published");
      assert.equal(published.result.approvedByReference, actor); // Same approver may publish.
      assert.equal(
        published.result.approvalEvidenceReference,
        approved.result.approvalEvidenceReference,
      );
      assert.equal(published.result.approvalValidUntil, approved.result.approvalValidUntil);
      assert.equal(published.result.lifecycleVersion, approved.result.lifecycleVersion + 1);
      const publishedVersion = parseDigitalReceiptTemplateVersion(
        published.result.publishedVersion,
      );
      assert.equal(publishedVersion.templateReference, lifecycleSubmission.templateReference);
      assert.equal(publishedVersion.versionReference, lifecycleSubmission.versionReference);
      assert.equal(publishedVersion.publishedAt, published.occurredAt);
      const actualPublishedRows = (
        await admin.query(
          "SELECT version_json,operation_id,publication_digest,audit_id FROM rms_device.digital_receipt_template_version",
        )
      ).rows;
      assert.equal(actualPublishedRows.length, 1);
      assert.deepEqual(actualPublishedRows[0].version_json, publishedVersion);
      assert.equal(actualPublishedRows[0].operation_id, published.operationReference);
      assert.equal(actualPublishedRows[0].publication_digest, lifecycleSubmission.contentDigest);
      assert.notEqual(actualPublishedRows[0].audit_id, published.auditReference); // Real Device audit is distinct from Core audit.
      const afterPublish = await lifecycleCounts();
      assert.deepEqual(afterPublish, {
        mutations: "4",
        originals: "2",
        versions: "1",
        audits: "25",
        events: "0",
      });
      const observedPublishedResponse = await send("GET", undefined, currentReviewTransport);
      assert.equal(observedPublishedResponse.status, 200);
      const observedPublished = parseDigitalReceiptTemplateReviewCurrent(
        observedPublishedResponse.body,
      );
      assert.equal(observedPublished.lifecycle.state, "Published");
      assert.equal(
        observedPublished.lifecycle.latestMutationOperationReference,
        published.operationReference,
      );
      assert.equal(
        observedPublished.currentDraft.versionReference,
        lifecycleSubmission.versionReference,
      );
      assert.equal(observedPublished.sourceQualification, "NotEvaluated");
      stage = "ReceiptLifecycleConcurrentPublishOriginals";
      const concurrentPublish = await Promise.all([
        send("POST", publish, lifecycleTransport),
        send("POST", publishResolve, lifecycleTransport),
      ]);
      for (const answer of concurrentPublish) {
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body, published);
      }
      assert.deepEqual(await lifecycleCounts(), afterPublish);
      stage = "ReceiptLifecycleFineWithdrawal";
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(4601)],
      );
      assert.equal((await send("POST", publish, lifecycleTransport)).status, 403);
      assert.equal((await send("POST", publishResolve, lifecycleTransport)).status, 403);
      assert.equal((await send("GET", undefined, currentReviewTransport)).status, 200);
      assert.equal((await send("GET", undefined, selectedDraftTransport)).status, 200);
      assert.deepEqual(await lifecycleCounts(), afterPublish);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(4601)],
      );
      const restoredOriginal = await send("POST", publishResolve, lifecycleTransport);
      assert.equal(restoredOriginal.status, 200);
      assert.deepEqual(restoredOriginal.body, published);
      assert.deepEqual(await lifecycleCounts(), afterPublish);
      stage = "ReceiptLifecycleAbandonedLateWriter";
      const lateApprove = { ...approve, operationReference: id(3304) },
        abandonResolve = originalResolve(lateApprove, scope);
      const abandonResponse = await send("POST", abandonResolve, lifecycleTransport);
      assert.equal(abandonResponse.status, 200);
      const abandonedLifecycle = parseDigitalReceiptTemplateLifecycleReceipt(abandonResponse.body);
      assert.equal(abandonedLifecycle.outcome, "Abandoned");
      assert.equal(abandonedLifecycle.result, null);
      const afterAbandon = await lifecycleCounts();
      assert.deepEqual(afterAbandon, {
        mutations: "4",
        originals: "3",
        versions: "1",
        audits: "26",
        events: "0",
      });
      assert.deepEqual(
        (await send("POST", lateApprove, lifecycleTransport)).body,
        abandonedLifecycle,
      );
      assert.deepEqual(
        (await send("POST", abandonResolve, lifecycleTransport)).body,
        abandonedLifecycle,
      );
      assert.deepEqual(await lifecycleCounts(), afterAbandon);
      const coreRows = (
        await admin.query(
          "SELECT mutation_json,intent_hash FROM bop_publishing.publishing_mutation_record ORDER BY lifecycle_version",
        )
      ).rows;
      assert.equal(coreRows.length, 4);
      const core = coreRows.map((r) => {
        const m = parseRecordedPublishingMutation(r.mutation_json);
        assert.equal(r.intent_hash, publishingRecordedMutationDigest(m));
        return m;
      });
      assert.deepEqual(
        core.map((m) => m.operation),
        ["CreateDraft", "SubmitReview", "Approve", "Publish"],
      );
      assert.equal(core[2].audit.actor.reference, actor);
      assert.equal(core[3].audit.actor.reference, actor);
      assert.deepEqual(core[2].current, core[1].next);
      assert.deepEqual(core[3].current, core[2].next);
      assert.equal(core[3].release.snapshotDigest, lifecycleSubmission.contentDigest);
      assert.equal(core[3].release.releaseId, publishedVersion.publicationReference);
      assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "1" });
      stage = "ReceiptPublishedCurrent";
      const bindingWorkspace = await send("GET");
      assert.equal(bindingWorkspace.status, 200);
      assert.deepEqual(bindingWorkspace.body.scope, scope);
      const savedSetup = bindingWorkspace.body.setup.snapshot;
      assert.ok(savedSetup);
      assert.equal(bindingWorkspace.body.store.locale, receiptStoreLocale);
      assert.equal(savedSetup.defaultLocale, receiptStoreLocale);
      assert.equal(bindingWorkspace.body.setup.businessReferenceValidation, "NotEvaluated");
      const publishedTransport = {
        receiptTemplatePublished: true,
        templateReference: publishedVersion.templateReference,
        locale: bindingWorkspace.body.store.locale,
      };
      const currentPublishedResponse = await send("GET", undefined, publishedTransport);
      assert.equal(currentPublishedResponse.status, 200);
      const currentPublished = parseDigitalReceiptTemplatePublishedCurrent(
        currentPublishedResponse.body,
      );
      for (const [field, value] of Object.entries(scope))
        assert.equal(currentPublished[field], value);
      assert.equal(currentPublished.templateReference, draftSecond.content.templateReference);
      assert.equal(currentPublished.locale, savedSetup.defaultLocale);
      assert.deepEqual(currentPublished.currentVersion, publishedVersion);
      assert.equal(currentPublished.professionalReviewStatus, "NotEvaluated");
      assert.equal(currentPublished.legalConclusion, "NotEvaluated");
      const wrongLocale = await send("GET", undefined, { ...publishedTransport, locale: "en-CA" });
      assert.equal(wrongLocale.status, 400);
      assert.deepEqual(wrongLocale.body, { error: "receipt_template_published_invalid" });
      assert.deepEqual(await lifecycleCounts(), afterAbandon);
      stage = "StoreReceiptTemplateBinding";
      const beforeBindingCounts = await artifactCounts();
      const bindReceipt = {
        command: "SaveDraft",
        operationReference: id(3400),
        expectedSetupReference: savedSetup.setupDraftReference,
        expectedRevision: savedSetup.revision,
        content: {
          ...savedSetup.content,
          receiptReference: { state: "Configured", value: currentPublished.templateReference },
        },
      };
      assert.notEqual(
        currentPublished.templateReference,
        currentPublished.currentVersion.versionReference,
      );
      assert.notEqual(
        currentPublished.templateReference,
        currentPublished.currentVersion.publicationReference,
      );
      const bindReceiptIntent = hash(bindMerchantStoreSetupCommand(bindReceipt, scope).command);
      assert.deepEqual(await send("POST", bindReceipt, { dropReply: true }), { replyLost: true });
      const bindingResolve = {
        command: "ResolveOriginal",
        operationReference: bindReceipt.operationReference,
        expectedSetupReference: bindReceipt.expectedSetupReference,
        expectedRevision: bindReceipt.expectedRevision,
        intentDigest: bindReceiptIntent,
      };
      const bindingResolved = await send("POST", bindingResolve);
      assert.equal(bindingResolved.status, 200);
      const bindingReceipt = parseStoreSetupOperationReceipt(bindingResolved.body);
      assert.equal(bindingReceipt.outcome, "Committed");
      assert.ok(bindingReceipt.snapshot);
      assert.equal(bindingReceipt.intentDigest, bindReceiptIntent);
      assert.equal(bindingReceipt.snapshot.setupDraftReference, savedSetup.setupDraftReference);
      assert.equal(bindingReceipt.snapshot.revision, savedSetup.revision + 1);
      assert.deepEqual(bindingReceipt.snapshot.content, bindReceipt.content);
      assert.equal(bindingReceipt.snapshot.defaultLocale, savedSetup.defaultLocale);
      const afterBindingCounts = await artifactCounts();
      assert.deepEqual(afterBindingCounts, {
        ...beforeBindingCounts,
        revisions: String(Number(beforeBindingCounts.revisions) + 1),
        operations: String(Number(beforeBindingCounts.operations) + 1),
        audits: String(Number(beforeBindingCounts.audits) + 1),
      });
      const reloadedBinding = await send("GET");
      assert.equal(reloadedBinding.status, 200);
      assert.deepEqual(reloadedBinding.body.setup.snapshot, bindingReceipt.snapshot);
      assert.equal(reloadedBinding.body.setup.businessReferenceValidation, "NotEvaluated");
      for (const body of [bindReceipt, bindingResolve]) {
        const originalBinding = await send("POST", body);
        assert.equal(originalBinding.status, 200);
        assert.deepEqual(originalBinding.body, bindingReceipt);
        assert.deepEqual(await artifactCounts(), afterBindingCounts);
      }
      const publishedAfterBinding = await send("GET", undefined, publishedTransport);
      assert.equal(publishedAfterBinding.status, 200);
      assert.deepEqual(
        parseDigitalReceiptTemplatePublishedCurrent(publishedAfterBinding.body).currentVersion,
        publishedVersion,
      );
      assert.deepEqual(await artifactCounts(), afterBindingCounts);
      assert.deepEqual(await draftCounts(), { revisions: "2", operations: "3", published: "1" });
      assert.deepEqual(await lifecycleCounts(), { ...afterAbandon, audits: "27" });

      // Fee policy is preparation only. Genuine Catalog registry/IAM and Store
      // owners below do not claim effective fees or accountant qualification.
      stage = "FeeContextClassificationAdmission";
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_eventing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_tax_classification_registry_record,platform_eventing.outbox_event TO " +
          role,
      );
      const feeCounts = async () => ({
        ...(await artifactCounts()),
        registryRecords: (
          await admin.query(
            "SELECT count(*)::text n FROM rms_catalog.product_tax_classification_registry_record",
          )
        ).rows[0].n,
      });
      const choicesTransport = { feeContextClassifications: true };
      const beforeMissingPermission = await feeCounts();
      assert.equal((await send("GET", undefined, choicesTransport)).status, 403);
      assert.deepEqual(await feeCounts(), beforeMissingPermission);
      const feeRole = id(7000),
        feeMembership = (
          await admin.query(
            "SELECT membership_id FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2",
            [actor, brand],
          )
        ).rows[0].membership_id;
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'internal_test_store_fee_registry','Active',$3,$4,1,$3,$3)",
        [feeRole, brand, from, until],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [id(7001), feeRole, feeMembership, actor, brand, from, until],
      );
      const feeGrantIds = new Map();
      for (const [index, action] of [
        "catalog.manage",
        "catalog.tax-classification.read",
        "catalog.tax-classification.manage",
      ].entries()) {
        let permission = (
          await admin.query(
            "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
            [action],
          )
        ).rows[0]?.permission_id;
        if (!permission) {
          permission = id(7010 + index);
          await admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
            [permission, action, from],
          );
        }
        const grant = id(7020 + index);
        feeGrantIds.set(action, grant);
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
          [grant, feeRole, permission, brand, from, until],
        );
      }
      const freshPersistence = { ...session.persistence, transactions, now };
      const registerRegistry = async (registry, expectedRegistryVersion) => {
        const source = createPostgresProductTaxClassificationRegistryStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          clock: { now },
          transactions,
          registerBeforeCommit: async (tx, guard, final) => {
            assert(ownerHooks.has(tx));
            ownerHooks.get(tx).push({ guard, final });
          },
          authority: {
            async holdUntilTransactionCompletes(tx, packet) {
              assert.equal(packet.purposeCode, "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY");
              assert.equal(packet.permission, "catalog.manage");
              assert.equal(packet.action, "catalog.tax-classification.manage");
              assert.deepEqual(packet.requiredFields, taxClassificationRegistryFields);
              const current = await createMerchantStoreScope(freshPersistence)(
                tx,
                session.sessionCookie,
                "merchant.access",
              );
              assert(await current.allowed());
              const currentBrand = await createMerchantBrandScope(freshPersistence)(
                tx,
                session.sessionCookie,
                current.sessionReference,
              );
              for (const action of [packet.permission, packet.action]) {
                const decision = await currentBrand.authorizeAction(action);
                assert.equal(decision?.effect, "Allow");
                assert.equal(decision?.scopeKind, "Brand");
              }
            },
          },
          audit: {
            create(command) {
              return {
                auditId: id(++reference),
                brandId: brand,
                actor: { type: "User", reference: actor },
                actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
                targetType: "CatalogTaxClassificationRegistry",
                targetId: registry.registryReference,
                reasonCode: command.reasonCode,
                correlationId: command.operationReference,
                occurredAt: command.occurredAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        return source.execute({
          purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          operationReference: id(++reference),
          expectedRegistryVersion,
          occurredAt: registry.registeredAt,
          reasonCode: "INTERNAL_TEST_FEE_CLASSIFICATION",
          registry,
        });
      };
      const registry = {
        profile: "CatalogProductTaxClassificationRegistryV1",
        tenantReference: tenant,
        brandReference: brand,
        registryReference: id(7030),
        versionReference: id(7031),
        registryVersion: 1,
        defaultLocale: "fr-CA",
        previousSnapshotDigest: null,
        registeredAt: now(),
        defaultClassificationReference: id(7032),
        definitions: [
          {
            classificationReference: id(7032),
            code: "INTERNAL_TEST_FEE",
            localizedNames: { "fr-CA": "InternalTest fee" },
            lifecycle: "Active",
          },
        ],
      };
      stage = "FeeContextRegistryProducer";
      const registered = await registerRegistry(registry, 0);
      const choices = await send("GET", undefined, choicesTransport);
      assert.equal(choices.status, 200);
      assert.deepEqual(choices.body.choices, registry.definitions);
      assert.equal(choices.body.sourceQualification, "NotEvaluated");
      for (const [key, value] of Object.entries(scope)) assert.equal(choices.body[key], value);
      const foreignChoiceResponse = await send("GET", undefined, {
        ...choicesTransport,
        selected: { ...scope, actorReference: id(999) },
      });
      assert.equal(foreignChoiceResponse.status, 503);
      assert.equal(foreignChoiceResponse.body.error, "store_setup_unavailable");
      assert.equal(Object.hasOwn(foreignChoiceResponse.body, "choices"), false);
      const fees = {
        state: "Configured",
        value: [
          {
            chargeType: "ServiceCharge",
            state: "Enabled",
            taxClassificationReference: id(7032),
            orderTypes: ["DineIn", "Pickup"],
          },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Unconfigured" },
        ],
      };
      const feeSave = {
        command: "SaveDraft",
        operationReference: id(7040),
        expectedSetupReference: bindingReceipt.snapshot.setupDraftReference,
        expectedRevision: bindingReceipt.snapshot.revision,
        content: { ...bindingReceipt.snapshot.content, feeContexts: fees },
      };
      const feeIntent = hash(bindMerchantStoreSetupCommand(feeSave, scope).command);
      stage = "FeeContextV2SaveLostReply";
      const beforeFees = await feeCounts();
      assert.deepEqual(await send("POST", feeSave, { dropReply: true }), { replyLost: true });
      const feeResolve = {
        command: "ResolveOriginal",
        operationReference: feeSave.operationReference,
        expectedSetupReference: feeSave.expectedSetupReference,
        expectedRevision: feeSave.expectedRevision,
        intentDigest: feeIntent,
      };
      const originalResponse = await send("POST", feeResolve);
      assert.equal(originalResponse.status, 200);
      const originalFee = parseStoreSetupOperationReceipt(originalResponse.body);
      assert.equal(originalFee.snapshot.profile, "StoreSetupDraftV2");
      assert.deepEqual(originalFee.snapshot.content.feeContexts, fees);
      assert.equal(originalFee.intentDigest, feeIntent);
      const afterFees = await feeCounts();
      assert.deepEqual(afterFees, {
        ...beforeFees,
        revisions: String(Number(beforeFees.revisions) + 1),
        operations: String(Number(beforeFees.operations) + 1),
        audits: String(Number(beforeFees.audits) + 1),
      });
      for (const command of [feeSave, feeResolve]) {
        const replay = await send("POST", command);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, originalFee);
        assert.deepEqual(await feeCounts(), afterFees);
      }
      const freshFee = await send("GET");
      assert.equal(freshFee.status, 200);
      assert.deepEqual(freshFee.body.setup.snapshot, originalFee.snapshot);
      stage = "FeeContextCurrentAndImmutablePreparation";
      const heldFee = await transactions.run(async (tx) => {
        const observedAt = now();
        const source = createPostgresStoreSetupDraftStore({
          ...scope,
          transaction: tx,
          clock: { now },
          originalObservedAt: observedAt,
          originalValidUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          registerBeforeCommit(actual, guard, final) {
            assert.equal(actual, tx);
            ownerHooks.get(tx).push({ guard, final });
          },
          references: {
            canonicalize: canonicalizeRfc8785,
            hashIntent: (value) => "sha256:" + sha256Hex(value),
            nextReference: unused,
          },
          appendAudit: unused,
          withCurrentSaveScope: unused,
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              assert.equal(actual, tx);
              assert.equal(packet.mode, "Read");
              assert.equal(packet.permission, "organization.manage");
              const current = await createMerchantStoreScope(freshPersistence)(
                tx,
                session.sessionCookie,
                "organization.manage",
              );
              assert(await current.allowed());
              assert.equal(current.selected.tenantReference, tenant);
              assert.equal(current.context.brand.brandReference, brand);
              assert.equal(current.store.storeReference, store);
              assert.equal(String(current.actorReference), actor);
              const currentUntil = current.authorizationValidUntil();
              assert(currentUntil);
              return {
                validUntil: currentUntil < packet.validUntil ? currentUntil : packet.validUntil,
              };
            },
          },
        });
        const selector = {
          setupDraftReference: originalFee.snapshot.setupDraftReference,
          sourceRevision: originalFee.snapshot.revision,
          sourceSnapshotDigest: hash(originalFee.snapshot),
        };
        return {
          source,
          tx,
          current: await source.readFeeContextPreparation(),
          historical: await source.readFeeContextPreparationVersion(selector),
        };
      });
      heldFee.source.assertFinalized(heldFee.tx);
      assert.deepEqual(heldFee.current.feeContexts, fees);
      assert.equal(heldFee.current.publicationStatus, "NotPublished");
      assert.equal(heldFee.historical.sourceBasis, "RecordedDraftRevision");
      assert.deepEqual(heldFee.historical.preparation.feeContexts, fees);
      assert.deepEqual(await feeCounts(), afterFees);
      stage = "FeeContextLateCatalogFineWithdrawal";
      lateFeePermissionGrant = feeGrantIds.get("catalog.tax-classification.read");
      const lateFee = await send("POST", {
        ...feeSave,
        operationReference: id(7041),
        expectedRevision: originalFee.snapshot.revision,
      });
      assert.equal(lateFee.status, 403);
      assert.equal(lateFeePermissionGrant, null);
      assert.deepEqual(await feeCounts(), afterFees);
      assert.equal(
        (
          await admin.query(
            "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
            [feeGrantIds.get("catalog.tax-classification.read")],
          )
        ).rows[0].lifecycle,
        "Active",
      );
      stage = "FeeContextDurableAbandoned";
      const absentFee = {
        ...feeSave,
        operationReference: id(7042),
        expectedRevision: originalFee.snapshot.revision,
      };
      const absentIntent = hash(bindMerchantStoreSetupCommand(absentFee, scope).command);
      const absentResolve = {
        command: "ResolveOriginal",
        operationReference: absentFee.operationReference,
        expectedSetupReference: absentFee.expectedSetupReference,
        expectedRevision: absentFee.expectedRevision,
        intentDigest: absentIntent,
      };
      const terminal = await send("POST", absentResolve);
      assert.equal(terminal.status, 200);
      assert.equal(terminal.body.outcome, "Abandoned");
      assert.equal(terminal.body.snapshot, null);
      const afterAbandoned = await feeCounts();
      assert.deepEqual(afterAbandoned, {
        ...afterFees,
        operations: String(Number(afterFees.operations) + 1),
        audits: String(Number(afterFees.audits) + 1),
      });
      assert.deepEqual((await send("POST", absentFee)).body, terminal.body);
      assert.deepEqual(await feeCounts(), afterAbandoned);
      stage = "FeeContextInactiveRegistryOriginalRecovery";
      await registerRegistry(
        {
          ...registry,
          versionReference: id(7050),
          registryVersion: 2,
          previousSnapshotDigest: registered.snapshotDigest,
          registeredAt: now(),
          defaultClassificationReference: null,
          definitions: [{ ...registry.definitions[0], lifecycle: "Inactive" }],
        },
        1,
      );
      const afterInactive = await feeCounts();
      assert.equal(
        (
          await send("POST", {
            ...feeSave,
            operationReference: id(7051),
            expectedRevision: originalFee.snapshot.revision,
          })
        ).status,
        400,
      );
      assert.deepEqual(await feeCounts(), afterInactive);
      for (const command of [feeSave, feeResolve, bindReceipt, bindingResolve]) {
        const replay = await send("POST", command);
        assert.equal(replay.status, 200);
        assert.deepEqual(
          replay.body,
          command.operationReference === feeSave.operationReference ? originalFee : bindingReceipt,
        );
        assert.deepEqual(await feeCounts(), afterInactive);
      }
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [feeGrantIds.get("catalog.tax-classification.read")],
      );
      assert.equal((await send("GET", undefined, choicesTransport)).status, 403);
      assert.equal(
        (
          await send("POST", {
            ...feeSave,
            operationReference: id(7052),
            expectedRevision: originalFee.snapshot.revision,
          })
        ).status,
        403,
      );
      assert.deepEqual((await send("POST", feeResolve)).body, originalFee);
      assert.deepEqual(await feeCounts(), afterInactive);
      if (context.ordinaryConfigurationProof === true) {
        stage = "OrdinaryConfigurationControlledQualification";
        await exerciseStoreConfigurationOrdinaryRuntimeHttp({
          admin,
          role,
          transactions,
          ownerHooks,
          session,
          manager,
          scope,
          now,
          id,
          sendSetup: send,
          savedSetup: originalFee.snapshot,
        });
      }
    });
  } catch (error) {
    const sql = sqlFailure ? ":" + sqlFailure.family + ":" + sqlFailure.code : "";
    const kind =
      error instanceof assert.AssertionError
        ? "Assertion"
        : error instanceof TypeError
          ? "TypeError"
          : error instanceof Error
            ? "Error"
            : "Other";
    throw new Error(
      "STORE_SETUP_NATIVE_FAILED:" +
        stage +
        sql +
        ":" +
        kind +
        ":HTTP" +
        httpStatus +
        ":" +
        httpCode,
      { cause: error },
    );
  } finally {
    try {
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
    } finally {
      await admin.end();
    }
  }
}
