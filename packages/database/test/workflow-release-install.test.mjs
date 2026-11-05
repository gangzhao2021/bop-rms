import assert from "node:assert/strict";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createPostgresWorkflowDefinitionStore } from "../../bop/workflow/src/index.ts";
import { evaluateAlertConditions } from "../../../tooling/environment/pilot-alerts.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { reportUnexpected } from "../../../tooling/environment/pilot-unexpected.mjs";
import { readInternalWorkflowReadiness } from "../../../tooling/environment/pilot-workflow-readiness.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  applyWorkflowRelease,
  commitPlannedRelease,
  installWorkflowRelease,
  planWorkflowRelease,
  workflowRuntimeFile,
} from "../../../tooling/environment/workflow-release-install.mjs";
import {
  matchesPlatformWorkflow,
  orderWorkflowReleases,
  platformWorkflows,
} from "../../../tooling/environment/platform-workflows.mjs";
const { Client } = pg;
const id = (n) => "0190999a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const issuedAt = Date.now() - 60_000;
const options = {
  release: "UnpaidDineInBatchCancellation",
  tenantReference: id(1),
  brandReference: id(2),
  operatorReference: id(5),
  approvedByReference: id(6),
  approvalEvidenceReference: id(7),
};
async function inTransaction(client, work) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
const count = async (client, table) =>
  (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

it("installs the released cancellation Workflow through Publishing, replays it exactly and serves it to a restricted role", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wfrelease" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_release_" + context.runId;
    try {
      const now = () => issuedAt + 60_000;
      // The operation reference carries its issue instant.
      const operation = (() => {
        const hex = issuedAt.toString(16).padStart(12, "0");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`;
      })();
      const release = { ...options, operationReference: operation };
      const first = await inTransaction(admin, () => applyWorkflowRelease(admin, release, now));
      assert.equal(first.status, "Applied");
      assert.equal(first.plan.published.lifecycle, "Published");
      assert.equal(matchesPlatformWorkflow(first.plan.published), true);
      const counts = async () => [
        await count(admin, "bop_workflow.workflow_definition_version"),
        await count(admin, "bop_publishing.publishing_mutation_record"),
        await count(admin, "platform_audit.audit_record"),
      ];
      const before = await counts();
      assert.deepEqual(before.slice(0, 2), [2, 4]);

      // Exact replay, even after the freshness window, writes nothing new.
      const replay = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, release, () => issuedAt + 86_400_000),
      );
      assert.equal(replay.status, "AlreadyApplied");
      assert.deepEqual(await counts(), before);

      // The same operation with a different approver is a different intent, never a replay.
      await assert.rejects(
        inTransaction(admin, () =>
          applyWorkflowRelease(admin, { ...release, approvedByReference: id(8) }, now),
        ),
      );
      // A new operation must be fresh.
      const staleOperation = (() => {
        const hex = (issuedAt - 3_600_000).toString(16).padStart(12, "0");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000002`;
      })();
      await assert.rejects(
        inTransaction(admin, () =>
          applyWorkflowRelease(admin, { ...release, operationReference: staleOperation }, now),
        ),
        /WORKFLOW_RELEASE_OPERATION_NOT_FRESH/u,
      );
      assert.deepEqual(await counts(), before);

      // The worker's restricted role resolves and validates it like any published Workflow.
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_workflow,bop_publishing,platform_helpers TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      // The pilot API role's grants (pilot ACL matrix plus additions); MAINTAIN only takes the
      // SHARE lock modes, the api role holds no UPDATE on these append-only tables (WP-2423).
      await admin.query(
        "GRANT SELECT,INSERT,MAINTAIN ON bop_workflow.workflow_definition_version,bop_publishing.publishing_mutation_record TO " +
          role,
      );
      const restricted = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work(client);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const store = createPostgresWorkflowDefinitionStore(restricted, {
        tenantReference: options.tenantReference,
        brandReference: options.brandReference,
        storeReference: id(3),
      });
      const observedAt = new Date(now()).toISOString();
      const current = await store.resolveCurrent({
        purposeCode: "UnpaidDineInBatchCancellation",
        applicabilityCode: "DineIn",
        observedAt,
      });
      assert.equal(current.definition.versionReference, first.plan.published.versionReference);
      assert.equal(current.definition.effectiveUntil, null);
      const validated = await store.validatePublication(
        current.definition.versionReference,
        observedAt,
      );
      assert.equal(validated.publication.release.releaseId, first.plan.release.releaseId);
      assert.equal(
        validated.publication.approvalEvidence.approvedActorReference,
        options.approvedByReference,
      );
      // Released history is append-only for the runtime role too.
      await assert.rejects(
        restricted.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [options.tenantReference, options.brandReference],
          );
          await tx.query(
            "UPDATE bop_workflow.workflow_definition_version SET effective_until=effective_from+interval '1 day'",
          );
        }),
      );

      // DEC-PILOT-INSTALLATION: the order Workflows release the same way (Brand-wide, approved by
      // the independent approver) and their runtime bindings name exactly the published version
      // and transitions the restricted role evaluates.
      const bindings = {};
      for (const [index, name] of orderWorkflowReleases.entries()) {
        const hex = (issuedAt + index + 1).toString(16).padStart(12, "0");
        const orderOperation = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-00000000001${index}`;
        const released = await inTransaction(admin, () =>
          applyWorkflowRelease(
            admin,
            { ...options, release: name, operationReference: orderOperation },
            now,
          ),
        );
        assert.equal(released.status, "Applied");
        assert.equal(matchesPlatformWorkflow(released.plan.published), true);
        const file = workflowRuntimeFile(released.plan, {
          environment: "Pilot",
          database: context.databaseName,
          scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
          operationReference: orderOperation,
          release: name,
        });
        bindings[platformWorkflows[name].binding] = file.workflow;
      }
      assert.equal(bindings.Pickup.purposeCode, bindings.DineIn.purposeCode);
      assert.notEqual(bindings.AdditionalRelease.purposeCode, bindings.DineIn.purposeCode);
      const allow = {
        authorizeResource: async () => true,
        authorizeAction: async () => true,
        evaluateRule: async () => true,
        authorizeOverride: async () => false,
      };
      const evaluate = (binding, applicabilityCode, currentState, action) =>
        store.evaluatePublishedAction(
          {
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            actorReference: id(40),
            resourceReference: id(41),
            resourceVersion: 1,
            purposeCode: binding.purposeCode,
            applicabilityCode,
            expectedVersionReference: binding.payment.workflowVersionReference,
            currentState,
            action,
            observedAt,
          },
          allow,
        );
      for (const [kind, applicability] of [
        ["Pickup", "Pickup"],
        ["DineIn", "DineIn"],
        ["AdditionalRelease", "DineIn"],
      ]) {
        const binding = bindings[kind];
        const submitted = await evaluate(binding, applicability, "CartReady", "SubmitOrder");
        assert.deepEqual(submitted.transition.effects, [
          { ownerModule: "inventory", commandCode: binding.reserveCommandCode },
        ]);
        const paying = await evaluate(binding, applicability, "Submitted", "CreatePaymentIntent");
        assert.equal(paying.transition.permissionCode, binding.payment.permissionCode);
        assert.deepEqual(paying.transition.ruleReferences, [
          binding.payment.intactReservationRuleReference,
        ]);
        const fulfilled = await evaluate(binding, applicability, "Accepted", "FulfillOrder");
        assert.equal(
          fulfilled.transition.transitionReference,
          binding.payment.fulfillmentTransitionReference,
        );
        assert.equal(fulfilled.transition.permissionCode, "order.fulfill");
        const accepted = await evaluate(binding, applicability, "Submitted", "Accept");
        assert.equal(
          accepted.transition.transitionReference,
          binding.payment.acceptanceTransitionReference,
        );
        assert.equal(accepted.transition.permissionCode, "order.accept");
      }
      // Only the additional round keeps an in-progress table order's phase on its paid release.
      const inProgress = await evaluate(
        bindings.AdditionalRelease,
        "DineIn",
        "InProgress",
        "ReleasePaidOrder",
      );
      assert.equal(inProgress.transition.nextState, "InProgress");
      await assert.rejects(evaluate(bindings.DineIn, "DineIn", "InProgress", "ReleasePaidOrder"));
    } finally {
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});

/** A UUIDv7 operation reference issued at this instant. */
const operationAt = (at, n) => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, "0")}`;
};
const root = path.resolve(import.meta.dirname, "../../..");
const now = () => issuedAt + 60_000;
const pickup = platformWorkflows.OrderFulfillmentPickup;
const released = (brand, n, release = "OrderFulfillmentPickup") => ({
  ...options,
  brandReference: brand,
  release,
  operationReference: operationAt(issuedAt + n, n),
});
const counts = async (client) => [
  await count(client, "bop_workflow.workflow_definition_version"),
  await count(client, "bop_publishing.publishing_mutation_record"),
  await count(client, "platform_audit.audit_record"),
];
const families = async (client, brand, purposeCode = "OrderFulfillment", code = "Pickup") =>
  (
    await client.query(
      "SELECT count(DISTINCT workflow_id)::int AS n FROM bop_workflow.workflow_definition_version WHERE brand_id=$1 AND purpose_code=$2 AND applicability_code=$3",
      [brand, purposeCode, code],
    )
  ).rows[0].n;
