import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  changeKitchenProductSection,
  changeKitchenSections,
  listKitchenWorkItemSections,
  loadKitchenProductSections,
  loadKitchenSections,
} from "../../rms/kitchen/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a8f1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "a".repeat(64);

/**
 * WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): one kitchen screen, each dish
 * marked with its kitchen section (档口), the screen filtered by section. Under the pilot api role
 * holding exactly the pilot ACL: the Store's sections are a versioned list the owner names (a stale
 * version and a reused operation for another list are refused, the same operation returns; names
 * are unique, also in the database); a dish's section is its next version and must be one of the
 * Store's sections; the kitchen reads each work item's section by its name now (renamed: the new
 * name; removed or never marked: no section); another Store sees and changes nothing; both records
 * are append-only. Synthetic TEST references only.
 */
it("keeps the kitchen's sections and each dish's section, per Store, under the pilot api role", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_section" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "kitchen_section_api_" + context.runId,
      worker = "kitchen_section_w_" + context.runId;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
      const other = { ...scope, storeReference: id(4) };
      const owner = id(5);
      const asApi = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query("SET LOCAL statement_timeout='5s'");
          const value = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const at = () => new Date(Math.floor(Date.now())).toISOString();
      const [wok, steam, roast] = [id(0x10), id(0x11), id(0x12)];

      // ── The Store's sections: none, then the owner names two; each change the next version.
      assert.deepEqual(await asApi((tx) => loadKitchenSections(tx, scope)), {
        version: 0,
        sections: [],
      });
      const named = { operationReference: id(0x20), actorReference: owner, observedAt: at() };
      const first = await asApi((tx) =>
        changeKitchenSections(tx, scope, {
          ...named,
          expectedVersion: 0,
          sections: [
            { sectionReference: wok, name: "炒锅 Wok" },
            { sectionReference: steam, name: "蒸柜 Steamer" },
          ],
        }),
      );
      assert.equal(first.version, 1);
      // The same operation again returns it; reused for another list, or a stale version, refused.
      assert.equal(
        (
          await asApi((tx) =>
            changeKitchenSections(tx, scope, {
              ...named,
              expectedVersion: 0,
              sections: first.sections,
            }),
          )
        ).version,
        1,
      );
      await assert.rejects(
        asApi((tx) =>
          changeKitchenSections(tx, scope, {
            ...named,
            expectedVersion: 0,
            sections: [{ sectionReference: wok, name: "炒锅 Wok" }],
          }),
        ),
        { code: "KITCHEN_SECTION_CHANGED" },
      );
      await assert.rejects(
        asApi((tx) =>
          changeKitchenSections(tx, scope, {
            operationReference: id(0x21),
            actorReference: owner,
            observedAt: at(),
            expectedVersion: 0,
            sections: [],
          }),
        ),
        { code: "KITCHEN_SECTION_CHANGED" },
      );
      // Names are unique (the database refuses a duplicate even when written directly).
      await assert.rejects(
        asApi((tx) =>
          changeKitchenSections(tx, scope, {
            operationReference: id(0x22),
            actorReference: owner,
            observedAt: at(),
            expectedVersion: 1,
            sections: [
              { sectionReference: wok, name: "炒锅 Wok" },
              { sectionReference: roast, name: "炒锅 Wok" },
            ],
          }),
        ),
        { code: "KITCHEN_SECTION_INPUT_INVALID" },
      );
      await assert.rejects(
        asApi(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return tx.query(
            "INSERT INTO rms_kitchen.kitchen_section_list (tenant_id,brand_id,store_id,version,operation_id,sections,actor_id,occurred_at) VALUES ($1,$2,$3,2,$4,$5::jsonb,$6,date_trunc('milliseconds',now()))",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              id(0x23),
              JSON.stringify([
                { sectionReference: wok, name: "Same" },
                { sectionReference: roast, name: "Same" },
              ]),
              owner,
            ],
          );
        }),
        /kitchen section list invalid/u,
      );

      // ── A dish's section: one of the Store's sections, its next version.
      const [dumplings, noodles, tea] = [id(0x30), id(0x31), id(0x32)];
      const mark = (product, op, expectedVersion, sectionReference) =>
        asApi((tx) =>
          changeKitchenProductSection(tx, scope, {
            productReference: product,
            operationReference: op,
            expectedVersion,
            sectionReference,
            actorReference: owner,
            observedAt: at(),
          }),
        );
      assert.deepEqual(await mark(dumplings, id(0x40), 0, steam), {
        sectionReference: steam,
        version: 1,
      });
      assert.deepEqual(await mark(noodles, id(0x41), 0, wok), {
        sectionReference: wok,
        version: 1,
      });
      await assert.rejects(mark(tea, id(0x42), 0, roast), { code: "KITCHEN_SECTION_UNKNOWN" });
      await assert.rejects(mark(dumplings, id(0x43), 0, wok), { code: "KITCHEN_SECTION_CHANGED" });
      assert.deepEqual(await mark(dumplings, id(0x40), 0, steam), {
        sectionReference: steam,
        version: 1,
      });

      // ── The kitchen reads each work item's section by its name now. TEST-ONLY work items seeded
      // by the owner with constraints off (the read is the api role's).
      await admin.query("SET session_replication_role = replica");
      try {
        for (const [n, product] of [
          [0x50, dumplings],
          [0x51, noodles],
          [0x52, tea],
        ])
          await admin.query(
            `INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,customer_note,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,created_by_actor_id,updated_by_actor_type,updated_by_actor_id,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',1,0,$11,$12,$13,$14,'{"en-CA":"TEST dish"}'::jsonb,'[]'::jsonb,NULL,$15,$16,$17,1,$15,$18,1,$15,'["TEST"]'::jsonb,$15,'System',NULL,'System',NULL,now(),now())`,
            [
              id(n),
              scope.brandReference,
              scope.storeReference,
              id(0x60),
              id(0x61),
              id(0x62),
              id(n + 0x100),
              id(0x63),
              id(0x64),
              n - 0x4f,
              product,
              id(0x65),
              id(n + 0x200),
              id(0x66),
              digest,
              id(0x67),
              id(0x68),
              id(0x69),
            ],
          );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const sections = () =>
        asApi((tx) =>
          listKitchenWorkItemSections(tx, scope, [id(0x50), id(0x51), id(0x52)]).then((found) => [
            ...found.entries(),
          ]),
        );
      assert.deepEqual(
        new Map(await sections()),
        new Map([
          [id(0x50), "蒸柜 Steamer"],
          [id(0x51), "炒锅 Wok"],
          [id(0x52), null],
        ]),
      );
      // Renamed: dishes keep the section under its new name; removed: they have no section.
      await asApi((tx) =>
        changeKitchenSections(tx, scope, {
          operationReference: id(0x24),
          actorReference: owner,
          observedAt: at(),
          expectedVersion: 1,
          sections: [{ sectionReference: steam, name: "点心 Dim sum" }],
        }),
      );
      assert.deepEqual(
        new Map(await sections()),
        new Map([
          [id(0x50), "点心 Dim sum"],
          [id(0x51), null],
          [id(0x52), null],
        ]),
      );

      // ── Another Store sees and changes nothing of it.
      assert.deepEqual(await asApi((tx) => loadKitchenSections(tx, other)), {
        version: 0,
        sections: [],
      });
      assert.equal(
        (await asApi((tx) => loadKitchenProductSections(tx, other, [dumplings]))).size,
        0,
      );
      assert.deepEqual(
        await asApi((tx) =>
          listKitchenWorkItemSections(tx, other, [id(0x50)]).then((found) => found.size),
        ),
        0,
      );

      // ── Both records are append-only.
      for (const table of ["kitchen_section_list", "kitchen_product_section"])
        await assert.rejects(
          asApi(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [scope.brandReference, scope.storeReference],
            );
            return tx.query(`UPDATE rms_kitchen.${table} SET actor_id=actor_id`, []);
          }),
          /append-only kitchen section record|permission denied/u,
        );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT version,actor_id::text actor FROM rms_kitchen.kitchen_section_list ORDER BY version",
          )
        ).rows.map((row) => [row.version, row.actor]),
        [
          [1, owner],
          [2, owner],
        ],
      );
    } finally {
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
