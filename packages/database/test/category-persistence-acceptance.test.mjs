import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import {
  CatalogError,
  createPostgresCategoryRepository,
  createPostgresCategorySourceStore,
  createPostgresCategorySourceConsumer,
  categorySourceDigest,
} from "../../rms/catalog/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-14T08:00:00.000Z";
const observedAt = "2026-09-27T08:00:00.000Z";
const authorityLease = "SyntheticCategoryAuthority:" + id(102) + ":" + id(100) + ":" + id(101);
const brand = id(100),
  actor = id(101),
  tenant = id(102);
const node = (n, extra = {}) => ({
  categoryReference: id(n),
  brandReference: brand,
  internalCode: "CATEGORY_" + n,
  lifecycle: "Draft",
  aggregateVersion: 1,
  defaultLocale: "en-CA",
  localizedNames: { "en-CA": "Synthetic category" },
  localizedDescriptions: {},
  parentCategoryReference: null,
  level: 1,
  sortOrder: n,
  storeReferences: [],
  createdAt: at,
  createdByActorReference: actor,
  updatedAt: at,
  ...extra,
});
const record = (n, aggregate, action = "Create") => ({
  action,
  operationReference: id(n),
  operationIntentHash: n.toString(16).padStart(64, "0"),
  aggregate,
});
const audit = (rec) => ({
  auditId: id(Number.parseInt(rec.operationReference.slice(-12), 16) + 10000),
  brandId: brand,
  actor: { type: "User", reference: actor },
  actionCode: "CATALOG_CATEGORY_" + rec.action.toUpperCase(),
  targetType: "CatalogCategory",
  targetId: rec.aggregate.categoryReference,
  reasonCode: "SYNTHETIC_TEST",
  correlationId: rec.operationReference,
  occurredAt: rec.aggregate.updatedAt,
  sourceChannel: "API",
  dataClassification: "Internal",
  retentionPolicyCode: "CONFIGURATION_AUDIT",
  retentionPolicyVersion: 1,
});
const input = (rec) => ({
  record: rec,
  audit: audit(rec),
  ...(rec.action === "Create"
    ? {}
    : { expectedAggregateVersion: rec.aggregate.aggregateVersion - 1 }),
});
it("commits real Category snapshots Audit Events and ordered receipts; retries and failures preserve history", async () => {
  await withIsolatedDatabase({ caseId: "wp2408_cat_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2408_cat_" + context.runId;
    assert.match(role, /^wp2408_cat_[a-f0-9]+$/);
    let eventId = 20000,
      permitted = true,
      failOnRecord = Infinity,
      recordChecks = 0,
      loseAck = false;
    const seen = [];
    const authority = {
      async holdUntilTransactionCompletes(tx, request) {
        seen.push(request);
        assert.equal(request.observedAt, observedAt);
        assert.equal(request.tenantReference, tenant);
        assert.equal(request.brandReference, brand);
        assert.equal(request.actorReference, actor);
        assert.equal(request.purposeCode, "CATALOG_CATEGORY_PERSISTENCE");
        assert.equal(request.requiredFields.length, 15);
        assert.equal(request.capability, "catalog.cat_category_tree");
        assert.equal(request.permission, "catalog.manage");
        assert.equal(request.domainPermission, "catalog.category.manage");
        if (!permitted || (request.record && ++recordChecks >= failOnRecord))
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        // Synthetic public authority lease, real PostgreSQL lock to outer COMMIT.
        await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          authorityLease,
        ]);
      },
    };
    const runner = {
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          if (loseAck) {
            loseAck = false;
            throw new Error("SYNTHETIC_COMMIT_ACK_LOSS");
          }
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    const options = {
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      transactions: runner,
      authority,
      clock: { now: () => observedAt },
      eventReference: () => id(eventId++),
      maximumCategoryNodes: 100,
    };
    const sourceAuthority = {
      async holdUntilTransactionCompletes(tx, request) {
        assert.equal(request.purposeCode, "CATALOG_CATEGORY_SOURCE_READ");
        assert.equal(request.permission, "catalog.manage");
        assert.equal(request.capability, "catalog.cat_category_tree");
        assert.equal(request.requiredFields.length, 15);
        assert.equal(request.observedAt, observedAt);
        if (!permitted) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
          authorityLease,
        ]);
      },
    };
    const sourceOptions = { ...options, authority: sourceAuthority, maximumSourceCommits: 100 };
    const source = createPostgresCategorySourceStore(sourceOptions);
    const repository = createPostgresCategoryRepository(options);
    const create = (rec) => repository.create(input(rec)),
      commit = (rec) => repository.commit(input(rec));
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*) FROM rms_catalog.category)::int roots,(SELECT count(*) FROM rms_catalog.category_operation_record)::int operations,(SELECT count(*) FROM rms_catalog.category_operation_snapshot)::int snapshots,(SELECT count(*) FROM rms_catalog.category_source_commit)::int commits,(SELECT count(*) FROM platform_eventing.outbox_event WHERE aggregate_type='Category')::int events,(SELECT count(*) FROM platform_audit.audit_record WHERE target_type='CatalogCategory')::int audits",
        )
      ).rows[0];
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.category,rms_catalog.category_source_head,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.category_operation_record,rms_catalog.category_operation_snapshot,rms_catalog.category_source_commit,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      assert.deepEqual(await source.loadSnapshot(), {
        brandReference: brand,
        sourceRevision: "0",
        observedAt,
        categories: [],
        sourceDigest: categorySourceDigest({
          brandReference: brand,
          sourceRevision: "0",
          categories: [],
        }),
      });
      assert.equal(await repository.load(id(1)), null);
      assert.equal(await repository.resolveOperation(id(1000)), null);
      const original = record(1000, node(1));
      assert.deepEqual(await create(original), original);
      const parent = record(1001, node(2));
      await create(parent);
      const child = record(1002, node(3, { parentCategoryReference: id(1), level: 2 }));
      await create(child);
      assert.deepEqual(await repository.load(id(1)), original.aggregate);
      assert.equal(
        await repository.codeAvailable({
          brandReference: brand,
          internalCode: "CATEGORY_1",
          excludingCategoryReference: null,
        }),
        false,
      );
      assert.equal(
        await repository.codeAvailable({
          brandReference: brand,
          internalCode: "CATEGORY_1",
          excludingCategoryReference: id(1),
        }),
        true,
      );
      const inspection = await repository.inspectMove({
        categoryReference: id(1),
        brandReference: brand,
        parentCategoryReference: id(2),
        sortOrder: 4,
      });
      assert.equal(inspection.subtreeDepth, 2);
      const before = await counts();
      await assert.rejects(
        commit(
          record(
            1003,
            node(1, {
              aggregateVersion: 2,
              parentCategoryReference: id(2),
              level: 2,
              sortOrder: 4,
            }),
            "Move",
          ),
        ),
        { code: "CATALOG_LIFECYCLE_CONFLICT" },
      );
      await assert.rejects(create(record(1004, node(4, { internalCode: "CATEGORY_1" }))), {
        code: "CATALOG_CODE_CONFLICT",
      });
      await assert.rejects(create(record(1005, node(4, { sortOrder: 1 }))), {
        code: "CATALOG_LIFECYCLE_CONFLICT",
      });
      assert.deepEqual(await counts(), before);
      const activated = record(
        1006,
        node(1, { aggregateVersion: 2, lifecycle: "Active" }),
        "ChangeLifecycle",
      );
      await commit(activated);
      const reordered = record(
        1007,
        { ...activated.aggregate, aggregateVersion: 3, sortOrder: 5 },
        "Move",
      );
      await commit(reordered);
      assert.deepEqual(await repository.resolveOperation(original.operationReference), original);
      assert.deepEqual(await create(original), original);
      assert.deepEqual(await commit(activated), activated);
      const replayCounts = await counts();
      await assert.rejects(
        repository.create({
          ...input(original),
          audit: { ...audit(original), actor: { type: "User", reference: id(999) } },
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      await assert.rejects(create({ ...original, operationIntentHash: "f".repeat(64) }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual(await counts(), replayCounts);
      permitted = false;
      await assert.rejects(repository.resolveOperation(original.operationReference), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      permitted = true;
      recordChecks = 0;
      failOnRecord = 2;
      const rollback = record(1008, node(4));
      await assert.rejects(create(rollback), { code: "CATALOG_PERMISSION_DENIED" });
      failOnRecord = Infinity;
      assert.deepEqual(await counts(), replayCounts);
      assert.equal(await repository.load(id(4)), null);
      // Caller catches an adapter failure and COMMITs an outer transaction: savepoint must still remove every write.
      const outer = new Client(context.clientConfig);
      await outer.connect();
      try {
        await outer.query("BEGIN");
        await outer.query("SET LOCAL ROLE " + role);
        recordChecks = 0;
        failOnRecord = 2;
        const caught = createPostgresCategoryRepository({
          ...options,
          transactions: {
            run: (work) => work({ query: (sql, values) => outer.query(sql, [...values]) }),
          },
        });
        await assert.rejects(caught.create(input(rollback)), { code: "CATALOG_PERMISSION_DENIED" });
        await outer.query("COMMIT");
      } finally {
        failOnRecord = Infinity;
        await outer.end();
      }
      assert.deepEqual(await counts(), replayCounts);
      loseAck = true;
      await assert.rejects(create(rollback), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await create(rollback), rollback);
      const afterAck = await counts();
      assert.equal(afterAck.operations, replayCounts.operations + 1);
      // Same-operation concurrent calls serialize and reuse one immutable receipt.
      const concurrent = record(1009, node(5, { sortOrder: 10 }));
      const results = await Promise.all([create(concurrent), create(concurrent)]);
      assert.deepEqual(results, [concurrent, concurrent]);
      assert.equal((await counts()).operations, afterAck.operations + 1);
      // Different operations racing one code cannot create two roots.
      const competing = await Promise.allSettled([
        create(record(1010, node(6, { internalCode: "CONCURRENT_CODE" }))),
        create(record(1011, node(7, { internalCode: "CONCURRENT_CODE" }))),
      ]);
      assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        competing.find((r) => r.status === "rejected").reason.code,
        "CATALOG_CODE_CONFLICT",
      );
      const movedChild = record(
        1012,
        { ...child.aggregate, aggregateVersion: 2, parentCategoryReference: id(2) },
        "Move",
      );
      await commit(movedChild);
      let life = rollback.aggregate;
      for (const [index, lifecycle] of ["Active", "Inactive", "Archived", "Draft"].entries()) {
        life = { ...life, aggregateVersion: life.aggregateVersion + 1, lifecycle };
        await commit(record(1013 + index, life, "ChangeLifecycle"));
      }
      await assert.rejects(
        commit(
          record(
            1017,
            { ...original.aggregate, aggregateVersion: 2, lifecycle: "Inactive" },
            "ChangeLifecycle",
          ),
        ),
        { code: "CATALOG_VERSION_CONFLICT" },
      );
      // Source barrier remains held after the repository returns, until outer COMMIT.
      const barrierOwner = new Client(context.clientConfig),
        contender = new Client(context.clientConfig);
      await barrierOwner.connect();
      await contender.connect();
      try {
        await barrierOwner.query("BEGIN");
        await barrierOwner.query("SET LOCAL ROLE " + role);
        const bounded = createPostgresCategoryRepository({
          ...options,
          transactions: {
            run: (work) => work({ query: (sql, values) => barrierOwner.query(sql, [...values]) }),
          },
        });
        await bounded.create(input(record(1018, node(8, { sortOrder: 20 }))));
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout='50ms'");
        await assert.rejects(
          contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogCategorySource:" + brand,
          ]),
          { code: "55P03" },
        );
        await contender.query("ROLLBACK");
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout='50ms'");
        await assert.rejects(
          contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [authorityLease]),
          { code: "55P03" },
        );
        await contender.query("ROLLBACK");
        await barrierOwner.query("COMMIT");
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout='50ms'");
        await contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogCategorySource:" + brand,
        ]);
        await contender.query("ROLLBACK");
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout='50ms'");
        await contender.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          authorityLease,
        ]);
        await contender.query("ROLLBACK");
      } finally {
        await barrierOwner.end();
        await contender.end();
      }
      const receipts = (
        await admin.query(
          "SELECT source_revision::text revision,event_type,source_revision::text FROM rms_catalog.category_source_commit ORDER BY rms_catalog.category_source_commit.source_revision",
        )
      ).rows;
      assert.deepEqual(
        receipts.map((r) => r.revision),
        receipts.map((_, i) => String(i + 1)),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT source_revision::text revision FROM rms_catalog.category_source_head WHERE brand_id=$1",
            [brand],
          )
        ).rows[0].revision,
        String(receipts.length),
      );
      assert.ok(receipts.some((r) => r.event_type === "CategoryUpdated"));
      assert.ok(receipts.some((r) => r.event_type === "CategoryReordered"));
      assert.deepEqual(
        [...new Set(receipts.map((r) => r.event_type))].sort(),
        [
          "CategoryCreated",
          "CategoryUpdated",
          "CategoryMoved",
          "CategoryReordered",
          "CategoryDeactivated",
          "CategoryArchived",
          "CategoryRestored",
        ].sort(),
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.category_source_head SET source_revision=source_revision+2 WHERE brand_id=$1",
          [brand],
        ),
        { code: "23514" },
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.category_operation_snapshot SET snapshot_json='{}' WHERE brand_id=$1",
            [brand],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query("DELETE FROM rms_catalog.category_source_commit WHERE brand_id=$1", [
            brand,
          ])
        ).rowCount,
        0,
      );
      const policyClient = new Client(context.clientConfig);
      await policyClient.connect();
      try {
        await policyClient.query("BEGIN");
        await policyClient.query("SET LOCAL ROLE " + role);
        await policyClient.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(999)],
        );
        assert.equal(
          (await policyClient.query("SELECT * FROM rms_catalog.category_source_commit")).rows
            .length,
          0,
        );
        await policyClient.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, id(999)],
        );
        assert.equal(
          (await policyClient.query("SELECT * FROM rms_catalog.category_operation_snapshot")).rows
            .length,
          0,
        );
        await policyClient.query("ROLLBACK");
      } finally {
        await policyClient.end();
      }
      const getter = vi.fn(() => brand);
      const hostile = { internalCode: "CATEGORY_1", excludingCategoryReference: null };
      Object.defineProperty(hostile, "brandReference", { enumerable: true, get: getter });
      await assert.rejects(repository.codeAvailable(hostile), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(getter.mock.calls.length, 0);
      await assert.rejects(
        createPostgresCategoryRepository({ ...options, maximumCategoryNodes: 1 }).inspectMove({
          categoryReference: id(1),
          brandReference: brand,
          parentCategoryReference: null,
          sortOrder: 5,
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const currentSource = await source.loadSnapshot();
      assert.equal(currentSource.sourceRevision, String(receipts.length));
      assert.equal(currentSource.categories.length, (await counts()).roots);
      assert.deepEqual(
        currentSource.categories.find((category) => category.categoryReference === id(1)),
        reordered.aggregate,
      );
      const originalEventId = (
        await admin.query(
          "SELECT event_id FROM rms_catalog.category_source_commit WHERE operation_id=$1",
          [original.operationReference],
        )
      ).rows[0].event_id;
      const originalEvent = await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [brand],
        );
        return loadOutboxEnvelope(tx, originalEventId);
      });
      assert.equal((await source.proveEvent(originalEvent)).sourceRevision, "1");
      for (const bad of [
        { ...originalEvent, eventId: id(999) },
        { ...originalEvent, actor: { type: "Actor", actorId: id(999) } },
        { ...originalEvent, correlationId: id(999) },
        { ...originalEvent, payload: { ...originalEvent.payload, sourceRevision: "2" } },
      ])
        await assert.rejects(source.proveEvent(bad), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      permitted = false;
      await assert.rejects(source.loadSnapshot(), { code: "CATALOG_PERMISSION_DENIED" });
      permitted = true;
      await assert.rejects(
        createPostgresCategorySourceStore({
          ...sourceOptions,
          maximumSourceCommits: 1,
        }).loadSnapshot(),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        createPostgresCategorySourceStore({
          ...sourceOptions,
          maximumCategoryNodes: 1,
        }).loadSnapshot(),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      // A root edited outside the participating writer is not a complete verified public source.
      await admin.query("BEGIN");
      try {
        await admin.query(
          "UPDATE rms_catalog.category SET localized_names_json=$1::jsonb WHERE category_id=$2",
          [JSON.stringify({ "en-CA": "Synthetic corrupt source" }), id(1)],
        );
        const directSource = createPostgresCategorySourceStore({
          ...sourceOptions,
          transactions: {
            run: (work) => work({ query: (sql, values) => admin.query(sql, [...values]) }),
          },
        });
        await assert.rejects(directSource.loadSnapshot(), {
          code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
      } finally {
        await admin.query("ROLLBACK");
      }
      // Legacy roots without original operation receipts never become a fabricated generation.
      await admin.query("BEGIN");
      try {
        await admin.query(
          "INSERT INTO rms_catalog.category(category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,localized_names_json,localized_descriptions_json,parent_category_id,tree_level,sort_order,store_ids_json,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'LEGACY_CATEGORY','Draft',1,'en-CA',$3::jsonb,'{}',NULL,1,100,'[]',$4,$5,$4)",
          [id(99), brand, JSON.stringify({ "en-CA": "Synthetic legacy category" }), at, actor],
        );
        const legacySource = createPostgresCategorySourceStore({
          ...sourceOptions,
          transactions: {
            run: (work) => work({ query: (sql, values) => admin.query(sql, [...values]) }),
          },
        });
        await assert.rejects(legacySource.loadSnapshot(), {
          code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
      } finally {
        await admin.query("ROLLBACK");
      }
      for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
        await admin.query("BEGIN ISOLATION LEVEL " + isolation);
        try {
          const transaction = {
            run: (work) => work({ query: (sql, values) => admin.query(sql, [...values]) }),
          };
          await assert.rejects(
            createPostgresCategorySourceStore({
              ...sourceOptions,
              transactions: transaction,
            }).loadSnapshot(),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
          await assert.rejects(
            createPostgresCategoryRepository({ ...options, transactions: transaction }).load(id(1)),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      await admin.query("BEGIN");
      try {
        await admin.query(
          "UPDATE rms_catalog.category_source_head SET source_revision=source_revision+1 WHERE brand_id=$1",
          [brand],
        );
        const gapSource = createPostgresCategorySourceStore({
          ...sourceOptions,
          transactions: {
            run: (work) => work({ query: (sql, values) => admin.query(sql, [...values]) }),
          },
        });
        await assert.rejects(gapSource.loadSnapshot(), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.deepEqual(await source.loadSnapshot(), currentSource);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role,
      );
      const consumer = createPostgresCategorySourceConsumer(sourceOptions);
      assert.deepEqual(await consumer.rebuild(), currentSource);
      assert.deepEqual(await consumer.consume(originalEvent), { status: "processed" });
      assert.deepEqual(await consumer.consume(originalEvent), { status: "duplicate_completed" });
      const inbox = await admin.query(
        "SELECT status,result_hash FROM platform_eventing.consumer_inbox WHERE consumer_name='catalog.category-source:v1' AND event_id=$1",
        [originalEventId],
      );
      assert.deepEqual(inbox.rows, [
        { status: "completed", result_hash: currentSource.sourceDigest.slice(7) },
      ]);
      await assert.rejects(
        consumer.consume({ ...originalEvent, actor: { type: "Actor", actorId: id(999) } }),
        (error) =>
          error.code === undefined && error.outcome?.errorCode === "CONSUMER_TEMPORARY_FAILURE",
      );
      permitted = false;
      await assert.rejects(
        consumer.consume(originalEvent),
        (error) => error.outcome?.errorCode === "TENANT_SCOPE_DENIED",
      );
      permitted = true;
      assert.deepEqual(
        (
          await admin.query(
            "SELECT status,result_hash FROM platform_eventing.consumer_inbox WHERE consumer_name='catalog.category-source:v1' AND event_id=$1",
            [originalEventId],
          )
        ).rows,
        inbox.rows,
      );

      const secondEventId = (
        await admin.query(
          "SELECT event_id FROM rms_catalog.category_source_commit WHERE operation_id=$1",
          [parent.operationReference],
        )
      ).rows[0].event_id;
      const secondEvent = await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [brand],
        );
        return loadOutboxEnvelope(tx, secondEventId);
      });
      loseAck = true;
      await assert.rejects(
        consumer.consume(secondEvent),
        (error) => error.outcome?.errorCode === "COMMIT_OUTCOME_UNKNOWN",
      );
      assert.deepEqual(await consumer.consume(secondEvent), { status: "duplicate_completed" });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_eventing.consumer_inbox WHERE consumer_name='catalog.category-source:v1'",
          )
        ).rows[0].n,
        2,
      );
      const deliveredTypes = new Set();
      for (const receipt of (
        await admin.query(
          "SELECT event_id FROM rms_catalog.category_source_commit ORDER BY source_revision",
        )
      ).rows) {
        const envelope = await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brand],
          );
          return loadOutboxEnvelope(tx, receipt.event_id);
        });
        deliveredTypes.add(envelope.eventType);
        assert.ok(
          ["processed", "duplicate_completed"].includes((await consumer.consume(envelope)).status),
        );
      }
      assert.equal(deliveredTypes.size, 7);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_eventing.consumer_inbox WHERE consumer_name='catalog.category-source:v1' AND status='completed'",
          )
        ).rows[0].n,
        receipts.length,
      );
      const total = await counts();
      assert.equal(total.operations, total.snapshots);
      assert.equal(total.operations, total.commits);
      assert.equal(total.operations, total.events);
      assert.equal(total.operations, total.audits);
      assert.ok(seen.every((request) => request.requiredFields.includes("localizedDescriptions")));
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
