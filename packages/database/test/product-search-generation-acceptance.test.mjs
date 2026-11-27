import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  CatalogProductListError,
  createPostgresCatalogProductListQueryStore,
  createPostgresProductCreationStore,
  createPostgresProductSearchGenerationStore,
  parseProductAggregate,
} from "../../rms/catalog/src/index.ts";
const id = (n) => "01902407-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-14T08:00:00.000Z";

it("persists complete Product generations, exact source Events and replay-safe current activation", async () => {
  await withIsolatedDatabase({ caseId: "wp2407_search_gen" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2407_gen_" + context.runId;
    let allowed = true,
      holdCount = 0,
      sqlCount = 0,
      clockOffset = 0,
      failRow = false,
      loseCommit = false,
      pageReads = 0;
    const now = () => new Date(Date.now() + clockOffset).toISOString();
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO " + role);
      await admin.query(
        "GRANT INSERT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_search_generation,rms_catalog.product_search_row TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT,UPDATE ON rms_catalog.product_source_head,rms_catalog.product_search_activation TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,platform_eventing.consumer_inbox TO " +
          role,
      );
      await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      const transactions = {
        async run(work) {
          const client = new pg.Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              async query(sql, values) {
                sqlCount++;
                if (sql.includes("WITH source AS")) pageReads++;
                const result = await client.query(sql, [...values]);
                if (failRow && /INSERT INTO rms_catalog\.product_search_row/.test(sql))
                  throw new Error("synthetic failure after actual projection row insert");
                return result;
              },
            });
            await client.query("COMMIT");
            if (loseCommit) {
              loseCommit = false;
              throw new Error("synthetic lost reply after actual generation COMMIT");
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
      const authorization = {
        async holdUntilTransactionCompletes(_tx, input) {
          holdCount++;
          assert.deepEqual(input, {
            tenantReference: id(40),
            brandReference: id(1),
            actorReference: id(43),
            purposeCode: input.purposeCode,
            permission: "catalog.manage",
            capability: "catalog.cat_product_list",
            sourceProtocolVersion: 1,
            ...(input.purposeCode === "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"
              ? {
                  requiredClassificationFields: [
                    "categoryClassification",
                    "categoryReferences",
                    "primaryCategoryReference",
                  ],
                }
              : {}),
            observedAt: input.observedAt,
          });
          assert.ok(
            ["CATALOG_PRODUCT_SEARCH_BUILD", "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"].includes(
              input.purposeCode,
            ),
          );
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      };
      const options = {
        tenantReference: id(40),
        brandReference: id(1),
        actorReference: id(43),
        transactions,
        authorization,
        clock: { now },
        maximumProducts: 1000,
      };
      const store = createPostgresProductSearchGenerationStore(options);
      const request = (operation) => ({
        operationReference: id(operation),
        actorReference: id(43),
        observedAt: now(),
      });
      assert.equal(await store.loadCurrent(now()), null);
      // Legacy source adoption reads 210 actual Roots in two keyset batches, not a list page.
      for (let n = 0; n < 210; n++) {
        await admin.query(
          "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood','Draft',1,$4,$5,$4)",
          [id(5000 + n), id(1), "LEGACY_" + n, at, id(42)],
        );
        await admin.query(
          "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
          [
            id(10000 + n),
            id(5000 + n),
            id(1),
            JSON.stringify({ "en-CA": "Synthetic legacy " + n }),
            at,
          ],
        );
      }
      const first = await store.rebuild(request(100));
      assert.equal(first.status, "Built");
      assert.equal(first.state, "Current");
      assert.equal(first.generation.productCount, 210);
      assert.equal(first.generation.sourceRevision, "0");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int count FROM rms_catalog.product_search_row WHERE generation_id=$1",
            [first.generation.generationReference],
          )
        ).rows[0].count,
        210,
      );
      const storedSources = (
        await admin.query(
          "SELECT product_id,source_json,row_digest,list_json,list_digest FROM rms_catalog.product_search_row WHERE generation_id=$1 ORDER BY product_id",
          [first.generation.generationReference],
        )
      ).rows;
      for (const row of storedSources) {
        assert.equal(row.row_digest, "sha256:" + sha256Hex(canonicalizeRfc8785(row.source_json)));
        assert.equal(row.source_json.updatedByActorReference, null);
        assert.equal(row.list_digest, "sha256:" + sha256Hex(canonicalizeRfc8785(row.list_json)));
        for (const field of [
          "createdByActorReference",
          "updatedByActorReference",
          "taxClassificationReference",
        ])
          assert.equal(Object.hasOwn(row.list_json, field), false);
      }
      const firstDigest =
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            brandReference: id(1),
            sourceRevision: "0",
            coverage: "CatalogProductDraftV1",
            rows: storedSources.map((row) => ({
              productReference: row.product_id,
              rowDigest: row.row_digest,
              listDigest: row.list_digest,
            })),
          }),
        );
      assert.equal(first.generation.sourceDigest, firstDigest);
      const classification = await store.loadClassificationSnapshot();
      assert.equal(classification.products.length, 210);
      assert.equal(classification.generation.sourceDigest, firstDigest);
      assert.ok(
        classification.products.every(
          (row) =>
            !Object.hasOwn(row, "categoryClassification") &&
            !Object.hasOwn(row, "createdByActorReference"),
        ),
      );
      assert.deepEqual(
        classification.products.map((row) => row.productReference),
        storedSources.map((row) => row.product_id),
      );
      const replay = await store.rebuild(request(100));
      assert.equal(replay.status, "AlreadyBuilt");
      assert.deepEqual(replay.generation, first.generation);
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product_search_generation) generations,(SELECT count(*)::int FROM rms_catalog.product_search_row) rows,(SELECT generation_id FROM rms_catalog.product_search_activation WHERE brand_id=$1) active",
            [id(1)],
          )
        ).rows[0];
      const before = await counts();
      await assert.rejects(
        createPostgresProductSearchGenerationStore({ ...options, maximumProducts: 209 }).rebuild(
          request(101),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(), before);
      failRow = true;
      await assert.rejects(store.rebuild(request(102)), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await counts(), before);
      failRow = false;
      const second = await store.rebuild(request(102));
      assert.equal(second.state, "Current");
      assert.notEqual(second.generation.generationReference, first.generation.generationReference);
      const oldReplay = await store.rebuild(request(100));
      assert.equal(oldReplay.state, "Superseded");
      assert.equal((await counts()).active, second.generation.generationReference);
      clockOffset = 31_000;
      await assert.rejects(store.loadClassificationSnapshot(), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal((await store.loadCurrent(now())).state, "Stale");
      clockOffset = 0;
      loseCommit = true;
      await assert.rejects(store.rebuild(request(103)), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      const afterLost = await counts();
      const recovered = await store.rebuild(request(103));
      assert.equal(recovered.status, "AlreadyBuilt");
      assert.equal(recovered.generation.generationReference, afterLost.active);
      assert.deepEqual(await counts(), afterLost);

      const list = createPostgresCatalogProductListQueryStore({
        runner: transactions,
        scope: { brandReference: id(1), storeReference: id(44) },
        clock: { now },
        cursorKey: new Uint8Array(32).fill(15),
        authorization: {
          async withAuthorizedProductList(input, work) {
            assert.equal(input.actorReference, id(43));
            if (!allowed) throw new CatalogProductListError("Denied");
            return work();
          },
        },
      });
      const listRequest = (extra = {}) => ({
        actorReference: id(43),
        purposeCode: "CATALOG_READ",
        locale: "en-CA",
        observedAt: now(),
        search: null,
        lifecycle: null,
        productType: null,
        limit: 1,
        cursor: null,
        includeArchived: false,
        hasActiveSku: null,
        missingTranslationLocale: null,
        updatedFrom: null,
        updatedUntil: null,
        createdFrom: null,
        createdUntil: null,
        sort: "updatedAt",
        direction: "DESC",
        ...extra,
      });
      const sourcePinnedPage = await list.load(listRequest());
      assert.equal(sourcePinnedPage.hasMore, true);
      assert.equal(sourcePinnedPage.projection.asOfUtc, recovered.generation.projectedAt);
      // Source producer creates real operation result/Audit/receipt/Outbox in its own transaction.
      const producer = createPostgresProductCreationStore({
        brandReference: id(1),
        transactions,
        authorize: async () => true,
      });
      const aggregate = parseProductAggregate({
        productReference: id(7000),
        brandReference: id(1),
        internalCode: "PRODUCED",
        productType: "NonAlcoholicBeverage",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: id(42),
        updatedAt: at,
        draft: {
          versionReference: id(7001),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic produced", "zh-CN": "测试商品" },
          taxClassificationReference: null,
          createdAt: at,
          updatedAt: at,
          optionBindings: [],
          skus: [
            {
              skuReference: id(7002),
              productReference: id(7000),
              brandReference: id(1),
              skuCode: "PRODUCED_SKU",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic SKU", "zh-CN": "测试规格" },
              variantSelections: [],
              unitOfSale: "EACH",
              unitQuantity: "1.5",
              createdAt: at,
              createdByActorReference: id(42),
            },
          ],
        },
      });
      await producer.create({
        record: {
          action: "Create",
          operationReference: id(104),
          operationIntentHash: sha256Hex("synthetic authorized Product intent"),
          aggregate,
        },
        audit: {
          auditId: id(105),
          brandId: id(1),
          actor: { type: "User", reference: id(42) },
          actionCode: "CATALOG_PRODUCT_CREATE",
          targetType: "CatalogProduct",
          targetId: id(7000),
          correlationId: id(104),
          occurredAt: at,
          reasonCode: "SYNTHETIC_TEST",
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        },
      });
      assert.equal((await store.loadCurrent(now())).state, "Changed");
      const readsBeforeChanged = pageReads;
      await assert.rejects(list.load(listRequest()), (error) => error.code === "Stale");
      await assert.rejects(
        list.load(listRequest({ cursor: sourcePinnedPage.nextCursor })),
        (error) => error.code === "Stale",
      );
      assert.equal(pageReads, readsBeforeChanged);
      const storedEvent = (
        await admin.query("SELECT * FROM platform_eventing.outbox_event WHERE aggregate_id=$1", [
          id(7000),
        ])
      ).rows[0];
      const event = {
        eventId: storedEvent.event_id,
        eventType: storedEvent.event_type,
        schemaVersion: storedEvent.schema_version,
        occurredAt: storedEvent.occurred_at.toISOString(),
        producerModule: storedEvent.producer_module,
        tenantId: storedEvent.brand_id,
        aggregateType: storedEvent.aggregate_type,
        aggregateId: storedEvent.aggregate_id,
        aggregateVersion: BigInt(storedEvent.aggregate_version),
        correlationId: storedEvent.correlation_id,
        actor: { type: storedEvent.actor_type, actorId: storedEvent.actor_id },
        payload: storedEvent.payload_json,
        redactionClassification: storedEvent.redaction_classification,
        replayMetadata: storedEvent.replay_metadata_json,
      };
      const consume = (value) => transactions.run((tx) => store.consume(tx, value));
      assert.deepEqual(await consume(event), { status: "processed" });
      let active = await store.loadCurrent(now());
      assert.equal(active.state, "Current");
      assert.equal(active.generation.sourceRevision, "1");
      assert.equal(active.generation.productCount, 211);
      await assert.rejects(
        list.load(listRequest({ cursor: sourcePinnedPage.nextCursor })),
        (error) => error.code === "Stale",
      );
      const producedList = await list.load(listRequest({ search: "PRODUCED" }));
      assert.equal(producedList.items[0].productReference, id(7000));
      assert.equal(producedList.items[0].skuCount, 1);
      assert.equal(producedList.projection.asOfUtc, active.generation.projectedAt);
      assert.deepEqual(producedList.items[0].updatedBy, { status: "Unavailable" });
      const producedRow = (
        await admin.query(
          "SELECT source_json FROM rms_catalog.product_search_row WHERE generation_id=$1 AND product_id=$2",
          [active.generation.generationReference, id(7000)],
        )
      ).rows[0].source_json;
      assert.equal(producedRow.updatedByActorReference, id(42));
      assert.equal(producedRow.createdByActorReference, id(42));
      assert.equal(producedRow.skuCount, 1);
      assert.equal(producedRow.activeSkuCount, 0);
      assert.equal(producedRow.skuSearch[0].localizedNames["zh-CN"], "测试规格");
      let afterEvent = await counts();
      assert.deepEqual(await consume(event), { status: "duplicate_completed" });
      assert.deepEqual(await counts(), afterEvent);
      // Exact proof is checked even before Inbox duplicate recovery.
      for (const malformed of [
        { ...event, actor: { type: "Actor", actorId: id(43) } },
        { ...event, correlationId: id(999) },
        { ...event, payload: { ...event.payload, changedSkuReference: id(7002) } },
        { ...event, replayMetadata: { ...event.replayMetadata, extra: true } },
        { ...event, tenantId: id(2) },
      ])
        await assert.rejects(consume(malformed));
      assert.deepEqual(await counts(), afterEvent);
      allowed = false;
      const callsBeforeDenied = sqlCount;
      await assert.rejects(consume(event), { code: "CATALOG_PERMISSION_DENIED" });
      await assert.rejects(store.rebuild(request(100)), { code: "CATALOG_PERMISSION_DENIED" });
      assert.equal(sqlCount, callsBeforeDenied);
      allowed = true;
      const metaCalls = holdCount;
      assert.equal((await store.rebuild(request(100))).state, "Superseded");
      assert.equal(holdCount, metaCalls + 1);
      assert.equal((await counts()).active, active.generation.generationReference);

      // Later Events arrive first: rebuild current owner truth and do not regress on older delivery.
      const produce = async (n) => {
        const productReference = id(n),
          versionReference = id(n + 1),
          skuReference = id(n + 2);
        const value = parseProductAggregate({
          ...aggregate,
          productReference,
          internalCode: "PRODUCED_" + n,
          draft: {
            ...aggregate.draft,
            versionReference,
            skus: [
              {
                ...aggregate.draft.skus[0],
                productReference,
                skuReference,
                skuCode: "PRODUCED_SKU_" + n,
              },
            ],
          },
        });
        await producer.create({
          record: {
            action: "Create",
            operationReference: id(n + 3),
            operationIntentHash: sha256Hex("synthetic authorized Product intent " + n),
            aggregate: value,
          },
          audit: {
            auditId: id(n + 4),
            brandId: id(1),
            actor: { type: "User", reference: id(42) },
            actionCode: "CATALOG_PRODUCT_CREATE",
            targetType: "CatalogProduct",
            targetId: productReference,
            correlationId: id(n + 3),
            occurredAt: at,
            reasonCode: "SYNTHETIC_TEST",
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
        const record = (
          await admin.query("SELECT * FROM platform_eventing.outbox_event WHERE aggregate_id=$1", [
            productReference,
          ])
        ).rows[0];
        return {
          ...event,
          eventId: record.event_id,
          aggregateId: record.aggregate_id,
          aggregateVersion: BigInt(record.aggregate_version),
          correlationId: record.correlation_id,
          payload: record.payload_json,
          replayMetadata: record.replay_metadata_json,
        };
      };
      const older = await produce(7100),
        newer = await produce(7200);
      assert.equal((await store.loadCurrent(now())).state, "Changed");
      const beforeDelivery = await counts();
      const inboxBefore = (
        await admin.query("SELECT count(*)::int count FROM platform_eventing.consumer_inbox")
      ).rows[0].count;
      failRow = true;
      await assert.rejects(consume(newer));
      failRow = false;
      assert.deepEqual(await counts(), beforeDelivery);
      assert.equal(
        (await admin.query("SELECT count(*)::int count FROM platform_eventing.consumer_inbox"))
          .rows[0].count,
        inboxBefore,
      );
      assert.deepEqual(await consume(newer), { status: "processed" });
      active = await store.loadCurrent(now());
      assert.equal(active.state, "Current");
      assert.equal(active.generation.sourceRevision, "3");
      assert.equal(active.generation.productCount, 213);
      afterEvent = await counts();
      assert.deepEqual(await consume(older), { status: "processed" });
      assert.deepEqual(await counts(), afterEvent);
      assert.deepEqual(await consume(newer), { status: "duplicate_completed" });
      assert.deepEqual(await counts(), afterEvent);
      // A current graph changed outside its participating owner commit fails immutable source proof.
      const names = aggregate.draft.localizedNames;
      await admin.query(
        "UPDATE rms_catalog.product_version SET localized_names_json=$1 WHERE product_version_id=$2",
        [JSON.stringify({ ...names, "en-CA": "Uncommitted source drift" }), id(7001)],
      );
      await assert.rejects(store.rebuild(request(107)), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await counts(), afterEvent);
      await admin.query(
        "UPDATE rms_catalog.product_version SET localized_names_json=$1 WHERE product_version_id=$2",
        [JSON.stringify(names), id(7001)],
      );

      // A missing Draft cannot disappear from the complete Root count.
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'MISSING_DRAFT','PreparedFood','Draft',1,$3,$4,$3)",
        [id(20000), id(1), at, id(42)],
      );
      await assert.rejects(store.rebuild(request(106)), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await counts(), afterEvent);
      // Immutable projection history and scope-filtered reads remain protected.
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.product_search_row SET source_json='{}' WHERE generation_id=$1",
            [active.generation.generationReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_catalog.product_search_generation")).rowCount,
        0,
      );
      await transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(2)],
        );
        for (const table of [
          "product_search_generation",
          "product_search_row",
          "product_search_activation",
        ])
          assert.equal((await tx.query("SELECT * FROM rms_catalog." + table, [])).rows.length, 0);
      });
      await transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(2)],
        );
        for (const table of [
          "product_search_generation",
          "product_search_row",
          "product_search_activation",
        ])
          assert.equal((await tx.query("SELECT * FROM rms_catalog." + table, [])).rows.length, 0);
      });
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
