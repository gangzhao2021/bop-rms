import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createInternalMerchantProduct } from "../../../tooling/environment/pilot-merchant-product.mjs";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createMerchantBffRouter as createEmittedMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  createProductAuthoringRecoveryClient,
  parseProductAuthoringCursor,
} from "../../../apps/merchant-web/src/product-authoring-recovery-client.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { exerciseProductSellingUnitRuntimeHttp } from "./product-selling-unit-runtime-http.mjs";

/** Real pilot composition, BFF/HTTP, encrypted persisted Session, current IAM,
 * FeatureControl and owning authoring sources in the existing migrated case.
 * Business identities, initial governing records and OIDC origin are synthetic.
 * Initial creation has complete text and explicitly empty optional references;
 * later first-SKU creation uses actual registered units. This does not establish
 * new Variant definitions, nonempty Media/Safety/Nutrition or browser IDB proof.
 */
export async function exerciseProductCurrentAuthoringRuntimeHttp(env) {
  const {
    admin,
    role,
    tenant,
    brand,
    storeReference,
    configurationVersionReference,
    expectedBrandVersion,
    policyReference,
    policyVersion,
    transactions,
    reference,
    now,
    observeSqlSourceTime,
  } = env;
  assert.match(role, /^wp2421_retire_[a-f0-9]+$/u);
  const actor = reference(),
    reviewer = reference(),
    at = now(),
    from = new Date(Date.parse(at) - 60000).toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString(),
    scope = { tenantReference: tenant, brandReference: brand, storeReference },
    selected = { brandReference: brand, storeReference };
  const session = await seedMerchantAcceptanceSession({
    admin,
    runner: transactions,
    role,
    scope,
    actor,
    at,
    referencePrefix: "0190a243",
    sessionReferencePrefix: "0190a244",
  });
  const membership = (
    await admin.query(
      "SELECT membership_id FROM bop_membership.membership WHERE brand_id=$1 AND actor_id=$2",
      [brand, actor],
    )
  ).rows[0].membership_id;
  const brandRole = reference();
  await admin.query(
    "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
    [brandRole, brand, "synthetic_current_product_authoring", from, until],
  );
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
    [reference(), brandRole, membership, actor, brand, from, until],
  );
  const grants = new Map();
  for (const action of [
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.create",
    "catalog.product.update",
    "catalog.product.read",
    "catalog.product.history.read",
    "catalog.content-registry.read",
    "catalog.sku.read",
    "catalog.sku.create",
    "catalog.option_set.read",
    "catalog.tax-classification.read",
    "media.asset.access",
  ]) {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = reference();
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    const grant = reference();
    grants.set(action, grant);
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
      [grant, brandRole, permission, brand, from, until],
    );
  }
  await admin.query("GRANT USAGE ON SCHEMA bop_feature_control TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.product_authoring_operation_abandonment,rms_catalog.selling_unit_registration_abandonment,rms_catalog.selling_unit_registry_record TO " +
      role,
  );
  async function feature(key, value) {
    const latest = (
      await admin.query(
        "SELECT control_id,control_version FROM bop_feature_control.control_version WHERE brand_id=$1 AND store_id IS NULL AND control_key=$2 ORDER BY control_version DESC LIMIT 1",
        [brand, key],
      )
    ).rows[0];
    const recordedAt = now();
    await admin.query(
      "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,$3,$4,'Synthetic ordinary authoring capability',$5,'PRODUCT_CAPABILITY','BrandOverride','Disabled',$6,'Published',false,$7,NULL,$8,NULL,$5,$9,$10,$11,$7,'ConfigurationMetadata')",
      [
        latest?.control_id ?? reference(),
        brand,
        key,
        Number(latest?.control_version ?? 0) + 1,
        actor,
        value,
        recordedAt,
        until,
        reviewer,
        reference(),
        reference(),
      ],
    );
  }
  await feature("catalog.product.create", "Enabled");
  await feature("catalog.product.edit", "Enabled");
  await feature("catalog.product.list", "Enabled");
  const sourceKinds = new Set();
  const queryMetrics = new Map();
  let sqlFailure = null,
    portFailure = null,
    portElapsedMilliseconds = null;
  const diagnostic = (error) => ({
    code:
      typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
        ? error.code
        : "UNCLASSIFIED",
    locations:
      typeof error?.stack === "string"
        ? error.stack
            .split("\n")
            .slice(1)
            .flatMap((line) => {
              const match = line.match(
                /(?:apps|packages)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|tsx):[0-9]+:[0-9]+/u,
              );
              return match ? [match[0]] : [];
            })
            .slice(0, 8)
        : [],
  });
  const observedTransactions = {
    run: (work) =>
      transactions.run(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = async (sql, values) => {
          let queryKind = "Other";
          for (const [kind, pattern] of [
            ["Brand", /bop_tenant\.brand_configuration/u],
            ["Policy", /bop_publishing\./u],
            ["Registry", /rms_catalog\.product_content_registry_record/u],
            ["History", /rms_catalog\.product_operation_snapshot/u],
            ["Permission", /bop_permission\./u],
            ["Capability", /bop_feature_control\./u],
            ["Membership", /bop_membership\./u],
            ["Session", /bop_identity\./u],
            ["Context", /set_config|current_setting/u],
          ])
            if (pattern.test(sql)) {
              if (queryKind === "Other") queryKind = kind;
              sourceKinds.add(kind);
            }
          const queryStartedAt = Date.now();
          let result;
          try {
            result = await query(sql, values);
          } catch (error) {
            sqlFailure = {
              sqlState:
                typeof error?.code === "string" && /^[A-Z0-9]{5}$/u.test(error.code)
                  ? error.code
                  : "UNCLASSIFIED",
              ...diagnostic(error),
            };
            throw error;
          } finally {
            const metric = queryMetrics.get(queryKind) ?? { count: 0, milliseconds: 0 };
            metric.count += 1;
            metric.milliseconds += Math.max(0, Date.now() - queryStartedAt);
            queryMetrics.set(queryKind, metric);
          }
          for (const row of result.rows) observeSqlSourceTime(row.source?.observedAt);
          return result;
        };
        return work(tx);
      }),
  };
  const persistence = { ...session.persistence, transactions: observedTransactions, now };
  const contentPolicy = {
    configurationVersionReference,
    expectedBrandVersion,
    policyReference,
    policyVersion,
  };
  const product = await createInternalMerchantProduct(
    { publicProfile: { binding: { tenantReference: tenant } }, scope: selected },
    {
      persistence,
      authentication: session.authentication,
      configuration: {
        scope,
        product: {
          contentPolicy,
          maximumApprovalValiditySeconds: 3600,
          authoringSources: { ...contentPolicy, allergenRegistryVersionReference: null },
        },
      },
      createCursorKey: async () => randomBytes(32),
    },
  );
  for (const port of [
    "productCreation",
    "productDraft",
    "productEditor",
    "productAuthoringContext",
    "productAuthoringResolution",
  ])
    assert.equal(typeof product[port], "function");
  const observedProduct = { ...product };
  const observePort = (actual) => async (input) => {
    sqlFailure = null;
    portFailure = null;
    queryMetrics.clear();
    const portStartedAt = Date.parse(now());
    portElapsedMilliseconds = null;
    try {
      return await actual(input);
    } catch (error) {
      portFailure = diagnostic(error);
      const elapsed = Date.parse(now()) - portStartedAt;
      portElapsedMilliseconds = Number.isSafeInteger(elapsed) ? elapsed : null;
      throw error;
    }
  };
  for (const port of ["productCreation", "productDraft", "productAuthoringContext"]) {
    observedProduct[port] = observePort(product[port]);
  }
  assert.equal(typeof product.productSellingUnitRegistry, "object");
  observedProduct.productSellingUnitRegistry = Object.fromEntries(
    ["inspect", "register", "context", "resolve"].map((mode) => {
      assert.equal(typeof product.productSellingUnitRegistry[mode], "function");
      return [mode, observePort(product.productSellingUnitRegistry[mode])];
    }),
  );
  const creation = {
    operationReference: reference(),
    internalCode: "SYNTHETIC_CURRENT_AUTHORING",
    productType: "PreparedFood",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic composed initial Product" },
    taxClassificationReference: null,
    skus: [],
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: { "en-CA": "Synthetic complete initial text" },
      localizedDescriptions: { "en-CA": "Persisted through actual current authoring sources" },
      preparationNotes: {},
      tagReferences: [],
      attributeValues: [],
      media: [],
      variantDimensions: [],
      variantCombinations: [],
      optionRules: [],
      allergenReferences: [],
      nutritionProfile: null,
    },
  };
  let productReference;
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox,(SELECT count(*)::int FROM rms_catalog.product_authoring_operation_abandonment WHERE brand_id=$2) fences",
        [productReference ?? reference(), brand],
      )
    ).rows[0];
  await withProductPublicationHttp(
    undefined,
    session,
    selected,
    async (post) => {
      const signal = new globalThis.AbortController().signal;
      let losePath = "/merchant/catalog/products";
      const dispatched = [];
      const fetcher = async (url, options) => {
        const headers = new globalThis.Headers(options.headers),
          body = JSON.parse(String(options.body));
        const response = await post(
          body,
          {
            "x-bop-csrf": headers.get("x-bop-csrf"),
            "x-bop-catalog-scope": headers.get("x-bop-catalog-scope"),
          },
          url,
        );
        if (url === "/merchant/catalog/products" || url === "/merchant/catalog/products/draft") {
          dispatched.push({
            path: url,
            operationReference: body.operationReference,
            status: response.status,
            errorCode:
              typeof response.body?.error === "string" &&
              /^[a-z][a-z0-9_]{0,95}$/u.test(response.body.error)
                ? response.body.error
                : null,
          });
          if (url === losePath && response.status === 200) {
            losePath = null;
            throw Error("Synthetic response loss after actual server COMMIT");
          }
        }
        return new globalThis.Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "content-type": response.contentType, "cache-control": response.cacheControl },
        });
      };
      const commands = createProductCommandClient(fetcher),
        recovery = createProductAuthoringRecoveryClient(fetcher, () => Date.parse(now()));
      const actual = await recovery.context("Create", selected, session.csrf, signal);
      assert.equal(actual.tenantReference, tenant);
      assert.equal(actual.actorReference, actor);
      const createScope = {
        ...scope,
        actorReference: actor,
        action: "Create",
        productReference: null,
      };
      const createCursor = parseProductAuthoringCursor(
        {
          profile: "CatalogProductAuthoringCursorV1",
          scope: createScope,
          operationReference: creation.operationReference,
          expectedAggregateVersion: null,
        },
        createScope,
      );
      await assert.rejects(
        commands.prepareCreate(creation, selected).execute(session.csrf, signal),
        (error) => error.code === "OutcomeUnknown",
      );
      assert.equal(
        dispatched.at(-1)?.status,
        200,
        JSON.stringify({
          status: dispatched.at(-1)?.status,
          errorCode: dispatched.at(-1)?.errorCode,
          portFailure,
          sqlFailure,
          observedSources: [...sourceKinds],
        }),
      );
      const created = await recovery.resolve(createCursor, session.csrf, signal);
      assert.equal(created.outcome, "Committed");
      assert.equal(created.aggregateVersion, 1);
      productReference = created.productReference;
      assert.equal(dispatched.length, 1);
      const editor = async (revision) => {
        const response = await post(
          { productReference, expectedAggregateVersion: revision },
          {},
          "/merchant/catalog/products/editor",
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.aggregateVersion, revision);
        return response.body.aggregate;
      };
      const initial = await editor(1);
      assert.deepEqual(initial.draft.editorContent, creation.editorContent);
      const originalCounts = await counts();
      assert.deepEqual(await recovery.resolve(createCursor, session.csrf, signal), created);
      assert.deepEqual(await counts(), originalCounts);
      const save = {
        productReference,
        expectedAggregateVersion: 1,
        operationReference: reference(),
        draft: {
          ...initial.draft,
          localizedNames: { "en-CA": "Synthetic ordinary saved edit" },
          editorContent: {
            ...initial.draft.editorContent,
            localizedDescriptions: {
              "en-CA": "Synthetic complete content saved through current sources",
            },
          },
        },
      };
      const saved = await commands
        .prepareDraft(save, selected)
        .execute(session.csrf, signal)
        .catch((error) => {
          assert.fail(
            JSON.stringify({
              clientCode: error.code,
              status: dispatched.at(-1)?.status,
              errorCode: dispatched.at(-1)?.errorCode,
              portFailure,
              portElapsedMilliseconds,
              queryMetrics: Object.fromEntries(queryMetrics),
              sqlFailure,
              observedSources: [...sourceKinds],
            }),
          );
        });
      assert.equal(saved.aggregateVersion, 2);
      const current = await editor(2);
      assert.deepEqual(current.draft.localizedNames, save.draft.localizedNames);
      assert.deepEqual(current.draft.editorContent, save.draft.editorContent);
      const unknown = {
        productReference,
        expectedAggregateVersion: 2,
        operationReference: reference(),
        draft: { ...current.draft, localizedNames: { "en-CA": "Synthetic committed reply lost" } },
      };
      const draftContext = await recovery.context("ReplaceDraft", selected, session.csrf, signal);
      assert.equal(draftContext.actorReference, actor);
      const draftScope = { ...createScope, action: "ReplaceDraft", productReference };
      const draftCursor = parseProductAuthoringCursor(
        {
          profile: "CatalogProductAuthoringCursorV1",
          scope: draftScope,
          operationReference: unknown.operationReference,
          expectedAggregateVersion: 2,
        },
        draftScope,
      );
      losePath = "/merchant/catalog/products/draft";
      await assert.rejects(
        commands.prepareDraft(unknown, selected).execute(session.csrf, signal),
        (error) => error.code === "OutcomeUnknown",
      );
      assert.equal(
        dispatched.at(-1)?.status,
        200,
        JSON.stringify({
          status: dispatched.at(-1)?.status,
          errorCode: dispatched.at(-1)?.errorCode,
          portFailure,
          sqlFailure,
          observedSources: [...sourceKinds],
        }),
      );
      const committedCounts = await counts();
      const resolved = await recovery.resolve(draftCursor, session.csrf, signal);
      assert.deepEqual(resolved, {
        outcome: "Committed",
        productReference,
        versionReference: current.draft.versionReference,
        aggregateVersion: 3,
      });
      assert.deepEqual(await counts(), committedCounts);
      assert.deepEqual((await editor(3)).draft.localizedNames, unknown.draft.localizedNames);
      assert.equal(dispatched.length, 3);
      assert.equal(new Set(dispatched.map((item) => item.operationReference)).size, 3);
      assert.equal(committedCounts.root, 3);
      for (const kind of ["Brand", "Policy", "Registry", "History", "Permission", "Capability"])
        assert(sourceKinds.has(kind), "Actual source must participate: " + kind);
      await exerciseProductSellingUnitRuntimeHttp({
        post,
        session,
        selected,
        reference,
        admin,
        brand,
        actor,
        now,
      }).catch(() => {
        assert.fail(
          JSON.stringify({
            portFailure,
            portElapsedMilliseconds,
            queryMetrics: Object.fromEntries(queryMetrics),
            sqlFailure,
            observedSources: [...sourceKinds],
          }),
        );
      });
      assert.deepEqual(await counts(), committedCounts);
      const unitBackedDraft = {
        productReference,
        expectedAggregateVersion: 3,
        operationReference: reference(),
        draft: {
          ...(await editor(3)).draft,
          skus: [
            {
              skuReference: reference(),
              productReference,
              brandReference: brand,
              skuCode: "SYNTHETIC_REGISTERED_EA",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic first unit-backed SKU" },
              variantSelections: [],
              unitOfSale: "EA",
              unitQuantity: "1",
              createdAt: now(),
              createdByActorReference: actor,
            },
          ],
        },
      };
      const withSku = await commands
        .prepareDraft(unitBackedDraft, selected)
        .execute(session.csrf, signal);
      assert.equal(withSku.aggregateVersion, 4);
      const persistedSku = (await editor(4)).draft.skus;
      assert.equal(persistedSku.length, 1);
      assert.equal(persistedSku[0].skuReference, unitBackedDraft.draft.skus[0].skuReference);
      assert.equal(persistedSku[0].unitOfSale, "EA");
      assert.equal(persistedSku[0].unitQuantity, "1");
      assert.equal(persistedSku[0].createdByActorReference, actor);
      const finalCounts = await counts();
      assert.equal(finalCounts.root, 4);
      assert.deepEqual(await recovery.resolve(draftCursor, session.csrf, signal), resolved);
      assert.deepEqual(await counts(), finalCounts);
      // A complete ordinary Create may explicitly include one registered base SKU.
      // Its Product/Version/SKU references must be allocated by the actual owner.
      const baseCreation = {
        ...creation,
        operationReference: reference(),
        internalCode: "SYNTHETIC_CURRENT_BASE_SKU",
        localizedNames: { "en-CA": "Synthetic complete created Product with registered SKU" },
        skus: [
          {
            skuCode: "SYNTHETIC_INITIAL_EA",
            localizedNames: { "en-CA": "Synthetic initially created item" },
            variantSelections: [],
            unitOfSale: "EA",
            unitQuantity: "1",
          },
        ],
      };
      const creationCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product WHERE brand_id=$1) products,(SELECT count(*)::int FROM rms_catalog.sku WHERE brand_id=$1) skus,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1) outbox",
            [brand],
          )
        ).rows[0];
      const beforeBase = await creationCounts();
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grants.get("catalog.sku.create")],
      );
      const deniedBase = await post(
        { ...baseCreation, operationReference: reference(), internalCode: "SYNTHETIC_DENIED_BASE" },
        {},
        "/merchant/catalog/products",
      );
      assert.equal(
        deniedBase.status,
        403,
        "Explicit initial SKU requires actual catalog.sku.create",
      );
      assert.deepEqual(await creationCounts(), beforeBase);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grants.get("catalog.sku.create")],
      );
      for (const [code, changes] of [
        ["SYNTHETIC_UNREGISTERED_BASE", { unitOfSale: "UNREGISTERED" }],
        ["SYNTHETIC_BAD_PRECISION_BASE", { unitQuantity: "0.5" }],
      ]) {
        const refused = await post(
          {
            ...baseCreation,
            internalCode: code,
            operationReference: reference(),
            skus: [{ ...baseCreation.skus[0], ...changes }],
          },
          {},
          "/merchant/catalog/products",
        );
        assert.equal(
          refused.status,
          409,
          JSON.stringify({
            status: refused.status,
            portFailure,
            portElapsedMilliseconds,
            queryMetrics: Object.fromEntries(queryMetrics),
            sqlFailure,
          }),
        );
        assert.equal(refused.body.error, "product_creation_conflict");
        assert.deepEqual(await creationCounts(), beforeBase);
      }
      const baseCursor = parseProductAuthoringCursor(
        {
          profile: "CatalogProductAuthoringCursorV1",
          scope: createScope,
          operationReference: baseCreation.operationReference,
          expectedAggregateVersion: null,
        },
        createScope,
      );
      losePath = "/merchant/catalog/products";
      await assert.rejects(
        commands.prepareCreate(baseCreation, selected).execute(session.csrf, signal),
        (error) => error.code === "OutcomeUnknown",
      );
      assert.equal(
        dispatched.at(-1)?.status,
        200,
        JSON.stringify({
          status: dispatched.at(-1)?.status,
          portFailure,
          portElapsedMilliseconds,
          queryMetrics: Object.fromEntries(queryMetrics),
          sqlFailure,
        }),
      );
      const afterBase = await creationCounts();
      assert.equal(afterBase.products, beforeBase.products + 1);
      assert.equal(afterBase.skus, beforeBase.skus + 1);
      assert.equal(afterBase.audit, beforeBase.audit + 1);
      assert.equal(afterBase.outbox, beforeBase.outbox + 1);
      const baseResolved = await recovery.resolve(baseCursor, session.csrf, signal);
      assert.equal(baseResolved.outcome, "Committed");
      assert.equal(baseResolved.aggregateVersion, 1);
      assert.deepEqual(await creationCounts(), afterBase);
      const baseRead = await post(
        { productReference: baseResolved.productReference, expectedAggregateVersion: 1 },
        {},
        "/merchant/catalog/products/editor",
      );
      assert.equal(baseRead.status, 200);
      const baseAggregate = baseRead.body.aggregate;
      assert.deepEqual(baseAggregate.draft.editorContent, baseCreation.editorContent);
      assert.deepEqual(baseAggregate.draft.localizedNames, baseCreation.localizedNames);
      assert.equal(baseAggregate.draft.skus.length, 1);
      const originalBaseRows = (
        await admin.query(
          "SELECT r.product_id,r.result_aggregate_version::text,r.occurred_at,r.intent_digest,s.snapshot_json FROM rms_catalog.product_operation_record r JOIN rms_catalog.product_operation_snapshot s USING(operation_id,brand_id,product_id) WHERE r.brand_id=$1 AND r.operation_id=$2 AND r.action_code='Create'",
          [brand, baseCreation.operationReference],
        )
      ).rows;
      assert.equal(originalBaseRows.length, 1);
      const originalBase = originalBaseRows[0];
      assert.equal(originalBase.product_id, baseResolved.productReference);
      assert.equal(originalBase.result_aggregate_version, "1");
      assert.equal(originalBase.occurred_at.toISOString(), baseAggregate.createdAt);
      assert.equal(originalBase.snapshot_json.createdByActorReference, actor);
      assert.equal(
        originalBase.snapshot_json.draft.versionReference,
        baseResolved.versionReference,
      );
      assert.deepEqual(originalBase.snapshot_json.draft.skus, baseAggregate.draft.skus);
      assert.match(originalBase.intent_digest, /^sha256:[0-9a-f]{64}$/u);
      const baseSku = baseAggregate.draft.skus[0];
      assert.equal(baseSku.skuCode, baseCreation.skus[0].skuCode);
      assert.equal(baseSku.productReference, baseResolved.productReference);
      assert.equal(baseSku.brandReference, brand);
      assert.equal(baseSku.createdByActorReference, actor);
      assert.equal(baseSku.createdAt, baseAggregate.createdAt);
      assert.equal(baseSku.lifecycle, "Draft");
      assert.equal(baseSku.unitOfSale, "EA");
      assert.equal(baseSku.unitQuantity, "1");
      assert.deepEqual(baseSku.variantSelections, []);
      assert.equal(typeof baseSku.skuReference, "string");
      assert(!Object.hasOwn(baseCreation.skus[0], "skuReference"));
      assert.deepEqual(await recovery.resolve(baseCursor, session.csrf, signal), baseResolved);
      assert.deepEqual(await creationCounts(), afterBase);
      assert.deepEqual(await counts(), finalCounts);
      await feature("catalog.product.edit", "Disabled");
      const disabled = await post(
        { action: "ReplaceDraft" },
        {},
        "/merchant/catalog/products/authoring-context",
      );
      assert.equal(
        disabled.status,
        409,
        JSON.stringify({
          status: disabled.status,
          portFailure,
          portElapsedMilliseconds,
          queryMetrics: Object.fromEntries(queryMetrics),
          sqlFailure,
        }),
      );
      assert.deepEqual(await counts(), finalCounts);
      await feature("catalog.product.edit", "Enabled");
      // Actual current authority revocation refuses context/recovery without writes.
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grants.get("catalog.product.manage")],
      );
      await assert.rejects(
        recovery.context("ReplaceDraft", selected, session.csrf, signal),
        (error) => error.code === "Denied",
      );
      await assert.rejects(
        recovery.resolve(draftCursor, session.csrf, signal),
        (error) => error.code === "Denied",
      );
      assert.deepEqual(await counts(), finalCounts);
    },
    observedProduct,
    createEmittedMerchantBffRouter,
  );
}
