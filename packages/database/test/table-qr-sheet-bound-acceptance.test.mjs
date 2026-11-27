import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createDiningTable,
  createDiningTableService,
  createPostgresDiningTableStore,
  transitionDiningTable,
} from "../../rms/dining/src/index.ts";
import { createMerchantDiningTableQr } from "../../../apps/api/dist/merchant-dining-table-qr.js";
import { createTableQrClient } from "../../../apps/merchant-web/src/table-qr-client.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

/**
 * Batch 58 (v15 b57 live, TM2 with 157 printable tables): "Print all codes" failed with 503 for
 * every Store with more than 100 printable codes, although the page lists up to 500 tables. The
 * printed sheet now takes every table the list shows (500), in one request, one file and one
 * audited print, within a stated size and time budget; more than that is refused as too many.
 *
 * Staff session and permission resolution is a test double naming the staff member and Store (as
 * in table-qr-issuance-acceptance); tables, their codes, the sheet read and its audit run for real
 * under a restricted NOBYPASSRLS role holding the rendered pilot API grants. No code or link is
 * written to the test output: only counts, sizes and booleans are compared.
 */
const merchant = vi.hoisted(() => ({ scope: null }));
vi.mock("../../../apps/api/dist/merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({ ...merchant.scope(), allowed: async () => true }),
}));

