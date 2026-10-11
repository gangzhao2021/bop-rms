import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresWorkflowDefinitionStore } from "../../bop/workflow/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { matchesPlatformWorkflow } from "../../../tooling/environment/platform-workflows.mjs";
const { Client } = pg;
const id = (n) => "0190999a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const issuedAt = Date.now() - 60_000;
const options = {
  purposeCode: "UnpaidDineInBatchCancellation",
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
      // The pilot API role's grants (docs/spec/pilot-acl-matrix.json); UPDATE only takes the lock mode.
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_workflow.workflow_definition_version,bop_publishing.publishing_mutation_record TO " +
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
    } finally {
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
