import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import {
  createPostgresProductTaxClassificationRegistryStore,
  taxClassificationRegistryFields,
} from "../../rms/catalog/src/index.ts";
import {
  createFeatureControlAdministrationDefinition,
  createPostgresFeatureControlInitialDraftStore,
  createPostgresFeatureControlAdministrationMutationStore,
  executeFeatureControlAdministration,
} from "../../bop/feature-control/src/index.ts";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringOperation,
  taxConfigAuthoringIntentDigest,
} from "../../rms/pricing/src/contracts/tax-config-authoring.ts";
import {
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialOperation,
  taxConfigMaterialIntentDigest,
} from "../../rms/pricing/src/contracts/tax-config-material.ts";
import {
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  taxConfigCandidateIntentDigest,
} from "../../rms/pricing/src/contracts/tax-config-candidate-authoring.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createMerchantRuntime } from "../../../apps/api/dist/merchant-runtime.js";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
import { createMerchantBrandScope } from "../../../apps/api/dist/merchant-brand-scope.js";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const id = (n) => `01902421-1315-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** Actual isolated Session, IAM, Feature/Catalog producers, runtime, HTTP,
 * Pricing, Audit and Outbox. Identities/OIDC association, currency metadata,
 * classification and rates are explicitly synthetic InternalTest material;
 * no professional/registration/approved-fixture or external Publish proof. */
export async function exerciseTaxConfigRuntimeHttp(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_tax_http_" + context.runId;
  assert.match(role, /^wp2421_tax_http_[a-f0-9]+$/u);
  const tenant = id(1),
    brand = id(2),
    store = id(3),
    actor = id(4),
    reviewer = id(5),
    now = () => new Date().toISOString(),
    at = now();
  const scope = {
    tenantReference: tenant,
    brandReference: brand,
    storeReference: store,
    actorReference: actor,
  };
  let serial = 100,
    createdRole = false,
    stage = "Seed",
    lastStatus = "NONE",
    sqlState = "NONE",
    permissionAsset = "NONE",
    featureCause = "NONE",
    featureCheckpoint = "NONE",
    lateCandidateFineRole = null,
    lateCandidateGuardCode = "NONE",
    lateCandidateGuardSite = "NONE",
    lateCandidateSourceStep = "NONE",
    lateCandidateAssertSite = "NONE";
  const reference = () => id(++serial),
    hooks = new WeakMap();
  await admin.connect();
  const transactions = {
    async run(work) {
      const client = new pg.Client({
        ...context.clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
      });
      await client.connect();
      let lateCandidateInjected = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        const tx = {
          async query(sql, values = []) {
            try {
              if (lateCandidateFineRole !== null) {
                if (sql.includes("tax_config_candidate_operation_available"))
                  lateCandidateSourceStep = "OriginalAvailability";
                else if (sql.includes("PricingTaxConfigRoot:"))
                  lateCandidateSourceStep = "DraftRootFence";
                else if (sql.startsWith("SELECT r.aggregate_version"))
                  lateCandidateSourceStep = "DraftCurrent";
                else if (sql.startsWith("SELECT jsonb_build_object"))
                  lateCandidateSourceStep = "DraftImmutableSource";
                else if (sql.includes("FROM rms_pricing.tax_config_material_version"))
                  lateCandidateSourceStep = "MaterialImmutableSource";
                else if (sql.includes("PricingTaxCandidateIdentity:"))
                  lateCandidateSourceStep = "IdentityAdmission";
                else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_publication_candidate"))
                  lateCandidateSourceStep = "CandidateRecordInsert";
              }
              const result = await client.query(sql, values);
              if (
                lateCandidateFineRole !== null &&
                (sql.startsWith("INSERT INTO rms_pricing.tax_config_candidate_operation") ||
                  (stage === "MaterialLateFineWithdrawn" &&
                    sql.startsWith("INSERT INTO rms_pricing.tax_config_material_operation"))) &&
                result.rowCount === 1
              ) {
                const selectedRole = lateCandidateFineRole;
                lateCandidateFineRole = null;
                // The actual Category host drains its guards inside work(tx).
                // Inject after terminal original INSERT, before returning this
                // query to the owner's source rereads and actual host finals.
                // This same-tx mutation must roll back with the candidate or material.
                await client.query("RESET ROLE");
                const mutation = await client.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='pricing.tax-config.manage')",
                  [selectedRole],
                );
                assert.equal(mutation.rowCount, 1);
                lateCandidateInjected = true;
                lateCandidateSourceStep = "TerminalOriginalInserted";
                await client.query("SET LOCAL ROLE " + role);
              }
              return result;
            } catch (error) {
              sqlState = /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : "NONE";
              if (error?.code === "42501") {
                if (error.message === "Tax original availability unavailable")
                  permissionAsset = "TaxOriginalAvailabilityScope";
                else if (error.message === "Tax original scope unavailable")
                  permissionAsset = "TaxOriginalInsertScope";
                else {
                  const assets = [
                    "tax_configuration",
                    "tax_configuration_version",
                    "tax_configuration_rule",
                    "tax_configuration_operation_record",
                    "tax_config_authoring_operation",
                    "audit_record",
                    "audit_chain_head",
                    "outbox_event",
                  ];
                  const asset = assets.find(
                    (name) => error.message === "permission denied for table " + name,
                  );
                  const functions = [
                    "tax_config_authoring_operation_available",
                    "current_brand_id",
                    "current_store_id",
                    "is_uuid_v7",
                  ];
                  const deniedFunction = functions.find(
                    (name) => error.message === "permission denied for function " + name,
                  );
                  const schemas = [
                    "rms_pricing",
                    "platform_helpers",
                    "platform_audit",
                    "platform_eventing",
                  ];
                  const deniedSchema = schemas.find(
                    (name) => error.message === "permission denied for schema " + name,
                  );
                  permissionAsset =
                    asset ??
                    deniedFunction ??
                    deniedSchema ??
                    (sql ===
                    "SELECT rms_pricing.tax_config_authoring_operation_available($1) available"
                      ? "TaxOriginalAvailabilityAcl"
                      : "OtherRefusal");
                }
              }
              throw error;
            }
          },
        };
        const entries = [];
        hooks.set(tx, entries);
        const result = await work(tx);
        for (const entry of entries) await entry.guard();
        for (const entry of entries) entry.final();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (lateCandidateInjected || lateCandidateFineRole !== null) {
          const codes = new Set([
            "TAX_CONFIG_PERMISSION_DENIED",
            "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
            "STORE_SERVICE_PERMISSION_DENIED",
            "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
            "ERR_ASSERTION",
          ]);
          lateCandidateGuardCode = codes.has(error?.code)
            ? error.code
            : codes.has(error?.message)
              ? error.message
              : "OTHER_REFUSAL";
          const stack =
            error instanceof Error && typeof error.stack === "string" ? error.stack : "";
          const sites = [
            ["merchant-tax-config-capability", "TaxCapability"],
            ["current-policy-store", "PermissionOwner"],
            ["tax-config-candidate-store", "CandidateOwner"],
            ["merchant-tax-config-authoring", "TaxAuthoring"],
            ["merchant-category-transactions", "CategoryHost"],
          ];
          lateCandidateGuardSite =
            sites.find(([path]) => stack.includes(path))?.[1] ?? "OTHER_REFUSAL";
          if (error?.code === "ERR_ASSERTION") {
            const localLine = /tax-config-runtime-http\.mjs:(\d+):\d+/u.exec(stack)?.[1];
            lateCandidateAssertSite =
              localLine && Number(localLine) > 0 && Number(localLine) < 2000
                ? "HarnessLine" + localLine
                : "NonHarnessAssertion";
          }
        }
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_pricing.tax_configuration) roots,(SELECT count(*)::int FROM rms_pricing.tax_configuration_version) versions,(SELECT count(*)::int FROM rms_pricing.tax_configuration_rule) rules,(SELECT count(*)::int FROM rms_pricing.tax_config_authoring_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
      )
    ).rows[0];
  // Fixed finite diagnostics retain only public classifications and fixture phases.
  // The owner may normalize callback failures; preserve their classification here.
  const classifyFeatureFailure = (error) => {
    const allowed = new Set([
      "FEATURE_CONTROL_ADMIN_MUTATION_INVALID",
      "FEATURE_CONTROL_ADMIN_PERMISSION_DENIED",
      "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
      "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
      "FEATURE_CONTROL_INPUT_INVALID",
      "FEATURE_CONTROL_CONTEXT_INVALID",
      "ERR_ASSERTION",
    ]);
    if (featureCause === "NONE")
      featureCause = allowed.has(error?.code)
        ? error.code
        : [
              "STORE_SERVICE_PERMISSION_DENIED",
              "MERCHANT_SELECTED_CONTEXT_UNAVAILABLE",
              "BRAND_SERVICE_PERMISSION_DENIED",
            ].includes(error?.message)
          ? error.message
          : "UNCLASSIFIED";
  };
  const freshPersistence = (session) => ({ ...session.persistence, transactions, now });
  const storeAuthority = async (tx, session, action) => {
    const current = await createMerchantStoreScope(freshPersistence(session))(
      tx,
      session.sessionCookie,
      action,
    );
    assert.equal(current.selected.tenantReference, tenant);
    assert.equal(current.context.brand.brandReference, brand);
    assert.equal(current.context.store?.storeReference, store);
    assert.equal(current.actorReference, session.actor);
    assert(await current.allowed());
    const decision = await current.authorizeAction(action);
    assert.equal(decision?.effect, "Allow");
    assert.equal(decision?.action, action);
    return { current, decision };
  };
  const grant = async (actorReference, actions, kind = "Store") => {
    const membership = (
      await admin.query(
        "SELECT membership_id FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2",
        [actorReference, brand],
      )
    ).rows[0].membership_id;
    const assignment = (
      await admin.query(
        "SELECT assignment_id FROM bop_membership.store_assignment WHERE actor_id=$1 AND store_id=$2",
        [actorReference, store],
      )
    ).rows[0].assignment_id;
    const roleId = reference(),
      from = new Date(Date.parse(at) - 60000).toISOString(),
      until = new Date(Date.parse(at) + 3600000).toISOString();
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [roleId, brand, kind === "Store" ? store : null, "internal_test_tax_" + serial, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
      [
        reference(),
        roleId,
        membership,
        kind === "Store" ? assignment : null,
        actorReference,
        brand,
        kind === "Store" ? store : null,
        from,
        until,
      ],
    );
    for (const action of actions) {
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
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [reference(), roleId, permission, brand, kind === "Store" ? store : null, from, until],
      );
    }
    return roleId;
  };
  const currency = input().currencyMetadata;
  const unused = () => {
    throw new Error("TAX_HTTP_UNRELATED_CONFIGURATION_UNAVAILABLE");
  };
  const runtimeFor = (session) =>
    createMerchantRuntime({
      persistence: {
        ...freshPersistence(session),
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
      taxConfigAuthoring: { nextReference: reference, currencyMetadata: currency },
    });
  async function withHttp(session, work) {
    const app = express();
    app.use("/merchant", createMerchantBffRouter(runtimeFor(session)));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      const send = (
        endpoint,
        body,
        { selected = scope, csrf = session.csrf, query = "", dropReply = false } = {},
      ) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body),
            method = bytes === null ? "GET" : "POST";
          const req = request(
            {
              host: "127.0.0.1",
              port: address.port,
              path: "/merchant/tax-config/authoring/" + endpoint + query,
              method,
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + session.sessionCookie,
                ...(endpoint === "scope"
                  ? {}
                  : {
                      "x-bop-store-setup-scope": Buffer.from(
                        canonicalizeRfc8785(selected),
                      ).toString("base64url"),
                    }),
                ...(bytes === null
                  ? {}
                  : {
                      "x-bop-csrf": csrf,
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(bytes),
                    }),
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.once("error", reject);
              response.once("end", () => {
                try {
                  assert.equal(response.headers["cache-control"], "no-store");
                  lastStatus = String(response.statusCode);
                  if (dropReply) {
                    assert.equal(response.statusCode, 200);
                    resolve({ replyLost: true });
                    return;
                  }
                  resolve({
                    status: response.statusCode,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  });
                } catch {
                  reject(new Error("TAX_HTTP_RESPONSE_UNAVAILABLE"));
                }
              });
            },
          );
          req.setTimeout(15000, () => req.destroy(new Error("TAX_HTTP_TIMEOUT")));
          req.once("error", reject);
          req.end(bytes ?? undefined);
        });
      await work(send);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_pricing,rms_catalog,bop_feature_control,bop_operating_entity,platform_helpers,platform_audit,platform_eventing TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_pricing.tax_config_authoring_operation_available(platform_helpers.uuid_v7),rms_pricing.tax_config_material_operation_available(platform_helpers.uuid_v7),rms_pricing.tax_config_candidate_operation_available(platform_helpers.uuid_v7) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.tax_configuration_operation_record,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_pricing.tax_config_authoring_operation,rms_catalog.product_tax_classification_registry_record,bop_feature_control.control_version,bop_feature_control.control_dependency,bop_feature_control.control_operation,platform_audit.audit_record,platform_eventing.outbox_event TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_pricing.tax_config_material TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON rms_pricing.tax_config_publication_candidate,rms_pricing.tax_config_candidate_operation,rms_pricing.tax_config_candidate_rule TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_pricing.tax_config_material_version,rms_pricing.tax_config_material_operation TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT ON bop_operating_entity.operating_entity,bop_operating_entity.store_operating_entity_assignment,bop_operating_entity.brand_operating_entity_assignment,bop_operating_entity.operating_entity_profile_version TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE(version) ON bop_operating_entity.operating_entity,bop_operating_entity.store_operating_entity_assignment TO " +
        role,
    );
    const author = {
      ...(await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        role,
        scope,
        actor,
        at,
        referencePrefix: "01913151",
        sessionReferencePrefix: "01913152",
      })),
      actor,
    };
    const approver = {
      ...(await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        role,
        scope,
        actor: reviewer,
        at,
        referencePrefix: "01913153",
        sessionReferencePrefix: "01913154",
      })),
      actor: reviewer,
    };
    const authorRole = await grant(actor, [
      "pricing.tax-config.manage",
      "organization.manage",
      "feature.control.change",
      "feature.control.approve",
      "feature.control.publish",
      "feature.control.activate",
    ]);
    await grant(reviewer, [
      "pricing.tax-config.manage",
      "organization.manage",
      "feature.control.change",
      "feature.control.approve",
      "feature.control.publish",
      "feature.control.activate",
    ]);
    await grant(
      actor,
      ["catalog.manage", "catalog.tax-classification.manage", "catalog.tax-classification.read"],
      "Brand",
    );
    stage = "MissingFeature";
    const beforeFeature = await counts();
    await withHttp(author, async (send) => {
      assert.equal(
        (await send("scope", undefined, { query: "?storeReference=" + store })).status,
        503,
      );
    });
    assert.deepEqual(await counts(), beforeFeature);
    stage = "FeatureDefinition";
    let definition = createFeatureControlAdministrationDefinition({
      controlId: reference(),
      key: "pricing.taxconfig.authoring",
      description: "InternalTest Tax authoring capability",
      version: 1,
      ownerReference: actor,
      purposeCode: "TAX_CONFIG_CAPABILITY",
      scope: { kind: "Store", brandReference: brand, storeReference: store },
      source: "StoreOverride",
      defaultValue: "Disabled",
      configuredValue: "Enabled",
      lifecycle: "Draft",
      temporary: false,
      effectiveFrom: new Date(Date.parse(at) - 1000).toISOString(),
      effectiveUntil: null,
      reviewAt: new Date(Date.parse(at) + 3600000).toISOString(),
      expiresAt: null,
      dependencies: [],
      authoredByReference: actor,
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
    });
    const featureAction = {
      CreateDraft: "feature.control.change",
      Submit: "feature.control.change",
      Approve: "feature.control.approve",
      Publish: "feature.control.publish",
      Disable: "feature.control.activate",
    };
    stage = "FeatureCreateDraft";
    const featureAuthority = (session) => ({
      async holdUntilTransactionCompletes(tx, p) {
        featureCheckpoint = "AuthorityIdentity";
        try {
          assert.equal(p.actorReference, session.actor);
          assert.equal(p.brandReference, brand);
          assert.equal(p.storeReference, store);
          featureCheckpoint = "AuthorityScopePermission";
          await storeAuthority(tx, session, featureAction[p.operation]);
          featureCheckpoint = "AuthorityComplete";
        } catch (error) {
          classifyFeatureFailure(error);
          throw error;
        }
      },
    });
    definition = await createPostgresFeatureControlInitialDraftStore({
      brandReference: brand,
      storeReference: store,
      actorReference: actor,
      clock: { now },
      transactions,
      authority: featureAuthority(author),
    }).createDraft({
      definition,
      idempotencyKey: reference(),
      audit: {
        auditId: reference(),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: actor },
        actionCode: "FEATURE_CONTROL_SAVEDRAFT",
        targetType: "FeatureControl",
        targetId: definition.controlId,
        reasonCode: definition.purposeCode,
        correlationId: reference(),
        occurredAt: now(),
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
        retentionPolicyVersion: 1,
      },
    });
    const mutateFeature = async (operation, session, changes) => {
      stage = "Feature" + operation;
      featureCheckpoint = "Definition";
      const next = createFeatureControlAdministrationDefinition({
        ...definition,
        ...changes,
        version: definition.version + 1,
      });
      const unitOfWork = createPostgresFeatureControlAdministrationMutationStore({
        brandReference: brand,
        storeReference: store,
        actorReference: session.actor,
        clock: { now },
        transactions,
        authority: featureAuthority(session),
        dependencies: {
          async withHeldCurrentPublicationEvidence(_tx, p, work) {
            assert.deepEqual(p.current.dependencies, []);
            assert.deepEqual(p.next.dependencies, []);
            return await work();
          },
        },
      });
      featureCheckpoint = "InitialScopePermission";
      const contextAndDecision = await transactions.run((tx) =>
        storeAuthority(tx, session, featureAction[operation]),
      );
      featureCheckpoint = "PublicExecute";
      definition = await executeFeatureControlAdministration(
        {
          tenantContext: contextAndDecision.current.context,
          operation,
          expectedVersion: definition.version,
          idempotencyKey: reference(),
          current: definition,
          next,
          auditId: reference(),
          correlationId: reference(),
          sourceChannel: "API",
        },
        {
          authorization: {
            authorize: () =>
              transactions.run(
                async (tx) =>
                  (await storeAuthority(tx, session, featureAction[operation])).decision,
              ),
          },
          unitOfWork,
        },
      );
    };
    await mutateFeature("Submit", author, { lifecycle: "PendingApproval" });
    await mutateFeature("Approve", approver, {
      lifecycle: "Approved",
      approvedByReference: reviewer,
      approvalEvidenceReference: reference(),
    });
    await mutateFeature("Publish", author, {
      lifecycle: "Published",
      publicationReference: reference(),
    });
    stage = "CatalogProducer";
    const registryAt = now(),
      classification = reference(),
      registry = {
        profile: "CatalogProductTaxClassificationRegistryV1",
        tenantReference: tenant,
        brandReference: brand,
        registryReference: reference(),
        versionReference: reference(),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt: registryAt,
        definitions: [
          {
            classificationReference: classification,
            code: "INTERNAL_TEST_CLASS",
            localizedNames: { "en-CA": "InternalTest classification" },
            lifecycle: "Active",
          },
        ],
        defaultClassificationReference: classification,
      };
    await createPostgresProductTaxClassificationRegistryStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      clock: { now },
      transactions,
      registerBeforeCommit: async (tx, guard, final) => {
        assert(hooks.has(tx));
        hooks.get(tx).push({ guard, final });
      },
      authority: {
        async holdUntilTransactionCompletes(tx, p) {
          assert.equal(p.permission, "catalog.manage");
          assert.equal(p.action, "catalog.tax-classification.manage");
          assert.equal(p.purposeCode, "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY");
          assert.deepEqual(p.requiredFields, taxClassificationRegistryFields);
          const current = await createMerchantStoreScope(freshPersistence(author))(
            tx,
            author.sessionCookie,
            "merchant.access",
          );
          assert(await current.allowed());
          const selected = await createMerchantBrandScope(freshPersistence(author))(
            tx,
            author.sessionCookie,
            current.sessionReference,
          );
          for (const action of [p.permission, p.action])
            assert.equal((await selected.authorizeAction(action))?.effect, "Allow");
        },
      },
      audit: {
        create(command) {
          return {
            auditId: reference(),
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
    }).execute({
      purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: reference(),
      expectedRegistryVersion: 0,
      occurredAt: registryAt,
      reasonCode: "INTERNAL_TEST_CLASSIFICATION",
      registry,
    });
    const initial = parseTaxConfigAuthoringCommand({
      action: "CreateDraft",
      operationReference: reference(),
      configurationReference: null,
      expectedAggregateVersion: null,
      content: {
        stableCode: "INTERNAL_TEST_TAX",
        effectivePeriod: input().taxConfiguration.effectivePeriod,
        rules: [
          {
            taxClassificationReference: classification,
            orderType: "Pickup",
            chargeType: "Sellable",
            taxComponentCode: "INTERNAL_TEST_TAX",
            treatment: "Taxable",
            rate: "0.13",
            priceInclusion: "Exclusive",
            roundingMode: "HalfUp",
            calculationOrder: 1,
            compoundOnPriorTax: false,
            exceptionEvidenceReference: null,
            receiptPresentationCode: "INTERNAL_TEST_TAX",
          },
        ],
      },
    });
    const original = (cmd) => ({
      action: cmd.action,
      operationReference: cmd.operationReference,
      configurationReference: cmd.configurationReference,
      expectedAggregateVersion: cmd.expectedAggregateVersion,
      intentDigest: taxConfigAuthoringIntentDigest(scope, cmd),
    });
    await withHttp(author, async (send) => {
      stage = "Scope";
      const bootstrap = await send("scope", undefined, { query: "?storeReference=" + store });
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.body.state, null);
      for (const [key, value] of Object.entries(scope)) assert.equal(bootstrap.body[key], value);
      const choices = await send("classifications", undefined, {
        query: "?storeReference=" + store,
      });
      assert.equal(choices.status, 200);
      assert.equal(choices.body.registryReference, registry.registryReference);
      assert.equal(choices.body.choices[0].classificationReference, classification);
      stage = "MaterialRegistrantAbsence";
      assert.equal(
        (await send("tax-registrant", undefined, { query: "?storeReference=" + store })).body,
        null,
      );
      const sourceAt = now(),
        entity = reference(),
        profile = reference();
      await admin.query(
        `INSERT INTO bop_operating_entity.operating_entity(
        operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,
        tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,
        lifecycle,version,created_at,updated_at
      ) VALUES($1,'LegalEntity','Controlled registration source',NULL,'CA-ON',$2,NULL,NULL,NULL,$3,'Active',1,$4,$4)`,
        [entity, reference(), reference(), sourceAt],
      );
      await admin.query(
        `INSERT INTO bop_operating_entity.store_operating_entity_assignment(
        assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at
      ) VALUES($1,$2,$3,$4,'TaxRegistrant','Active',$5,NULL,1,$5,$5)`,
        [reference(), brand, store, entity, sourceAt],
      );
      await admin.query(
        `INSERT INTO bop_operating_entity.operating_entity_profile_version(
        profile_version_id,brand_id,store_id,operating_entity_id,profile_version,legal_name,trade_name,jurisdiction_code,
        registration_reference,tax_registration_reference,registered_address_reference,billing_identity_reference,
        settlement_reference,evidence_references,recorded_by_reference,recorded_at,data_classification
      ) SELECT $1,$2,NULL,operating_entity_id,7,legal_name,trade_name,jurisdiction_code,registration_reference,
        tax_registration_reference,NULL,NULL,NULL,ARRAY[evidence_reference],$3,$4,'RestrictedReferenceMetadata'
        FROM bop_operating_entity.operating_entity WHERE operating_entity_id=$5`,
        [profile, brand, actor, sourceAt, entity],
      );
      stage = "MaterialRegistrantCurrent";
      const registrationSource = await send("tax-registrant", undefined, {
        query: "?storeReference=" + store,
      });
      assert.equal(registrationSource.status, 200);
      assert.equal(registrationSource.body.operatingEntityProfileVersionReference, profile);
      assert.equal(registrationSource.body.taxRegistrationReference, null);
      assert.equal(registrationSource.body.profileVersion, 7);
      const material = parseTaxConfigMaterialCommand({
        action: "CreateMaterial",
        operationReference: reference(),
        materialReference: null,
        expectedRevision: null,
        materialKind: "RegistrationApplicability",
        content: {
          operatingEntityProfileVersionReference: profile,
          operatingEntityTaxReference: null,
          jurisdictionCode: "CA-ON",
          applicability: "NotApplicable",
          sourceIssuedAt: sourceAt,
          effectiveFrom: sourceAt,
          effectiveUntil: null,
          declaredSourceDigest: null,
        },
      });
      const materialOriginal = (command) => ({
        action: command.action,
        operationReference: command.operationReference,
        materialReference: command.materialReference,
        expectedRevision: command.expectedRevision,
        materialKind: command.materialKind,
        intentDigest: taxConfigMaterialIntentDigest(scope, command),
      });
      stage = "MaterialLostReply";
      assert.deepEqual(await send("materials/commands", material, { dropReply: true }), {
        replyLost: true,
      });
      const saved = parseTaxConfigMaterialOperation(
        (await send("materials/resolve-original", materialOriginal(material))).body,
      );
      assert.equal(saved.outcome, "Committed");
      assert.equal(saved.version.content.operatingEntityTaxReference, null);
      assert.equal(saved.version.qualification, "NotEvaluated");
      assert.deepEqual((await send("materials/commands", material)).body, saved);
      stage = "MaterialReplace";
      const replacementMaterial = parseTaxConfigMaterialCommand({
        ...material,
        action: "ReplaceMaterial",
        operationReference: reference(),
        materialReference: saved.version.materialReference,
        expectedRevision: 1,
        content: { ...material.content, applicability: "Applicable" },
      });
      const replaced = parseTaxConfigMaterialOperation(
        (await send("materials/commands", replacementMaterial)).body,
      );
      assert.equal(replaced.version.revision, 2);
      assert.equal(replaced.version.previousVersionReference, saved.version.versionReference);
      const selection = "?storeReference=" + store + "&materialKind=RegistrationApplicability";
      const materialCurrent = await send("materials/current", undefined, {
        query: selection + "&materialReference=" + saved.version.materialReference,
      });
      assert.equal(materialCurrent.status, 200);
      assert.deepEqual(materialCurrent.body.version, replaced.version);
      const materialHistory = await send("materials/version", undefined, {
        query: selection + "&versionReference=" + saved.version.versionReference,
      });
      assert.equal(materialHistory.status, 200);
      assert.deepEqual(materialHistory.body.version, saved.version);
      const materialRoster = await send("materials/roster", undefined, { query: selection });
      assert.equal(materialRoster.status, 200);
      assert.equal(materialRoster.body.entries.length, 1);
      assert.equal(Object.hasOwn(materialRoster.body.entries[0], "content"), false);
      assert.deepEqual(
        (await send("materials/resolve-original", materialOriginal(material))).body,
        saved,
      );
      stage = "MaterialForgedSource";
      const beforeMaterial = (
        await admin.query("SELECT count(*)::int n FROM rms_pricing.tax_config_material_operation")
      ).rows[0].n;
      const forged = await send("materials/commands", {
        ...material,
        operationReference: reference(),
        content: { ...material.content, operatingEntityProfileVersionReference: reference() },
      });
      assert.equal(forged.status, 409);
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM rms_pricing.tax_config_material_operation"))
          .rows[0].n,
        beforeMaterial,
      );
      const draftBaseline = await counts();
      stage = "CreateLostReply";
      assert.deepEqual(await send("commands", initial, { dropReply: true }), { replyLost: true });
      const resolve = await send("resolve-original", original(initial));
      assert.equal(resolve.status, 200);
      const first = parseTaxConfigAuthoringOperation(resolve.body);
      assert.equal(first.outcome, "Committed");
      assert.equal(first.snapshot.lifecycle, "Draft");
      assert.deepEqual((await send("commands", initial)).body, first);
      stage = "Replace";
      const replacement = parseTaxConfigAuthoringCommand({
        ...initial,
        action: "ReplaceDraft",
        operationReference: reference(),
        configurationReference: first.snapshot.configurationReference,
        expectedAggregateVersion: 1,
        content: { ...initial.content, rules: [{ ...initial.content.rules[0], rate: "0.14" }] },
      });
      const secondResponse = await send("commands", replacement);
      assert.equal(secondResponse.status, 200);
      const second = parseTaxConfigAuthoringOperation(secondResponse.body);
      assert.equal(second.snapshot.aggregateVersion, 2);
      assert.notEqual(second.snapshot.versionReference, first.snapshot.versionReference);
      assert.deepEqual(
        (await send("commands", initial)).body,
        first,
        "original replay retains original snapshot after successor",
      );
      stage = "Current";
      const current = await send("current", undefined, {
        query:
          "?storeReference=" +
          store +
          "&configurationReference=" +
          second.snapshot.configurationReference,
      });
      assert.equal(current.status, 200);
      assert.deepEqual(current.body.state.snapshot, JSON.parse(JSON.stringify(second.snapshot)));
      assert.equal(
        (await send("roster", undefined, { query: "?storeReference=" + store })).status,
        200,
      );
      stage = "DraftMechanicalSimulation";
      for (const [kind, amount, tax] of [
        ["Basket", "1000", "140"],
        ["Refund", "-1000", "-140"],
      ]) {
        const simulation = await send("simulate", {
          configurationReference: second.snapshot.configurationReference,
          expectedVersionReference: second.snapshot.versionReference,
          expectedSnapshotDigest: second.snapshot.snapshotDigest,
          fixture: {
            profile: "TaxDraftFixtureV1",
            fixtureReference: reference(),
            kind,
            evaluatedAt: now(),
            lines: [
              {
                lineReference: reference(),
                calculationReferences: [reference()],
                labelCode: "INTERNAL_TEST_LINE",
                taxClassificationReference: classification,
                orderType: "Pickup",
                chargeType: "Sellable",
                amountMinor: amount,
              },
            ],
          },
        });
        assert.equal(simulation.status, 200);
        assert.equal(simulation.body.simulation.taxAmountMinor, tax);
        assert.equal(simulation.body.simulation.professionalReviewStatus, "NotEvaluated");
        assert.equal(simulation.body.simulation.legalConclusion, "NotEvaluated");
      }
      stage = "Refusals";
      const before = await counts();
      assert.equal(
        (await send("commands", { ...replacement, operationReference: reference() })).status,
        409,
      );
      assert.equal(
        (await send("commands", initial, { selected: { ...scope, actorReference: reviewer } }))
          .status,
        403,
      );
      assert.equal((await send("commands", initial, { csrf: "A".repeat(43) })).status, 403);
      assert.deepEqual(await counts(), before);
      stage = "Abandoned";
      const absent = parseTaxConfigAuthoringCommand({
        ...initial,
        operationReference: reference(),
        content: { ...initial.content, stableCode: "INTERNAL_TEST_ABANDONED" },
      });
      const abandoned = await send("resolve-original", original(absent));
      assert.equal(abandoned.status, 200);
      assert.equal(abandoned.body.outcome, "Abandoned");
      const after = await counts();
      assert.deepEqual((await send("commands", absent)).body, abandoned.body);
      assert.deepEqual(await counts(), after);
      assert.deepEqual(await counts(), {
        roots: draftBaseline.roots + 1,
        versions: draftBaseline.versions + 2,
        rules: draftBaseline.rules + 2,
        originals: draftBaseline.originals + 3,
        audits: draftBaseline.audits + 3,
        events: draftBaseline.events + 2,
      });
      stage = "CandidatePrepareLostReply";
      const candidateCounts = async () => ({
        ...(await counts()),
        ...(
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_pricing.tax_config_publication_candidate) candidates,(SELECT count(*)::int FROM rms_pricing.tax_config_candidate_rule) reservations,(SELECT count(*)::int FROM rms_pricing.tax_config_candidate_operation) candidateOriginals",
          )
        ).rows[0],
      });
      const candidateBaseline = await candidateCounts();
      const candidateCommand = parseTaxConfigCandidateCommand({
        action: "PrepareCandidate",
        operationReference: reference(),
        configurationReference: second.snapshot.configurationReference,
        expectedDraft: {
          versionReference: second.snapshot.versionReference,
          snapshotDigest: second.snapshot.snapshotDigest,
          aggregateVersion: second.snapshot.aggregateVersion,
          versionNumber: second.snapshot.versionNumber,
        },
        registrationMaterial: {
          materialReference: replaced.version.materialReference,
          versionReference: replaced.version.versionReference,
          contentDigest: replaced.version.contentDigest,
        },
      });
      const candidateQuery =
        "?storeReference=" +
        store +
        "&configurationReference=" +
        candidateCommand.configurationReference;
      const emptyCandidate = await send("candidates/current", undefined, { query: candidateQuery });
      assert.equal(emptyCandidate.status, 200);
      assert.equal(parseTaxConfigCandidateCurrent(emptyCandidate.body).record, null);
      assert.deepEqual(await send("candidates/commands", candidateCommand, { dropReply: true }), {
        replyLost: true,
      });
      const candidateOriginal = {
        ...candidateCommand,
        intentDigest: taxConfigCandidateIntentDigest(scope, candidateCommand),
      };
      const recoveredCandidate = await send("candidates/resolve-original", candidateOriginal);
      assert.equal(recoveredCandidate.status, 200);
      const candidateReceipt = parseTaxConfigCandidateOperation(recoveredCandidate.body);
      assert.equal(candidateReceipt.outcome, "Committed");
      assert.equal(candidateReceipt.result.qualification, "NotEvaluated");
      assert.equal(candidateReceipt.result.candidate.content.rules[0].rate, "0.14");
      assert.deepEqual(
        (await send("candidates/commands", candidateCommand)).body,
        candidateReceipt,
      );
      const target = candidateReceipt.result.candidate.content.targetVersionReference;
      const currentCandidate = await send("candidates/current", undefined, {
        query: candidateQuery + "&targetVersionReference=" + target,
      });
      assert.equal(currentCandidate.status, 200);
      assert.deepEqual(
        parseTaxConfigCandidateCurrent(currentCandidate.body).record,
        candidateReceipt.result,
      );
      const latestCandidate = await send("candidates/current", undefined, {
        query: candidateQuery,
      });
      assert.equal(latestCandidate.status, 200);
      assert.deepEqual(
        parseTaxConfigCandidateCurrent(latestCandidate.body).record,
        candidateReceipt.result,
      );
      const rosterCandidate = await send("candidates/roster", undefined, { query: candidateQuery });
      assert.equal(rosterCandidate.status, 200);
      const candidateRoster = parseTaxConfigCandidateRoster(rosterCandidate.body);
      assert.equal(candidateRoster.entries.length, 1);
      assert.equal(candidateRoster.entries[0].targetVersionReference, target);
      assert.equal(JSON.stringify(candidateRoster).includes('"rules"'), false);
      assert.equal(JSON.stringify(candidateRoster).includes("operatingEntityTaxReference"), false);
      stage = "CandidateForgedPins";
      const beforeForgedCandidate = await candidateCounts();
      assert.equal(
        (
          await send("candidates/commands", {
            ...candidateCommand,
            operationReference: reference(),
            registrationMaterial: {
              ...candidateCommand.registrationMaterial,
              contentDigest: "sha256:" + "a".repeat(64),
            },
          })
        ).status,
        409,
      );
      assert.deepEqual(await candidateCounts(), beforeForgedCandidate);
      stage = "CandidateHistoricalAfterDraftAdvance";
      const thirdResponse = await send("commands", {
        ...replacement,
        operationReference: reference(),
        expectedAggregateVersion: 2,
        content: {
          ...replacement.content,
          rules: [{ ...replacement.content.rules[0], rate: "0.15" }],
        },
      });
      assert.equal(thirdResponse.status, 200);
      const third = parseTaxConfigAuthoringOperation(thirdResponse.body);
      assert.equal(third.snapshot.aggregateVersion, 3);
      const beforeCandidateReplay = await candidateCounts();
      assert.deepEqual(
        (await send("candidates/resolve-original", candidateOriginal)).body,
        candidateReceipt,
      );
      assert.deepEqual(
        (await send("candidates/commands", candidateCommand)).body,
        candidateReceipt,
      );
      const historicCandidate = await send("candidates/current", undefined, {
        query: candidateQuery + "&targetVersionReference=" + target,
      });
      assert.equal(historicCandidate.status, 200);
      assert.equal(
        parseTaxConfigCandidateCurrent(historicCandidate.body).record.candidate.content.rules[0]
          .rate,
        "0.14",
      );
      assert.deepEqual(await candidateCounts(), beforeCandidateReplay);
      stage = "CandidateLateFineWithdrawn";
      const lateCommand = {
        ...candidateCommand,
        operationReference: reference(),
        expectedDraft: {
          versionReference: third.snapshot.versionReference,
          snapshotDigest: third.snapshot.snapshotDigest,
          aggregateVersion: third.snapshot.aggregateVersion,
          versionNumber: third.snapshot.versionNumber,
        },
      };
      const beforeLateCandidate = await candidateCounts();
      const grantState = async () =>
        (
          await admin.query(
            "SELECT lifecycle,version FROM bop_permission.permission_grant WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='pricing.tax-config.manage')",
            [authorRole],
          )
        ).rows;
      const beforeLateGrant = await grantState();
      assert.equal(beforeLateGrant.length, 1);
      assert.equal(beforeLateGrant[0].lifecycle, "Active");
      lateCandidateFineRole = authorRole;
      const lateCandidateResponse = await send("candidates/commands", lateCommand);
      assert.equal(lateCandidateFineRole, null);
      assert.deepEqual(
        await grantState(),
        beforeLateGrant,
        "Late IAM mutation must roll back with the Candidate write",
      );
      assert.deepEqual(await candidateCounts(), beforeLateCandidate);
      assert.equal(
        lateCandidateResponse.status,
        403,
        "Actual late guard classification=" +
          lateCandidateGuardCode +
          " site=" +
          lateCandidateGuardSite,
      );
      stage = "CandidateAbandoned";
      const absentCandidate = { ...lateCommand, operationReference: reference() },
        absentCandidateOriginal = {
          ...absentCandidate,
          intentDigest: taxConfigCandidateIntentDigest(scope, absentCandidate),
        };
      const abandonedCandidateResponse = await send(
        "candidates/resolve-original",
        absentCandidateOriginal,
      );
      assert.equal(abandonedCandidateResponse.status, 200);
      const abandonedCandidate = parseTaxConfigCandidateOperation(abandonedCandidateResponse.body);
      assert.equal(abandonedCandidate.outcome, "Abandoned");
      const afterCandidateAbandon = await candidateCounts();
      assert.deepEqual(
        (await send("candidates/commands", absentCandidate)).body,
        abandonedCandidate,
      );
      assert.deepEqual(await candidateCounts(), afterCandidateAbandon);
      assert.deepEqual(afterCandidateAbandon, {
        ...candidateBaseline,
        versions: candidateBaseline.versions + 1,
        rules: candidateBaseline.rules + 1,
        originals: candidateBaseline.originals + 1,
        audits: candidateBaseline.audits + 3,
        events: candidateBaseline.events + 2,
        candidates: 1,
        reservations: 1,
        candidateoriginals: 2,
      });
      stage = "CandidateBoundSuiteAndReport";
      const candidatePin = {
        versionReference: target,
        contentDigest: candidateReceipt.result.candidate.contentDigest,
      };
      const fixtureReference = reference(),
        lineReference = reference();
      const suiteCommand = parseTaxConfigMaterialCommand({
        action: "CreateMaterial",
        operationReference: reference(),
        materialReference: null,
        expectedRevision: null,
        materialKind: "FixtureSuite",
        content: {
          targetPublicationCandidate: candidatePin,
          currencyMetadata: candidateReceipt.result.candidate.content.currencyMetadata,
          sourceIssuedAt: now(),
          declaredSourceDigest: null,
          cases: [
            {
              fixture: {
                profile: "TaxDraftFixtureV1",
                fixtureReference,
                kind: "Basket",
                evaluatedAt: now(),
                lines: [
                  {
                    lineReference,
                    calculationReferences: [reference()],
                    labelCode: "INTERNAL_TEST_LINE",
                    taxClassificationReference: classification,
                    orderType: "Pickup",
                    chargeType: "Sellable",
                    amountMinor: "1000",
                  },
                ],
              },
              expected: {
                fixtureReference,
                kind: "Basket",
                configurationReference: candidateCommand.configurationReference,
                versionReference: target,
                snapshotDigest: candidatePin.contentDigest,
                netAmountMinor: "1000",
                taxAmountMinor: "140",
                grossAmountMinor: "1140",
                receiptPreview: [
                  {
                    lineReference,
                    labelCode: "INTERNAL_TEST_LINE",
                    componentCode: "INTERNAL_TEST_TAX",
                    treatment: "Taxable",
                    rate: "0.14",
                    taxAmountMinor: "140",
                  },
                ],
              },
            },
          ],
        },
      });
      assert.deepEqual(await send("materials/commands", suiteCommand, { dropReply: true }), {
        replyLost: true,
      });
      const suiteResponse = await send(
        "materials/resolve-original",
        materialOriginal(suiteCommand),
      );
      assert.equal(suiteResponse.status, 200);
      const suiteReceipt = parseTaxConfigMaterialOperation(suiteResponse.body);
      assert.equal(suiteReceipt.outcome, "Committed");
      assert.equal(suiteReceipt.version.qualification, "NotEvaluated");
      assert.deepEqual((await send("materials/commands", suiteCommand)).body, suiteReceipt);
      const reviewedAt = now();
      const reportCommand = parseTaxConfigMaterialCommand({
        action: "CreateMaterial",
        operationReference: reference(),
        materialReference: null,
        expectedRevision: null,
        materialKind: "ProfessionalReport",
        content: {
          targetPublicationCandidate: candidatePin,
          registrationMaterial: {
            versionReference: replaced.version.versionReference,
            contentDigest: replaced.version.contentDigest,
          },
          fixtureSuiteMaterial: {
            versionReference: suiteReceipt.version.versionReference,
            contentDigest: suiteReceipt.version.contentDigest,
          },
          declaredIssuer: {
            displayName: "Controlled external declaration",
            organizationName: null,
            credentialIdentifier: null,
          },
          reviewedAt,
          validUntil: new Date(Date.parse(reviewedAt) + 86400000).toISOString(),
          declaredConclusion: "Pass",
          declaredSourceDigest: null,
        },
      });
      const reportResponse = await send("materials/commands", reportCommand);
      assert.equal(reportResponse.status, 200);
      const reportReceipt = parseTaxConfigMaterialOperation(reportResponse.body);
      assert.equal(reportReceipt.version.qualification, "NotEvaluated");
      assert.equal(reportReceipt.version.content.declaredConclusion, "Pass");
      assert.deepEqual(
        (await send("materials/resolve-original", materialOriginal(reportCommand))).body,
        reportReceipt,
      );
      const materialCounts = async () => ({
        ...(await candidateCounts()),
        ...(
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_pricing.tax_config_material) materialroots,(SELECT count(*)::int FROM rms_pricing.tax_config_material_version) materialversions,(SELECT count(*)::int FROM rms_pricing.tax_config_material_operation) materialoriginals",
          )
        ).rows[0],
      });
      const beforeMaterialForgery = await materialCounts();
      const wrongDigest = "sha256:" + "b".repeat(64);
      const wrongSuite = parseTaxConfigMaterialCommand({
        ...suiteCommand,
        operationReference: reference(),
        content: {
          ...suiteCommand.content,
          targetPublicationCandidate: { ...candidatePin, contentDigest: wrongDigest },
          cases: suiteCommand.content.cases.map((c) => ({
            ...c,
            expected: { ...c.expected, snapshotDigest: wrongDigest },
          })),
        },
      });
      assert.equal((await send("materials/commands", wrongSuite)).status, 409);
      assert.equal(
        (
          await send("materials/commands", {
            ...reportCommand,
            operationReference: reference(),
            content: {
              ...reportCommand.content,
              registrationMaterial: {
                ...reportCommand.content.registrationMaterial,
                contentDigest: wrongDigest,
              },
            },
          })
        ).status,
        409,
      );
      assert.deepEqual(await materialCounts(), beforeMaterialForgery);
      stage = "MaterialLateFineWithdrawn";
      const beforeLateMaterial = await materialCounts(),
        beforeMaterialGrant = await grantState();
      lateCandidateFineRole = authorRole;
      const lateMaterial = await send("materials/commands", {
        ...suiteCommand,
        operationReference: reference(),
      });
      assert.equal(lateCandidateFineRole, null);
      assert.equal(lateMaterial.status, 403);
      assert.deepEqual(await grantState(), beforeMaterialGrant);
      assert.deepEqual(await materialCounts(), beforeLateMaterial);
      stage = "MaterialImmutableHistory";
      const historicalSuite = await send("materials/version", undefined, {
        query:
          "?storeReference=" +
          store +
          "&materialKind=FixtureSuite&versionReference=" +
          suiteReceipt.version.versionReference,
      });
      assert.equal(historicalSuite.status, 200);
      assert.deepEqual(historicalSuite.body.version, suiteReceipt.version);
      stage = "MaterialActualCandidateComparison";
      const compareCommand = {
        configurationReference: candidateCommand.configurationReference,
        targetPublicationCandidate: candidatePin,
        fixtureSuiteMaterial: {
          materialReference: suiteReceipt.version.materialReference,
          versionReference: suiteReceipt.version.versionReference,
          contentDigest: suiteReceipt.version.contentDigest,
        },
      };
      const beforeComparison = await materialCounts();
      const comparisonResponse = await send("materials/compare", compareCommand);
      assert.equal(comparisonResponse.status, 200);
      assert.equal(comparisonResponse.body.profile, "TaxConfigMaterialComparisonV1");
      for (const [key, value] of Object.entries(scope))
        assert.equal(comparisonResponse.body[key], value);
      assert.equal(comparisonResponse.body.comparison.allCasesMatched, true);
      assert.equal(comparisonResponse.body.comparison.professionalReviewStatus, "NotEvaluated");
      assert.equal(comparisonResponse.body.comparison.legalConclusion, "NotEvaluated");
      assert.deepEqual(comparisonResponse.body.comparison.candidate, candidatePin);
      assert.deepEqual(
        comparisonResponse.body.comparison.suite,
        compareCommand.fixtureSuiteMaterial,
      );
      assert.equal(comparisonResponse.body.comparison.cases.length, 1);
      assert.equal(
        comparisonResponse.body.comparison.cases[0].actualDigest,
        comparisonResponse.body.comparison.cases[0].expectedDigest,
      );
      assert.deepEqual(comparisonResponse.body.comparison.cases[0].mismatchedFields, []);
      assert.deepEqual(await materialCounts(), beforeComparison);
      const mismatchCommand = parseTaxConfigMaterialCommand({
        ...suiteCommand,
        operationReference: reference(),
        content: {
          ...suiteCommand.content,
          cases: suiteCommand.content.cases.map((c) => ({
            ...c,
            expected: {
              ...c.expected,
              taxAmountMinor: "141",
              grossAmountMinor: "1141",
              receiptPreview: c.expected.receiptPreview.map((p) => ({
                ...p,
                taxAmountMinor: "141",
              })),
            },
          })),
        },
      });
      const mismatchSaved = await send("materials/commands", mismatchCommand);
      assert.equal(mismatchSaved.status, 200);
      const mismatchReceipt = parseTaxConfigMaterialOperation(mismatchSaved.body);
      assert.equal(mismatchReceipt.version.qualification, "NotEvaluated");
      const mismatchComparisonCommand = {
        ...compareCommand,
        fixtureSuiteMaterial: {
          materialReference: mismatchReceipt.version.materialReference,
          versionReference: mismatchReceipt.version.versionReference,
          contentDigest: mismatchReceipt.version.contentDigest,
        },
      };
      const beforeMismatchCompare = await materialCounts();
      const mismatchResponse = await send("materials/compare", mismatchComparisonCommand);
      assert.equal(mismatchResponse.status, 200);
      assert.equal(mismatchResponse.body.comparison.allCasesMatched, false);
      assert.deepEqual(mismatchResponse.body.comparison.cases[0].mismatchedFields, [
        "taxAmountMinor",
        "grossAmountMinor",
        "receiptPreview",
      ]);
      assert.notEqual(
        mismatchResponse.body.comparison.cases[0].actualDigest,
        mismatchResponse.body.comparison.cases[0].expectedDigest,
      );
      assert.equal(mismatchResponse.body.referenceEligibility, "NotEvaluated");
      assert.equal(
        (
          await send("materials/compare", {
            ...compareCommand,
            fixtureSuiteMaterial: {
              ...compareCommand.fixtureSuiteMaterial,
              contentDigest: wrongDigest,
            },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await send("materials/compare", {
            ...compareCommand,
            targetPublicationCandidate: { ...candidatePin, contentDigest: wrongDigest },
          })
        ).status,
        409,
      );
      assert.deepEqual(await materialCounts(), beforeMismatchCompare);
      stage = "FeatureDisabled";
      await mutateFeature("Disable", author, {
        lifecycle: "Disabled",
        configuredValue: "Disabled",
      });
      const disabledCounts = await counts();
      const disabled = await send("scope", undefined, { query: "?storeReference=" + store });
      assert.equal(disabled.status, 503);
      assert.equal(disabled.body.error, "tax_config_authoring_feature_disabled");
      assert.deepEqual(await counts(), disabledCounts);
      stage = "FinePermissionWithdrawn";
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='pricing.tax-config.manage')",
        [authorRole],
      );
      const deniedCounts = await materialCounts();
      for (const [endpoint, body, query] of [
        ["scope", undefined, "?storeReference=" + store],
        ["commands", initial, ""],
        ["resolve-original", original(initial), ""],
        ["candidates/current", undefined, candidateQuery + "&targetVersionReference=" + target],
        ["candidates/resolve-original", candidateOriginal, ""],
        ["materials/commands", suiteCommand, ""],
        ["materials/resolve-original", materialOriginal(reportCommand), ""],
        ["materials/compare", compareCommand, ""],
      ])
        assert.equal((await send(endpoint, body, { query })).status, 403);
      assert.deepEqual(await materialCounts(), deniedCounts);
    });
  } catch (error) {
    if (stage.startsWith("Feature")) classifyFeatureFailure(error);
    throw new Error(
      `TAX_RUNTIME_HTTP_FAILED stage=${stage} status=${lastStatus} SQLSTATE=${sqlState} permissionAsset=${permissionAsset} featureCheckpoint=${featureCheckpoint} featureCode=${featureCause} lateGuardCode=${lateCandidateGuardCode} lateGuardSite=${lateCandidateGuardSite} lateSourceStep=${lateCandidateSourceStep} lateAssertSite=${lateCandidateAssertSite}`,
      { cause: error },
    );
  } finally {
    if (createdRole) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