/** Roles holding exactly the rendered pilot ACL; everything under test runs as `api`. */
async function pilotRoles(admin, runId) {
  const api = "wp2423_wf_" + runId,
    worker = "wp2423_wf_w_" + runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const spec = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, spec), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, { api, worker }));
  return {
    api,
    drop: async () => {
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
    },
  };
}
const restrictedRunner = (context, role) => ({
  async run(work) {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL statement_timeout = '20s'");
      const result = await work({
        query: (sql, values) => client.query(sql, values && [...values]),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
});
const resolver = (runner, brand, store = id(3)) =>
  createPostgresWorkflowDefinitionStore(runner, {
    tenantReference: options.tenantReference,
    brandReference: brand,
    storeReference: store,
  });
const resolvePickup = (store) =>
  store.resolveCurrent({
    purposeCode: "OrderFulfillment",
    applicabilityCode: "Pickup",
    observedAt: new Date(now()).toISOString(),
  });
const INSERT_VERSION =
  "INSERT INTO bop_workflow.workflow_definition_version (tenant_id,brand_id,store_id,workflow_id,version_id,version_number,operation_id,intent_hash,actor_id,audit_id,purpose_code,applicability_code,lifecycle,effective_from,effective_until,created_at,definition_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)";
const versionValues = (definition, n) => [
  definition.tenantReference,
  definition.brandReference,
  definition.storeReference,
  definition.workflowReference,
  definition.versionReference,
  definition.versionNumber,
  id(n),
  "sha256:" + "a".repeat(64),
  id(5),
  id(n + 1),
  definition.purposeCode,
  definition.applicabilityCode,
  definition.lifecycle,
  definition.effectiveFrom,
  definition.effectiveUntil,
  definition.createdAt,
  definition,
];
/** A writer around the owner store: one row, straight into the table. */
const rawInsert = (runner, definition, n, whileOpen = async () => undefined) =>
  runner.run(async (tx) => {
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [definition.tenantReference, definition.brandReference, definition.storeReference ?? ""],
    );
    await tx.query(INSERT_VERSION, versionValues(definition, n));
    await whileOpen();
  });
/** Waits until a session of this database is queued on an advisory lock. */
async function advisoryWaiter(admin) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const waiting = await admin.query(
      "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname=current_database() AND l.locktype='advisory' AND NOT l.granted",
    );
    if (waiting.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no session waited on the purpose lock");
}

it("a second install under a new operation writes nothing and the restricted role still resolves it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wfrerun" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = await pilotRoles(admin, context.runId);
    try {
      const restricted = restrictedRunner(context, roles.api);
      const brand = id(2);
      const first = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(brand, 1), now),
      );
      assert.equal(first.status, "Applied");
      const before = await counts(admin);
      assert.deepEqual(before.slice(0, 2), [2, 4]);

      const second = await inTransaction(admin, () =>
        applyWorkflowRelease(
          admin,
          { ...released(brand, 2), approvalEvidenceReference: id(8), approvedByReference: id(9) },
          now,
        ),
      );
      const resolved = await resolvePickup(resolver(restricted, brand)).then(
        (current) => current.definition.versionReference,
        () => "refused",
      );
      assert.deepEqual(
        {
          status: second.status,
          version: second.plan.published.versionReference,
          written: await counts(admin),
          resolved,
          families: await families(admin, brand),
        },
        {
          status: "AlreadyInstalled",
          version: first.plan.published.versionReference,
          written: before,
          resolved: first.plan.published.versionReference,
          families: 1,
        },
      );
      // The operation behind the version it names, not the one that found it.
      assert.notEqual(second.operationReference, released(brand, 2).operationReference);

      // The first operation still replays exactly; a stale new one is still refused first.
      const replay = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(brand, 1), () => issuedAt + 86_400_000),
      );
      assert.equal(replay.status, "AlreadyApplied");
      await assert.rejects(
        inTransaction(admin, () =>
          applyWorkflowRelease(admin, released(brand, 3), () => issuedAt + 86_400_000),
        ),
        /WORKFLOW_RELEASE_OPERATION_NOT_FRESH/u,
      );
      assert.deepEqual(await counts(admin), before);

      // The money path works from a binding written by the rerun, for a second Store of the Brand.
      const binding = workflowRuntimeFile(second.plan, {
        environment: "InternalTest",
        database: context.databaseName,
        scope: { tenantReference: id(1), brandReference: brand, storeReference: id(4) },
        operationReference: second.operationReference,
        release: "OrderFulfillmentPickup",
      }).workflow;
      const paying = await resolver(restricted, brand, id(4)).evaluatePublishedAction(
        {
          tenantReference: id(1),
          brandReference: brand,
          storeReference: id(4),
          actorReference: id(40),
          resourceReference: id(41),
          resourceVersion: 1,
          purposeCode: binding.purposeCode,
          applicabilityCode: binding.applicabilityCode,
          expectedVersionReference: binding.payment.workflowVersionReference,
          currentState: "Submitted",
          action: binding.payment.action,
          observedAt: new Date(now()).toISOString(),
        },
        {
          authorizeResource: async () => true,
          authorizeAction: async () => true,
          evaluateRule: async () => true,
          authorizeOverride: async () => false,
        },
      );
      assert.equal(paying.transition.permissionCode, binding.payment.permissionCode);

      // Another Brand and another order type are other families.
      const otherBrand = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(id(20), 4), now),
      );
      assert.equal(otherBrand.status, "Applied");
      const otherType = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(brand, 5, "OrderFulfillmentDineIn"), now),
      );
      assert.equal(otherType.status, "Applied");
    } finally {
      await roles.drop();
      await admin.end();
    }
  });
});

