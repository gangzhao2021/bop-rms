import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import {
  parseProductAggregate,
  parseProductPublicationVersionV2,
  parseCatalogProductPublicationManagementV2,
  parseCatalogProductPublicationValidationReportView,
} from "../../rms/catalog/src/index.ts";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { seedOrdinaryRefundSession } from "./ordinary-refund-session.mjs";

const lifecyclePath = "/merchant/catalog/products/lifecycle",
  publicationPath = "/merchant/catalog/products/publication/v2",
  acknowledgementPath = "/merchant/catalog/products/publication/warning-acknowledgements/v1",
  managementPath = "/merchant/catalog/products/publication/management/v2",
  reportPath = "/merchant/catalog/products/publication/validation-report/v2";
const transport = (command) =>
  Object.fromEntries(
    Object.entries(command).filter(
      ([key]) =>
        ![
          "tenantReference",
          "brandReference",
          "actorReference",
          "actorKind",
          "purposeCode",
        ].includes(key),
    ),
  );

/** Actual HTTP/session/current IAM/FeatureControl and production source assembly.
 * Only OIDC identity origin, session crypto, governing seed configuration and
 * unused workflows are controlled. No check, Ack, report or approval is supplied
 * as evidence. The independent Product starts through actual owning writers.
 */
export async function exerciseProductFullPublicationRuntimeHttp(env) {
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
    createProduct,
    command,
    acknowledgement,
    counts,
  } = env;
  assert.match(role, /^wp2421_retire_[a-f0-9]+$/);
  const at = now(),
    from = new Date(Date.parse(at) - 60000).toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString(),
    author = reference(),
    reviewer = reference(),
    scope = { tenantReference: tenant, brandReference: brand, storeReference },
    knownActors = new Set([author, reviewer]);
  // Both sessions use one actual runtime and one ephemeral crypto authority.
  // No credentials are returned from this helper or written to artifacts.
  const sharedSessionAuthority = {
    encryptionKey: randomBytes(32),
    selectorPepper: randomBytes(32),
    async currentActor(_tx, actorReference, authenticatedAt) {
      assert(knownActors.has(actorReference));
      return createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    },
  };
  await admin.query(
    "GRANT USAGE ON SCHEMA bop_identity,bop_membership,bop_permission,bop_tenant,bop_feature_control TO " +
      role,
  );
  await admin.query("GRANT SELECT,UPDATE ON bop_identity.authentication_session TO " + role);
  await admin.query("GRANT SELECT ON bop_identity.browser_session_selection TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON bop_tenant.brand,bop_tenant.store,bop_membership.membership,bop_membership.store_assignment,bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_definition,bop_permission.permission_grant,bop_permission.permission_override TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO " +
      role,
  );
  await admin.query(
    "INSERT INTO bop_permission.policy_state(brand_id,snapshot_id,version,updated_at) VALUES($1,$2,1,$3) ON CONFLICT(brand_id) DO NOTHING",
    [brand, reference(), from],
  );
  const grants = new Map(),
    sessions = [];
  async function grant(roleReference, store, action, actorReference) {
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
    const grantReference = reference();
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [grantReference, roleReference, permission, brand, store, from, until],
    );
    grants.set(actorReference + ":" + action, grantReference);
  }
  const brandActions = [
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.read",
    "catalog.product.validate",
    "catalog.product.submit",
    "catalog.product.approve",
    "catalog.product.publish",
    "catalog.product.history.read",
    "catalog.product.approval.read",
    "catalog.product.acknowledge-warnings",
    "catalog.sku.read",
    "catalog.sku.activate",
    "catalog.tax-classification.read",
    "catalog.content-registry.read",
    "catalog.option_set.read",
    "media.asset.access",
    "recipe.manage",
    "inventory.item.read",
    "inventory.item.history.read",
    "pricing.price-book.manage",
    "pricing.promotion.manage",
  ];
  for (const [index, actorReference] of [author, reviewer].entries()) {
    const membership = reference(),
      assignment = reference(),
      storeRole = reference(),
      brandRole = reference();
    await admin.query(
      "INSERT INTO bop_membership.membership VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [membership, actorReference, brand, reference(), from, until],
    );
    await admin.query(
      "INSERT INTO bop_membership.store_assignment VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [assignment, membership, actorReference, brand, storeReference, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [storeRole, brand, storeReference, "native_product_navigation_" + index, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
      [
        reference(),
        storeRole,
        membership,
        assignment,
        actorReference,
        brand,
        storeReference,
        from,
        until,
      ],
    );
    await grant(storeRole, storeReference, "merchant.access", actorReference);
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
      [brandRole, brand, "native_product_publication_" + index, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
      [reference(), brandRole, membership, actorReference, brand, from, until],
    );
    for (const action of brandActions) await grant(brandRole, null, action, actorReference);
    sessions.push(
      await seedOrdinaryRefundSession({
        client: admin,
        runner: () => transactions,
        scope,
        requester: actorReference,
        at,
        referencePrefix: index === 0 ? "0190a201" : "0190a202",
        sharedSessionAuthority,
      }),
    );
  }
  // Actual owning definition rows; empty dependencies are an actual empty graph.
  // The default fixed CAT-PRODUCT-EDIT binding is used without an injected resolver.
  const control = reference(),
    skuControl = reference();
  async function featureVersion(version, configuredValue, key = "catalog.product.edit") {
    const recordedAt = now();
    await admin.query(
      "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,$11,$3,'Isolated ordinary Product edit',$4,'PRODUCT_CAPABILITY','BrandOverride','Disabled',$5,'Published',false,$6,NULL,$7,NULL,$4,$8,$9,$10,$6,'ConfigurationMetadata')",
      [
        key === "catalog.sku.detail" ? skuControl : control,
        brand,
        version,
        author,
        configuredValue,
        recordedAt,
        until,
        reviewer,
        reference(),
        reference(),
        key,
      ],
    );
  }
  await featureVersion(1, "Enabled");
  await featureVersion(1, "Enabled", "catalog.sku.detail");
  let sourceQueries = 0,
    totalQueries = 0,
    permissionQueries = 0,
    lastQueryFailure = null;
  const runtimeTransactions = {
    async run(work) {
      return transactions.run(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = async (sql, values) => {
          totalQueries++;
          if (/bop_permission\./u.test(sql)) permissionQueries++;
          if (
            /rms_recipe\.|rms_inventory\.|rms_pricing\.|bop_publishing\.|rms_catalog\.product_content_registry_record|rms_catalog\.product_tax_classification_registry/u.test(
              sql,
            )
          )
            sourceQueries++;
          try {
            const result = await query(sql, values);
            for (const row of result.rows) observeSqlSourceTime(row.source?.observedAt);
            return result;
          } catch (error) {
            const queryClass =
                /INSERT\s+INTO\s+rms_catalog\.product_publication_warning_acknowledgement\b/iu.test(
                  sql,
                )
                  ? "AckInsert"
                  : /platform_audit\./u.test(sql)
                    ? "Audit"
                    : /platform_eventing\./u.test(sql)
                      ? "Outbox"
                      : /bop_permission\./u.test(sql)
                        ? "Permission"
                        : "Other",
              sqlState =
                error instanceof Error &&
                typeof error.code === "string" &&
                /^[A-Z0-9]{5}$/u.test(error.code)
                  ? error.code
                  : "UNCLASSIFIED",
              locations =
                error instanceof Error && typeof error.stack === "string"
                  ? error.stack
                      .split("\n")
                      .slice(1)
                      .flatMap((line) => {
                        const match = line.match(
                          /(?:apps|packages)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|tsx):[0-9]+:[0-9]+/u,
                        );
                        return match ? [match[0]] : [];
                      })
                      .slice(0, 3)
                  : [];
            lastQueryFailure = { queryClass, sqlState, locations };
            throw error;
          }
        };
        return work(tx);
      });
    },
  };
  const persistence = {
    ...sessions[0].persistence,
    transactions: runtimeTransactions,
    now,
    currentActor: sharedSessionAuthority.currentActor,
    async validateAssociation(_tx, session, selected) {
      return (
        knownActors.has(session.actor.actorReference) &&
        selected.tenantReference === tenant &&
        selected.brandReference === brand &&
        selected.storeReference === storeReference
      );
    },
  };
  const references = new Map();
  const stableReference = (kind) => (operation) => {
    const key = kind + ":" + operation;
    if (!references.has(key)) references.set(key, reference());
    return references.get(key);
  };
  const unused = () => {
    throw new Error("ISOLATED_UNCONFIGURED_STORE_WORKFLOW");
  };
  const runtime = createMerchantRuntime({
    persistence,
    acceptedHost: "merchant.invalid",
    exactOrigin: "https://merchant.invalid",
    serviceAudit: {
      reasonCode: "ISOLATED_PRODUCT_RUNTIME",
      retentionPolicyCode: "AUDIT_DEFAULT",
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
      review: { validate: unused, snapshotAudit: unused },
    },
    productLifecycle: { currentRuntime: true, auditReference: stableReference("audit") },
    productPublicationRuntime: {
      sources: {
        contentPolicy: {
          configurationVersionReference,
          expectedBrandVersion,
          policyReference,
          policyVersion,
        },
        evidenceReference: stableReference("evidence"),
        reviewReference: stableReference("review"),
      },
      auditReference: stableReference("audit"),
      maximumApprovalValiditySeconds: 3600,
    },
  });
  let acknowledgementDiagnostic = null,
    publicationDiagnostic = null;
  const actualAcknowledgement = runtime.productPublicationWarningAcknowledgement;
  assert.equal(typeof actualAcknowledgement, "function");
  const observedRuntime = {
    ...runtime,
    async productPublicationV2(input) {
      const started = performance.now();
      publicationDiagnostic = null;
      lastQueryFailure = null;
      try {
        return await runtime.productPublicationV2(input);
      } catch (error) {
        const code =
          typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
            ? error.code
            : "UNCLASSIFIED";
        const locations =
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
                .slice(0, 5)
            : [];
        publicationDiagnostic = {
          code,
          locations,
          durationMilliseconds: Math.ceil(performance.now() - started),
          lastQueryFailure,
        };
        throw error;
      }
    },
    async productPublicationWarningAcknowledgement(input) {
      const started = performance.now(),
        initialTotalQueries = totalQueries,
        initialPermissionQueries = permissionQueries;
      acknowledgementDiagnostic = null;
      lastQueryFailure = null;
      try {
        const result = await actualAcknowledgement.call(runtime, input);
        acknowledgementDiagnostic = {
          durationMilliseconds: Math.ceil(performance.now() - started),
          totalQueryCount: totalQueries - initialTotalQueries,
          permissionQueryCount: permissionQueries - initialPermissionQueries,
          failures: [],
          lastQueryFailure,
        };
        return result;
      } catch (error) {
        const failures = [];
        let current = error;
        // Fixed error classification and source locations only. Never retain
        // messages, SQL, commands, credentials or unrestricted stack text.
        for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
          const code =
              typeof current.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(current.code)
                ? current.code
                : "UNCLASSIFIED",
            name =
              typeof current.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(current.name)
                ? current.name
                : "Error",
            locations =
              typeof current.stack === "string"
                ? current.stack
                    .split("\n")
                    .slice(1)
                    .flatMap((line) => {
                      const match = line.match(
                        /(?:apps|packages)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|tsx):[0-9]+:[0-9]+/u,
                      );
                      return match ? [match[0]] : [];
                    })
                    .slice(0, 3)
                : [];
          failures.push({ code, name, locations });
          current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
        }
        acknowledgementDiagnostic = {
          durationMilliseconds: Math.ceil(performance.now() - started),
          totalQueryCount: totalQueries - initialTotalQueries,
          permissionQueryCount: permissionQueries - initialPermissionQueries,
          failures,
          lastQueryFailure,
        };
        throw error;
      }
    },
  };
  const initial = await createProduct(true, false, { activate: false }),
    product = initial.productReference,
    expectedReasons = [
      "REQUIRED_PRICING_REFERENCE_MISSING",
      "REQUIRED_RECIPE_REFERENCE_MISSING",
      "REQUIRED_INVENTORY_REFERENCE_MISSING",
      "REQUIRED_MENU_REFERENCE_MISSING",
    ].sort(),
    committedRequests = [];
  let aggregate = initial,
    current = null;
  await withProductPublicationHttp(
    undefined,
    sessions[0],
    { brandReference: brand, storeReference },
    async (post) => {
      const headers = (actorReference) =>
        actorReference === reviewer
          ? {
              cookie: "__Host-bop-merchant=" + sessions[1].sessionCookie,
              "x-bop-csrf": sessions[1].csrf,
            }
          : {};
      const send = (c) =>
        post(
          transport(c),
          headers(c.actorReference),
          c.action === "AcknowledgeProductPublicationWarnings"
            ? acknowledgementPath
            : publicationPath,
        );
      async function view(actorReference = author) {
        const before = await counts(product),
          managementReply = await post(
            { productReference: product, expectedAggregateVersion: aggregate.aggregateVersion },
            headers(actorReference),
            managementPath,
          );
        assert.equal(
          managementReply.status,
          200,
          "Actual Product management HTTP must be available",
        );
        assert.equal(managementReply.cacheControl, "no-store");
        const management = parseCatalogProductPublicationManagementV2(managementReply.body);
        assert.equal(management.aggregateVersion, aggregate.aggregateVersion);
        assert.equal(management.tenantReference, tenant);
        assert.equal(management.storeReference, storeReference);
        assert.equal(management.eligibility, "NotEvaluated");
        const versionReference = current?.versionReference ?? aggregate.draft.versionReference,
          publicationVersion = current?.publicationVersion ?? 0,
          reportReply = await post(
            {
              productReference: product,
              versionReference,
              expectedAggregateVersion: aggregate.aggregateVersion,
              expectedPublicationVersion: publicationVersion,
            },
            headers(actorReference),
            reportPath,
          );
        assert.equal(reportReply.status, 200, "Actual Product report HTTP must be available");
        assert.equal(reportReply.cacheControl, "no-store");
        const reportView = parseCatalogProductPublicationValidationReportView(reportReply.body);
        assert.equal(reportView.aggregateVersion, aggregate.aggregateVersion);
        assert.equal(reportView.publicationVersion, publicationVersion);
        assert.equal(reportView.eligibility, "NotEvaluated");
        assert.deepEqual(
          await counts(product),
          before,
          "Management/report reads cannot mutate Product or qualification",
        );
        return reportView;
      }
      const activationCommand = {
          productReference: product,
          skuReference: initial.draft.skus[0].skuReference,
          targetLifecycle: "Active",
          expectedAggregateVersion: initial.aggregateVersion,
          operationReference: reference(),
        },
        beforeActivation = await counts(product),
        activationReply = await post(activationCommand, {}, lifecyclePath);
      assert.equal(activationReply.status, 200, "Actual SKU activation HTTP must be available");
      assert.equal(activationReply.body.status, "Applied");
      assert.equal(activationReply.body.aggregateVersion, initial.aggregateVersion + 1);
      assert.equal(activationReply.body.skuLifecycle, "Active");
      assert.equal(activationReply.body.productLifecycle, "Draft");
      const activationStored = await admin.query(
        "SELECT snapshot_json aggregate FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 AND operation_id=$3",
        [brand, product, activationCommand.operationReference],
      );
      assert.equal(activationStored.rows.length, 1);
      aggregate = parseProductAggregate(activationStored.rows[0].aggregate);
      assert.equal(aggregate.draft.skus[0].lifecycle, "Active");
      const activatedCounts = await counts(product);
      for (const key of ["root", "operations", "snapshots", "audit", "outbox"])
        assert.equal(
          activatedCounts[key],
          beforeActivation[key] + 1,
          "Activation append count: " + key,
        );
      const activationReplay = await post(activationCommand, {}, lifecyclePath);
      assert.equal(activationReplay.status, 200);
      assert.deepEqual(activationReplay.body, {
        ...activationReply.body,
        status: "AlreadyApplied",
      });
      assert.deepEqual(await counts(product), activatedCounts);
      assert.equal((await view()).status, "NotValidated");
      await exerciseProductPublicationActions({
        admin,
        tenant,
        brand,
        product,
        author,
        reviewer,
        aggregate,
        current,
        command,
        send,
        view,
        counts,
        acknowledgement,
        expectedReasons,
        committedRequests,
        acknowledgementDiagnostic: () => acknowledgementDiagnostic,
        onCurrent(nextAggregate, nextPublication) {
          aggregate = nextAggregate;
          current = nextPublication;
        },
      });
      assert.notEqual(aggregate.draft.versionReference, initial.draft.versionReference);
      const published = await counts(product);
      assert.equal(published.reports, 4);
      assert.equal(published.approvals, 1);
      assert.equal(published.acknowledgements, 2);
      // Treat the first responses as lost. The same transport bytes under the same
      // authenticated Actor recover immutable receipts without fresh qualification.
      const beforeSources = sourceQueries;
      assert(beforeSources > 0, "Actual owner sources must have been acquired for new commands");
      for (const original of committedRequests) {
        const replay = await send(original.command);
        assert.equal(
          replay.status,
          200,
          "Original HTTP retry " +
            original.command.action +
            " " +
            JSON.stringify(
              original.command.action === "AcknowledgeProductPublicationWarnings"
                ? acknowledgementDiagnostic
                : publicationDiagnostic,
            ),
        );
        assert.deepEqual(replay.body, { ...original.reply, status: "Replayed" });
      }
      assert.equal(sourceQueries, beforeSources);
      assert.deepEqual(await counts(product), published);
      const lateActivationReplay = await post(activationCommand, {}, lifecyclePath);
      assert.equal(lateActivationReplay.status, 200);
      assert.deepEqual(lateActivationReplay.body, {
        ...activationReply.body,
        status: "AlreadyApplied",
      });
      assert.equal(sourceQueries, beforeSources);
      assert.deepEqual(await counts(product), published);
      await featureVersion(2, "Disabled", "catalog.sku.detail");
      assert.equal((await post(activationCommand, {}, lifecyclePath)).status, 409);
      assert.deepEqual(await counts(product), published);
      await featureVersion(3, "Enabled", "catalog.sku.detail");
      const activationGrant = grants.get(author + ":catalog.sku.activate");
      assert(activationGrant);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [activationGrant],
      );
      assert.equal((await post(activationCommand, {}, lifecyclePath)).status, 403);
      assert.deepEqual(await counts(product), published);
      const original = committedRequests[0].command;
      for (const overrides of [
        { "x-bop-csrf": randomBytes(32).toString("base64url") },
        { cookie: "__Host-bop-merchant=" + randomBytes(32).toString("base64url") },
        {
          "x-bop-catalog-scope": Buffer.from(
            JSON.stringify({ brandReference: brand, storeReference: reference() }),
          ).toString("base64url"),
        },
      ]) {
        assert.equal((await post(transport(original), overrides, publicationPath)).status, 403);
        assert.deepEqual(await counts(product), published);
      }
      // Current grants gate historical retry too; no prior receipt is permission.
      const revoked = grants.get(author + ":catalog.product.validate");
      assert(revoked);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [revoked],
      );
      assert.equal((await send(original)).status, 403);
      assert.deepEqual(await counts(product), published);
      // Independent reviewer still has grants, but the actual newer Disabled
      // definition gates their old operation. Keep both immutable definitions.
      await featureVersion(2, "Disabled");
      const reviewerOriginal = committedRequests.find(
        (value) => value.command.action === "Approve",
      );
      assert(reviewerOriginal);
      const featureDenied = await send(reviewerOriginal.command);
      assert.equal(featureDenied.status, 409);
      assert.deepEqual(await counts(product), published);
      const disabledRead = await post(
        { productReference: product, expectedAggregateVersion: aggregate.aggregateVersion },
        headers(reviewer),
        managementPath,
      );
      assert.notEqual(disabledRead.status, 200);
      assert.deepEqual(await counts(product), published);
    },
    observedRuntime,
  );
}

