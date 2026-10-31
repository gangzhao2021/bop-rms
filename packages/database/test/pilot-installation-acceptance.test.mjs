import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import pg from "pg";
import { it, vi } from "vitest";
import { createPostgresWorkflowDefinitionStore } from "../../bop/workflow/src/index.ts";
import { createPostgresCurrentMenuReleaseStore } from "../../rms/catalog/src/index.ts";
import { paymentProviderWebhookRoute } from "../../../apps/api/src/payment-provider-webhook.ts";
import { startCognitoTestProvider } from "../../../tooling/environment/cognito-test-provider.mjs";
import {
  checkConfiguredPilotCapabilities,
  currentPilotEnvironment,
} from "../../../tooling/environment/pilot-environment.mjs";
import {
  checkCertificateFiles,
  checkPilotTls,
} from "../../../tooling/environment/pilot-hosting.mjs";
import { loadPilotInstallation } from "../../../tooling/environment/pilot-installation.mjs";
import {
  INSTALLATION_FILES,
  run as runInstallation,
} from "../../../tooling/environment/pilot-installation-issue.mjs";
import { renewInternalTestInstallation } from "../../../tooling/environment/pilot-internal-test-renew.mjs";
import { generateManagedSecrets } from "../../../tooling/environment/pilot-secrets.mjs";
import { startStripeFake } from "../../../tooling/environment/pilot-stripe-fake.mjs";
import { checkPilotStartReadiness } from "../../../tooling/environment/pilot-supervisor.mjs";
import { createTestCertificates } from "../../../tooling/environment/pilot-test-certificates.mjs";
import {
  installPermissionCatalog,
  uuidV7,
} from "../../../tooling/environment/permission-catalog-install.mjs";
import {
  orderWorkflowReleases,
  platformWorkflows,
} from "../../../tooling/environment/platform-workflows.mjs";
import { run as runStoreRoles } from "../../../tooling/environment/store-role-provisioning.mjs";
import { installWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { seedCartCatalog } from "../test-support/cart-catalog-seed.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const root = path.resolve(import.meta.dirname, "../../..");
const id = (n) => "0190c4e0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store] = [1, 2, 3].map(id);
const owner = id(10);
// TEST-ONLY public-looking Store name: nothing resolves or connects to it.
const host = "order.store-install.ca",
  origin = "https://" + host;

/**
 * WP-2423 DEC-PILOT-INSTALLATION — a Pilot Store installed from an empty database by the operator
 * tools in runbook order ("Switching a Store to Pilot"), in a Pilot process (NODE_ENV=production,
 * BOP_PILOT_ENVIRONMENT=Pilot):
 *
 * 1. Empty isolated database → migrations (the harness) → permission catalog
 *    (`permission-catalog-install`) → Store roles with the first Owner (`store-role-provisioning`
 *    keygen/prepare/sign/apply with a trust file).
 * 2. In-product Owner facts, seeded TEST-ONLY by the database owner because their flows are their
 *    own acceptances: the Brand/Store records (B2), the published Store configuration with its
 *    approved launch gate (a non-synthetic requirement), one published menu, one stock site.
 * 3. `pilot-installation-issue` prepare → sign (independent Platform approver, PILOT_INSTALLATION
 *    trust) → apply dry run (writes nothing) → apply → rerun (AlreadyApplied). The services' LOGIN
 *    NOBYPASSRLS roles are created with the rendered pilot ACL; the api role logs in with its
 *    password file and reads the menu and workflows under row security.
 * 4. `workflow-release-install` releases the Pickup, DineIn, additional-round and cancellation
 *    Workflows into the runtime directory (refused for another Store's directory).
 * 5. Hosting, managed secrets, Stripe live and Cognito configuration as in the Pilot smoke → the
 *    supervisor's start check reports only `PricingCurrencyMetadata` (no override anywhere).
 * 6. Pilot renewal of the validity window with the Owner's approval wording (prepare-renewal/sign/
 *    apply): only the profile and task queue windows move; the InternalTest renewal tool refuses
 *    the Pilot directory, and the installer refuses to run in an InternalTest process.
 */
it("installs a Pilot Store from an empty database with the operator tools and starts with only the tax gap", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pilot_install" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "wp2423_pi_api_" + context.runId,
      workerRole = "wp2423_pi_w_" + context.runId;
    const work = realpathSync(mkdtempSync(join(tmpdir(), "bop-pilot-install-work-")));
    const runtime = realpathSync(mkdtempSync(join(tmpdir(), "bop-pilot-install-runtime-")));
    chmodSync(runtime, 0o700);
    const stripe = await startStripeFake({
      secretKey: "sk_live_" + "FAKE".repeat(6),
      livemode: true,
    });
    const cognito = await startCognitoTestProvider({
      callbackUrls: [origin + "/merchant/callback", origin + "/merchant/identity/step-up/callback"],
    });
    // The migration authority file the operator tools read (inside the repository, password under .local).
    const control = join(root, ".local", "wp0024-" + context.runId);
    const envFile = join(control, "pilot-install-migrate.env");
    // The harness's compose environment, pointed at the isolated database (not its admin database).
    writeFileSync(
      envFile,
      readFileSync(context.clientConfig.envFile, "utf8").replace(
        /^BOP_RMS_POSTGRES_DB=.*$/mu,
        "BOP_RMS_POSTGRES_DB=" + context.databaseName,
      ),
      { mode: 0o600 },
    );
    const target = "test:" + context.databaseName;
    const file = (name) => join(work, name);
    const json = async (name) => JSON.parse(await readFile(file(name), "utf8"));
    const flags = (values) => Object.entries(values).flat();
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
      assert.equal(currentPilotEnvironment(), "Pilot");

      // ── 1. Catalog and Store roles (Brand/Store records and the Owner's membership first).
      const from = new Date(Date.now() - 4 * 86_400_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'PIN','Pilot Install Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'PIN_STORE','Pilot Install Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, from],
      );
      const membership = id(20),
        assignment = id(21);
      await admin.query(
        "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
        [membership, owner, brand, id(22), from],
      );
      await admin.query(
        "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
        [assignment, membership, owner, brand, store, from],
      );
      const operator = id(30),
        approver = id(31),
        environment = id(32);
      await installPermissionCatalog(
        flags({
          "--env-file": envFile,
          "--confirm-target": target,
          "--operator": operator,
          "--approved-by": approver,
          "--approval-evidence": id(33),
        }),
      );
      const trust = (purposeCode, key, publicKeySpki) => ({
        profile: "StoreRoleProvisioningTrustV1",
        keys: [
          {
            keyReference: key,
            approvedByReference: approver,
            environmentReference: environment,
            purposeCode,
            notBefore: new Date(Date.now() - 3_600_000).toISOString(),
            validUntil: new Date(Date.now() + 86_400_000).toISOString(),
            publicKeySpki,
          },
        ],
        revokedApprovalEvidenceReferences: [],
      });
      const roleKey = await runStoreRoles(["keygen", "--private-key", file("roles-approver.pem")]);
      writeFileSync(
        file("roles-trust.json"),
        JSON.stringify(trust("STORE_ROLE_PROVISIONING", id(34), roleKey.publicKeySpki)),
      );
      await runStoreRoles([
        "prepare",
        ...flags({
          "--environment": environment,
          "--operator": operator,
          "--tenant": tenant,
          "--brand": brand,
          "--store": store,
          "--effective-from": new Date(Date.now() - 60_000).toISOString(),
          "--templates":
            "owner,store-manager,area-manager,front-of-house,kitchen,inventory-manager",
          "--out": file("roles-plan.json"),
          "--owner-actor": owner,
          "--owner-membership": membership,
          "--owner-store-assignment": assignment,
        }),
      ]);
      await runStoreRoles([
        "sign",
        ...flags({
          "--plan": file("roles-plan.json"),
          "--private-key": file("roles-approver.pem"),
          "--approved-by": approver,
          "--approval-evidence": id(35),
          "--key": id(34),
          "--valid-hours": "1",
          "--out": file("roles-approval.json"),
        }),
      ]);
      const opened = await runStoreRoles([
        "apply",
        ...flags({
          "--env-file": envFile,
          "--confirm-target": target,
          "--plan": file("roles-plan.json"),
          "--approval": file("roles-approval.json"),
          "--trust": file("roles-trust.json"),
        }),
      ]);
      assert.equal(opened.status, "Applied");

      // ── 2. TEST-ONLY seeds of the in-product Owner facts (their flows have their own acceptances).
      const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
      await seedJourneyStorePublication({
        client: admin,
        scope,
        // Published days back so the last closed business day exists (first settlement window).
        publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        validUntil: new Date(Date.now() + 120 * 86_400_000).toISOString(),
        businessDayStart: "00:00:00",
        prefix: "01a1e400",
      });
      // The Owner's approved launch gate names a real requirement (a Pilot Store refuses SYNTHETIC_).
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "UPDATE bop_publishing.live_gate_requirement SET requirement_code='STORE_LAUNCH_APPROVED',category_code='STORE_LAUNCH' WHERE store_id=$1",
          [store],
        );
        await admin.query(
          "UPDATE bop_publishing.live_gate_version SET gate_id='STORE-LIVE-GATE' WHERE store_id=$1",
          [store],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const catalogId = (n) =>
        n === 2
          ? brand
          : n === 20
            ? store
            : "01a1e500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const menuAt = new Date(
        Math.floor((Date.now() - 2 * 86_400_000) / 1000) * 1000,
      ).toISOString();
      await seedCartCatalog(admin, catalogId, menuAt);
      const stockSite = id(40);
      await ensureSyntheticStockPlace(admin, {
        tenantId: tenant,
        brandId: brand,
        storeId: store,
        stockSiteId: stockSite,
        locationId: id(41),
        at: menuAt,
      });

      // ── 3. The installation: prepare → sign → dry run → apply → rerun.
      const installKey = await runInstallation([
        "keygen",
        "--private-key",
        file("install-approver.pem"),
      ]);
      writeFileSync(
        file("install-trust.json"),
        JSON.stringify(trust("PILOT_INSTALLATION", id(36), installKey.publicKeySpki)),
      );
      const validUntil = new Date(Date.now() + 60 * 86_400_000).toISOString();
      const prepared = await runInstallation([
        "prepare",
        ...flags({
          "--env-file": envFile,
          "--directory": runtime,
          "--environment": environment,
          "--operator": operator,
          "--tenant": tenant,
          "--brand": brand,
          "--store": store,
          "--valid-until": validUntil,
          "--api-role": apiRole,
          "--worker-role": workerRole,
          "--database-port": String(context.clientConfig.port),
          "--owner-approved-by": "Owner (TEST-ONLY)",
          "--owner-approval": "Approved: install the pilot store for 60 days",
          "--reason": "Open the pilot store installation",
          "--out": file("install-plan.json"),
        }),
      ]);
      assert.equal(prepared.kind, "Install");
      assert.deepEqual(
        prepared.files.map((entry) => entry.name),
        INSTALLATION_FILES,
      );
      const plan = await json("install-plan.json");
      assert.deepEqual(plan.facts.liveGateRequirementCodes, ["STORE_LAUNCH_APPROVED"]);
      assert.equal(plan.facts.menuReference, catalogId(1));
      assert.equal(plan.facts.stockSiteReference, stockSite);
      assert.equal(plan.facts.timeZone, "America/Toronto");
      assert.ok(plan.facts.firstWindow.endsAt <= new Date().toISOString());
      // The plan holds no secret: no password, key or token.
      assert.doesNotMatch(JSON.stringify(plan), /password|secret|sk_live|BEGIN PRIVATE/iu);
      await runInstallation([
        "sign",
        ...flags({
          "--plan": file("install-plan.json"),
          "--private-key": file("install-approver.pem"),
          "--approved-by": approver,
          "--approval-evidence": id(37),
          "--key": id(36),
          "--valid-hours": "1",
          "--out": file("install-approval.json"),
        }),
      ]);
      const apply = (extra = {}) =>
        runInstallation([
          "apply",
          ...flags({
            "--env-file": envFile,
            "--plan": file("install-plan.json"),
            "--approval": file("install-approval.json"),
            "--trust": file("install-trust.json"),
            ...extra,
          }),
        ]);
      const dry = await apply();
      assert.equal(dry.status, "DryRun");
      assert.deepEqual(
        dry.roles.map((entry) => entry.action),
        ["WouldCreate", "WouldCreate"],
      );
      assert.deepEqual(await readdir(runtime), []);
      assert.equal(
        (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [apiRole])).rowCount,
        0,
      );
      await assert.rejects(apply({ "--confirm-target": "test:other_database" }), {
        reason: "target-not-confirmed",
      });
      const applied = await apply({ "--confirm-target": target });
      assert.equal(applied.status, "Applied");
      assert.deepEqual(
        applied.roles.map((entry) => entry.action),
        ["Created", "Created"],
      );
      for (const name of [...INSTALLATION_FILES, "api-password", "worker-password"])
        assert.equal(statSync(join(runtime, name)).mode & 0o777, 0o600, name);
      const again = await apply({ "--confirm-target": target });
      assert.equal(again.status, "AlreadyApplied");
      assert.deepEqual(
        again.roles.map((entry) => entry.action),
        ["Restricted", "Restricted"],
      );
      const roles = (
        await admin.query(
          "SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
          [[apiRole, workerRole]],
        )
      ).rows;
      assert.deepEqual(
        roles.map((row) => [row.rolcanlogin, row.rolsuper, row.rolbypassrls]),
        [
          [true, false, false],
          [true, false, false],
        ],
      );
      assert.ok(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'bop_workflow.workflow_definition_version','SELECT') AS ok",
            [apiRole],
          )
        ).rows[0].ok,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.platform_actor_audit_record WHERE purpose_code='PILOT_INSTALLATION' AND action_code='PILOT_INSTALLATION_ISSUED' AND operation_id=$1",
            [plan.operationReference],
          )
        ).rows[0].n,
        1,
      );
      const log = (await readFile(join(runtime, "pilot-installation-log.jsonl"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(log.length, 1);
      assert.doesNotMatch(log[0], /[0-9a-f]{64}"?\s*$/u);

      // ── 4. Workflows released into the runtime directory by the release tool.
      const release = (workflow, output, overrides = {}) =>
        installWorkflowRelease(
          flags({
            "--env-file": envFile,
            "--confirm-target": target,
            "--workflow": workflow,
            "--runtime-environment": "Pilot",
            "--tenant": tenant,
            "--brand": brand,
            "--store": store,
            "--operator": operator,
            "--approved-by": approver,
            "--approval-evidence": id(38),
            "--operation": uuidV7(),
            "--output": output,
            ...overrides,
          }),
        );
      await assert.rejects(
        release("OrderFulfillmentPickup", join(runtime, "internal-test-workflow-Pickup.json"), {
          "--store": id(99),
        }),
        { message: "WORKFLOW_RELEASE_PROFILE_MISMATCH" },
      );
      for (const name of orderWorkflowReleases) {
        const released = await release(
          name,
          join(runtime, `internal-test-workflow-${platformWorkflows[name].binding}.json`),
        );
        assert.equal(released.status, "Applied");
      }
      await release(
        "UnpaidDineInBatchCancellation",
        join(runtime, "cancellation-workflow-draft-result.json"),
      );

      // The installed api role logs in with its own password file and reads under row security.
      const installation = await loadPilotInstallation(runtime);
      const password = (await readFile(join(runtime, "api-password"), "utf8")).trim();
      const apiClient = new Client({
        host: context.clientConfig.host,
        port: context.clientConfig.port,
        database: context.databaseName,
        user: installation.connection.user("api"),
        password,
      });
      await apiClient.connect();
      try {
        const runner = {
          async run(work) {
            await apiClient.query("BEGIN");
            try {
              const result = await work({
                query: (sql, values = []) => apiClient.query(sql, [...values]),
              });
              await apiClient.query("COMMIT");
              return result;
            } catch (error) {
              await apiClient.query("ROLLBACK").catch(() => undefined);
              throw error;
            }
          },
        };
        const at = new Date().toISOString();
        for (const kind of ["Pickup", "DineIn", "AdditionalRelease"]) {
          const saved = await installation.loadWorkflow(kind);
          const current = await createPostgresWorkflowDefinitionStore(runner, scope).resolveCurrent(
            {
              purposeCode: saved.workflow.purposeCode,
              applicabilityCode: saved.workflow.applicabilityCode,
              observedAt: at,
            },
          );
          assert.equal(
            current.definition.versionReference,
            saved.workflow.payment.workflowVersionReference,
          );
        }
        const menu = await createPostgresCurrentMenuReleaseStore(runner, {
          brandReference: brand,
          storeReference: store,
        }).load({
          menuReference: (await installation.loadMenu()).menuReference,
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
          observedAt: at,
        });
        assert.equal(menu.menuReference, catalogId(1));
      } finally {
        await apiClient.end();
      }

      // ── 5. Hosting, managed secrets, Stripe live and Cognito → only the tax gap remains.
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "bop-pilot-install-hosting-")));
      try {
        const privateFile = (name, value) => {
          writeFileSync(join(runtime, name), value, { mode: 0o600 });
          chmodSync(join(runtime, name), 0o600);
        };
        const secrets = join(outside, "secrets");
        await generateManagedSecrets(secrets);
        writeFileSync(join(secrets, "cognito-client-secret"), cognito.clientSecret + "\n", {
          mode: 0o400,
        });
        const tlsDirectory = join(outside, "tls");
        mkdirSync(tlsDirectory, { mode: 0o700 });
        const certificates = await createTestCertificates(tlsDirectory, { hostname: host });
        privateFile(
          "hosting.json",
          JSON.stringify({
            schemaVersion: 1,
            environment: "Pilot",
            customerOrigin: origin,
            secretsDirectory: secrets,
            tls: {
              mode: "front",
              certificateFile: certificates.certificateFile,
              keyFile: certificates.keyFile,
            },
          }),
        );
        privateFile("stripe-live-secret-key", stripe.secretKey);
        privateFile("stripe-live-webhook-secret", stripe.webhookSecret);
        privateFile(
          "payment.json",
          JSON.stringify({
            schemaVersion: 1,
            provider: "stripe",
            stripe: {
              mode: "live",
              apiVersion: stripe.apiVersion,
              publishableKey: "pk_live_SYNTHETIC0001",
              secretKeyFile: "stripe-live-secret-key",
              webhookSecretFile: "stripe-live-webhook-secret",
              returnUrl: "https://pay-return.store-install.ca/return",
              webhookUrl: origin + paymentProviderWebhookRoute,
            },
          }),
        );
        privateFile(
          "staff-sign-in.json",
          JSON.stringify({
            schemaVersion: 1,
            environment: "Pilot",
            mode: "cognito",
            exactOrigin: origin,
            cognito: {
              bindingEnvironment: "bop-pilot-install",
              issuer: cognito.issuer,
              clientId: cognito.clientId,
              managedLoginOrigin: cognito.managedLoginOrigin,
            },
          }),
        );
        const notReady = [];
        const start = () =>
          checkPilotStartReadiness({
            runtimeDirectory: runtime,
            absoluteDirectory: runtime,
            // The harness's only TLS route: its own root stands in for the public trust store.
            checkCapabilities: (directory) =>
              checkConfiguredPilotCapabilities(directory, {
                checkTls: (hosting) =>
                  checkPilotTls(hosting, {
                    checkFiles: (files) =>
                      checkCertificateFiles(files, { roots: [certificates.root] }),
                  }),
              }),
            report: (line) => notReady.push(line),
          });
        await assert.rejects(start(), {
          message: "PILOT_CAPABILITY_MISSING:PricingCurrencyMetadata",
        });
        assert.deepEqual(notReady, []);
        // A missing Workflow binding is named and keeps Installation open.
        const pickup = await readFile(join(runtime, "internal-test-workflow-Pickup.json"));
        rmSync(join(runtime, "internal-test-workflow-Pickup.json"));
        await assert.rejects(start(), {
          message: "PILOT_CAPABILITY_MISSING:Installation,PricingCurrencyMetadata",
        });
        assert.deepEqual(notReady, [
          "PILOT_NOT_READY Installation: missing internal-test-workflow-Pickup.json",
        ]);
        writeFileSync(join(runtime, "internal-test-workflow-Pickup.json"), pickup, { mode: 0o600 });
        notReady.length = 0;
        await assert.rejects(start(), {
          message: "PILOT_CAPABILITY_MISSING:PricingCurrencyMetadata",
        });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }

      // ── 6. Pilot renewal with the Owner's approval; InternalTest tools stay InternalTest-only.
      const renewedUntil = new Date(Date.parse(validUntil) + 20 * 86_400_000).toISOString();
      const profileBefore = await readFile(join(runtime, "internal-test-profile.json"), "utf8");
      const menuBefore = await readFile(join(runtime, "internal-test-menu.json"), "utf8");
      await runInstallation([
        "prepare-renewal",
        ...flags({
          "--env-file": envFile,
          "--directory": runtime,
          "--environment": environment,
          "--operator": operator,
          "--valid-until": renewedUntil,
          "--owner-approved-by": "Owner (TEST-ONLY)",
          "--owner-approval": "Approved: continue the pilot 20 more days",
          "--reason": "Continue the pilot store",
          "--out": file("renew-plan.json"),
        }),
      ]);
      await runInstallation([
        "sign",
        ...flags({
          "--plan": file("renew-plan.json"),
          "--private-key": file("install-approver.pem"),
          "--approved-by": approver,
          "--approval-evidence": id(39),
          "--key": id(36),
          "--valid-hours": "1",
          "--out": file("renew-approval.json"),
        }),
      ]);
      const renewed = await runInstallation([
        "apply",
        ...flags({
          "--env-file": envFile,
          "--plan": file("renew-plan.json"),
          "--approval": file("renew-approval.json"),
          "--trust": file("install-trust.json"),
          "--confirm-target": target,
        }),
      ]);
      assert.equal(renewed.status, "Applied");
      assert.deepEqual(renewed.pendingFiles, [
        "internal-test-task-queue.json",
        "internal-test-profile.json",
      ]);
      const profileAfter = JSON.parse(
        await readFile(join(runtime, "internal-test-profile.json"), "utf8"),
      );
      assert.equal(profileAfter.binding.validUntil, renewedUntil);
      assert.deepEqual(
        { ...profileAfter, binding: { ...profileAfter.binding, validUntil: validUntil } },
        JSON.parse(profileBefore),
      );
      const queue = JSON.parse(
        await readFile(join(runtime, "internal-test-task-queue.json"), "utf8"),
      );
      assert.equal(queue.effectiveUntil, renewedUntil);
      assert.equal(queue.exceptionTaskPolicy.effectiveUntil, renewedUntil);
      assert.equal(await readFile(join(runtime, "internal-test-menu.json"), "utf8"), menuBefore);
      assert.equal(
        (await readFile(join(runtime, "pilot-installation-log.jsonl"), "utf8")).trim().split("\n")
          .length,
        2,
      );
      const records = (await readdir(runtime)).filter((name) =>
        name.startsWith("pilot-installation-renew-"),
      );
      assert.equal(records.length, 1);
      const record = JSON.parse(await readFile(join(runtime, records[0], "record.json"), "utf8"));
      assert.equal(record.ownerApproval.approval, "Approved: continue the pilot 20 more days");
      assert.equal(record.window.previousValidUntil, validUntil);
      assert.equal(
        await readFile(join(runtime, records[0], "internal-test-profile.json"), "utf8"),
        profileBefore,
      );
      // The InternalTest renewal never touches a Pilot directory; the installer never runs as InternalTest.
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
      await assert.rejects(
        renewInternalTestInstallation({
          directory: runtime,
          expectedDatabaseName: context.databaseName,
          until: new Date(Date.now() + 10 * 86_400_000).toISOString(),
          reason: "Must be refused for a Pilot Store",
          approvedBy: "Owner",
          approval: "Not applicable to a Pilot Store",
          dryRun: true,
          renewDatabase: async () => assert.fail("database renewal must not run"),
        }),
        { message: "PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE" },
      );
      await assert.rejects(apply({ "--confirm-target": target }), { reason: "not-pilot-process" });
      await assert.rejects(loadPilotInstallation(runtime).then((value) => value.loadProfile()));
    } finally {
      vi.unstubAllEnvs();
      await stripe.close();
      await cognito.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      for (const name of [apiRole, workerRole]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