it("the tool writes a lost or second Store's binding, and refuses to move one that names anything else", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wffile" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = await pilotRoles(admin, context.runId);
    const directory = await mkdtemp(join(tmpdir(), "bop-workflow-release-"));
    try {
      const envFile = join(root, ".local", "wp0024-" + context.runId, "release-migrate.env");
      writeFileSync(
        envFile,
        readFileSync(context.clientConfig.envFile, "utf8").replace(
          /^BOP_RMS_POSTGRES_DB=.*$/mu,
          "BOP_RMS_POSTGRES_DB=" + context.databaseName,
        ),
        { mode: 0o600 },
      );
      let n = 0;
      const brand = id(2);
      const install = (workflow, output, store = id(3)) =>
        installWorkflowRelease(
          Object.entries({
            "--env-file": envFile,
            "--confirm-target": "test:" + context.databaseName,
            "--workflow": workflow,
            "--runtime-environment": "InternalTest",
            "--tenant": id(1),
            "--brand": brand,
            "--store": store,
            "--operator": id(5),
            "--approved-by": id(6),
            "--approval-evidence": id(7),
            "--operation": operationAt(Date.now(), ++n),
            "--output": output,
          }).flat(),
        );
      const file = (folder, name) => join(directory, folder, name);
      await mkdir(join(directory, "first"));
      await mkdir(join(directory, "second"));
      const first = file("first", "internal-test-workflow-Pickup.json");
      const installed = await install("OrderFulfillmentPickup", first);
      assert.equal(installed.status, "Applied");
      // Services read the file when they start, so the operator is told when one needs a restart.
      assert.equal(installed.bindingFile, "Written");
      assert.equal((await stat(first)).mode & 0o777, 0o600);
      const before = await counts(admin);
      const original = await readFile(first, "utf8");
      const named = (text) => JSON.parse(text).workflow.payment.workflowVersionReference;
      assert.equal(named(original), installed.versionReference);

      // A second Store of the Brand gets its own binding from the same family.
      const second = file("second", "internal-test-workflow-Pickup.json");
      const secondStore = await install("OrderFulfillmentPickup", second, id(4));
      assert.equal(secondStore.status, "AlreadyInstalled");
      assert.equal(secondStore.versionReference, installed.versionReference);
      const secondBinding = JSON.parse(await readFile(second, "utf8"));
      assert.equal((await stat(second)).mode & 0o777, 0o600);
      assert.equal(secondBinding.scope.storeReference, id(4));
      assert.equal(secondBinding.release, "OrderFulfillmentPickup");
      assert.equal(named(JSON.stringify(secondBinding)), installed.versionReference);
      const resolved = await resolver(
        restrictedRunner(context, roles.api),
        brand,
        id(4),
      ).resolveCurrent({
        purposeCode: "OrderFulfillment",
        applicabilityCode: "Pickup",
        observedAt: new Date().toISOString(),
      });
      assert.equal(resolved.definition.versionReference, installed.versionReference);
      assert.deepEqual(await counts(admin), before);

      // Rerunning changes nothing, not even the file.
      const rerun = await install("OrderFulfillmentPickup", first);
      assert.equal(rerun.status, "AlreadyInstalled");
      assert.equal(rerun.bindingFile, "Unchanged");
      assert.equal(await readFile(first, "utf8"), original);

      // A lost file comes back naming the version the Brand uses.
      await rm(first);
      const restored = await install("OrderFulfillmentPickup", first);
      assert.equal(restored.status, "AlreadyInstalled");
      assert.equal(restored.bindingFile, "Written");
      assert.equal(named(await readFile(first, "utf8")), installed.versionReference);
      assert.deepEqual(await counts(admin), before);

      // The mistake that broke a Brand: the Pickup release written over the DineIn binding.
      const dineIn = file("first", "internal-test-workflow-DineIn.json");
      await assert.rejects(install("OrderFulfillmentPickup", dineIn), {
        message: "WORKFLOW_RELEASE_OUTPUT_MISMATCH",
      });
      await assert.rejects(stat(dineIn), { code: "ENOENT" });

      // A file naming another version is left alone, and a person looks.
      const moved = {
        ...secondBinding,
        workflow: {
          ...secondBinding.workflow,
          payment: { ...secondBinding.workflow.payment, workflowVersionReference: id(70) },
        },
      };
      await writeFile(second, JSON.stringify(moved), { mode: 0o600 });
      await assert.rejects(install("OrderFulfillmentPickup", second, id(4)), {
        message: "WORKFLOW_RELEASE_BINDING_CONFLICT",
      });
      assert.deepEqual(JSON.parse(await readFile(second, "utf8")), moved);
      // Named for another Store: the same.
      await assert.rejects(install("OrderFulfillmentPickup", first, id(4)), {
        message: "WORKFLOW_RELEASE_BINDING_CONFLICT",
      });
      // A refused run installs nothing either: a new family rolls back with the refusal.
      await writeFile(dineIn, JSON.stringify(moved), { mode: 0o600 });
      await assert.rejects(install("OrderFulfillmentDineIn", dineIn), {
        message: "WORKFLOW_RELEASE_BINDING_CONFLICT",
      });
      assert.equal(await families(admin, brand, "OrderFulfillment", "DineIn"), 0);
      // A damaged file is not guessed at.
      await writeFile(dineIn, "{ half a fi", { mode: 0o600 });
      await assert.rejects(install("OrderFulfillmentDineIn", dineIn), {
        message: "WORKFLOW_RELEASE_BINDING_UNREADABLE",
      });
      assert.equal(await families(admin, brand, "OrderFulfillment", "DineIn"), 0);
      assert.deepEqual(await counts(admin), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await roles.drop();
      await admin.end();
    }
  });
});

