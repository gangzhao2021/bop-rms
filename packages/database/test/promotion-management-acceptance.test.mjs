import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createPostgresPromotionReferenceSourceStore } from "../../rms/pricing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (c) => `sha256:${c.repeat(64)}`;
const at = "2026-08-13T18:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2104_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.promotion(promotion_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_LUNCH',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_rate,stacking,stacking_group_code,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,1,$4,'Published','OrderPercentage','CAD','Order','Percentage',0.10,'SameGroupExclusive','MEAL',10,100000,1250,5,100,$5,'America/Toronto','SYNTHETIC_COPY',$5)`,
      [id(4), id(1), id(2), digest("a"), at],
    );
    await admin.query(
      `UPDATE rms_pricing.promotion SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE promotion_id=$3`,
      [id(4), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_eligibility_reference(promotion_eligibility_reference_id,promotion_version_id,promotion_id,brand_id,reference_kind,public_reference_id) VALUES($1,$2,$3,$4,'Segment',$5)`,
      [id(5), id(4), id(1), id(2), id(6)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_operation_record(operation_id,promotion_id,brand_id,action_code,intent_digest,result_aggregate_version,result_version_id,outbox_event_id,occurred_at) VALUES($1,$2,$3,'Publish',$4,2,$5,$6,$7)`,
      [id(7), id(1), id(2), digest("b"), id(4), id(8), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_fixed_minor,stacking,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,2,$4,'Draft','OrderFixed','CAD','Order','Fixed',10,'Stackable',1,99.5,0,0,1,$5,'America/Toronto','INVALID',$5)`,
        [id(9), id(1), id(2), digest("c"), at],
      ),
      /promotion_version_money_check/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_pricing.promotion_version SET budget_minor=1 WHERE promotion_version_id=$1`,
          [id(4)],
        )
      ).rowCount,
      0,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(
      `GRANT SELECT ON rms_pricing.promotion,rms_pricing.promotion_version,rms_pricing.promotion_eligibility_reference TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 1);
    assert.equal(
      (
        await admin.query(
          `SELECT public_reference_id FROM rms_pricing.promotion_eligibility_reference`,
        )
      ).rows[0].public_reference_id,
      id(6),
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
    // Actual complete owner source; authority and original Catalog intent are synthetic.
    async function sourceRoot(n, brand = id(2)) {
      await admin.query(
        "INSERT INTO rms_pricing.promotion(promotion_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
        [id(n), brand, "SYNTHETIC_SOURCE_" + n, at, id(3)],
      );
    }
    async function sourceVersion(
      rootId,
      versionId,
      number,
      lifecycle,
      benefitScope = "Item",
      from = at,
      until = null,
      brand = id(2),
    ) {
      await admin.query(
        "INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_rate,stacking,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_until,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,$4,$5,$6,'ItemPercentage','CAD',$7,'Percentage',0.10,'Stackable',1,100000,0,0,100,$8,$9,'America/Toronto','SYNTHETIC_COPY',$10)",
        [
          id(versionId),
          id(rootId),
          brand,
          number,
          digest("c"),
          lifecycle,
          benefitScope,
          from,
          until,
          at,
        ],
      );
      await admin.query(
        "UPDATE rms_pricing.promotion SET current_version_id=$1,aggregate_version=$2 WHERE promotion_id=$3 AND brand_id=$4",
        [id(versionId), number + 1, id(rootId), brand],
      );
    }
    async function qualifier(n, versionId, rootId, kind, target) {
      await admin.query(
        "INSERT INTO rms_pricing.promotion_eligibility_reference(promotion_eligibility_reference_id,promotion_version_id,promotion_id,brand_id,reference_kind,public_reference_id) VALUES($1,$2,$3,$4,$5,$6)",
        [id(n), id(versionId), id(rootId), id(2), kind, id(target)],
      );
    }
    await sourceVersion(1, 10, 2, "Paused");
    await qualifier(12, 10, 1, "Sellable", 101);
    await qualifier(13, 10, 1, "Category", 102);
    await qualifier(14, 10, 1, "Segment", 103);
    await sourceVersion(
      1,
      11,
      3,
      "Archived",
      "Item",
      at,
      new Date(Date.parse(at) + 1000).toISOString(),
    );
    await sourceRoot(20);
    await sourceVersion(20, 21, 1, "Published");
    await sourceRoot(30);
    await sourceRoot(40);
    await sourceVersion(40, 41, 1, "Draft", "Order");
    await qualifier(42, 41, 40, "Category", 104);
    await sourceRoot(50);
    await sourceVersion(50, 51, 1, "Paused", "Item", new Date(Date.now() + 86400000).toISOString());
    await sourceRoot(90, id(99));
    await sourceVersion(90, 91, 1, "Published", "Item", at, null, id(99));
    const runner = {
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL ROLE " + role);
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
    };
    const impactRequest = {
      purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(200),
      catalogIntentDigest: digest("d"),
    };
    let holds = 0,
      deniedAt = 0;
    const source = createPostgresPromotionReferenceSourceStore({
      tenantReference: id(201),
      brandReference: id(2),
      actorReference: id(3),
      transactions: runner,
      clock: { now: () => new Date().toISOString() },
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          void tx;
          assert.equal(input.permission, "pricing.promotion.manage");
          assert.deepEqual(input.request, impactRequest);
          if (++holds === deniedAt) throw new Error("synthetic authority denied");
        },
      },
    });
    const snapshot = await source.loadSnapshot(impactRequest);
    assert.equal(holds, 2);
    assert.equal(snapshot.profile, "PromotionEligibility");
    assert.equal(snapshot.consistency, "StatementSnapshot");
    assert.equal(snapshot.roots.length, 5);
    assert.equal(snapshot.versions.length, 6);
    assert.ok(
      snapshot.roots.some(
        (r) => r.promotionReference === id(30) && r.currentVersionReference === null,
      ),
    );
    assert.ok(!snapshot.versions.some((v) => v.promotionReference === id(30)));
    assert.ok(!snapshot.roots.some((r) => r.promotionReference === id(90)));
    const original = snapshot.versions.find((v) => v.versionReference === id(4));
    assert.equal(original.isCurrentVersion, false);
    assert.equal(original.eligibility[0].referenceKind, "Segment");
    assert.equal(original.catalogReferenceMode, "OrderSubtotal");
    const paused = snapshot.versions.find((v) => v.versionReference === id(10));
    assert.equal(paused.lifecycle, "Paused");
    assert.equal(paused.eligibility.length, 3);
    assert.equal(paused.catalogReferenceMode, "ExplicitSellableOrCategory");
    assert.equal(
      snapshot.versions.find((v) => v.versionReference === id(11)).temporalStatus,
      "Expired",
    );
    assert.equal(
      snapshot.versions.find((v) => v.versionReference === id(21)).catalogReferenceMode,
      "AllSellables",
    );
    assert.equal(snapshot.versions.find((v) => v.versionReference === id(41)).lifecycle, "Draft");
    assert.equal(
      snapshot.versions.find((v) => v.versionReference === id(51)).temporalStatus,
      "Future",
    );
    assert.equal(JSON.stringify(snapshot).includes("budgetMinor"), false);
    assert.equal(JSON.stringify(snapshot).includes("customerCopyCode"), false);
    assert.equal(
      (
        await admin.query("SELECT has_table_privilege($1,'rms_catalog.product','SELECT') allowed", [
          role,
        ])
      ).rows[0].allowed,
      false,
    );
    assert.equal((await source.loadSnapshot(impactRequest)).digest, snapshot.digest);
    // Append a new synthetic aggregate instead of editing observed version qualifiers.
    await sourceRoot(60);
    await sourceVersion(60, 61, 1, "Published");
    await qualifier(62, 61, 60, "Sellable", 105);
    const changed = await source.loadSnapshot(impactRequest);
    assert.notEqual(changed.digest, snapshot.digest);
    assert.equal(
      changed.versions.find((v) => v.versionReference === id(61)).catalogReferenceMode,
      "ExplicitSellableOrCategory",
    );
    deniedAt = holds + 1;
    await assert.rejects(source.loadSnapshot(impactRequest), {
      code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE",
    });
    deniedAt = holds + 2;
    await assert.rejects(source.loadSnapshot(impactRequest), {
      code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE",
    });
    deniedAt = 0;
    assert.equal((await source.loadSnapshot(impactRequest)).digest, changed.digest);
    await admin.query(
      "UPDATE rms_pricing.promotion SET updated_at=created_at+interval '1 microsecond' WHERE promotion_id=$1",
      [id(30)],
    );
    await assert.rejects(source.loadSnapshot(impactRequest), {
      code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE",
    });
    await admin.query(
      "UPDATE rms_pricing.promotion SET updated_at=created_at WHERE promotion_id=$1",
      [id(30)],
    );
    assert.equal((await source.loadSnapshot(impactRequest)).digest, changed.digest);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("keeps Promotion versions, budget facts, event linkage and Brand RLS exact", async () => {
  await withIsolatedDatabase({ caseId: "promotion_management", root }, prove);
}, 120_000);
