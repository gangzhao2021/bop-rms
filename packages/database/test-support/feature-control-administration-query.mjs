import assert from "node:assert/strict";
import pg from "pg";
import {
  createPostgresFeatureControlAdministrationQueryStore,
  createPostgresFeatureControlAdministrationMutationStore,
  createPostgresFeatureControlInitialDraftStore,
} from "../../bop/feature-control/src/index.ts";
/** Synthetic held authority plus actual owning SQL/RLS. No actual flag or phase grant. */
export async function exerciseFeatureControlAdministrationQuery({ admin, context, role, id, at }) {
  const scope = { brandReference: id(2), storeReference: id(3) };
  let held = 0,
    allowed = true,
    sqlCalls = 0;
  const request = {
    actorReference: id(8),
    purposeCode: "FEATURE_CONTROL_READ",
    key: "ordering.delivery.capability",
    observedAt: at,
  };
  const authority = {
    async withAuthorizedDefinitionsScope(input, work) {
      assert.equal(input.actorReference, id(8));
      assert.equal(input.purposeCode, "FEATURE_CONTROL_READ");
      assert.equal(input.access, "AdministrationDefinitions");
      if (!allowed) throw Error("synthetic source denial");
      held++;
      try {
        return await work();
      } finally {
        held--;
      }
    },
  };
  const runner = {
    async run(work) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await work({
          async query(sql, values) {
            assert.ok(held > 0);
            sqlCalls++;
            return client.query(sql, [...values]);
          },
        });
        await client.query("COMMIT");
        assert.ok(held > 0);
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const store = (input = scope) =>
    createPostgresFeatureControlAdministrationQueryStore(runner, input, authority);
  const first = await store().load(request);
  assert.equal(first.definitions.length, 1);
  assert.equal(first.definitions[0].scope.storeReference, id(3));
  assert.equal(first.definitions[0].dependencies[0].evidenceReference, id(21));
  assert.equal(first.definitions[0].dependencies[0].kind, "RequiresFutureTrigger");
  assert.equal(Object.isFrozen(first.definitions[0].dependencies[0]), true);
  assert.equal(first.dependencyCoverage, "Unconfirmed");
  assert.equal("available" in first, false);
  assert.equal("backendExecution" in first, false);
  const current = await store().withCurrentDefinitions(request, async (source) => {
    assert.ok(held > 0);
    assert.equal(source.dependencyCoverage, "Complete");
    return source;
  });
  assert.equal(current.definitions[0].dependencies.length, 1);
  assert.equal(held, 0);
  // Exact parent scope FK closes the legacy RLS-hidden dependency hole.
  await assert.rejects(
    admin.query(
      "INSERT INTO bop_feature_control.control_dependency(dependency_id,brand_id,store_id,control_id,control_version,dependency_kind,target_key,minimum_compatible_version,dependency_status,evidence_reference,evidence_version,data_classification) VALUES($1,$2,$3,$4,1,'RequiresFutureTrigger','delivery.provider.readiness',1,'Satisfied',$5,1,'ConfigurationMetadata')",
      [id(40), id(2), id(30), id(1), id(21)],
    ),
    (error) => error.code === "23503",
  );
  allowed = false;
  const callsBeforeDenied = sqlCalls;
  await assert.rejects(
    store().load(request),
    (error) => error.code === "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
  );
  assert.equal(sqlCalls, callsBeforeDenied);
  allowed = true;
  assert.equal(
    (await store({ brandReference: id(99), storeReference: id(3) }).load(request)).definitions
      .length,
    0,
  );
  assert.equal(
    (await store({ brandReference: id(2), storeReference: id(30) }).load(request)).definitions
      .length,
    0,
  );
  assert.equal(
    (await store({ ...scope, storeReference: null }).load(request)).definitions.length,
    0,
  );
  // Append a new immutable lifecycle fact; history query retains both actual versions.
  const later = new Date(Date.parse(at) + 1000).toISOString();
  await admin.query(
    `INSERT INTO bop_feature_control.control_version SELECT control_id,brand_id,store_id,control_key,2,description,owner_reference,purpose_code,source,default_value,'Disabled','Disabled',temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,$1,$2,data_classification FROM bop_feature_control.control_version WHERE control_id=$3 AND control_version=1`,
    [id(31), later, id(1)],
  );
  await assert.rejects(
    store().load(request),
    (error) => error.code === "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
  );
  const history = await store().load({ ...request, observedAt: later });
  assert.equal(history.definitions.length, 2);
  assert.deepEqual(
    history.definitions.map((d) => [d.version, d.lifecycle]),
    [
      [1, "Published"],
      [2, "Disabled"],
    ],
  );
  assert.equal(history.definitions[1].dependencies.length, 0);
  // Exact Brand inheritance remains visible independently of a Store definition.
  await admin.query(
    `INSERT INTO bop_feature_control.control_version SELECT $1,brand_id,NULL,control_key,1,description,owner_reference,purpose_code,'BrandOverride',default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,$2,created_at,data_classification FROM bop_feature_control.control_version WHERE control_id=$3 AND control_version=1`,
    [id(32), id(33), id(1)],
  );
  assert.equal((await store().load({ ...request, observedAt: later })).definitions.length, 3);
  assert.equal(
    (await store({ ...scope, storeReference: null }).load({ ...request, observedAt: later }))
      .definitions.length,
    1,
  );
  assert.equal(
    (await store({ ...scope, storeReference: id(30) }).load({ ...request, observedAt: later }))
      .definitions.length,
    1,
  );
  // The new FK rejects the legacy scope-corrupt child before RLS can hide it.
  await assert.rejects(
    admin.query(
      `INSERT INTO bop_feature_control.control_dependency VALUES($1,$2,$3,$4,1,'RequiresCapability','delivery.provider.readiness',1,'Unsatisfied',NULL,NULL,'ConfigurationMetadata')`,
      [id(34), id(2), id(3), id(32)],
    ),
    (error) => error.code === "23503",
  );
  const otherStore = await store({ ...scope, storeReference: id(30) }).withCurrentDefinitions(
    { ...request, observedAt: later },
    async (source) => source,
  );
  assert.equal(otherStore.dependencyCoverage, "Complete");
  assert.equal(otherStore.definitions[0].dependencies.length, 0);
  await admin.query(
    `GRANT INSERT ON bop_feature_control.control_version,bop_feature_control.control_dependency,bop_feature_control.control_operation TO ${role}`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA platform_audit TO ${role}`);
  await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
  await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
  await admin.query(`GRANT INSERT ON platform_audit.audit_record TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
  await admin.query(
    "INSERT INTO bop_feature_control.control_dependency(dependency_id,brand_id,store_id,control_id,control_version,dependency_kind,target_key,minimum_compatible_version,dependency_status,evidence_reference,evidence_version,data_classification) VALUES($1,$2,NULL,$3,1,'RequiresFutureTrigger','delivery.provider.readiness',1,'Satisfied',$4,1,'ConfigurationMetadata')",
    [id(60), id(2), id(32), id(21)],
  );
  const brandScope = { ...scope, storeReference: null };
  const original = (await store(brandScope).load({ ...request, observedAt: later })).definitions[0];
  const next = {
    ...original,
    version: 2,
    lifecycle: "Disabled",
    configuredValue: "Disabled",
    publicationReference: id(50),
  };
  const mutationInput = {
    idempotencyKey: id(51),
    expectedVersion: 1,
    current: original,
    next,
    audit: {
      auditId: id(52),
      brandId: id(2),
      actor: { type: "User", reference: id(8) },
      actionCode: "FEATURE_CONTROL_DISABLE",
      targetType: "FeatureControl",
      targetId: original.controlId,
      reasonCode: original.purposeCode,
      correlationId: id(51),
      occurredAt: later,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
      retentionPolicyVersion: 1,
    },
  };
  let grant = true,
    authorityCalls = 0,
    denyAfterAppend = true;
  const mutationOptions = {
    ...brandScope,
    actorReference: id(8),
    clock: { now: () => later },
    transactions: {
      async run(work) {
        held++;
        try {
          return await runner.run(work);
        } finally {
          held--;
        }
      },
    },
    authority: {
      async holdUntilTransactionCompletes() {
        assert.ok(held > 0);
        if (!grant || (++authorityCalls === 2 && denyAfterAppend)) throw Error("synthetic denied");
      },
    },
    dependencies: {
      async withHeldCurrentPublicationEvidence(_tx, _input, work) {
        return work();
      },
    },
  };
  const mutation = createPostgresFeatureControlAdministrationMutationStore(mutationOptions);
  await assert.rejects(
    mutation.commit(mutationInput),
    (error) => error.code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM bop_feature_control.control_operation WHERE operation_id=$1",
        [id(51)],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM platform_audit.audit_record WHERE audit_id=$1",
        [id(52)],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM bop_feature_control.control_dependency WHERE dependency_id=$1",
        [id(60)],
      )
    ).rows[0].n,
    1,
  );
  denyAfterAppend = false;
  await mutation.commit(mutationInput);
  await mutation.commit(mutationInput); // Original operation replay appends no duplicate artifacts.
  const alias = createPostgresFeatureControlAdministrationMutationStore({
    ...mutationOptions,
    operationReference: () => id(51),
  });
  await assert.rejects(
    alias.commit({ ...mutationInput, idempotencyKey: "different-original-key" }),
    (error) => error.code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM bop_feature_control.control_operation WHERE operation_id=$1",
        [id(51)],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM bop_feature_control.control_dependency WHERE dependency_id=$1",
        [id(60)],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer n FROM platform_audit.audit_record WHERE audit_id=$1",
        [id(52)],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    mutation.commit({ ...mutationInput, next: { ...next, description: "Changed intent" } }),
    (error) => error.code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
  );
  grant = false;
  await assert.rejects(
    mutation.commit(mutationInput),
    (error) => error.code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
  );
  grant = true;
  const currentBrand = await store(brandScope).withCurrentDefinitions(
    { ...request, observedAt: later },
    async (source) => source,
  );
  assert.equal(currentBrand.definitions.at(-1).configuredValue, "Disabled");
  // A participating writer cannot pass the current reader's Brand source barrier.
  await store(brandScope).withCurrentDefinitions({ ...request, observedAt: later }, async () => {
    const contender = new pg.Client(context.clientConfig);
    await contender.connect();
    try {
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        contender.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('bop.feature-control:' || $1,0))",
          [id(2)],
        ),
        (error) => error.code === "55P03",
      );
    } finally {
      await contender.query("ROLLBACK");
      await contender.end();
    }
  });
  // A bounded history sentinel fails instead of truncating or selecting a maximum as authorization.
  await admin.query(
    `INSERT INTO bop_feature_control.control_version SELECT $1,v.brand_id,NULL,'synthetic.overflow.capability',g.version,v.description,v.owner_reference,v.purpose_code,'BrandOverride',v.default_value,v.configured_value,v.lifecycle,v.temporary,v.effective_from,v.effective_until,v.review_at,v.expires_at,v.authored_by_reference,v.approved_by_reference,v.approval_evidence_reference,v.publication_reference,v.created_at,v.data_classification FROM bop_feature_control.control_version v CROSS JOIN generate_series(1,257) g(version) WHERE v.control_id=$2 AND v.control_version=1`,
    [id(40), id(1)],
  );
  await assert.rejects(
    store().load({ ...request, key: "synthetic.overflow.capability", observedAt: later }),
    (error) => error.code === "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
  );
  assert.equal(held, 0);
}