it("the store and the database refuse a second family, whoever writes it, and two installs leave one", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wfguard" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = await pilotRoles(admin, context.runId);
    try {
      const restricted = restrictedRunner(context, roles.api);
      const brand = id(2);
      const installed = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(brand, 1), now),
      );
      const before = await counts(admin);

      // The owner store refuses it by name, under the restricted role.
      const secondPlan = planWorkflowRelease(released(brand, 2));
      await assert.rejects(
        createPostgresWorkflowDefinitionStore(restricted, {
          tenantReference: options.tenantReference,
          brandReference: brand,
          storeReference: null,
        }).commit(secondPlan.workflowWrites[0], async () => true),
        { code: "WORKFLOW_DEFINITION_UNAVAILABLE", rule: "FamilyAlreadyExists" },
      );
      assert.deepEqual(await counts(admin), before);

      // The database refuses anything writing around the store.
      const draft = installed.plan.draft;
      const secondFamily = { ...draft, workflowReference: id(100), versionReference: id(101) };
      await assert.rejects(rawInsert(restricted, secondFamily, 200), { code: "23514" });
      assert.equal(await families(admin, brand), 1);
      // A further version of the family it holds is not a second family.
      await rawInsert(restricted, { ...draft, versionReference: id(102), versionNumber: 3 }, 202);
      // Neither is another order type, another Brand, or a Store's own override.
      await rawInsert(
        restricted,
        { ...secondFamily, applicabilityCode: "DineIn", versionReference: id(103) },
        204,
      );
      await rawInsert(
        restricted,
        {
          ...secondFamily,
          brandReference: id(20),
          workflowReference: id(104),
          versionReference: id(105),
        },
        206,
      );
      const override = (store, family) => ({
        ...draft,
        storeReference: store,
        baseVersionReference: installed.plan.published.versionReference,
        overrideAuthorizationReference: id(110),
        workflowReference: id(family),
        versionReference: id(family + 1),
      });
      await rawInsert(restricted, override(id(3), 120), 208);
      await rawInsert(restricted, override(id(4), 122), 210);
      // A Store holds one override family for the same reason a Brand holds one family.
      await assert.rejects(rawInsert(restricted, override(id(3), 124), 212), { code: "23514" });

      // Two writers racing: the second waits for the first, then finds its row.
      const racing = id(21);
      const raceFamily = (family) => ({
        ...draft,
        brandReference: racing,
        workflowReference: id(family),
        versionReference: id(family + 1),
      });
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let inserted;
      const firstInserted = new Promise((resolve) => {
        inserted = resolve;
      });
      const winner = rawInsert(restricted, raceFamily(130), 214, async () => {
        inserted();
        await held;
      });
      await firstInserted;
      const loser = rawInsert(restricted, raceFamily(132), 216);
      await advisoryWaiter(admin);
      release();
      await winner;
      await assert.rejects(loser, { code: "23514" });
      assert.equal(await families(admin, racing), 1);

      // Two installs at once: one installs, the other waits and then finds it installed.
      const racingInstalls = id(22);
      const a = new Client(context.clientConfig),
        b = new Client(context.clientConfig);
      await a.connect();
      await b.connect();
      try {
        await a.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const applied = await applyWorkflowRelease(a, released(racingInstalls, 3), now);
        await b.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const waiting = applyWorkflowRelease(b, released(racingInstalls, 4), now);
        await advisoryWaiter(admin);
        await a.query("COMMIT");
        const found = await waiting;
        await b.query("COMMIT");
        assert.equal(applied.status, "Applied");
        assert.equal(found.status, "AlreadyInstalled");
        assert.equal(
          found.plan.published.versionReference,
          applied.plan.published.versionReference,
        );
        assert.equal(await families(admin, racingInstalls), 1);
      } finally {
        await a.end();
        await b.end();
      }
    } finally {
      await roles.drop();
      await admin.end();
    }
  });
});

