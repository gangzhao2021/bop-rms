import { exerciseProductListBrowser } from "../test-support/catalog-product-list-browser.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresCatalogProductListQueryStore,
  createPostgresProductSearchGenerationStore,
  CatalogProductListError,
} from "../../rms/catalog/src/index.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export async function exerciseCatalogProductList(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `wp2407_${context.runId}`;
  let held = 0,
    allowed = true,
    phase = true,
    sqlCalls = 0;
  await admin.connect();
  const scope = { brandReference: id(2), storeReference: id(3) };
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT SELECT(generation_id,brand_id,source_revision,source_digest,projected_at,product_count,source_coverage,is_partial) ON rms_catalog.product_search_generation TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT(generation_id,brand_id,product_id,list_json,list_digest) ON rms_catalog.product_search_row TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_catalog.product_search_activation,rms_catalog.product_source_head TO ${role}`,
    );
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    async function seed(
      n,
      code,
      name,
      updatedAt,
      lifecycle = "Draft",
      brand = id(2),
      createdAt = "2026-08-01T00:00:00.000Z",
    ) {
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood',$4,1,$5,$6,$7)",
        [id(n), brand, code, lifecycle, createdAt, id(4), updatedAt],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,base_product_version_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at) VALUES($1,$2,$3,NULL,'Draft','en-CA',$4::jsonb,NULL,$5,$6)",
        [
          id(n + 1000),
          id(n),
          brand,
          JSON.stringify({ "en-CA": name, "fr-CA": `Synthétique ${n}` }),
          createdAt,
          updatedAt,
        ],
      );
    }
    await seed(100, "SYNTH_A", "Synthetic Alpha", "2026-08-01T12:00:00.000Z");
    await seed(
      101,
      "SYNTH_B",
      "Synthetic Beta",
      "2026-08-02T12:00:00.000Z",
      "Draft",
      id(2),
      "2026-08-01T00:00:00.001Z",
    );
    await seed(102, "EXACT", "Synthetic exact code", "2026-08-01T12:00:00.000Z");
    await seed(103, "OTHER", "Synthetic exact text", "2026-08-03T12:00:00.000Z");
    await seed(104, "ARCHIVED", "Synthetic archived", "2026-08-04T12:00:00.000Z", "Archived");
    await seed(105, "FOREIGN", "Synthetic foreign", "2026-08-04T12:00:00.000Z", "Draft", id(99));
    for (const [n, lifecycle, code, name] of [
      [200, "Active", "ACTIVE_SKU", "Synthetic iced tea"],
      [201, "Draft", "DRAFT_SKU", "Synthetic draft size"],
    ]) {
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8,'EACH',1,$9,$10)",
        [
          id(n),
          id(101),
          id(2),
          id(1101),
          code,
          lifecycle,
          JSON.stringify({ "en-CA": name }),
          `sha256:${String(n).padStart(64, "0")}`,
          "2026-08-01T12:00:00.000Z",
          id(4),
        ],
      );
    }
    // Source-owned counts2 and10 must exercise numeric SQL ordering, not only a mocked comparator.
    for (const [product, total, start] of [
      [103, 10, 220],
      [104, 2, 230],
    ]) {
      for (let offset = 0; offset < total; offset++) {
        const n = start + offset;
        await admin.query(
          "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Active',$6::jsonb,'[]'::jsonb,$7,'EACH',1,$8,$9)",
          [
            id(n),
            id(product),
            id(2),
            id(product + 1000),
            `SYNTH_MORE_SKU_${n}`,
            JSON.stringify({ "en-CA": `Synthetic additional unit ${n}` }),
            `sha256:${String(n).padStart(64, "0")}`,
            "2026-08-01T12:00:00.000Z",
            id(4),
          ],
        );
      }
    }
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
    const authority = {
      async withAuthorizedProductList(input, work) {
        assert.equal(input.actorReference, id(4));
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.capability, "catalog.cat_product_list");
        if (!allowed) throw new CatalogProductListError("Denied");
        if (!phase) throw new CatalogProductListError("FeatureDisabled");
        held++;
        try {
          return await work();
        } finally {
          held--;
        }
      },
    };
    const store = (scopeValue = scope) =>
      createPostgresCatalogProductListQueryStore({
        runner,
        scope: scopeValue,
        authorization: authority,
        clock: { now: () => new Date().toISOString() },
        cursorKey: new Uint8Array(32).fill(9),
      });
    const request = (extra = {}) => ({
      actorReference: id(4),
      purposeCode: "CATALOG_READ",
      locale: "en-CA",
      observedAt: new Date().toISOString(),
      search: null,
      lifecycle: null,
      productType: null,
      limit: 2,
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
    await admin.query(
      "UPDATE rms_catalog.product_version SET localized_names_json=$1 WHERE product_id=$2",
      [
        JSON.stringify({
          "en-CA": "Synthetic Alpha",
          "fr-CA": "Synthétique 100",
          "zh-CN": "Ｚebra",
        }),
        id(100),
      ],
    );
    await admin.query(
      "UPDATE rms_catalog.product_version SET localized_names_json=$1 WHERE product_id=$2",
      [
        JSON.stringify({
          "en-CA": "Synthetic Beta",
          "fr-CA": "Synthétique 100",
          "zh-CN": "🍵 Tea",
        }),
        id(101),
      ],
    );
    let buildOperation = 600;
    const rebuild = async (brandReference = id(2)) =>
      createPostgresProductSearchGenerationStore({
        tenantReference: id(1),
        brandReference,
        actorReference: id(4),
        clock: { now: () => new Date().toISOString() },
        maximumProducts: 1000,
        // Isolated fixture bootstrap only. The generation acceptance separately verifies owner role/RLS.
        authorization: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.actorReference, id(4));
            assert.equal(input.sourceProtocolVersion, 1);
          },
        },
        transactions: {
          async run(work) {
            const client = new pg.Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN");
              const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
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
      }).rebuild({
        operationReference: id(buildOperation++),
        actorReference: id(4),
        observedAt: new Date().toISOString(),
      });
    await assert.rejects(store().load(request()), (error) => error.code === "Unavailable");
    await rebuild();
    await rebuild(id(99));
    // Query role cannot read mutable roots or internal Actor/tax projection metadata.
    const restricted = new pg.Client(context.clientConfig);
    await restricted.connect();
    try {
      await restricted.query("BEGIN");
      await restricted.query(`SET LOCAL ROLE ${role}`);
      for (const sql of [
        "SELECT * FROM rms_catalog.product",
        "SELECT source_json FROM rms_catalog.product_search_row",
        "SELECT actor_id FROM rms_catalog.product_search_generation",
      ]) {
        await restricted.query("SAVEPOINT forbidden_field");
        await assert.rejects(restricted.query(sql), (error) => error.code === "42501");
        await restricted.query("ROLLBACK TO SAVEPOINT forbidden_field");
      }
      await restricted.query("ROLLBACK");
    } finally {
      await restricted.end();
    }
    const first = await store().load(request());
    assert.deepEqual(
      first.items.map((i) => i.productReference),
      [id(103), id(101)],
    );
    assert.equal(first.projection.name, "catalog_product_search_v1");
    assert.equal(first.projection.partial, true);
    assert.equal(first.hasMore, true);
    assert.equal(first.items[1].skuCount, 2);
    assert.equal(first.items[1].activeSkuCount, 1);
    assert.deepEqual(first.items[1].availability, { status: "Unavailable" });
    const second = await store().load(request({ cursor: first.nextCursor }));
    assert.deepEqual(
      second.items.map((i) => i.productReference),
      [id(100), id(102)],
    );
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    assert.equal(second.items[1].skuCount, 0); // actual empty current Draft SKU set, never a missing feed default.
    const active = await store().load(
      request({
        hasActiveSku: true,
        updatedFrom: "2026-08-02T12:00:00.000Z",
        updatedUntil: "2026-08-02T12:00:00.001Z",
      }),
    );
    assert.deepEqual(
      active.items.map((item) => item.productReference),
      [id(101)],
    );
    assert.equal(
      (
        await store().load(
          request({
            hasActiveSku: false,
            updatedFrom: "2026-08-02T12:00:00.000Z",
            updatedUntil: "2026-08-02T12:00:00.001Z",
          }),
        )
      ).items.length,
      0,
    );
    assert.equal(
      (await store().load(request({ hasActiveSku: true, search: "Synthetic exact code" }))).items
        .length,
      0,
    );
    assert.equal(
      (
        await store().load(
          request({ hasActiveSku: true, updatedUntil: "2026-08-02T12:00:00.000Z" }),
        )
      ).items.length,
      0,
    );
    assert.equal(
      (
        await store().load(
          request({
            hasActiveSku: true,
            updatedFrom: "2026-08-02T12:00:00.001Z",
            updatedUntil: "2026-08-03T12:00:00.000Z",
          }),
        )
      ).items.length,
      0,
    );
    const noActive = await store().load(
      request({
        hasActiveSku: false,
        limit: 1,
        updatedFrom: "2026-08-01T12:00:00.000Z",
        updatedUntil: "2026-08-04T12:00:00.000Z",
      }),
    );
    assert.deepEqual(
      noActive.items.map((item) => item.productReference),
      [id(100)],
    );
    for (const direction of ["ASC", "DESC"]) {
      const found = [];
      let cursor = null;
      do {
        const page = await store().load(
          request({
            missingTranslationLocale: "zh-CN",
            locale: "zh-CN",
            includeArchived: true,
            sort: "name",
            direction,
            limit: 1,
            cursor,
          }),
        );
        assert.ok(
          page.items.every((item) => item.nameLocale === "en-CA" && item.localeFallback),
          "fallback is not a translation",
        );
        found.push(...page.items.map((item) => item.productReference));
        cursor = page.nextCursor;
        assert.ok(found.length <= 3);
      } while (cursor);
      assert.deepEqual(found, (direction === "ASC" ? [104, 102, 103] : [103, 102, 104]).map(id));
    }
    assert.deepEqual(
      (await store().load(request({ missingTranslationLocale: "en-CA" }))).items,
      [],
    );
    // Product fr-CA names are complete even when SKU fr-CA translations are absent.
    assert.deepEqual(
      (await store().load(request({ missingTranslationLocale: "fr-CA" }))).items,
      [],
    );
    assert.deepEqual(
      (
        await store().load(request({ missingTranslationLocale: "zh-CN", hasActiveSku: true }))
      ).items.map((item) => item.productReference),
      [id(103)],
    );
    assert.deepEqual(
      (
        await store().load(
          request({
            missingTranslationLocale: "zh-CN",
            hasActiveSku: false,
            search: "EXACT",
            updatedUntil: "2026-08-02T12:00:00.000Z",
          }),
        )
      ).items.map((item) => item.productReference),
      [id(102)],
    );
    const missingFirst = await store().load(
      request({ missingTranslationLocale: "zh-CN", limit: 1 }),
    );
    for (const changed of [null, "fr-CA"]) {
      const before = sqlCalls;
      await assert.rejects(
        store().load(
          request({ missingTranslationLocale: changed, limit: 1, cursor: missingFirst.nextCursor }),
        ),
        (error) => error.code === "Invalid",
      );
      assert.equal(sqlCalls, before);
    }
    const beforeBadLocale = sqlCalls;
    await assert.rejects(
      store().load(request({ missingTranslationLocale: "fr_ca" })),
      (error) => error.code === "Invalid",
    );
    assert.equal(sqlCalls, beforeBadLocale);
    const noActiveNext = await store().load(
      request({
        hasActiveSku: false,
        limit: 1,
        updatedFrom: "2026-08-01T12:00:00.000Z",
        updatedUntil: "2026-08-04T12:00:00.000Z",
        cursor: noActive.nextCursor,
      }),
    );
    assert.deepEqual(
      noActiveNext.items.map((item) => item.productReference),
      [id(102)],
    );
    for (const changed of [
      { missingTranslationLocale: "fr-CA" },
      { hasActiveSku: true },
      { updatedFrom: "2026-08-01T12:00:00.001Z" },
      { updatedUntil: "2026-08-04T12:00:00.001Z" },
    ]) {
      const before = sqlCalls;
      await assert.rejects(
        store().load(
          request({
            hasActiveSku: false,
            limit: 1,
            updatedFrom: "2026-08-01T12:00:00.000Z",
            updatedUntil: "2026-08-04T12:00:00.000Z",
            cursor: noActive.nextCursor,
            ...changed,
          }),
        ),
        (error) => error.code === "Invalid",
      );
      assert.equal(sqlCalls, before);
    }
    const expectedSortOrders = {
      name: { ASC: [100, 101, 104, 102, 103], DESC: [103, 102, 104, 101, 100] },
      updatedAt: { ASC: [100, 102, 101, 103, 104], DESC: [104, 103, 101, 100, 102] },
      createdAt: { ASC: [100, 102, 103, 104, 101], DESC: [101, 100, 102, 103, 104] },
      internalCode: { ASC: [104, 102, 103, 100, 101], DESC: [101, 100, 103, 102, 104] },
      lifecycle: { ASC: [104, 100, 101, 102, 103], DESC: [100, 101, 102, 103, 104] },
      activeSkuCount: { ASC: [100, 102, 101, 104, 103], DESC: [103, 104, 101, 100, 102] },
    };
    for (const [sort, directions] of Object.entries(expectedSortOrders)) {
      for (const [direction, expected] of Object.entries(directions)) {
        const collected = [];
        let cursor = null;
        for (let page = 0; page < 3; page++) {
          const current = await store().load(
            request({ sort, direction, includeArchived: true, cursor, limit: 2 }),
          );
          collected.push(...current.items.map((item) => item.productReference));
          if (page < 2) assert.equal(current.hasMore, true);
          else assert.equal(current.hasMore, false);
          cursor = current.nextCursor;
        }
        assert.deepEqual(
          collected,
          expected.map(id),
          `${sort} ${direction} source ordering and ID-ASC ties across pages`,
        );
        const exactFirst = await store().load(
          request({ sort, direction, search: "exact", limit: 1 }),
        );
        assert.equal(exactFirst.items[0].productReference, id(102));
        const exactSecond = await store().load(
          request({ sort, direction, search: "exact", limit: 1, cursor: exactFirst.nextCursor }),
        );
        assert.equal(exactSecond.items[0].productReference, id(103));
        assert.equal(exactSecond.hasMore, false);
      }
    }
    for (const direction of ["ASC", "DESC"]) {
      const collected = [];
      let cursor = null;
      for (let page = 0; page < 3; page++) {
        const current = await store().load(
          request({
            sort: "name",
            direction,
            locale: "zh-CN",
            includeArchived: true,
            cursor,
            limit: 2,
          }),
        );
        collected.push(...current.items.map((item) => item.productReference));
        cursor = current.nextCursor;
        for (const item of current.items)
          assert.equal(
            item.localeFallback,
            [id(102), id(103), id(104)].includes(item.productReference),
          );
      }
      assert.deepEqual(
        collected,
        (direction === "ASC" ? [104, 102, 103, 100, 101] : [101, 100, 103, 102, 104]).map(id),
      );
    }
    for (const direction of ["ASC", "DESC"]) {
      const firstTie = await store().load(
        request({ sort: "name", direction, locale: "fr-CA", search: "Synthétique 100", limit: 1 }),
      );
      const secondTie = await store().load(
        request({
          sort: "name",
          direction,
          locale: "fr-CA",
          search: "Synthétique 100",
          limit: 1,
          cursor: firstTie.nextCursor,
        }),
      );
      assert.deepEqual(
        [...firstTie.items, ...secondTie.items].map((item) => item.productReference),
        [id(100), id(101)],
      );
      assert.equal(secondTie.hasMore, false);
    }
    const nameCursor = await store().load(request({ sort: "name", locale: "zh-CN", limit: 1 }));
    await assert.rejects(
      store().load(
        request({ sort: "name", locale: "fr-CA", limit: 1, cursor: nameCursor.nextCursor }),
      ),
      (error) => error.code === "Invalid",
    );
    const createdBoundary = await store().load(
      request({
        hasActiveSku: true,
        createdFrom: "2026-08-01T00:00:00.001Z",
        createdUntil: "2026-08-01T00:00:00.002Z",
      }),
    );
    assert.equal(createdBoundary.items[0].createdAt, "2026-08-01T00:00:00.001Z");
    assert.equal(createdBoundary.items[0].productReference, id(101));
    assert.equal(
      (
        await store().load(
          request({ hasActiveSku: true, search: "Beta", createdUntil: "2026-08-01T00:00:00.001Z" }),
        )
      ).items.length,
      0,
    );
    assert.equal(
      (await store().load(request({ hasActiveSku: true, createdFrom: "2026-08-01T00:00:00.002Z" })))
        .items.length,
      0,
    );
    const creationCursor = await store().load(
      request({ createdFrom: "2026-08-01T00:00:00.000Z", limit: 1 }),
    );
    for (const changed of [
      { sort: "internalCode" },
      { direction: "ASC" },
      { createdFrom: "2026-08-01T00:00:00.001Z" },
      { createdUntil: "2026-08-01T00:00:00.002Z" },
    ]) {
      const before = sqlCalls;
      await assert.rejects(
        store().load(
          request({
            createdFrom: "2026-08-01T00:00:00.000Z",
            limit: 1,
            cursor: creationCursor.nextCursor,
            ...changed,
          }),
        ),
        (error) => error.code === "Invalid",
      );
      assert.equal(sqlCalls, before);
    }
    const exact = await store().load(request({ search: "exact" }));
    assert.deepEqual(
      exact.items.map((i) => i.productReference),
      [id(102), id(103)],
    );
    const skuName = await store().load(request({ search: "iced tea" }));
    assert.equal(skuName.items[0].productReference, id(101));
    const alternate = await store().load(request({ search: "Synthétique 100", locale: "fr-CA" }));
    assert.equal(alternate.items[0].name, "Synthétique 100");
    const archived = await store().load(request({ includeArchived: true, lifecycle: "Archived" }));
    assert.equal(archived.items[0].productReference, id(104));
    assert.equal(
      (await store().load(request({ productType: "NonAlcoholicBeverage" }))).items.length,
      0,
    );
    assert.equal((await store().load(request({ search: "%" }))).items.length, 0);
    assert.equal(
      (await store({ brandReference: id(99), storeReference: id(3) }).load(request())).items[0]
        .productReference,
      id(105),
    );
    const scoped = await store().load(request());
    assert.equal(
      scoped.items.some((i) => i.productReference === id(105)),
      false,
    );
    const beforeDenied = sqlCalls;
    allowed = false;
    await assert.rejects(store().load(request()), (error) => error.code === "Denied");
    assert.equal(sqlCalls, beforeDenied);
    allowed = true;
    phase = false;
    await assert.rejects(store().load(request()), (error) => error.code === "FeatureDisabled");
    assert.equal(sqlCalls, beforeDenied);
    phase = true;
    await assert.rejects(
      store({ ...scope, storeReference: id(30) }).load(request({ cursor: first.nextCursor })),
      (error) => error.code === "Invalid",
    );
    const oldPage = await store().load(request());
    await rebuild();
    await assert.rejects(
      store().load(request({ cursor: oldPage.nextCursor })),
      (error) => error.code === "Stale",
    );
    await exerciseProductListBrowser({
      root,
      store,
      request,
      seed,
      rebuild,
      setAllowed: (value) => {
        allowed = value;
      },
      setPhase: (value) => {
        phase = value;
      },
      getSqlCalls: () => sqlCalls,
    });
    await seed(110, "FUTURE", "Synthetic future", "2099-08-01T12:00:00.000Z");
    await assert.rejects(rebuild(), (error) => error.code === "CATALOG_DEPENDENCY_UNAVAILABLE");
    assert.equal((await store().load(request({ search: "FUTURE" }))).items.length, 0);
    assert.equal(held, 0);
  } finally {
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("reads Catalog Product List from actual scoped owner data with signed pagination and current authority", async () => {
  await withIsolatedDatabase({ caseId: "wp2407_catalog_list", root }, exerciseCatalogProductList);
}, 120_000);