/** Actual owning SQL with controlled current authority; no real Store/trigger grant. */
export async function exerciseFeatureControlInitialDraft({ admin, context, role, id, at }) {
  const draft = {
    controlId: id(101),
    key: "inventory.item.capability",
    description: "Synthetic initial capability proposal",
    version: 1,
    ownerReference: id(102),
    purposeCode: "ITEM_CAPABILITY",
    scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
    source: "StoreOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Draft",
    temporary: false,
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: "2026-08-20T14:00:00.000Z",
    expiresAt: null,
    dependencies: [104, 103].map((n) => ({
      dependencyId: id(n),
      kind: "RequiresFutureTrigger",
      targetKey: n === 104 ? "inventory.provider.readiness" : "inventory.operator.readiness",
      minimumCompatibleVersion: 1,
      status: "Unsatisfied",
      evidenceReference: null,
      evidenceVersion: null,
    })),
    authoredByReference: id(8),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
  };
  const input = {
    definition: draft,
    idempotencyKey: id(105),
    audit: {
      auditId: id(106),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(8) },
      actionCode: "FEATURE_CONTROL_SAVEDRAFT",
      targetType: "FeatureControl",
      targetId: draft.controlId,
      reasonCode: draft.purposeCode,
      correlationId: id(107),
      occurredAt: at,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
      retentionPolicyVersion: 1,
    },
  };
  let now = at,
    allowed = true,
    denyAfterWrite = false,
    expireAfterWrite = false,
    repeatCallback = false,
    writes = 0,
    authorityCalls = 0;
  const options = {
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(8),
    clock: { now: () => now },
    authority: {
      async holdUntilTransactionCompletes(_tx, request) {
        authorityCalls++;
        assert.equal(request.operation, "CreateDraft");
        assert.equal(request.action, "feature.control.change");
        assert.equal(request.storeReference, id(3));
        assert.equal(request.actorReference, id(8));
        if (!allowed || (denyAfterWrite && writes > 0)) throw Error("synthetic current denial");
        if (expireAfterWrite && writes > 0) now = new Date(Date.parse(at) + 5000).toISOString();
      },
    },
    transactions: {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const tx = {
            async query(sql, values) {
              const result = await client.query(sql, [...values]);
              if (
                sql.startsWith("INSERT INTO bop_feature_control.control_operation") &&
                result.rowCount === 1
              )
                writes++;
              return result;
            },
          };
          const result = await work(tx);
          if (repeatCallback) await work(tx);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    },
  };
  const writer = createPostgresFeatureControlInitialDraftStore(options);
  const counts = async () =>
    (
      await admin.query(`SELECT
    (SELECT count(*) FROM bop_feature_control.control_version) AS versions,
    (SELECT count(*) FROM bop_feature_control.control_dependency) AS dependencies,
    (SELECT count(*) FROM bop_feature_control.control_operation) AS operations,
    (SELECT count(*) FROM platform_audit.audit_record) AS audits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) AS chains`)
    ).rows;
  const baseline = await counts();
  const failed = (error) => error.code === "FEATURE_CONTROL_ADMIN_COMMIT_FAILED";
  denyAfterWrite = true;
  await assert.rejects(writer.createDraft(input), failed);
  assert.equal(writes, 1);
  assert.deepEqual(await counts(), baseline);
  denyAfterWrite = false;
  writes = 0;
  expireAfterWrite = true;
  await assert.rejects(writer.createDraft(input), failed);
  assert.equal(writes, 1);
  assert.deepEqual(await counts(), baseline);
  expireAfterWrite = false;
  writes = 0;
  now = at;
  repeatCallback = true;
  await assert.rejects(writer.createDraft(input), failed);
  assert.equal(writes, 1);
  assert.deepEqual(await counts(), baseline);
  repeatCallback = false;
  writes = 0;
  const created = await writer.createDraft(input);
  assert.equal(writes, 1);
  assert.equal(created.lifecycle, "Draft");
  assert.equal(created.version, 1);
  assert.equal(created.approvalEvidenceReference, null);
  assert.equal(created.publicationReference, null);
  assert.deepEqual(
    created.dependencies.map((d) => d.dependencyId),
    [id(103), id(104)],
  );
  assert.ok(
    created.dependencies.every((d) => d.status === "Unsatisfied" && d.evidenceReference === null),
  );
  const operation = (
    await admin.query(
      "SELECT command_type,expected_version,resulting_version FROM bop_feature_control.control_operation WHERE operation_id=$1",
      [id(105)],
    )
  ).rows[0];
  assert.deepEqual(operation, {
    command_type: "SaveDraft",
    expected_version: "0",
    resulting_version: "1",
  });
  // A later Draft revision cannot change the original initial-creation result.
  await admin.query(
    `INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification)
    SELECT control_id,brand_id,store_id,control_key,2,'Synthetic later Draft',owner_reference,purpose_code,source,default_value,'Disabled',lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification FROM bop_feature_control.control_version WHERE control_id=$1 AND control_version=1`,
    [id(101)],
  );
  const after = await counts();
  now = new Date(Date.parse(at) + 60_000).toISOString();
  assert.deepEqual(await writer.createDraft(input), created);
  assert.deepEqual(await counts(), after);
  await assert.rejects(
    writer.createDraft({ ...input, definition: { ...draft, configuredValue: "Disabled" } }),
    failed,
  );
  await assert.rejects(
    writer.createDraft({
      ...input,
      idempotencyKey: id(108),
      audit: { ...input.audit, auditId: id(109) },
    }),
    failed,
  );
  assert.deepEqual(await counts(), after);
  allowed = false;
  const callsBefore = authorityCalls;
  await assert.rejects(writer.createDraft(input), failed);
  assert.equal(authorityCalls, callsBefore + 1);
  assert.deepEqual(await counts(), after);
  allowed = true;
  // Store exact scope: the new Draft and its original journal are hidden elsewhere.
  await admin.query(`SET ROLE ${role}`);
  try {
    await admin.query(
      "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
      [id(2), id(30)],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT control_id FROM bop_feature_control.control_version WHERE control_id=$1",
          [id(101)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT operation_id FROM bop_feature_control.control_operation WHERE operation_id=$1",
          [id(105)],
        )
      ).rowCount,
      0,
    );
  } finally {
    await admin.query("RESET ROLE");
  }
}
