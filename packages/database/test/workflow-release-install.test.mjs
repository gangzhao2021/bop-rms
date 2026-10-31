import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresWorkflowDefinitionStore } from "../../bop/workflow/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  applyWorkflowRelease,
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
