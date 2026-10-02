import { exerciseCurrentPinnedOptionProductDraft } from "./product-current-pinned-option-draft-http.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  CatalogError,
  contentRegistryFields,
  productVariantHistoryFields,
  productEditorContentFields,
  parseProductAggregate,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresTenantBrandConfigurationContentSource,
  tenantBrandConfigurationContentDigest,
  tenantBrandConfigurationRequiredFields,
} from "../../bop/tenant/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";
import { remainingProductEditorVariantReferenceChecks } from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";

// Actual current Tenant/Publishing/Variant/registry SQL and native IAM/HTTP.
// Tenant Published metadata and governance approval/validation are synthetic;
// independent fields/purpose/current policy and remaining-five/write holders are synthetic.
export async function exerciseCurrentPolicyProductDraft({
  admin,
  role,
  id,
  editorSession,
  runtimeOptions,
}) {
  assert.match(role, /^wp2421_full_[a-f0-9]+$/);
  const at = new Date().toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString();
  await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
  await admin.query("GRANT SELECT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role);
  await admin.query("GRANT SELECT ON bop_tenant.brand_configuration_version TO " + role);
  await admin.query("GRANT UPDATE(version) ON bop_tenant.brand TO " + role);
  const publicationScope = { kind: "Brand", brandReference: id(2), storeReference: null };
  const runner = {
    async run(work) {
      await admin.query("BEGIN");
      try {
        const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
  const publisher = createPostgresPublishingMutationStore(runner, id(1), publicationScope);
  const previousConfiguration = (
    await admin.query(
      "SELECT configuration_version_id,configuration_version::int version FROM bop_tenant.brand_configuration_version WHERE brand_id=$1 ORDER BY configuration_version DESC LIMIT 1",
      [id(2)],
    )
  ).rows[0];
  const configuration = {
    configurationVersionReference: id(97210),
    brandReference: id(2),
    configurationVersion: (previousConfiguration?.version ?? 0) + 1,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA", "fr-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(97213),
    platformTemplateReference: id(97214),
    overrideAllowedFieldCodes: ["DISPLAY.THEME"],
    hardRequirementFieldCodes: ["SECURITY.REAUTH"],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesVersionReference: previousConfiguration?.configuration_version_id ?? null,
    reasonCode: "SYNTHETIC_CONFIGURATION",
    authoredByReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(97211),
    publicationReference: id(97212),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(97500),
    policyReference: id(97220),
    policyVersion: 1,
    scopeOrder: productPolicyScopeLevels,
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA", "fr-CA"],
    mediaRequirement: "Required",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  async function publish({ base, type, snapshot, digest, family, releaseId, approvalId, body }) {
    const draft = {
      lifecycleId: id(base),
      familyReference: family,
      configurationType: type,
      purposeCode: type,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
    const validation = {
      evidenceReference: id(base + 10),
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      result: "Pass",
      checkedAt: at,
      validUntil: until,
      checkCodes: ["SCHEMA_VALID"],
    };
    const review = {
      ...draft,
      version: 2,
      state: "InReview",
      validationEvidenceReference: validation.evidenceReference,
    };
    const approval = {
      evidenceReference: approvalId,
      reviewLifecycleId: draft.lifecycleId,
      reviewVersion: 2,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      decision: "Accepted",
      approvedActorReference: id(4),
      approvedAt: at,
      validUntil: until,
    };
    const approved = {
      ...review,
      version: 3,
      state: "Approved",
      approvalEvidenceReference: approvalId,
    };
    const published = { ...approved, version: 4, state: "Published" };
    const release = {
      releaseId,
      familyReference: family,
      configurationType: type,
      purposeCode: type,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      sequence: 1,
      sourceLifecycleId: draft.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    };
    const mutation = (operation, current, next, offset, extra = {}) => ({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(base + offset),
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: id(base + offset + 1),
        brandId: id(2),
        actor: {
          type: "User",
          reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(3) : id(4),
        },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: next.lifecycleId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(base + offset),
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
      ...extra,
    });
    await publisher.commit(
      mutation("CreateDraft", null, draft, 1, body ? { productPolicyContent: body } : {}),
    );
    await publisher.commit(
      mutation("SubmitReview", draft, review, 3, { validationEvidence: validation }),
    );
    await publisher.commit(
      mutation("Approve", review, approved, 5, { approvalEvidence: approval }),
    );
    await publisher.commit(
      mutation("Publish", approved, published, 7, {
        validationEvidence: validation,
        approvalEvidence: approval,
        release,
      }),
    );
  }
  await publish({
    base: 97300,
    type: "BRAND_CONFIGURATION",
    snapshot: configuration.configurationVersionReference,
    digest: tenantBrandConfigurationContentDigest(configuration),
    family: id(97320),
    releaseId: configuration.publicationReference,
    approvalId: configuration.approvalEvidenceReference,
  });
  // Immutable synthetic metadata fixture, not an ordinary Tenant authoring writer.
  await admin.query(
    `INSERT INTO bop_tenant.brand_configuration_version(configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    Object.values(configuration),
  );
  await publish({
    base: 97400,
    type: "PRODUCT_PUBLICATION_POLICY",
    snapshot: policy.policyReference,
    digest: publishingProductPublicationPolicyDigest(policy),
    family: policy.familyReference,
    releaseId: id(97222),
    approvalId: id(97221),
    body: policy,
  });

  // Isolated setup assertions use owning public reads and the actual API role.
  // Their field/purpose holders remain synthetic, like the ordinary scenario.
  await editorSession.persistence.transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.tenant_id',$1,true)", [id(1)]);
    const observedAt = new Date().toISOString();
    const brandSource = createPostgresTenantBrandConfigurationContentSource({
      brandReference: id(2),
      clock: () => new Date().toISOString(),
      transactions: { run: (work) => work(tx) },
      authority: {
        withCurrentContentRead: async (_request, fields, work) => {
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          return work();
        },
        isCurrent: async () => true,
      },
    });
    const request = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      purposeCode: "CATALOG_PRODUCT_CONTENT",
      configurationVersionReference: id(97210),
      expectedBrandVersion: 1,
      originalIntentDigest: "sha256:" + "a".repeat(64),
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    };
    await brandSource.withRecordedConfiguration(request, async (source) => {
      assert.equal(source.contentDigest, tenantBrandConfigurationContentDigest(configuration));
    });
    const reads = createPostgresPublishingMutationStore(
      { run: (work) => work(tx) },
      id(1),
      publicationScope,
    );
    await reads.resolveCurrentReleaseForReference({
      publicationReference: configuration.publicationReference,
      configurationType: "BRAND_CONFIGURATION",
      purposeCode: "BRAND_CONFIGURATION",
      observedAt,
    });
    await reads.resolveCurrentProductPublicationPolicy({
      policyReference: policy.policyReference,
      policyVersion: policy.policyVersion,
      observedAt,
    });
  });

  const product = id(600),
    grant = id(96420);
  const recorded = parseProductAggregate(
    (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 AND result_aggregate_version=9",
        [id(2), product],
      )
    ).rows[0].snapshot_json,
  );
  assert.equal(recorded.aggregateVersion, 9);
  const command = {
    productReference: product,
    operationReference: id(97202),
    expectedAggregateVersion: 9,
    draft: {
      ...recorded.draft,
      localizedNames: {
        ...recorded.draft.localizedNames,
        "fr-CA": "Synthetic required translation",
      },
      editorContent: {
        ...recorded.draft.editorContent,
        localizedDescriptions: {
          ...recorded.draft.editorContent.localizedDescriptions,
          "en-CA": "Synthetic native current Brand/policy Draft",
        },
      },
    },
  };
  let clockOverride = null,
    mode = "normal",
    policyAllowed = true,
    tentative = false,
    historyHolds = 0,
    brandReads = 0,
    policyReads = 0,
    brandAllowed = true;
  let originalDeadline;
  const historyRoots = new Set();
  const now = () => clockOverride ?? new Date().toISOString();
  const options = {
    ...runtimeOptions,
    productCreation: undefined,
    persistence: { ...editorSession.persistence, now },
    productDraft: {
      auditReference: () => id(97203),
      writeAuthority: async () => "Allowed",
      categoryPolicy: async () => ({ allowedLifecycles: ["Draft"] }),
      registeredEditorContent: {
        registryAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.deepEqual(input.requiredFields, contentRegistryFields);
          },
        },
        variantHistory: {
          authority: {
            async holdUntilTransactionCompletes(_tx, input) {
              historyHolds++;
              historyRoots.add(input.request.expectedAggregateVersion);
              assert.equal(input.actorReference, id(3));
              assert.deepEqual(input.requiredFields, productVariantHistoryFields);
            },
          },
          contentPolicy: {
            configurationVersionReference: configuration.configurationVersionReference,
            expectedBrandVersion: 1,
            policyReference: policy.policyReference,
            policyVersion: 1,
            brandAuthority: {
              async withCurrentContentRead(input, fields, work) {
                brandReads++;
                assert.equal(input.tenantReference, id(1));
                assert.equal(input.brandReference, id(2));
                assert.equal(input.actorReference, id(3));
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_CONTENT");
                assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
                if (!brandAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
                return work();
              },
              async isCurrent(tx) {
                await observeLate(tx);
                return brandAllowed;
              },
            },
            policyAuthority: {
              async holdUntilTransactionCompletes(tx, input) {
                policyReads++;
                assert.equal(input.tenantReference, id(1));
                assert.equal(input.brandReference, id(2));
                assert.equal(input.actorReference, id(3));
                assert.equal(input.actorKind, "User");
                assert.equal(input.policyReference, policy.policyReference);
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
                assert.deepEqual(input.requiredFields, currentProductPolicyFields);
                await observeLate(tx);
                if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
            remainingAuthority: async (_tx, input) => {
              originalDeadline = input.validUntil;
              assert.equal(input.productReference, product);
              assert.deepEqual(input.requiredFields, productEditorContentFields);
              assert.deepEqual(
                input.requiredReferenceChecks,
                input.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
              );
            },
          },
        },
      },
    },
  };
  async function observeLate(tx) {
    const root = (
      await tx.query(
        "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
        [id(2), product],
      )
    ).rows[0].aggregate_version;
    if (mode !== "normal" && !tentative && root === 10) {
      tentative = true;
      if (mode === "late-grant")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grant],
        );
      if (mode === "late-policy") policyAllowed = false;
      if (mode === "late-brand") brandAllowed = false;
      if (mode === "late-expiry") clockOverride = originalDeadline;
    }
  }
  const tables = (
    await admin.query(
      "SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema=ANY($1::text[]) ORDER BY table_schema,table_name",
      [
        [
          "rms_catalog",
          "bop_tenant",
          "bop_publishing",
          "platform_audit",
          "platform_eventing",
          "bop_permission",
        ],
      ],
    )
  ).rows;
  const state = async () => {
    const body = {};
    for (const { table_schema: schema, table_name: table } of tables) {
      assert.match(schema, /^[a-z_]+$/);
      assert.match(table, /^[a-z_]+$/);
      const rows = (
        await admin.query(
          'SELECT to_jsonb(t) value FROM "' +
            schema +
            '"."' +
            table +
            '" t ORDER BY to_jsonb(t)::text',
        )
      ).rows;
      body[schema + "." + table] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return body;
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [product],
      )
    ).rows[0];
  const native = createMerchantRuntime(options),
    scope = { brandReference: id(2), storeReference: id(20) },
    path = "/merchant/catalog/products/draft";
  const configuredPolicy =
    options.productDraft.registeredEditorContent.variantHistory.contentPolicy;
  const capturedPolicy = { ...configuredPolicy };
  for (const patch of [
    { configurationVersionReference: id(97290) },
    { expectedBrandVersion: 2 },
    { policyReference: id(97291) },
    { policyVersion: 2 },
  ]) {
    const staleRuntime = createMerchantRuntime({
      ...options,
      productDraft: {
        ...options.productDraft,
        registeredEditorContent: {
          ...options.productDraft.registeredEditorContent,
          variantHistory: {
            ...options.productDraft.registeredEditorContent.variantHistory,
            contentPolicy: { ...capturedPolicy, ...patch },
          },
        },
      },
    });
    const before = await state();
    await withProductPublicationHttp(
      undefined,
      editorSession,
      scope,
      async (post) => {
        assert.equal((await post(command, {}, path)).status, 503);
      },
      { productDraft: staleRuntime.productDraft },
    );
    assert.deepEqual(await state(), before);
  }
  // Mutation after runtime construction must not replace captured server selectors/holders.
  configuredPolicy.configurationVersionReference = id(97292);
  configuredPolicy.expectedBrandVersion = 2;
  configuredPolicy.policyVersion = 2;
  configuredPolicy.brandAuthority.withCurrentContentRead = async () => {
    throw Error("SYNTHETIC_REBOUND_BRAND_HOLDER");
  };
  configuredPolicy.policyAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_POLICY_HOLDER");
  };
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      let before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      policyAllowed = false;
      before = await state();
      assert.equal((await post(command, {}, path)).status, 503);
      assert.deepEqual(await state(), before);
      policyAllowed = true;
      for (const bad of [
        {
          ...command,
          draft: { ...command.draft, localizedNames: { "en-CA": "Missing required translation" } },
        },
        {
          ...command,
          draft: { ...command.draft, editorContent: { ...command.draft.editorContent, media: [] } },
        },
        {
          ...command,
          draft: {
            ...command.draft,
            editorContent: {
              ...command.draft.editorContent,
              preparationNotes: { "de-DE": "Unsupported locale" },
            },
          },
        },
      ]) {
        before = await state();
        assert.equal((await post(bad, {}, path)).status, 409);
        assert.deepEqual(await state(), before);
      }
      for (const [failure, status] of [
        ["late-grant", 403],
        ["late-policy", 503],
        ["late-brand", 503],
        ["late-expiry", 503],
      ]) {
        mode = failure;
        clockOverride = null;
        tentative = false;
        policyAllowed = true;
        brandAllowed = true;
        historyHolds = 0;
        before = await state();
        assert.equal((await post(command, {}, path)).status, status);
        assert.equal(tentative, true);
        assert.ok(historyHolds > 0);
        assert.deepEqual(await state(), before);
      }
      mode = "normal";
      clockOverride = null;
      policyAllowed = true;
      brandAllowed = true;
      const initial = await counts();
      let lose = true;
      const bodies = [];
      const fetcher = async (url, request) => {
        assert.equal(url, path);
        bodies.push(request.body);
        const reply = await post(
          JSON.parse(request.body),
          { "x-bop-csrf": String(new globalThis.Headers(request.headers).get("x-bop-csrf")) },
          path,
        );
        if (lose) {
          assert.equal(reply.status, 200);
          lose = false;
          throw new TypeError("SYNTHETIC_NATIVE_POLICY_SAVE_REPLY_LOST");
        }
        return new globalThis.Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": reply.contentType, "cache-control": reply.cacheControl },
        });
      };
      const pending = createProductCommandClient(fetcher).prepareDraft(command, scope);
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const after = await counts();
      assert.equal(after.root, 10);
      assert.ok(historyRoots.has(9) && historyRoots.has(10));
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(after[key], initial[key] + 1);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      before = await state();
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      clockOverride = new Date(Date.parse(now()) + 60000).toISOString();
      before = await state();
      historyHolds = 0;
      brandReads = 0;
      policyReads = 0;
      policyAllowed = false;
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.aggregateVersion, 10);
      assert.deepEqual(replay.draft.editorContent, command.draft.editorContent);
      assert.equal(historyHolds, 0);
      assert.equal(brandReads, 0);
      assert.equal(policyReads, 0);
      assert.deepEqual(await state(), before);
      assert.ok(bodies.length === 3 && bodies.every((x) => x === bodies[0]));
    },
    { productDraft: native.productDraft },
  );
  await exerciseCurrentPinnedOptionProductDraft({
    admin,
    role,
    id,
    editorSession,
    runtimeOptions,
    configuration,
    policy,
  });
}
