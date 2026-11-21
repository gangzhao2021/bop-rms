import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createDiningTable,
  createDiningTableService,
  createPostgresDiningTableStore,
  createQrSignatureVerifier,
  createQrTableContextService,
  parseQrVerificationKeySetEvidence,
  transitionDiningTable,
} from "../../rms/dining/src/index.ts";
import { createMerchantDiningTableQr } from "../../../apps/api/dist/merchant-dining-table-qr.js";
import { RetiredTableQrError } from "../../../apps/api/dist/persistent-customer-entry.js";
import { createIssuedDiningEntries } from "../../../tooling/environment/pilot-dining-issued-entry.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// As the Q11 acceptance: staff session and permission resolution is an explicit double naming the
// staff member, the selected Store and the current `dining.table.qr.manage` decision; the public
// Store profile is a double (Active). The Dining tables, their codes, operations and audit run for
// real under a restricted NOBYPASSRLS role with the rendered pilot API grants.
const merchant = vi.hoisted(() => ({ allowed: true, store: null }));
vi.mock("../../../apps/api/dist/merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({
    actorReference: merchant.staff,
    selected: { tenantReference: merchant.tenant },
    context: { brand: { brandReference: merchant.brand }, resolvedAt: new Date().toISOString() },
    store: { storeReference: merchant.store, displayName: "DEMO Store", timeZone: "UTC" },
    allowed: async () => merchant.allowed,
  }),
}));
vi.mock("../../../apps/api/dist/public-store-resolution.js", () => ({
  createConfiguredPublicStoreResolution: () => ({
    resolve: async () => ({
      brandLifecycle: "Active",
      storeLifecycle: "Active",
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  }),
}));

const { Client } = pg;
const id = (n) => "0190aa21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store1, store2, public1, public2, staff, keyReference] = [
  1, 2, 3, 4, 5, 6, 7, 8,
].map(id);
let sequence = 0x100;
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (sequence++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();
const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-11-01): store 2 had no tables
 * and nothing in the product could make one, so no guest could reach it. On Table QR codes, under
 * the restricted role, through the Dining table service:
 * 1. "Add a table" at store 2 creates and publishes "Table 5" (4 seats), audited; a retry of the
 *    same operation answers the same table;
 * 2. it gets its code through the existing issue path, and a guest scanning it is admitted;
 * 3. "Rename" changes its name; another table's name is refused;
 * 4. "Retire" turns its code off at once (the guest is refused), it leaves the list and is kept
 *    (never deleted); a seated table cannot be retired;
 * 5. store 1's table and code are untouched throughout.
 */
it("staff add, rename and retire their Store's tables; store 1 is untouched", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_table_manage" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_tbl_api_" + context.runId,
      worker = "wp2423_tbl_w_" + context.runId;
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      Object.assign(merchant, { tenant, brand, staff, store: store1 });
      const runner = (store) => ({
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
      });
      // The current Store's transactions (the BFF runs in the selected Store).
      const transactions = { run: (work) => runner(merchant.store).run(work) };

      // Store 1: a published table with a code, made through the Dining table service.
      const references = { hashIntent, equals: (a, b) => a === b };
      const oneTable = fresh();
      await runner(store1).run(async (tx) => {
        const scope = { tenantReference: tenant, brandReference: brand, storeReference: store1 };
        const repository = createPostgresDiningTableStore({ run: (w) => w(tx) }, scope, references);
        const service = createDiningTableService({
          references,
          authorization: {
            authorize: async (input) => ({
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store1,
              actorReference: staff,
              purpose: "dining-table",
              permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
              audit: {
                auditId: fresh(),
                brandId: brand,
                storeId: store1,
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
        const at = now();
        const draft = createDiningTable({
          ...scope,
          tableReference: oneTable,
          stableLabel: "DEMO-01",
          areaReference: fresh(),
          areaCode: "MAIN",
          capacity: 4,
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
        for (const [action, candidate, expected] of [
          ["CreateDraft", draft, null],
          ["Publish", transitionDiningTable(draft, "Publish", at), 1],
        ])
          await service.executeTable({
            action,
            operationReference: fresh(),
            candidate,
            expectedAggregateVersion: expected,
            observedAt: at,
          });
      });

      // TEST key pair (the pilot signs with its TEST-ONLY key file the same way).
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const keys = {
        keys: {
          load: async () =>
            parseQrVerificationKeySetEvidence({
              registryVersion: 1,
              registryEvidenceReference: id(9),
              validUntil: new Date(Date.now() + 600_000).toISOString(),
              keys: [
                {
                  kid: "test-v1",
                  algorithm: "ES256",
                  state: "Current",
                  publicKeyReference: keyReference,
                  validFrom: "2026-01-01T00:00:00.000Z",
                  validUntil: "2028-01-01T00:00:00.000Z",
                  compromisedAt: null,
                },
              ],
            }),
        },
        verifier: createQrSignatureVerifier(async (reference) =>
          String(reference) === keyReference ? pair.publicKey : null,
        ),
        telemetry: { record: () => undefined },
        signer: {
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
        },
      };
      const port = createMerchantDiningTableQr({
        persistence: { transactions, now },
        authentication: { authorize: async () => ({ sessionReference: id(10) }) },
        newReference: fresh,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
        signer: keys.signer,
        publicStore: async (reference) =>
          reference === store1
            ? { publicStoreReference: public1, locale: "en-CA" }
            : reference === store2
              ? { publicStoreReference: public2, locale: "en-CA" }
              : null,
        customerOrigin: "https://127.0.0.1:4443",
      });
      const call = { sessionCookie: "cookie", csrf: "csrf" };
      const at = (store) => {
        merchant.store = store;
        return {
          list: async () => (await port.list({ ...call, query: {} })).items,
          manage: (command) => port.manage({ ...call, command }),
          issue: (row) =>
            port.command({
              ...call,
              command: {
                action: "Issue",
                tableReference: row.tableReference,
                expectedAggregateVersion: row.aggregateVersion,
                operationReference: fresh(),
              },
            }),
        };
      };
      const enter = async (store, publicStore, token) => {
        const binding = {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          publicStoreReference: publicStore,
        };
        const entries = await createIssuedDiningEntries(
          {
            scope: { brandReference: brand, storeReference: store },
            transactions: runner(store),
            credentials: { sessions: {} },
            publicProfile: { binding, authorize: async () => true },
            operatingReader: () => ({}),
          },
          { loadProfile: async () => ({ binding }), loadKeys: async () => keys },
        );
        try {
          const verified = await runner(store).run(async (tx) => {
            const sources = await entries.entry.persistent.sources(tx, {
              qrToken: token,
              requestedAt: now(),
            });
            return createQrTableContextService(sources.qr).resolveQrTableContext({
              qrToken: token,
              evaluatedAt: now(),
              purpose: "CustomerEntry",
            });
          });
          return verified.status;
        } catch (error) {
          if (error instanceof RetiredTableQrError) return error.reason;
          throw error;
        }
      };
      const storeOneState = () =>
        admin.query(
          "SELECT version::int,table_snapshot->>'stableLabel' label,table_snapshot->>'lifecycle' lifecycle,(SELECT count(*)::int FROM rms_dining.dining_table_qr_issue q WHERE q.table_id=t.table_id) codes FROM rms_dining.dining_table t WHERE store_id=$1",
          [store1],
        );
      // Store 1's table has a code.
      const [oneRow] = await at(store1).list();
      await at(store1).issue(oneRow);
      const storeOneBefore = (await storeOneState()).rows;

      // 0. Store 2 starts with no tables.
      assert.deepEqual(await at(store2).list(), []);

      // 1. Add "Table 5" with 4 seats; a retry answers the same table.
      const add = { action: "Add", operationReference: fresh(), label: "Table 5", capacity: 4 };
      const added = await at(store2).manage(add);
      assert.equal(added.status, "Applied");
      assert.equal(added.item.stableLabel, "Table 5");
      assert.equal(added.item.codeState, "None");
      const again = await at(store2).manage(add);
      assert.equal(again.status, "AlreadyApplied");
      assert.equal(again.item.tableReference, added.item.tableReference);
      const rows = await at(store2).list();
      assert.deepEqual(
        rows.map((row) => [row.stableLabel, row.codeState]),
        [["Table 5", "None"]],
      );
      const audits = (
        await admin.query(
          "SELECT action_code,reason_code,actor_reference::text actor FROM platform_audit.audit_record WHERE store_id=$1 AND target_id=$2 ORDER BY chain_sequence",
          [store2, added.item.tableReference],
        )
      ).rows;
      assert.deepEqual(
        audits.map((row) => [row.action_code, row.reason_code, row.actor]),
        [
          ["DINING_TABLE_CREATEDRAFT", "TABLE_ADDED", staff],
          ["DINING_TABLE_PUBLISH", "TABLE_ADDED", staff],
        ],
      );

      // 2. Its code through the existing issue path; a guest scanning it is admitted.
      const issued = await at(store2).issue(rows[0]);
      assert.equal(issued.item.codeState, "Active");
      const [{ qr_token: token }] = (
        await admin.query(
          "SELECT qr_token FROM rms_dining.dining_table_qr_issue WHERE table_id=$1",
          [added.item.tableReference],
        )
      ).rows;
      assert.equal(await enter(store2, public2, token), "Verified");

      // 3. Rename; a name another table has is refused.
      let [current] = await at(store2).list();
      const renamed = await at(store2).manage({
        action: "Rename",
        operationReference: fresh(),
        tableReference: current.tableReference,
        expectedAggregateVersion: current.aggregateVersion,
        label: "Patio 2",
      });
      assert.equal(renamed.item.stableLabel, "Patio 2");
      assert.equal(renamed.item.codeState, "Active");
      await at(store2).manage({
        action: "Add",
        operationReference: fresh(),
        label: "Table 6",
        capacity: 2,
      });
      await assert.rejects(
        at(store2).manage({
          action: "Add",
          operationReference: fresh(),
          label: "patio 2",
          capacity: 2,
        }),
        /TABLE_NAME_TAKEN/u,
      );
      assert.equal(await enter(store2, public2, token), "Verified");

      // 4. Retire: its code stops at once, it leaves the list, and it is kept.
      [current] = (await at(store2).list()).filter((row) => row.stableLabel === "Patio 2");
      const retired = await at(store2).manage({
        action: "Retire",
        operationReference: fresh(),
        tableReference: current.tableReference,
        expectedAggregateVersion: current.aggregateVersion,
      });
      assert.equal(retired.status, "Applied");
      assert.notEqual(await enter(store2, public2, token), "Verified");
      assert.deepEqual(
        (await at(store2).list()).map((row) => row.stableLabel),
        ["Table 6"],
      );
      const [kept] = (
        await admin.query(
          "SELECT table_snapshot->>'lifecycle' lifecycle,table_snapshot->>'qrStatus' qr FROM rms_dining.dining_table WHERE table_id=$1",
          [added.item.tableReference],
        )
      ).rows;
      assert.deepEqual(kept, { lifecycle: "Retired", qr: "Revoked" });
      // A retired name is free again.
      await at(store2).manage({
        action: "Add",
        operationReference: fresh(),
        label: "Patio 2",
        capacity: 4,
      });
      // A seated table cannot be retired (owner fixture: a session holds it).
      const [six] = (await at(store2).list()).filter((row) => row.stableLabel === "Table 6");
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=version+1,table_snapshot=jsonb_set(jsonb_set(table_snapshot,'{activeDiningSessionReference}',to_jsonb($2::text)),'{aggregateVersion}',to_jsonb(version+1)) WHERE table_id=$1",
        [six.tableReference, fresh()],
      );
      const [seated] = (await at(store2).list()).filter((row) => row.stableLabel === "Table 6");
      assert.equal(seated.seated, true);
      await assert.rejects(
        at(store2).manage({
          action: "Retire",
          operationReference: fresh(),
          tableReference: seated.tableReference,
          expectedAggregateVersion: seated.aggregateVersion,
        }),
        /TABLE_SEATED/u,
      );

      // 5. Store 1 is untouched; its code still admits guests; store 2's tables are not its own.
      assert.deepEqual((await storeOneState()).rows, storeOneBefore);
      assert.deepEqual(
        (await at(store1).list()).map((row) => row.stableLabel),
        ["DEMO-01"],
      );
      const [{ qr_token: oneToken }] = (
        await admin.query(
          "SELECT qr_token FROM rms_dining.dining_table_qr_issue WHERE table_id=$1",
          [oneTable],
        )
      ).rows;
      assert.equal(await enter(store1, public1, oneToken), "Verified");
    } finally {
      await admin.end();
    }
  });
}, 240_000);
