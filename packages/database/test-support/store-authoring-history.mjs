import assert from "node:assert/strict";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
export async function verifyStoreAuthoringHistory({ admin, role, id, configuration }) {
  const draft = createStoreConfigurationVersion({
    ...configuration,
    configurationReference: id(400),
    configurationVersion: 2,
    supersedesConfigurationReference: configuration.configurationReference,
    lifecycle: "Draft",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
  });
  const insert = (op, sequence, command, content, expected) =>
    admin.query(
      "INSERT INTO rms_store.store_configuration_authoring_operation VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'STORE_CONFIGURATION',$13,$14,'ConfigurationMetadata')",
      [
        id(op),
        id(2),
        id(3),
        sequence,
        content.configurationReference,
        content.configurationVersion,
        command,
        content.lifecycle,
        expected,
        "sha256:" + "a".repeat(64),
        JSON.stringify(content),
        id(10),
        id(op + 100),
        content.updatedAt,
      ],
    );
  await insert(401, 1, "SaveDraft", draft, 1);
  const submitted = createStoreConfigurationVersion({ ...draft, lifecycle: "PendingApproval" });
  await insert(402, 2, "Submit", submitted, 2);
  const approved = createStoreConfigurationVersion({
    ...submitted,
    lifecycle: "Approved",
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
  });
  await insert(403, 3, "Approve", approved, 2);
  const published = createStoreConfigurationVersion({
    ...approved,
    lifecycle: "Published",
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
  });
  await insert(404, 4, "Publish", published, 2);
  const rows = await admin.query(
    "SELECT configuration_version,lifecycle FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 ORDER BY sequence_number",
    [id(2), id(3)],
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.configuration_version, row.lifecycle]),
    [
      ["2", "Draft"],
      ["2", "PendingApproval"],
      ["2", "Approved"],
      ["2", "Published"],
    ],
  );
  await assert.rejects(insert(405, 4, "Publish", published, 2), { code: "23505" });
  await assert.rejects(insert(406, 5, "Approve", draft, 2), { code: "23514" });
  await assert.rejects(insert(407, 5, "SaveDraft", { ...draft, storeReference: id(99) }, 1), {
    code: "23514",
  });
  await assert.rejects(insert(408, 5, "SaveDraft", draft, 2), { code: "23514" });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_version WHERE configuration_id=$1",
        [id(400)],
      )
    ).rowCount,
    0,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_store.store_configuration_authoring_operation TO " +
      role,
  );
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  async function asRole(store, work) {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(2), store],
      );
      return await work();
    } finally {
      await admin.query("ROLLBACK");
    }
  }
  assert.equal(
    (
      await asRole(id(99), () =>
        admin.query("SELECT * FROM rms_store.store_configuration_authoring_operation"),
      )
    ).rowCount,
    0,
  );
  assert.equal((await asRole(id(3), () => insert(410, 5, "SaveDraft", draft, 1))).rowCount, 1);
  await assert.rejects(
    asRole(id(99), () => insert(409, 5, "SaveDraft", draft, 1)),
    { code: "42501" },
  );
  await assert.rejects(
    asRole(id(3), () =>
      admin.query(
        "UPDATE rms_store.store_configuration_authoring_operation SET sequence_number=99 WHERE operation_id=$1",
        [id(401)],
      ),
    ),
    { code: "55000" },
  );
  assert.equal(
    (
      await asRole(id(3), () =>
        admin.query(
          "DELETE FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
          [id(401)],
        ),
      )
    ).rowCount,
    0,
  );
}
