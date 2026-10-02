import { createFrozenFullOptionBindingRuleSource } from "../../../apps/api/src/frozen-full-option-binding-rule-source.ts";
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
  parseCatalogOptionSetEditorContent,
  createPostgresFullOptionSetDraftStore,
  createPostgresFullOptionSetContentSealStore,
  fullOptionSealChecks,
  frozenFullOptionSetContentFields,
} from "../../rms/catalog/src/index.ts";
import { tenantBrandConfigurationRequiredFields } from "../../bop/tenant/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";
import { remainingProductEditorVariantReferenceChecks } from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";

// Actual owning full Option Create/seal/reader, current Tenant/Publishing/Variant/registry and native IAM/HTTP.
// All authoring/seal validation/approval, independent fields and remaining-five/write holders are synthetic.
export async function exerciseCurrentPinnedOptionProductDraft({
  admin,
  role,
  id,
  editorSession,
  runtimeOptions,
  configuration,
  policy,
}) {
  assert.match(role, /^wp2421_full_[a-f0-9]+$/);
  const at = new Date().toISOString(),
    product = id(600),
    grant = id(97601);
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.option_set.read'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(97600);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.option_set.read','Active',1,$2,$2)",
      [permission, at],
    );
  }
  for (const action of [
    "catalog.option_set.write",
    "catalog.other_set.read",
    "catalog.option_set.read.other",
  ]) {
    await assert.rejects(
      admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [id(97699), action, at],
      ),
      { code: "23514" },
    );
  }
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [grant, id(96401), permission, id(2), at, new Date(Date.parse(at) + 3600000).toISOString()],
  );
  await admin.query(
    "GRANT SELECT ON rms_catalog.option_set_version,rms_catalog.option_set_publication_content,rms_catalog.option_set_draft_content_snapshot,rms_catalog.option_set_operation_record TO " +
      role,
  );
  for (const table of [
    "option_set_version",
    "option_set_publication_content",
    "option_set_draft_content_snapshot",
    "option_set_operation_record",
  ]) {
    assert.equal(
      (
        await admin.query("SELECT has_table_privilege($1,$2,'SELECT') allowed", [
          role,
          "rms_catalog." + table,
        ])
      ).rows[0].allowed,
      true,
    );
  }
  const transactions = {
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
  let next = 97700,
    event = 0;
  const lease = {
    async holdUntilTransactionCompletes(_tx, input) {
      return {
        observedAt: input.observedAt,
        validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
      };
    },
  };
  const audit = (input, actionCode) => ({
    auditId: id(98400 + ++event),
    brandId: id(2),
    actor: { type: "User", reference: id(3) },
    actionCode,
    targetType: "CatalogOptionSet",
    targetId:
      input.result.sourceAggregate?.optionSetReference ??
      input.result.supportedContent.optionSetReference,
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  });
  const request = {
    internalCode: "SYNTH_PIN109",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic initial choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 3,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 3,
      options: ["OAT", "SOY", "DAIRY"].map((stableCode, sortOrder) => ({
        stableCode,
        sortOrder,
        lifecycle: "Draft",
        localizedNames: { "en-CA": stableCode },
        localizedDescriptions: {},
        defaultEligible: true,
        triggeredOptionSetReference: null,
        conflictOptionCodes: [],
      })),
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: ["OAT", "SOY", "DAIRY"].map((stableCode) => ({
        stableCode,
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: {
          mediaReference: id(99050),
          assetReference: id(99051),
          assetVersionReference: id(99052),
          altText: { "en-CA": "Synthetic image" },
        },
        pricingRule: { reference: id(99060), versionReference: id(99061) },
        consumption: {
          kind: "Inventory",
          reference: id(99070),
          versionReference: id(99071),
          quantity: "0.125",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      })),
      conditionalRules: [
        { ruleReference: id(99080), whenAllSelectedCodes: ["OAT"], requiredOptionCodes: ["SOY"] },
      ],
      conflictRules: [{ ruleReference: id(99081), forbiddenTogetherCodes: ["OAT", "DAIRY"] }],
      scopeSet: [
        { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: id(97602),
    occurredAt: at,
    reasonCode: "INITIAL_CONFIGURATION",
  };
  const writer = createPostgresFullOptionSetDraftStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => new Date().toISOString() },
    transactions,
    authority: lease,
    creation: { authority: lease, references: { generate: () => id(++next) } },
    audit: { create: (input) => audit(input, "CATALOG_OPTION_SET_CREATE") },
    events: { generateReference: () => id(98500 + ++event) },
  });
  const created = await writer.create(request),
    set = created.content.sourceAggregate.optionSetReference,
    version = created.content.sourceAggregate.draft.versionReference;
  const sealer = createPostgresFullOptionSetContentSealStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => new Date().toISOString() },
    transactions,
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        assert.deepEqual(input.requiredChecks, input.phase === "Apply" ? fullOptionSealChecks : []);
        return lease.holdUntilTransactionCompletes(tx, input);
      },
    },
    readAuthority: lease,
    references: { generateSuccessorVersion: () => id(++next) },
    audit: { create: (input) => audit(input, "CATALOG_OPTION_SET_CONTENT_SEALED") },
    events: { generateReference: () => id(98500 + ++event) },
  });
  const { sourceAggregate, ...details } = created.content;
  const sealedInput = parseCatalogOptionSetEditorContent(sourceAggregate, details);
  await sealer.seal({
    optionSetReference: set,
    versionReference: version,
    expectedAggregateVersion: 1,
    sourceDigest: sealedInput.sourceDigest,
    contentDigest: sealedInput.contentDigest,
    configurationDigest: sealedInput.configurationDigest,
    operationReference: id(97603),
    occurredAt: new Date().toISOString(),
    reasonCode: "CONFIGURATION_EDIT",
  });
  const recorded = parseProductAggregate(
    (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 AND result_aggregate_version=10",
        [id(2), product],
      )
    ).rows[0].snapshot_json,
  );
  assert.equal(recorded.aggregateVersion, 10);
  const command = {
    productReference: product,
    operationReference: id(97604),
    expectedAggregateVersion: 10,
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
  const bindingReference = id(97900),
    optionByCode = new Map(
      created.content.sourceAggregate.draft.options.map((o) => [o.stableCode, o.optionReference]),
    );
  command.draft.optionBindings = [
    {
      bindingReference,
      optionSetReference: set,
      optionSetVersionReference: version,
      purpose: "CUSTOMIZATION",
      sortOrder: 0,
      enabledOptionReferences: [...optionByCode.values()],
      defaultSelections: [
        { optionReference: optionByCode.get("OAT"), quantity: 1 },
        { optionReference: optionByCode.get("SOY"), quantity: 1 },
      ],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
  ];
  command.draft.editorContent.optionRules = [
    {
      bindingReference,
      versionResolution: "Pinned",
      pricingRule: null,
      conditionalRule: null,
      conflictRule: null,
      variantCondition: [],
    },
  ];
  command.draft.optionBindings.push({
    ...command.draft.optionBindings[0],
    bindingReference: id(97901),
    purpose: "TOPPING",
    sortOrder: 1,
  });
  command.draft.editorContent.optionRules.push({
    ...command.draft.editorContent.optionRules[0],
    bindingReference: id(97901),
  });
  parseProductAggregate({ ...recorded, draft: command.draft });
  // Public owning source preflight under the same isolated API role, no private source DTO.
  await editorSession.persistence.transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.tenant_id',$1,true)", [id(1)]);
    const source = createFrozenFullOptionBindingRuleSource({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      authority: lease,
    });
    await source.withPinnedAssessment(tx, command.draft.optionBindings[0], async (result) => {
      assert.equal(result.rules.status, "Satisfiable");
      assert.equal(result.referenceEligibility, "NotEvaluated");
    });
    const conflict = {
      ...command.draft.optionBindings[0],
      defaultSelections: [
        { optionReference: optionByCode.get("OAT"), quantity: 1 },
        { optionReference: optionByCode.get("DAIRY"), quantity: 1 },
      ],
    };
    await source.withPinnedAssessment(tx, conflict, async (result) => {
      assert.equal(result.rules.status, "Unsatisfiable");
    });
  });
  let clockOverride = null,
    mode = "normal",
    policyAllowed = true,
    tentative = false,
    historyHolds = 0,
    optionHolds = 0,
    optionAllowed = true,
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
      auditReference: () => id(97605),
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
            pinnedOptions: {
              optionAuthority: {
                async holdUntilTransactionCompletes(tx, input) {
                  optionHolds++;
                  assert.equal(input.actorReference, id(3));
                  assert.equal(input.action, "catalog.option_set.read");
                  assert.deepEqual(input.requiredFields, frozenFullOptionSetContentFields);
                  if (input.content !== null) {
                    assert.equal(input.content.supportedContent.optionSetReference, set);
                    assert.equal(input.content.supportedContent.versionReference, version);
                  }
                  if (!optionAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
                  return lease.holdUntilTransactionCompletes(tx, input);
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
    },
  };
  async function observeLate(tx) {
    const root = (
      await tx.query(
        "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
        [id(2), product],
      )
    ).rows[0].aggregate_version;
    if (mode !== "normal" && !tentative && root === 11) {
      tentative = true;
      if (mode === "late-grant")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grant],
        );
      if (mode === "late-policy") optionAllowed = false;
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
  const capturedPinned =
    options.productDraft.registeredEditorContent.variantHistory.contentPolicy.pinnedOptions;
  capturedPinned.optionAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_OPTION_HOLDER");
  };
  capturedPinned.remainingAuthority = async () => {
    throw Error("SYNTHETIC_REBOUND_REMAINING_HOLDER");
  };

  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      let before = await state();
      for (const [kind, status] of [
        ["missing", 503],
        ["current", 503],
        ["conflict", 409],
      ]) {
        const bad = globalThis.structuredClone(command);
        if (kind === "missing") bad.draft.optionBindings[0].optionSetVersionReference = id(97999);
        if (kind === "current")
          bad.draft.editorContent.optionRules[0].versionResolution = "CurrentPublished";
        if (kind === "conflict")
          bad.draft.optionBindings[0].defaultSelections = [
            { optionReference: optionByCode.get("OAT"), quantity: 1 },
            { optionReference: optionByCode.get("DAIRY"), quantity: 1 },
          ];
        parseProductAggregate({ ...recorded, draft: bad.draft });
        const reply = await post(bad, {}, path);
        if (kind === "conflict")
          assert.ok(optionHolds > 0, "native owning field holder reached before business conflict");
        assert.equal(reply.status, status, kind);
        assert.deepEqual(await state(), before);
      }
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      optionAllowed = false;
      before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      optionAllowed = true;
      for (const [probe, status] of [
        ["late-grant", 403],
        ["late-policy", 403],
        ["late-expiry", 503],
      ]) {
        mode = probe;
        tentative = false;
        clockOverride = null;
        optionAllowed = true;
        before = await state();
        assert.equal((await post(command, {}, path)).status, status, probe);
        assert.equal(tentative, true);
        assert.deepEqual(await state(), before);
      }
      mode = "normal";
      clockOverride = null;
      optionAllowed = true;
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
          throw new TypeError("SYNTHETIC_PINNED_OPTION_REPLY_LOST");
        }
        return new globalThis.Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": reply.contentType, "cache-control": reply.cacheControl },
        });
      };
      const pending = createProductCommandClient(fetcher).prepareDraft(command, scope);
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const after = await counts();
      assert.equal(after.root, 11);
      assert.ok(optionHolds > 0);
      assert.ok(historyRoots.has(10) && historyRoots.has(11));
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
      optionHolds = 0;
      historyHolds = 0;
      brandReads = 0;
      policyReads = 0;
      optionAllowed = false;
      before = await state();
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.aggregateVersion, 11);
      assert.deepEqual(replay.draft.editorContent, command.draft.editorContent);
      assert.deepEqual(replay.draft.optionBindings, command.draft.optionBindings);
      assert.equal(optionHolds, 0);
      assert.equal(historyHolds, 0);
      assert.equal(brandReads, 0);
      assert.equal(policyReads, 0);
      assert.deepEqual(await state(), before);
      assert.ok(bodies.length === 3 && bodies.every((x) => x === bodies[0]));
    },
    { productDraft: native.productDraft },
  );
}