/** Shared concrete ordinary HTTP action/consent journey. Initial identity and
 * governance are synthetic fixture inputs; send/view are actual authenticated
 * HTTP and persisted rows are read only to assert physical owning consistency.
 * No validation, permission or publication source is supplied as a Pass. */
export async function exerciseProductPublicationActions({
  admin,
  tenant,
  brand,
  product,
  author,
  reviewer,
  aggregate,
  current,
  command,
  send,
  view,
  counts,
  acknowledgement,
  expectedReasons,
  committedRequests,
  acknowledgementDiagnostic = () => null,
  onCurrent,
  onStage,
}) {
  for (const action of ["Validate", "SubmitReview", "Approve", "Publish"]) {
    onStage?.("Product" + action);
    const actorReference = action === "Approve" ? reviewer : author,
      c = command(aggregate, current, action, actorReference),
      reply = await send(c);
    assert.equal(reply.status, 200, "Actual ordinary HTTP action failed: " + action);
    assert.equal(reply.cacheControl, "no-store");
    assert.equal(reply.body.profile, "CatalogProductPublicationCommandResultV2");
    assert.equal(reply.body.status, "Applied");
    assert.equal(reply.body.operationReference, c.operationReference);
    assert.equal(reply.body.aggregateVersion, aggregate.aggregateVersion + 1);
    // Physical consistency assertion only. Commands and consent use HTTP views;
    // this native inspection supplies no permission, validation or phase facts.
    const persisted = await admin.query(
      "SELECT s.snapshot_json aggregate,p.snapshot_json publication,r.snapshot_json report FROM rms_catalog.product_operation_snapshot s JOIN rms_catalog.product_publication_revision p ON p.operation_id=s.operation_id AND p.brand_id=s.brand_id AND p.product_id=s.product_id JOIN rms_catalog.product_publication_validation_report r ON r.operation_id=p.operation_id WHERE p.tenant_id=$1 AND p.brand_id=$2 AND p.product_id=$3 AND p.operation_id=$4",
      [tenant, brand, product, c.operationReference],
    );
    assert.equal(persisted.rows.length, 1);
    aggregate = parseProductAggregate(persisted.rows[0].aggregate);
    current = parseProductPublicationVersionV2(persisted.rows[0].publication);
    onCurrent(aggregate, current);
    assert.equal(current.actorReference, actorReference);
    assert.equal(
      current.state,
      {
        Validate: "Draft",
        SubmitReview: "InReview",
        Approve: "Approved",
        Publish: "Published",
      }[action],
    );
    const reportView = await view(actorReference),
      report = reportView.report;
    assert.equal(reportView.status, "Recorded");
    assert(report);
    assert.deepEqual(report, persisted.rows[0].report);
    assert.equal(report.details.coverage, "Complete");
    assert.equal(report.validation.checks.length, 12);
    assert.deepEqual(
      report.details.findings
        .filter((finding) => finding.checkCode === "ChangeImpact")
        .map((finding) => finding.reasonCode)
        .sort(),
      expectedReasons,
    );
    assert.equal(
      report.validation.checks.find((check) => check.code === "ChangeImpact").outcome,
      "Warning",
    );
    assert.equal(
      report.validation.checks.find((check) => check.code === "ApprovalPolicy").outcome,
      ["Validate", "SubmitReview"].includes(action) ? "Pending" : "Pass",
    );
    for (const check of report.validation.checks.filter(
      (value) => !["ChangeImpact", "ApprovalPolicy"].includes(value.code),
    ))
      assert.equal(check.outcome, "Pass");
    assert.equal(
      report.validation.warningAcknowledgement?.actorReference ?? null,
      action === "Validate" ? null : actorReference,
    );
    committedRequests.push({ command: c, reply: reply.body });
    if (action === "Validate" || action === "SubmitReview") {
      onStage?.("WarningRequired" + action);
      const acknowledgingActor = action === "SubmitReview" ? reviewer : author,
        beforeDenied = await counts(product),
        next = command(
          aggregate,
          current,
          action === "Validate" ? "SubmitReview" : "Approve",
          acknowledgingActor,
        ),
        unacknowledged = await send(next);
      assert.equal(
        unacknowledged.status,
        409,
        "Each human requires their own actual Warning acknowledgement",
      );
      assert.deepEqual(await counts(product), beforeDenied);
      // Consent refers to the actual current HTTP report, including the full
      // four specific missing-configuration findings. It never edits checks.
      onStage?.("WarningAcknowledgement" + action);
      const actualReportView = await view(acknowledgingActor),
        ack = acknowledgement(
          {
            aggregate,
            publication: current,
            validationReport: {
              status: actualReportView.status,
              report: actualReportView.report,
            },
          },
          acknowledgingActor,
        ),
        ackReply = await send(ack),
        afterAck = await counts(product);
      assert.equal(
        ackReply.status,
        200,
        "Actual ordinary HTTP Warning acknowledgement failed " +
          JSON.stringify({
            action: "AcknowledgeProductPublicationWarnings",
            actorRole: acknowledgingActor === author ? "Author" : "Reviewer",
            diagnostic: acknowledgementDiagnostic(),
          }),
      );
      assert.equal(ackReply.body.status, "Applied");
      assert.equal(
        ackReply.body.profile,
        "CatalogProductPublicationWarningAcknowledgementResultV1",
      );
      assert.equal(ackReply.body.warningBindingDigest, report.warningBindingDigest);
      assert.equal(afterAck.root, beforeDenied.root);
      assert.equal(afterAck.reports, beforeDenied.reports);
      assert.equal(afterAck.acknowledgements, beforeDenied.acknowledgements + 1);
      assert.equal(afterAck.audit, beforeDenied.audit + 1);
      assert.equal(afterAck.outbox, beforeDenied.outbox + 1);
      committedRequests.push({ command: ack, reply: ackReply.body });
      assert.deepEqual(
        (await view(acknowledgingActor)).report,
        report,
        "Ack cannot rewrite or renew the displayed report",
      );
    }
  }
  return { aggregate, current };
}