it("a family that cannot serve the release is refused; an older one still binds; two families name the rule", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wfdiffer" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = await pilotRoles(admin, context.runId);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const restricted = restrictedRunner(context, roles.api);
      const installAs = async (brand, n, workflow, release = "OrderFulfillmentPickup") => {
        const planned = released(brand, n, release);
        return inTransaction(admin, () =>
          commitPlannedRelease(admin, planWorkflowRelease(planned, workflow), planned),
        );
      };
      const rerun = (brand, n, release) =>
        inTransaction(admin, () => applyWorkflowRelease(admin, released(brand, n, release), now));

      // The repository moved on after this Brand installed: it keeps serving, and a Store can bind.
      const olderBrand = id(20);
      const older = await installAs(olderBrand, 1, {
        ...pickup,
        transitions: pickup.transitions.filter((t) => t.currentState !== "Ready"),
      });
      const before = await counts(admin);
      const found = await rerun(olderBrand, 2);
      assert.equal(found.status, "AlreadyInstalledOlderDefinition");
      assert.equal(found.plan.published.versionReference, older.plan.published.versionReference);
      assert.deepEqual(await counts(admin), before);
      assert.equal(
        (await resolvePickup(resolver(restricted, olderBrand))).definition.versionReference,
        older.plan.published.versionReference,
      );

      // A family the binding cannot name is refused, and nothing is written.
      const unbound = id(21);
      await installAs(unbound, 3, {
        ...pickup,
        transitions: pickup.transitions.filter((t) => t.action !== "FulfillOrder"),
      });
      await assert.rejects(rerun(unbound, 4), /WORKFLOW_RELEASE_ALREADY_INSTALLED_DIFFERENT/u);
      assert.equal(await families(admin, unbound), 1);

      // The cancellation worker accepts only the repository's current definition.
      const cancellation = id(22);
      const unpaid = platformWorkflows.UnpaidDineInBatchCancellation;
      await installAs(
        cancellation,
        5,
        { ...unpaid, transitions: unpaid.transitions.slice(1) },
        "UnpaidDineInBatchCancellation",
      );
      await assert.rejects(
        rerun(cancellation, 6, "UnpaidDineInBatchCancellation"),
        /WORKFLOW_RELEASE_ALREADY_INSTALLED_DIFFERENT/u,
      );

      // Withdrawn: the resolver refuses it by name, and the tool does not reinstall over it.
      const withdrawnBrand = id(23);
      const withdrawn = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(withdrawnBrand, 7), now),
      );
      await rawInsert(
        { run: (work) => work(admin) },
        {
          ...withdrawn.plan.published,
          versionReference: id(300),
          versionNumber: 3,
          lifecycle: "Withdrawn",
        },
        301,
      );
      await assert.rejects(
        rerun(withdrawnBrand, 8),
        /WORKFLOW_RELEASE_ALREADY_INSTALLED_DIFFERENT/u,
      );
      await assert.rejects(resolvePickup(resolver(restricted, withdrawnBrand)), {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
        rule: "BrandVersionNotActive",
      });

      // A Brand already holding two families, as a retired TEST merchant on v15 does: the rows
      // cannot be edited, so they are crafted here as they were written then.
      const duplicated = id(24);
      const one = await inTransaction(admin, () =>
        applyWorkflowRelease(admin, released(duplicated, 9), now),
      );
      await admin.query(
        "ALTER TABLE bop_workflow.workflow_definition_version DISABLE TRIGGER workflow_definition_append",
      );
      await rawInsert(
        { run: (work) => work(admin) },
        { ...one.plan.published, workflowReference: id(310), versionReference: id(311) },
        312,
      );
      await admin.query(
        "ALTER TABLE bop_workflow.workflow_definition_version ENABLE TRIGGER workflow_definition_append",
      );
      await assert.rejects(rerun(duplicated, 10), /WORKFLOW_RELEASE_DUPLICATE_FAMILIES/u);
      assert.equal(await families(admin, duplicated), 2);

      // Reading what is already there still works under the guard: the history is intact.
      const owner = resolver(restricted, duplicated);
      const stored = await restricted.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [options.tenantReference, duplicated],
        );
        return (
          await tx.query(
            "SELECT workflow_id::text AS family,version_number::int AS version FROM bop_workflow.workflow_definition_version WHERE brand_id=$1 ORDER BY workflow_id,version_number",
            [duplicated],
          )
        ).rows;
      });
      assert.equal(stored.length, 3);
      assert.equal(new Set(stored.map(({ family }) => family)).size, 2);
      // A later version of a family it already holds still works (only a new family is refused).
      await rawInsert(
        restricted,
        { ...one.plan.draft, versionReference: id(313), versionNumber: 3 },
        314,
      );

      // The resolver stays closed and names the rule, for every action a money path evaluates.
      const refused = await resolvePickup(owner).catch((error) => error);
      assert.equal(refused.code, "WORKFLOW_DEFINITION_UNAVAILABLE");
      assert.equal(refused.rule, "TwoBrandVersions");
      for (const { currentState, action } of pickup.transitions)
        await assert.rejects(
          owner.evaluatePublishedAction(
            {
              tenantReference: id(1),
              brandReference: duplicated,
              storeReference: id(3),
              actorReference: id(40),
              resourceReference: id(41),
              resourceVersion: 1,
              purposeCode: "OrderFulfillment",
              applicabilityCode: "Pickup",
              expectedVersionReference: one.plan.published.versionReference,
              currentState,
              action,
              observedAt: new Date(now()).toISOString(),
            },
            {
              authorizeResource: async () => true,
              authorizeAction: async () => true,
              evaluateRule: async () => true,
              authorizeOverride: async () => false,
            },
          ),
          { code: "WORKFLOW_DEFINITION_UNAVAILABLE", rule: "TwoBrandVersions" },
        );

      // The log line a guest's failed order leaves: Ordering wraps Inventory, which wraps this.
      reportUnexpected(
        "CUSTOMER_ORDER_UNAVAILABLE",
        Object.assign(
          new Error("order", {
            cause: Object.assign(new Error("source", { cause: refused }), {
              code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
            }),
          }),
          { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
        ),
      );
      const line = JSON.parse(spy.mock.calls.at(-1)[0]);
      assert.deepEqual(line.causes, [
        "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
        "WORKFLOW_DEFINITION_UNAVAILABLE",
      ]);
      assert.equal(line.rule, "TwoBrandVersions");

      // Staff hear before a guest does: the monitor's read, under the restricted role, raises the row.
      const bindingFile = (brand, plan, release) =>
        workflowRuntimeFile(plan, {
          environment: "InternalTest",
          database: context.databaseName,
          scope: { tenantReference: id(1), brandReference: brand, storeReference: id(3) },
          operationReference: id(1),
          release,
        });
      const binding = (brand, version) =>
        bindingFile(
          brand,
          { published: { ...one.plan.published, versionReference: version } },
          "OrderFulfillmentPickup",
        );
      const resources = (brand) => ({
        publicProfile: { binding: { tenantReference: id(1) } },
        scope: { brandReference: brand, storeReference: id(3) },
        now: () => new Date(now()).toISOString(),
        transactions: restricted,
      });
      const lost = () => {
        throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
      };
      const store = ({ Cancellation, ...orders } = {}) => ({
        loadWorkflow: async (kind) => orders[kind] ?? lost(),
        loadCancellationWorkflow: async () => Cancellation ?? lost(),
      });
      const raised = (workflow) =>
        evaluateAlertConditions({
          now: now(),
          probes: {},
          supervisor: { maintenance: false, reportAgeMs: 0, attention: [] },
          business: { workflow },
          backup: { lastSuccessAt: new Date(now()).toISOString() },
          certificate: null,
          disks: [],
          channels: [],
        });
      const duplicatedStore = store({
        Pickup: binding(duplicated, one.plan.published.versionReference),
      });
      // Its other bindings do not load, and the refusal is still raised.
      const notReady = await readInternalWorkflowReadiness(resources(duplicated), duplicatedStore);
      assert.deepEqual(notReady, {
        ready: false,
        refusals: [{ binding: "Pickup", rule: "TwoBrandVersions" }],
        // Nothing published yet: it is not called a type the Store does not sell.
        orderTypes: ["Pickup", "DineIn"],
      });
      assert.deepEqual([...raised(notReady).keys()], ["orders.workflow"]);
      assert.equal(raised(notReady).get("orders.workflow").severity, "critical");
      assert.equal(raised(notReady).get("orders.workflow").params.state, "Pickup");

      // Dine-in only, as the trial's hotpot restaurant: a refused pickup family is no emergency.
      const configuration = (brand, version, modes) =>
        admin.query(
          `INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,enabled_service_modes,effective_from,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification)
           VALUES($1,$2,$3,$4,'Published','StoreOverride',$5,'en-CA','CAD','America/Toronto',$6,$7,$8,$9,$10,$11::text[],$12,$13,'TEST_ONLY',$14,$15,$16,$17,$18,$12,$12,'ConfigurationMetadata')`,
          [
            id(400 + version),
            brand,
            id(3),
            version,
            ...[410, 411, 412, 413, 414, 415].map(id),
            modes,
            "2026-01-01T00:00:00.000Z",
            version === 1 ? null : id(400 + version - 1),
            ...[416, 417, 418, 419, 420].map(id),
          ],
        );
      await configuration(duplicated, 1, ["DineIn"]);
      const dineInOnly = await readInternalWorkflowReadiness(
        resources(duplicated),
        duplicatedStore,
      );
      assert.deepEqual(dineInOnly.orderTypes, ["DineIn"]);
      assert.equal(raised(dineInOnly).get("orders.workflow").severity, "warning");
      assert.equal(raised(dineInOnly).get("orders.workflow").params.state, "PickupNotOffered");
      // The Owner turns pickup on: the newest published version answers, and it is urgent at once.
      await configuration(duplicated, 2, ["DineIn", "Pickup"]);
      const turnedOn = await readInternalWorkflowReadiness(resources(duplicated), duplicatedStore);
      assert.deepEqual(turnedOn.orderTypes, ["DineIn", "Pickup"]);
      assert.equal(raised(turnedOn).get("orders.workflow").severity, "critical");
      // Another Store's configuration says nothing about this one: row security, not a filter.
      const another = await restricted.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [duplicated, id(4)],
        );
        return (
          await tx.query(
            "SELECT count(*)::int AS n FROM rms_store.store_configuration_version WHERE brand_id=$1",
            [duplicated],
          )
        ).rows[0].n;
      });
      assert.equal(another, 0);

      // A whole, healthy Store: every binding the tool writes loads and answers, under the same
      // role, and a family from an earlier repository is healthy too.
      const installWhole = async (brand, first, pickupInstalled = null) => {
        const files = {};
        for (const [index, release] of Object.keys(platformWorkflows).entries()) {
          const installed =
            release === "OrderFulfillmentPickup" && pickupInstalled !== null
              ? pickupInstalled
              : await inTransaction(admin, () =>
                  applyWorkflowRelease(admin, released(brand, first + index, release), now),
                );
          files[platformWorkflows[release].binding ?? "Cancellation"] = bindingFile(
            brand,
            installed.plan,
            release,
          );
        }
        return files;
      };
      const healthyBrand = id(25);
      const healthy = await installWhole(healthyBrand, 11);
      assert.deepEqual(
        await readInternalWorkflowReadiness(resources(healthyBrand), store(healthy)),
        { ready: true },
      );
      assert.deepEqual(
        await readInternalWorkflowReadiness(
          resources(olderBrand),
          store(await installWhole(olderBrand, 21, older)),
        ),
        { ready: true },
      );

      // A binding naming another version: guests still pay, so it is not the same alarm.
      const staleBinding = binding(healthyBrand, id(999));
      const stale = await readInternalWorkflowReadiness(
        resources(healthyBrand),
        store({ ...healthy, Pickup: staleBinding }),
      );
      assert.deepEqual(stale.refusals, [{ binding: "Pickup", rule: "ExpectedVersionChanged" }]);
      assert.equal(raised(stale).get("orders.workflow").params.state, "PaidPickup");

      // A cancellation binding from another family: the staff cancel would refuse it.
      const otherFamily = {
        ...healthy.Cancellation,
        definition: { ...healthy.Cancellation.definition, workflowReference: id(998) },
      };
      const noCancel = await readInternalWorkflowReadiness(
        resources(healthyBrand),
        store({ ...healthy, Cancellation: otherFamily }),
      );
      assert.deepEqual(noCancel.refusals, [
        { binding: "Cancellation", rule: "ExpectedVersionChanged" },
      ]);
      assert.deepEqual([...raised(noCancel).keys()], ["orders.unpaid_rounds"]);

      // Lost bindings at a Store whose Brand has its Workflows: it cannot say all is well, in whole
      // or in part. Services hold their copies until the next restart, so nobody else would notice.
      for (const lostSome of [store(), store({ ...healthy, DineIn: undefined })])
        await assert.rejects(
          readInternalWorkflowReadiness(resources(healthyBrand), lostSome),
          /PILOT_WORKFLOW_BINDING_UNAVAILABLE/u,
        );
      // A Store being opened, whose Brand holds nothing yet: not checked.
      assert.equal(await readInternalWorkflowReadiness(resources(id(26)), store()), null);
    } finally {
      spy.mockRestore();
      await roles.drop();
      await admin.end();
    }
  });
});
