import assert from "node:assert/strict";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import {
  createPostgresStoreServiceControl,
  createPostgresStorePauseHistorySource,
} from "../../rms/store/src/index.ts";
export async function verifyStoreServiceControl({ admin, role, id, currentConfiguration }) {
  await admin.query(
    "GRANT INSERT,UPDATE ON rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  let now = "2026-08-16T08:00:00.000Z",
    authorized = true,
    failAudit = true;
  const run = async (work) => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
      await admin.query("COMMIT");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const write = createPostgresStoreServiceControl({
    brandReference: id(2),
    storeReference: id(3),
    now: () => now,
    run,
    authorize: async () => authorized,
    currentConfiguration,
    hashIntent: (command) =>
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          brandReference: id(2),
          storeReference: id(3),
          ...command,
        }),
      ),
    appendAudit: async (tx, input) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: input.command.auditReference,
        brandId: id(2),
        storeId: id(3),
        actor: { type: "User", reference: input.command.actorReference },
        actionCode:
          input.command.command === "PauseService"
            ? "STORE_SERVICE_PAUSED"
            : "STORE_SERVICE_RESUMED",
        targetType: "StoreServiceControl",
        targetId: input.command.operationReference,
        reasonCode: "SYNTHETIC_SERVICE_CONTROL",
        correlationId: input.command.operationReference,
        occurredAt: input.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "STORE_SERVICE_AUDIT",
        retentionPolicyVersion: 1,
      });
      if (failAudit) throw new Error("synthetic failure after Audit write");
    },
  });
  const pause = {
    command: "PauseService",
    operationReference: id(300),
    configurationReference: id(1),
    actorReference: id(11),
    purposeCode: "STORE_SERVICE",
    expectedVersion: 2,
    auditReference: id(301),
    content: { effectiveUntil: "2026-08-16T09:00:00.000Z", serviceModes: ["Pickup"] },
  };
  await assert.rejects(write(pause), /synthetic failure after Audit write/u);
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_operation WHERE operation_id=$1",
        [id(300)],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [id(301)]))
      .rowCount,
    0,
  );
  failAudit = false;
  assert.deepEqual(await write(pause), { status: "Applied", resultingVersion: 3 });
  assert.deepEqual(await write(pause), { status: "AlreadyApplied", resultingVersion: 3 });
  assert.equal(
    (await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [id(301)]))
      .rowCount,
    1,
  );
  await assert.rejects(
    write({ ...pause, content: { ...pause.content, effectiveUntil: "2026-08-16T10:00:00.000Z" } }),
    /STORE_SERVICE_IDEMPOTENCY_CONFLICT/u,
  );
  await assert.rejects(
    write({ ...pause, operationReference: id(302), auditReference: id(303) }),
    /STORE_SERVICE_VERSION_CONFLICT/u,
  );
  const read = createPostgresStorePauseHistorySource({
    brandReference: id(2),
    storeReference: id(3),
    authorize: async () => true,
    verifyOperation: async () => true,
  });
  assert.equal(
    (await run((tx) => read(tx, "2026-08-16T08:15:00.000Z")))[0].closureReference,
    id(300),
  );
  now = "2026-08-16T08:30:00.000Z";
  const resume = {
    command: "ResumeService",
    operationReference: id(304),
    configurationReference: id(1),
    actorReference: id(11),
    purposeCode: "STORE_SERVICE",
    expectedVersion: 3,
    auditReference: id(305),
    content: { pauseOperationReference: id(300) },
  };
  authorized = false;
  await assert.rejects(write(resume), /STORE_SERVICE_PERMISSION_DENIED/u);
  authorized = true;
  assert.deepEqual(await write(resume), { status: "Applied", resultingVersion: 4 });
  assert.deepEqual(await run((tx) => read(tx, now)), []);
  now = "2026-08-16T10:00:00.000Z";
  assert.deepEqual(await write(pause), { status: "AlreadyApplied", resultingVersion: 3 });
}