const { Client } = pg;
const id = (n) => "0190ab58-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store, publicStore, staff] = [1, 2, 3, 4, 5].map(id);
const tableScope = { tenantReference: tenant, brandReference: brand, storeReference: store };
let sequence = 0x1000;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (sequence++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();
const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const tableCount = 500;

it("Batch 58: a Store prints all of its 500 table codes in one file; 501 is refused as too many", async () => {
  await withIsolatedDatabase({ caseId: "b58_sheet" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "b58_sheet_api_" + context.runId,
      worker = "b58_sheet_w_" + context.runId;
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const acl = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(acl, { api: role, worker }));
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, brand, store],
            );
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
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

      // 500 published tables, made through the Dining table service as staff add them.
      const references = { hashIntent, equals: (a, b) => a === b };
      const area = fresh();
      await transactions.run(async (tx) => {
        const repository = createPostgresDiningTableStore(
          { run: (w) => w(tx) },
          tableScope,
          references,
        );
        const service = createDiningTableService({
          references,
          authorization: {
            authorize: async (input) => ({
              ...tableScope,
              actorReference: staff,
              purpose: "dining-table",
              permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
              audit: {
                auditId: fresh(),
                brandId: brand,
                storeId: store,
                actor: { type: "User", reference: staff },
                actionCode: "DINING_TABLE_" + input.action.toUpperCase(),
                targetType: "DiningTable",
                targetId: input.targetReference,
                reasonCode: "TABLE_SETUP",
                correlationId: fresh(),
                occurredAt: input.observedAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              },
            }),
          },
          repository: {
            ...repository,
            loadSession: async () => null,
            resolveMoveOperation: async () => null,
            commitMove: async () => assert.fail("no move"),
          },
        });
        for (let n = 1; n <= tableCount; n++) {
          const at = now();
          const draft = createDiningTable({
            ...tableScope,
            tableReference: fresh(),
            stableLabel: "Hall " + n,
            areaReference: area,
            areaCode: "HALL",
            capacity: 10,
            accessibilityAttributes: [],
            lifecycle: "Draft",
            qrStatus: "Inactive",
            qrVersion: 0,
            operationalState: "Available",
            blockReasonCode: null,
            activeDiningSessionReference: null,
            aggregateVersion: 1,
            createdAt: at,
            observedAt: at,
          });
          await service.executeTable({
            action: "CreateDraft",
            operationReference: fresh(),
            candidate: draft,
            expectedAggregateVersion: null,
            observedAt: at,
          });
          await service.executeTable({
            action: "Publish",
            operationReference: fresh(),
            candidate: transitionDiningTable(draft, "Publish", at),
            expectedAggregateVersion: 1,
            observedAt: at,
          });
        }
      });

      // TEST key pair; each code is signed as the pilot signs it.
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const signer = {
        async sign(payload) {
          const input = [{ alg: "ES256", kid: "test-v1", typ: "BOP-QR" }, payload]
            .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
            .join(".");
          const signature = sign("sha256", Buffer.from(input), {
            key: pair.privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
          return { keyId: "test-v1", token: input + "." + signature };
        },
      };
      merchant.scope = () => ({
        actorReference: staff,
        selected: { tenantReference: tenant },
        context: { brand: { brandReference: brand }, resolvedAt: now() },
        store: { storeReference: store, displayName: "DEMO Hall", timeZone: "America/Toronto" },
      });
      const port = createMerchantDiningTableQr({
        persistence: { transactions, now },
        authentication: { authorize: async () => ({ sessionReference: id(8) }) },
        newReference: fresh,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
        signer,
        publicStore: async (reference) =>
          reference === store ? { publicStoreReference: publicStore, locale: "zh-Hans-CA" } : null,
        // A customer origin longer than the pilot's, so the codes are at least as large as real ones.
        customerOrigin: "https://order.example-restaurant-group.ca",
      });
      const call = { sessionCookie: "cookie", csrf: "csrf" };
      const list = async () => (await port.list({ ...call, query: {} })).items;
      for (const row of await list())
        await port.command({
          ...call,
          command: {
            action: "Issue",
            tableReference: row.tableReference,
            expectedAggregateVersion: row.aggregateVersion,
            operationReference: fresh(),
          },
        });
      const rows = await list();
      assert.equal(rows.length, tableCount);
      assert.equal(rows.filter((row) => row.codeState === "Active").length, tableCount);
      const all = rows.map((row) => row.tableReference);

      const printedAudits = () =>
        admin.query(
          "SELECT target_id::text AS sheet,correlation_id::text AS correlation,after_summary_json AS after FROM platform_audit.audit_record WHERE action_code='DINING_TABLE_QR_PRINTED' ORDER BY chain_sequence",
        );
      const cardsIn = (html) => html.split('<article class="card">').length - 1;
      // The page's own client reads the reply exactly as the BFF sends it (the port's result as JSON).
      const asPageReads = (result, tableReferences) =>
        createTableQrClient("a".repeat(43), async (_path, init) => {
          assert.deepEqual(
            JSON.parse(String(init.body)).tableReferences.length,
            tableReferences.length,
          );
          return new globalThis.Response(JSON.stringify(result), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }).sheet(tableReferences);

      // 100 and 101: the old limit and just past it.
      for (const size of [100, 101]) {
        const sheet = await port.sheet({ ...call, query: { tableReferences: all.slice(0, size) } });
        assert.equal(cardsIn(sheet.html), size);
      }

      // 500, the bound: one request, one file with every card, inside the size and time budget.
      const started = performance.now();
      const sheet = await port.sheet({ ...call, query: { tableReferences: all } });
      const seconds = (performance.now() - started) / 1000;
      assert.equal(cardsIn(sheet.html), tableCount);
      assert.ok(sheet.html.includes("<h2>Table Hall 500</h2>"), "the last table is printed");
      const bytes = Buffer.byteLength(JSON.stringify(sheet), "utf8");
      // Budget: the reply at 500 tables stays under 20 MB (the page reads up to 40 MB) and is
      // made within 30 s on a shared CI runner (about 3 s on a developer Mac).
      assert.ok(bytes < 20_000_000, "the 500-table reply is " + bytes + " bytes");
      assert.ok(seconds < 30, "the 500-table sheet took " + seconds.toFixed(1) + " s");
      const read = await asPageReads(sheet, all);
      assert.equal(cardsIn(read.html), tableCount);
      // No internal reference is printed.
      assert.ok(!all.some((reference) => sheet.html.includes(reference)));

      // Every print is audited with the exact tables it printed, never a code.
      const audits = (await printedAudits()).rows;
      const big = audits.filter((row) => row.after.tableCount === tableCount);
      assert.ok(big.length >= 1);
      assert.equal(new Set(big.map((row) => row.sheet)).size, 1);
      assert.deepEqual(big.flatMap((row) => row.after.tableReferences).sort(), [...all].sort());
      const tokens = (
        await admin.query("SELECT qr_token FROM rms_dining.dining_table_qr_issue")
      ).rows.map((row) => row.qr_token.split(".")[2]);
      assert.ok(
        !audits.some((row) => tokens.some((token) => JSON.stringify(row.after).includes(token))),
      );

      // 501: more than one file holds is refused as too many, before anything is read or audited.
      const before = audits.length;
      await assert.rejects(
        port.sheet({ ...call, query: { tableReferences: [...all, fresh()] } }),
        /TABLE_QR_TOO_MANY/u,
      );
      assert.equal((await printedAudits()).rows.length, before);
    } finally {
      await admin.end();
    }
  });
});
