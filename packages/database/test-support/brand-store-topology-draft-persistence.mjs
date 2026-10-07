import assert from "node:assert/strict";
import pg from "pg";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { createPostgresBrandStoreTopologyDraftStore } from "../../bop/tenant/src/infrastructure/persistence/brand-store-topology-draft-store.ts";
import { createPostgresTenantStoreReferenceSource } from "../../bop/tenant/src/infrastructure/persistence/store-reference-source.ts";
import {
  BrandStoreTopologyError,
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
} from "../../bop/tenant/src/contracts/brand-store-topology-operation.ts";

/** Actual PostgreSQL/owning producer component acceptance. Authority is an
 * explicit synthetic control, not current encrypted Session or IAM proof. */
export async function exerciseBrandStoreTopologyDraft({ context, admin, role, id, at }) {
  await admin.query(
    "GRANT SELECT,INSERT ON bop_tenant.brand_store_topology_draft_revision,bop_tenant.brand_store_topology_draft_operation TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON bop_tenant.store_reference_generation,bop_tenant.store_reference_projection,bop_tenant.brand TO " +
      role,
  );
  await admin.query("GRANT UPDATE(version) ON bop_tenant.brand TO " + role);
  await admin.query("GRANT UPDATE(updated_at,code,display_name) ON bop_tenant.store TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  const sourceTime = (
    await admin.query(
      "SELECT greatest(b.updated_at,s.updated_at,$3::timestamptz) AS observed_at FROM bop_tenant.brand b JOIN bop_tenant.store s ON s.brand_id=b.brand_id WHERE b.brand_id=$1 AND s.store_id=$2",
      [id(1), id(2), at],
    )
  ).rows[0];
  assert.ok(sourceTime);
  let clockMs = sourceTime.observed_at.getTime();
  let next = 7200;
  let allowed = true;
  let withdrawAtGuard = false;
  let failAudit = false;
  let rosterReads = 0;
  let actualAuditWrites = 0;
  const hashIntent = (text) => "sha256:" + sha256Hex(text);
  const scope = { tenantReference: id(7001), brandReference: id(1), actorReference: id(7002) };
  const command = (operation, expectedRevision, name = "Synthetic North group") =>
    parseBrandStoreTopologySave({
      profile: "BrandStoreTopologySaveV1",
      ...scope,
      operationReference: id(operation),
      expectedRevision,
      content: {
        profile: "BrandStoreTopologyDraftV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        draftReference: id(7003),
        selectors: [{ kind: "StoreGroup", reference: id(7004), code: "NORTH", name }],
        assignments: [{ storeReference: id(2), selectorReference: id(7004) }],
      },
    });
  const resolveCommand = (original) => {
    const { content, ...identity } = original;
    void content;
    return parseBrandStoreTopologyResolve({
      ...identity,
      profile: "BrandStoreTopologyResolveV1",
      intentDigest: hashIntent(canonicalizeRfc8785(original)),
    });
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM bop_tenant.brand_store_topology_draft_revision WHERE brand_id=$1) revisions,(SELECT count(*)::int FROM bop_tenant.brand_store_topology_draft_operation WHERE brand_id=$1) operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audits",
        [scope.brandReference],
      )
    ).rows[0];
  const authority = async (_tx, request) => {
    assert.equal(request.tenantReference, scope.tenantReference);
    assert.equal(request.brandReference, scope.brandReference);
    assert.ok([scope.actorReference, id(7005)].includes(request.actorReference));
    assert.equal(request.permission, "organization.manage");
    assert.equal(request.purposeCode, "BRAND_STORE_TOPOLOGY_DRAFT");
    if (!allowed) throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
    return { validUntil: request.validUntil };
  };
  const appendAudit = async (tx, input) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      scope.brandReference,
    ]);
    await appendAuditRecordInTransaction(tx, {
      auditId: input.auditReference,
      brandId: scope.brandReference,
      actor: { type: "User", reference: input.actorReference },
      actionCode:
        input.mode === "Save"
          ? "BRAND_STORE_TOPOLOGY_DRAFT_SAVED"
          : "BRAND_STORE_TOPOLOGY_ORIGINAL_ABANDONED",
      targetType: "BrandStoreTopology",
      targetId: scope.brandReference,
      correlationId: input.operationReference,
      reasonCode: "BRAND_STORE_TOPOLOGY_DRAFT",
      occurredAt: input.occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    actualAuditWrites++;
    if (failAudit) throw new Error("Synthetic post-Audit rollback");
  };
  const storeSource = (tx) =>
    createPostgresTenantStoreReferenceSource({
      brandReference: scope.brandReference,
      transactions: { run: async (work) => work(tx) },
      authority: {
        withCurrentBrandReferenceRead: async (_request, work) => work(),
        isCurrent: async () => allowed,
      },
    });
  const readStoreRoster = async (tx, request, work) => {
    rosterReads++;
    return storeSource(tx).withCurrentSnapshot(
      {
        brandReference: scope.brandReference,
        actorReference: request.actorReference,
        purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
        originalIntentDigest: hashIntent(canonicalizeRfc8785(request)),
        observedAt: request.observedAt,
      },
      work,
    );
  };
  async function run(work, actorReference = scope.actorReference) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    const asyncGuards = [],
      finals = [];
    clockMs += 10;
    const originMs = clockMs;
    const observedAt = new Date(originMs).toISOString();
    const validUntil = new Date(originMs + 5000).toISOString();
    const started = Date.now();
    const clock = { now: () => new Date(originMs + Date.now() - started).toISOString() };
    const tx = { query: (sql, values) => client.query(sql, [...values]) };
    const owner = createPostgresBrandStoreTopologyDraftStore({
      ...scope,
      actorReference,
      transaction: tx,
      clock,
      originalObservedAt: observedAt,
      originalValidUntil: validUntil,
      registerBeforeCommit: async (actual, guard, final) => {
        assert.equal(actual, tx);
        asyncGuards.push(guard);
        finals.push(final);
      },
      authority: {
        holdUntilTransactionCompletes: async (actual, request) => {
          assert.equal(actual, tx);
          assert.equal(request.actorReference, actorReference);
          return authority(actual, request);
        },
      },
      references: {
        canonicalize: canonicalizeRfc8785,
        hashIntent,
        nextReference: (kind) => {
          assert.equal(kind, "Audit");
          return id(next++);
        },
      },
      appendAudit,
      withCurrentStoreReferences: readStoreRoster,
    });
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL ROLE " + role);
      await client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [scope.tenantReference, scope.brandReference],
      );
      const result = await work(owner, tx, clock);
      if (withdrawAtGuard) allowed = false;
      for (const guard of asyncGuards) await guard();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const final of finals) final();
      await client.query("COMMIT");
      owner.assertFinalized(tx);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      clockMs = Math.max(clockMs, Date.parse(clock.now()));
      await client.end();
    }
  }
  const before = await counts();
  assert.equal((await run((owner) => owner.readCurrent())).current, null);
  const actualStoreLabels = (
    await admin.query(
      "SELECT store_id,code,display_name FROM bop_tenant.store WHERE brand_id=$1 ORDER BY store_id",
      [scope.brandReference],
    )
  ).rows;
  const labelsRequest = (clock) => ({
    brandReference: scope.brandReference,
    actorReference: scope.actorReference,
    purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
    originalIntentDigest: hashIntent(canonicalizeRfc8785(scope)),
    observedAt: clock.now(),
  });
  await run(async (owner, tx, clock) => {
    await owner.readCurrent();
    await storeSource(tx).withCurrentLabelSnapshot(labelsRequest(clock), async (snapshot) => {
      assert.equal(snapshot.profile, "TenantStoreLabelReferenceV1");
      assert.equal(snapshot.referenceCount, String(actualStoreLabels.length));
      assert.deepEqual(
        snapshot.references.map((row) => ({
          store_id: row.storeReference,
          code: row.code,
          display_name: row.displayName,
        })),
        actualStoreLabels,
      );
    });
  });
  await assert.rejects(
    run(async (owner, tx, clock) => {
      await owner.readCurrent();
      await storeSource(tx).withCurrentLabelSnapshot(labelsRequest(clock), async (snapshot) => {
        const original = snapshot.references.find((row) => row.storeReference === id(2));
        assert.ok(original);
        await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(2)]);
        const changed = await tx.query(
          "UPDATE bop_tenant.store SET display_name=$2 WHERE store_id=$1 RETURNING display_name",
          [id(2), "Synthetic changed label"],
        );
        assert.equal(changed.rowCount, 1);
        await tx.query("SELECT set_config('bop.store_id','',true)", []);
        const projected = await tx.query(
          "SELECT code,display_name FROM bop_tenant.store_reference_projection WHERE brand_id=$1 AND store_id=$2",
          [scope.brandReference, id(2)],
        );
        assert.deepEqual(projected.rows, [
          { code: original.code, display_name: "Synthetic changed label" },
        ]);
      });
    }),
    { message: "TENANT_STORE_REFERENCE_UNAVAILABLE" },
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT store_id,code,display_name FROM bop_tenant.store WHERE brand_id=$1 ORDER BY store_id",
        [scope.brandReference],
      )
    ).rows,
    actualStoreLabels,
  );
  assert.deepEqual(await counts(), before);
  const firstCommand = command(7101, 0);
  const first = await run((owner) => owner.save(firstCommand));
  assert.equal(first.outcome, "Committed");
  assert.equal(first.snapshot.revision, 1);
  assert.deepEqual(first.snapshot.content, firstCommand.content);
  assert.equal(first.snapshot.actorReference, scope.actorReference);
  const firstTime = first.snapshot.createdAt;
  const secondCommand = parseBrandStoreTopologySave({
    ...command(7102, 1, "Synthetic renamed group"),
    actorReference: id(7005),
  });
  const second = await run((owner) => owner.save(secondCommand), id(7005));
  assert.equal(second.snapshot.revision, 2);
  assert.equal(second.snapshot.createdAt, firstTime);
  assert.equal(second.snapshot.actorReference, id(7005));
  const workspace = await run((owner) => owner.readCurrent());
  assert.equal(workspace.actorReference, scope.actorReference);
  assert.deepEqual(workspace.current, second.snapshot);
  const history = await run((owner) => owner.readHistory());
  assert.deepEqual(history, [first.snapshot, second.snapshot]);
  const saved = await counts();
  assert.deepEqual(saved, {
    revisions: before.revisions + 2,
    operations: before.operations + 2,
    audits: before.audits + 2,
  });
  const rosterAtReplay = rosterReads,
    noncesAtReplay = next;
  assert.deepEqual(await run((owner) => owner.save(firstCommand)), first);
  assert.deepEqual(await run((owner) => owner.resolve(resolveCommand(firstCommand))), first);
  assert.equal(rosterReads, rosterAtReplay);
  assert.equal(next, noncesAtReplay);
  assert.deepEqual(await counts(), saved);
  await assert.rejects(
    run((owner) => owner.save(command(7101, 0, "Changed original intent"))),
    { code: "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT" },
  );
  await assert.rejects(
    run((owner) => owner.save(command(7103, 1))),
    { code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" },
  );
  assert.deepEqual(await counts(), saved);
  const absentCommand = command(7104, 2);
  const abandoned = await run((owner) => owner.resolve(resolveCommand(absentCommand)));
  assert.equal(abandoned.outcome, "Abandoned");
  assert.equal(abandoned.snapshot, null);
  const afterAbsent = await counts();
  assert.deepEqual(afterAbsent, {
    revisions: saved.revisions,
    operations: saved.operations + 1,
    audits: saved.audits + 1,
  });
  const abandonedRoster = rosterReads,
    abandonedNonce = next;
  assert.deepEqual(await run((owner) => owner.save(absentCommand)), abandoned);
  assert.deepEqual(await run((owner) => owner.resolve(resolveCommand(absentCommand))), abandoned);
  assert.equal(rosterReads, abandonedRoster);
  assert.equal(next, abandonedNonce);
  assert.deepEqual(await counts(), afterAbsent);
  withdrawAtGuard = true;
  await assert.rejects(
    run((owner) => owner.save(command(7105, 2))),
    { code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED" },
  );
  withdrawAtGuard = false;
  allowed = true;
  assert.deepEqual(await counts(), afterAbsent);
  const auditsBeforeFailure = actualAuditWrites;
  failAudit = true;
  await assert.rejects(
    run((owner) => owner.save(command(7106, 2))),
    { code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE" },
  );
  failAudit = false;
  assert.equal(actualAuditWrites, auditsBeforeFailure + 1);
  assert.deepEqual(await counts(), afterAbsent);
  const brandBefore = (
    await admin.query("SELECT version::text,updated_at FROM bop_tenant.brand WHERE brand_id=$1", [
      scope.brandReference,
    ])
  ).rows[0];
  await assert.rejects(
    run(async (owner, tx, clock) => {
      await owner.save(command(7107, 2));
      const changed = await tx.query(
        "UPDATE bop_tenant.brand SET version=version+1,updated_at=$2 WHERE brand_id=$1 RETURNING version::text",
        [scope.brandReference, clock.now()],
      );
      assert.equal(changed.rowCount, 1);
      assert.equal(changed.rows[0].version, String(BigInt(brandBefore.version) + 1n));
    }),
    { code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" },
  );
  assert.deepEqual(
    (
      await admin.query("SELECT version::text,updated_at FROM bop_tenant.brand WHERE brand_id=$1", [
        scope.brandReference,
      ])
    ).rows[0],
    brandBefore,
  );
  assert.deepEqual(await counts(), afterAbsent);
  const storeBefore = (
    await admin.query(
      "SELECT store_id,brand_id,version::text,lifecycle,updated_at FROM bop_tenant.store WHERE store_id=$1",
      [id(2)],
    )
  ).rows[0];
  const generationBefore = (
    await admin.query(
      "SELECT brand_id,generation::text,reference_count::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
      [scope.brandReference],
    )
  ).rows[0];
  const projectionBefore = (
    await admin.query(
      "SELECT * FROM bop_tenant.store_reference_projection WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, id(2)],
    )
  ).rows[0];
  await assert.rejects(
    run(async (owner, tx, clock) => {
      await owner.save(command(7108, 2));
      await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(2)]);
      const changed = await tx.query(
        "UPDATE bop_tenant.store SET version=version+1,updated_at=$2 WHERE store_id=$1 RETURNING version::text,lifecycle",
        [id(2), clock.now()],
      );
      assert.equal(changed.rowCount, 1);
      assert.equal(changed.rows[0].version, String(BigInt(storeBefore.version) + 1n));
      assert.equal(changed.rows[0].lifecycle, storeBefore.lifecycle);
      await tx.query("SELECT set_config('bop.store_id','',true)", []);
      const advanced = await tx.query(
        "SELECT generation::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
        [scope.brandReference],
      );
      assert.equal(advanced.rows[0].generation, String(BigInt(generationBefore.generation) + 1n));
      // The owner restores Brand scope and actually reobserves the complete
      // public roster at its final guard; no generation row is written here.
    }),
    { code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" },
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT store_id,brand_id,version::text,lifecycle,updated_at FROM bop_tenant.store WHERE store_id=$1",
        [id(2)],
      )
    ).rows[0],
    storeBefore,
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT brand_id,generation::text,reference_count::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
        [scope.brandReference],
      )
    ).rows[0],
    generationBefore,
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT * FROM bop_tenant.store_reference_projection WHERE brand_id=$1 AND store_id=$2",
        [scope.brandReference, id(2)],
      )
    ).rows[0],
    projectionBefore,
  );
  assert.deepEqual(await counts(), afterAbsent);
  const scoped = new pg.Client(context.clientConfig);
  await scoped.connect();
  try {
    await scoped.query("BEGIN");
    await scoped.query("SET LOCAL ROLE " + role);
    await scoped.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [id(7999), scope.brandReference],
    );
    assert.equal(
      (await scoped.query("SELECT * FROM bop_tenant.brand_store_topology_draft_revision")).rowCount,
      0,
    );
    assert.equal(
      (await scoped.query("SELECT * FROM bop_tenant.brand_store_topology_draft_operation"))
        .rowCount,
      0,
    );
    await scoped.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, id(2)],
    );
    assert.equal(
      (await scoped.query("SELECT * FROM bop_tenant.brand_store_topology_draft_revision")).rowCount,
      0,
    );
    assert.equal(
      (await scoped.query("SELECT * FROM bop_tenant.brand_store_topology_draft_operation"))
        .rowCount,
      0,
    );
  } finally {
    await scoped.query("ROLLBACK");
    await scoped.end();
  }
  // Actual owning append-only triggers, independently of the reader role ACL.
  for (const table of [
    "brand_store_topology_draft_revision",
    "brand_store_topology_draft_operation",
  ]) {
    for (const sql of [
      `UPDATE bop_tenant.${table} SET tenant_id=tenant_id`,
      `DELETE FROM bop_tenant.${table}`,
    ]) {
      await admin.query("BEGIN");
      try {
        await assert.rejects(admin.query(sql), (error) => error.code === "55000");
      } finally {
        await admin.query("ROLLBACK");
      }
    }
  }
  // Include both mutually referenced tables so PostgreSQL reaches the owning
  // BEFORE TRUNCATE guard rather than rejecting the foreign-key graph first.
  await admin.query("BEGIN");
  try {
    await assert.rejects(
      admin.query(
        "TRUNCATE bop_tenant.brand_store_topology_draft_revision,bop_tenant.brand_store_topology_draft_operation",
      ),
      (error) => error.code === "55000",
    );
  } finally {
    await admin.query("ROLLBACK");
  }
  assert.deepEqual(await counts(), afterAbsent);
  assert.deepEqual(await run((owner) => owner.readHistory()), history);
  assert.ok(rosterReads >= 4);
}
