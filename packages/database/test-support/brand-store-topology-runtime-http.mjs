import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { seedStorePublication } from "./store-publication-seed.mjs";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyOperationReceipt,
} from "../../bop/tenant/src/index.ts";
import {
  createFeatureControlAdministrationDefinition,
  createPostgresFeatureControlInitialDraftStore,
  createPostgresFeatureControlAdministrationMutationStore,
  executeFeatureControlAdministration,
} from "../../bop/feature-control/src/index.ts";
import { createMerchantRuntime } from "../../../apps/api/dist/merchant-runtime.js";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const id = (n) => `01902421-2300-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Isolated synthetic identities/labels/OIDC association and naming definitions.
 * Session encryption, current IAM, public Feature producer, Tenant owners, actual
 * Audit, runtime/BFF/HTTP and PostgreSQL are real. This proves Draft preparation,
 * never effective membership, governance approval or external Store readiness. */
export async function exerciseBrandStoreTopologyRuntimeHttp(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_topology_http_" + context.runId;
  assert.match(role, /^wp2421_topology_http_[a-f0-9]+$/u);
  const tenant = id(1),
    brand = id(2),
    store = id(3),
    actor = id(4),
    reviewer = id(5);
  const now = () => new Date().toISOString(),
    at = now();
  const scope = { tenantReference: tenant, brandReference: brand, actorReference: actor };
  const selectedScope = { ...scope, storeReference: store };
  let serial = 100,
    createdRole = false,
    stage = "Seed",
    lastStatus = "NONE",
    sqlState = "NONE",
    sqlAsset = "NONE",
    deniedAsset = "NONE",
    lateRole = null,
    lateNavigationRole = null;
  const reference = () => id(++serial);
  await admin.connect();
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
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        const tx = {
          async query(sql, values = []) {
            try {
              const result = await client.query(sql, values);
              if (
                lateRole !== null &&
                sql.startsWith("INSERT INTO bop_tenant.brand_store_topology_draft_operation") &&
                result.rowCount === 1
              ) {
                const revoke = lateRole;
                lateRole = null;
                await client.query("RESET ROLE");
                const changed = await client.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage')",
                  [revoke],
                );
                assert.equal(changed.rowCount, 1);
                await client.query("SET LOCAL ROLE " + role);
              }
              if (
                lateNavigationRole !== null &&
                stage === "NavigationLatePermissionWithdraw" &&
                sql.includes("FROM bop_feature_control.control_version") &&
                result.rows.length > 0
              ) {
                const revoke = lateNavigationRole;
                lateNavigationRole = null;
                await client.query("RESET ROLE");
                const changed = await client.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage')",
                  [revoke],
                );
                assert.equal(changed.rowCount, 1);
                await client.query("SET LOCAL ROLE " + role);
              }
              return result;
            } catch (error) {
              sqlState = /^[0-9A-Z]{5}$/u.test(error?.code ?? "") ? error.code : "NONE";
              deniedAsset =
                /permission denied for (?:table|relation|schema|function) ([a-z_]+)/u.exec(
                  error?.message ?? "",
                )?.[1] ?? "NONE";
              // Static owner asset only; never statement text or bound values.
              sqlAsset =
                /((?:bop_[a-z_]+|rms_[a-z_]+|platform_[a-z_]+)\.[a-z_]+)/iu.exec(
                  sql.replaceAll('"', ""),
                )?.[1] ?? "NONE";
              throw error;
            }
          },
        };
        const result = await work(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
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
        "SELECT (SELECT count(*)::int FROM bop_tenant.brand_store_topology_draft_revision) revisions,(SELECT count(*)::int FROM bop_tenant.brand_store_topology_draft_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
      )
    ).rows[0];
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
      [
        roleId,
        brand,
        kind === "Store" ? store : null,
        "internal_test_topology_" + serial,
        from,
        until,
      ],
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

  const unused = () => {
    throw new Error("TOPOLOGY_HTTP_UNRELATED_CONFIGURATION_UNAVAILABLE");
  };
  const runtimeFor = (session) =>
    createMerchantRuntime({
      persistence: {
        ...freshPersistence(session),
        initialScope: async () => ({
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
        }),
        targetScope: async (_tx, _session, storeReference) => {
          assert.equal(storeReference, store);
          return { tenantReference: tenant, brandReference: brand, storeReference: store };
        },
        // Presentation candidates are untrusted; ordinary bootstrap must replace
        // these labels and independently authorize the Brand navigation entry.
        workspace: async () => {
          const selectedScope = {
            brandLabel: "Untrusted candidate label",
            storeLabel: "Untrusted candidate label",
            storeReference: store,
          };
          return {
            screenId: "HOME-OVERVIEW",
            selectedScope,
            authorizedStores: [selectedScope],
            businessDate: "2000-01-01",
            storeStatus: "Unavailable",
            freshness: "Stale",
            dashboardAvailability: "UnavailableUntilWP1905",
            navigation: [
              {
                screenId: "ORG-BRAND-DETAIL",
                href: "/app/organization/brands/" + brand,
                label: "Untrusted candidate",
                permission: "organization.manage",
              },
            ],
          };
        },
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
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
      brandStoreTopologyDraft: { nextReference: reference },
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
      const send = (endpoint, body, { csrf = session.csrf, dropReply = false } = {}) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body);
          const req = request(
            {
              host: "127.0.0.1",
              port: address.port,
              path:
                endpoint === "session"
                  ? "/merchant/session"
                  : "/merchant/organization/brands/topology/draft/" + endpoint,
              method: bytes === null ? "GET" : "POST",
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + session.sessionCookie,
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
                } catch (error) {
                  reject(new Error("TOPOLOGY_HTTP_RESPONSE_UNAVAILABLE", { cause: error }));
                }
              });
            },
          );
          req.setTimeout(15000, () => req.destroy(new Error("TOPOLOGY_HTTP_TIMEOUT")));
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
      "GRANT USAGE ON SCHEMA bop_tenant,bop_feature_control,platform_helpers,platform_audit TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON bop_tenant.brand_store_topology_draft_revision,bop_tenant.brand_store_topology_draft_operation,bop_feature_control.control_version,bop_feature_control.control_dependency,bop_feature_control.control_operation,platform_audit.audit_record TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    await admin.query(
      "GRANT SELECT ON bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO " +
        role,
    );
    const author = {
      ...(await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        role,
        scope: selectedScope,
        actor,
        at,
        referencePrefix: "01923011",
        sessionReferencePrefix: "01923012",
      })),
      actor,
    };
    const approver = {
      ...(await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        role,
        scope: selectedScope,
        actor: reviewer,
        at,
        referencePrefix: "01923013",
        sessionReferencePrefix: "01923014",
      })),
      actor: reviewer,
    };
    const featureActions = [
      "feature.control.change",
      "feature.control.approve",
      "feature.control.publish",
      "feature.control.activate",
    ];
    await grant(actor, [...featureActions, "organization.manage"]);
    await grant(reviewer, featureActions);
    stage = "StoreOperatingFixture";
    // This previously accepted helper records synthetic Store facts through the
    // real public Publishing/Audit owners. It is not external StoreReady evidence.
    const publicationId = (n) => (n === 90 ? tenant : id(6000 + n));
    const from = new Date(Date.parse(at) - 60000).toISOString();
    const configuration = createStoreConfigurationVersion({
      configurationReference: id(5000),
      brandReference: brand,
      storeReference: store,
      configurationVersion: 1,
      lifecycle: "Published",
      source: "StoreOverride",
      brandBaseVersionReference: id(5001),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "00:00:00",
      addressReference: id(5002),
      contactReference: id(5003),
      receiptReference: id(5004),
      taxConfigurationReference: id(5005),
      paymentConfigurationReference: id(5006),
      capacityConfigurationReference: null,
      enabledServiceModes: ["Pickup"],
      weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals: [
          {
            startLocalTime: "00:00:00",
            endLocalTime: "23:59:59",
            endsNextDay: false,
            serviceModes: ["Pickup"],
            orderCutoffSeconds: 0,
            leadTimeSeconds: 600,
          },
        ],
      })),
      exceptions: [],
      effectiveFrom: from,
      effectiveUntil: null,
      supersedesConfigurationReference: null,
      reasonCode: "INTERNAL_TEST",
      authoredByReference: actor,
      approvedByReference: reviewer,
      approvalEvidenceReference: id(5007),
      publicationReference: id(5008),
      liveGateEvidenceReference: id(5009),
      createdAt: from,
      updatedAt: from,
      dataClassification: "ConfigurationMetadata",
    });
    await admin.query(
      "INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto','00:00:00',$5,$6,$7,$8,$9,NULL,ARRAY['Pickup'],$10,NULL,NULL,'INTERNAL_TEST',$11,$12,$13,$14,$15,$10,$10,'ConfigurationMetadata')",
      [
        configuration.configurationReference,
        brand,
        store,
        configuration.brandBaseVersionReference,
        configuration.addressReference,
        configuration.contactReference,
        configuration.receiptReference,
        configuration.taxConfigurationReference,
        configuration.paymentConfigurationReference,
        from,
        actor,
        reviewer,
        configuration.approvalEvidenceReference,
        configuration.publicationReference,
        configuration.liveGateEvidenceReference,
      ],
    );
    await admin.query(
      "INSERT INTO rms_store.store_configuration_publication_content VALUES($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
      [
        brand,
        store,
        configuration.configurationReference,
        publicationId(70),
        hash(configuration),
        configuration,
        from,
      ],
    );
    await seedStorePublication(
      admin,
      publicationId,
      configuration,
      hash(configuration),
      undefined,
      undefined,
      new Date(Date.parse(at) + 3600000).toISOString(),
    );
    for (let day = 1; day <= 7; day++)
      await admin.query(
        "INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,$5,1,'00:00:00','23:59:59',false,ARRAY['Pickup'],0,600,'ConfigurationMetadata')",
        [id(5100 + day), brand, store, configuration.configurationReference, day],
      );
    await admin.query("GRANT USAGE ON SCHEMA rms_store,bop_publishing TO " + role);
    const readonlyAssets = [
      "rms_store.store_configuration_authoring_operation",
      "rms_store.store_configuration_version",
      "rms_store.store_configuration_publication_content",
      "rms_store.store_weekly_service_period",
      "rms_store.store_service_exception",
      "rms_store.store_service_exception_content",
      "rms_store.store_service_exception_interval",
      "rms_store.store_configuration_operation",
      "rms_store.store_service_pause_content",
      "rms_store.store_service_resume_content",
      "bop_publishing.publishing_mutation_record",
      "bop_publishing.live_gate_version",
      "bop_publishing.live_gate_requirement",
    ];
    for (const table of readonlyAssets) {
      await admin.query("GRANT SELECT ON " + table + " TO " + role);
      // These actual owner readers take explicit table SHARE locks, matching
      // the existing isolated ordinary workspace acceptance role.
      await admin.query("GRANT UPDATE ON " + table + " TO " + role);
    }

    stage = "StoreOnlyOrg";
    const storeOnlyCounts = await counts();
    await withHttp(author, async (send) => {
      assert.equal((await send("workspace", { expectedBrandReference: brand })).status, 403);
      const bootstrap = await send("session");
      assert.equal(bootstrap.status, 200);
      assert.equal(
        bootstrap.body.workspace.navigation.some((item) => item.screenId === "ORG-BRAND-DETAIL"),
        false,
      );
    });
    assert.deepEqual(await counts(), storeOnlyCounts);
    const brandRole = await grant(actor, ["organization.manage"], "Brand");
    await grant(reviewer, ["organization.manage"], "Brand");
    stage = "MissingFeature";
    const missingCounts = await counts();
    await withHttp(author, async (send) => {
      assert.equal((await send("workspace", { expectedBrandReference: brand })).status, 503);
      const bootstrap = await send("session");
      assert.equal(bootstrap.status, 503);
      assert.equal(bootstrap.body.error, "merchant_workspace_unavailable");
    });
    assert.deepEqual(await counts(), missingCounts);
    let definition = createFeatureControlAdministrationDefinition({
      controlId: reference(),
      key: "organization.brand.detail",
      description: "InternalTest Brand topology Draft capability",
      version: 1,
      ownerReference: actor,
      purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
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
        assert.equal(p.actorReference, session.actor);
        assert.equal(p.brandReference, brand);
        assert.equal(p.storeReference, store);
        await storeAuthority(tx, session, featureAction[p.operation]);
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

      const contextAndDecision = await transactions.run((tx) =>
        storeAuthority(tx, session, featureAction[operation]),
      );

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
    const draftReference = reference(),
      region = reference(),
      group = reference();
    const makeSave = (session, revision, extra = {}) =>
      parseBrandStoreTopologySave({
        profile: "BrandStoreTopologySaveV1",
        ...scope,
        actorReference: session.actor,
        operationReference: reference(),
        expectedRevision: revision,
        content: {
          profile: "BrandStoreTopologyDraftV1",
          tenantReference: tenant,
          brandReference: brand,
          draftReference,
          selectors: [
            { kind: "Region", reference: region, code: "NORTH", name: "Synthetic North" },
            { kind: "StoreGroup", reference: group, code: "PILOT", name: "Synthetic Group" },
          ],
          assignments: [
            { storeReference: store, selectorReference: region },
            { storeReference: store, selectorReference: group },
          ],
          ...extra,
        },
      });
    const original = (command) =>
      parseBrandStoreTopologyResolve({
        profile: "BrandStoreTopologyResolveV1",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: command.actorReference,
        operationReference: command.operationReference,
        expectedRevision: command.expectedRevision,
        intentDigest: hash(command),
      });
    const envelope = (command) => ({
      expectedScope: { ...scope, actorReference: command.actorReference },
      command,
    });
    const first = makeSave(author, 0);
    let firstReceipt;
    await withHttp(author, async (send) => {
      stage = "Workspace";
      const bootstrap = await send("session");
      assert.equal(bootstrap.status, 200);
      assert.deepEqual(
        bootstrap.body.workspace.navigation.filter((item) => item.screenId === "ORG-BRAND-DETAIL"),
        [
          {
            screenId: "ORG-BRAND-DETAIL",
            href: "/app/organization/brands/" + brand,
            label: "Brand administration",
            permission: "organization.manage",
          },
        ],
      );
      assert.deepEqual(bootstrap.body.workspace.selectedScope, {
        brandLabel: "Synthetic Receipt Brand",
        storeLabel: "Synthetic Receipt Store",
        storeReference: store,
        // WP-2423: order times are shown in the selected Store's time zone.
        timeZone: "America/Toronto",
      });
      {
        // The Store list carries no time zone; only the selected Store does.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { timeZone, ...selectedStore } = bootstrap.body.workspace.selectedScope;
        assert.deepEqual(bootstrap.body.workspace.authorizedStores, [selectedStore]);
      }
      stage = "NavigationLatePermissionWithdraw";
      const beforeNavigation = await counts();
      lateNavigationRole = brandRole;
      const deniedNavigation = await send("session");
      assert.equal(lateNavigationRole, null);
      assert.equal(deniedNavigation.status, 503);
      assert.equal(deniedNavigation.body.error, "merchant_workspace_unavailable");
      assert.deepEqual(await counts(), beforeNavigation);
      assert.equal(
        (
          await admin.query(
            "SELECT lifecycle FROM bop_permission.permission_grant WHERE role_id=$1 AND permission_id=(SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage')",
            [brandRole],
          )
        ).rows[0].lifecycle,
        "Active",
      );
      stage = "Workspace";
      const workspace = await send("workspace", { expectedBrandReference: brand });
      assert.equal(workspace.status, 200);
      assert.equal(workspace.body.status, "DraftOnly");
      assert.deepEqual(
        {
          tenantReference: workspace.body.tenantReference,
          brandReference: workspace.body.brandReference,
          actorReference: workspace.body.actorReference,
        },
        scope,
      );
      assert.equal(workspace.body.current.current, null);
      assert.deepEqual(workspace.body.history, []);
      assert.equal(workspace.body.stores.references.length, 1);
      assert.deepEqual(
        {
          code: workspace.body.stores.references[0].code,
          displayName: workspace.body.stores.references[0].displayName,
        },
        { code: "SYNTHETIC_RECEIPT_STORE", displayName: "Synthetic Receipt Store" },
      );
      assert(Date.parse(workspace.body.validUntil) - Date.parse(workspace.body.observedAt) <= 5000);
      const before = await counts();
      stage = "ForeignScope";
      for (const body of [
        { expectedBrandReference: reference() },
        { expectedBrandReference: brand, expectedScope: { ...scope, actorReference: reviewer } },
        {
          expectedBrandReference: brand,
          expectedScope: { ...scope, tenantReference: reference() },
        },
      ])
        assert.equal((await send("workspace", body)).status, 403);
      assert.equal((await send("save", envelope(first), { csrf: "A".repeat(43) })).status, 403);
      assert.deepEqual(await counts(), before);
      stage = "CreateLostReply";
      assert.deepEqual(await send("save", envelope(first), { dropReply: true }), {
        replyLost: true,
      });
      const committed = await counts();
      assert.equal(committed.revisions, before.revisions + 1);
      assert.equal(committed.originals, before.originals + 1);
      assert.equal(committed.audits, before.audits + 1);
      stage = "ResolveCommitted";
      const resolution = await send("resolve", envelope(original(first)));
      assert.equal(resolution.status, 200);
      firstReceipt = parseBrandStoreTopologyOperationReceipt(resolution.body);
      assert.equal(firstReceipt.outcome, "Committed");
      assert.equal(firstReceipt.intentDigest, hash(first));
      assert.equal(firstReceipt.snapshot.revision, 1);
      assert.deepEqual(firstReceipt.snapshot.content, first.content);
      assert.deepEqual(await counts(), committed);
      stage = "ExactReplay";
      assert.deepEqual((await send("save", envelope(first))).body, firstReceipt);
      assert.deepEqual(await counts(), committed);
      const refreshed = await send("workspace", {
        expectedBrandReference: brand,
        expectedScope: scope,
      });
      assert.equal(refreshed.status, 200);
      assert.deepEqual(refreshed.body.current.current, firstReceipt.snapshot);
      assert.deepEqual(refreshed.body.history, [firstReceipt.snapshot]);
      stage = "CASConflict";
      assert.equal((await send("save", envelope(makeSave(author, 0)))).status, 409);
      assert.deepEqual(await counts(), committed);
      stage = "IntentConflict";
      const changed = parseBrandStoreTopologySave({
        ...first,
        content: { ...first.content, assignments: [] },
      });
      assert.equal((await send("save", envelope(changed))).status, 409);
      assert.deepEqual(await counts(), committed);
      stage = "AbsentOriginal";
      const absent = makeSave(author, 1),
        absentBefore = await counts();
      const abandoned = await send("resolve", envelope(original(absent)));
      assert.equal(abandoned.status, 200);
      const abandonedReceipt = parseBrandStoreTopologyOperationReceipt(abandoned.body);
      assert.equal(abandonedReceipt.outcome, "Abandoned");
      assert.equal(abandonedReceipt.snapshot, null);
      const abandonedCounts = await counts();
      assert.equal(abandonedCounts.revisions, absentBefore.revisions);
      assert.equal(abandonedCounts.originals, absentBefore.originals + 1);
      assert.equal(abandonedCounts.audits, absentBefore.audits + 1);
      assert.deepEqual((await send("save", envelope(absent))).body, abandonedReceipt);
      assert.deepEqual(await counts(), abandonedCounts);
      stage = "LatePermissionWithdraw";
      const lateBefore = await counts();
      lateRole = brandRole;
      const denied = await send("save", envelope(makeSave(author, 1)));
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, "request_denied");
      assert.equal(lateRole, null);
      assert.deepEqual(await counts(), lateBefore);
      assert.equal(
        (
          await admin.query(
            "SELECT lifecycle FROM bop_permission.permission_grant WHERE role_id=$1",
            [brandRole],
          )
        ).rows[0].lifecycle,
        "Active",
      );
    });
    await withHttp(approver, async (send) => {
      stage = "IndependentReader";
      const value = await send("workspace", { expectedBrandReference: brand });
      assert.equal(value.status, 200);
      assert.equal(value.body.actorReference, reviewer);
      assert.equal(value.body.current.current.actorReference, actor);
      assert.deepEqual(value.body.history, [firstReceipt.snapshot]);
      const unchanged = await counts();
      assert.equal(
        (
          await send("resolve", {
            expectedScope: { ...scope, actorReference: reviewer },
            command: { ...original(first), actorReference: reviewer },
          })
        ).status,
        403,
      );
      assert.deepEqual(await counts(), unchanged);
      stage = "Successor";
      const second = makeSave(approver, 1, {
        assignments: [{ storeReference: store, selectorReference: group }],
      });
      const saved = await send("save", envelope(second));
      assert.equal(saved.status, 200);
      const receipt = parseBrandStoreTopologyOperationReceipt(saved.body);
      assert.equal(receipt.snapshot.actorReference, reviewer);
      assert.equal(receipt.snapshot.revision, 2);
      assert.equal(receipt.snapshot.content.draftReference, draftReference);
      assert.equal(receipt.snapshot.createdAt, firstReceipt.snapshot.createdAt);
      const refreshed = await send("workspace", { expectedBrandReference: brand });
      assert.equal(refreshed.status, 200);
      assert.deepEqual(refreshed.body.history, [firstReceipt.snapshot, receipt.snapshot]);
      assert.deepEqual(refreshed.body.current.current, receipt.snapshot);
    });
    await withHttp(author, async (send) => {
      stage = "HistoricalOriginal";
      const before = await counts();
      assert.deepEqual((await send("resolve", envelope(original(first)))).body, firstReceipt);
      assert.deepEqual((await send("save", envelope(first))).body, firstReceipt);
      assert.deepEqual(await counts(), before);
    });
    stage = "AuditPrivacy";
    const audits = (
      await admin.query(
        "SELECT action_code,after_summary_json AS after_summary FROM platform_audit.audit_record WHERE target_type='BrandStoreTopologyDraft' ORDER BY occurred_at,audit_id",
      )
    ).rows;
    assert.equal(audits.length, 3);
    for (const audit of audits) {
      assert.deepEqual(Object.keys(audit.after_summary), ["intentDigest"]);
      assert.match(audit.after_summary.intentDigest, /^sha256:[0-9a-f]{64}$/u);
      assert(!JSON.stringify(audit.after_summary).includes("Synthetic"));
    }
    stage = "FeatureDisabled";
    await mutateFeature("Disable", author, { lifecycle: "Disabled", configuredValue: "Disabled" });
    const disabledBefore = await counts();
    await withHttp(author, async (send) => {
      const bootstrap = await send("session");
      assert.equal(bootstrap.status, 200);
      assert.equal(
        bootstrap.body.workspace.navigation.some((item) => item.screenId === "ORG-BRAND-DETAIL"),
        false,
      );
      const value = await send("workspace", { expectedBrandReference: brand });
      assert.equal(value.status, 503);
      assert.equal(value.body.error, "brand_store_topology_feature_disabled");
      assert.equal((await send("save", envelope(makeSave(author, 2)))).status, 503);
    });
    assert.deepEqual(await counts(), disabledBefore);
  } catch (error) {
    throw new Error(
      `BRAND_TOPOLOGY_RUNTIME_HTTP_FAILED stage=${stage} status=${lastStatus} SQLSTATE=${sqlState} asset=${sqlAsset} deniedAsset=${deniedAsset}`,
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
