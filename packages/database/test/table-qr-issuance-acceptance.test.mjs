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
  createPostgresDiningTableQrStore,
  createPostgresDiningTableStore,
  createQrSignatureVerifier,
  createQrTableContextService,
  parseQrVerificationKeySetEvidence,
  transitionDiningTable,
} from "../../rms/dining/src/index.ts";
import { createMerchantDiningTableQr } from "../../../apps/api/dist/merchant-dining-table-qr.js";
import { createConfiguredDiningQrContext } from "../../../apps/api/dist/configured-dining-qr-context.js";
import { RetiredTableQrError } from "../../../apps/api/dist/persistent-customer-entry.js";
import { createIssuedDiningEntries } from "../../../tooling/environment/pilot-dining-issued-entry.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// Staff session, membership and permission resolution (Identity, Membership, Permission owners)
// is replaced by an explicit test double naming the staff member, the Store and the current
// `dining.table.qr.manage` decision. Public Store profile resolution is likewise a double (Active
// Brand and Store); the Dining table, its codes, the table operation and audit run for real under
// a restricted NOBYPASSRLS role with the rendered pilot API grants.
const merchant = vi.hoisted(() => ({ allowed: true, actions: [], scope: null }));
vi.mock("../../../apps/api/dist/merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async (_tx, _cookie, action) => {
    merchant.actions.push(action);
    return {
      ...merchant.scope(),
      allowed: async () => merchant.allowed,
    };
  },
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
const id = (n) => "0190aa11-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store, publicStore, staff, keyReference] = [1, 2, 3, 4, 5, 6].map(id);
const tableScope = { tenantReference: tenant, brandReference: brand, storeReference: store };
const binding = { ...tableScope, publicStoreReference: publicStore };
let sequence = 0x100;
/** Fresh UUIDv7 with the current instant as its time prefix. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (sequence++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();
const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

it("WP-2423 Q11: staff issue, print, replace and turn off one table's code; old codes stop at once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_q11" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_q11_api_" + context.runId,
      worker = "wp2423_q11_w_" + context.runId,
      matrixOnly = "wp2423_q11_m_" + context.runId,
      matrixWorker = "wp2423_q11_mw_" + context.runId;
    try {
      for (const name of [role, worker, matrixOnly, matrixWorker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const [matrix, additions] = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql([matrix, additions], { api: role, worker }));
      // Without the proposed Q11 grants (matrix plus every other addition) codes cannot be kept.
      await admin.query(
        renderPilotAclSql(
          [
            matrix,
            {
              ...additions,
              entries: additions.entries.filter((e) => e.object !== "dining_table_qr_issue"),
            },
          ],
          { api: matrixOnly, worker: matrixWorker },
        ),
      );

      const runner = (as = role) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + as);
            await client.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, brand, store],
            );
            const tx = {
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            };
            const result = await work(tx);
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
      const transactions = runner();

      // A published table without a code, created through the Dining table service.
      const references = { hashIntent, equals: (a, b) => a === b };
      const seed = async (work) =>
        transactions.run(async (tx) => {
          const repository = createPostgresDiningTableStore(
            { run: (w) => w(tx) },
            tableScope,
            references,
          );
          const service = createDiningTableService({
            references,
            authorization: {
              authorize: async (input) => ({
                tenantReference: tenant,
                brandReference: brand,
                storeReference: store,
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
          return work(repository, service);
        });
      const tableReference = fresh();
      await seed(async (_repository, service) => {
        const at = now();
        const draft = createDiningTable({
          ...tableScope,
          tableReference,
          stableLabel: "T 12",
          areaReference: fresh(),
          areaCode: "PATIO",
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
      });

      // TEST key pair (the pilot uses its TEST-ONLY key file the same way).
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const keys = {
        keys: {
          load: async () =>
            parseQrVerificationKeySetEvidence({
              registryVersion: 1,
              registryEvidenceReference: id(7),
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

      merchant.scope = () => ({
        actorReference: staff,
        selected: { tenantReference: tenant },
        context: { brand: { brandReference: brand }, resolvedAt: now() },
        store: { storeReference: store, displayName: "DEMO Store", timeZone: "America/Toronto" },
      });
      const persistence = { transactions, now };
      const port = createMerchantDiningTableQr({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(8) }) },
        newReference: fresh,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
        signer: keys.signer,
        publicStore: async (reference) =>
          reference === store ? { publicStoreReference: publicStore, locale: "en-CA" } : null,
        customerOrigin: "https://127.0.0.1:4443",
      });
      const call = { sessionCookie: "cookie", csrf: "csrf" };
      const list = async () => (await port.list({ ...call, query: {} })).items;
      const command = (action, row, operationReference = fresh()) =>
        port.command({
          ...call,
          command: {
            action,
            tableReference: row.tableReference,
            expectedAggregateVersion: row.aggregateVersion,
            operationReference,
          },
        });

      // Guest entry as the pilot composes it, against the same restricted role.
      const entries = await createIssuedDiningEntries(
        {
          scope: { brandReference: brand, storeReference: store },
          transactions,
          credentials: { sessions: {} },
          publicProfile: { binding, authorize: async () => true },
          operatingReader: () => ({}),
        },
        { loadProfile: async () => ({ binding }), loadKeys: async () => keys },
      );
      const enter = (token) =>
        transactions.run(async (tx) => {
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
      const retired = async (token) => {
        try {
          await enter(token);
        } catch (error) {
          if (error instanceof RetiredTableQrError) return error.reason;
          throw error;
        }
        return "Admitted";
      };
      const issueRows = () =>
        admin.query(
          "SELECT qr_id::text,public_table_id::text,qr_version::int,qr_token FROM rms_dining.dining_table_qr_issue WHERE table_id=$1 ORDER BY qr_version",
          [tableReference],
        );
      const audits = (action) =>
        admin.query(
          "SELECT reason_code,actor_reference::text AS actor,after_summary_json AS after FROM platform_audit.audit_record WHERE action_code=$1 ORDER BY chain_sequence",
          [action],
        );

      // 1. No code yet; an unknown code is refused as unavailable (not "replaced").
      let [row] = await list();
      assert.equal(row.codeState, "None");
      assert.deepEqual(merchant.actions, ["dining.table.qr.manage"]);

      // 2. Create the first code; a retry of the same operation is answered, not repeated.
      const first = fresh();
      const created = await command("Issue", row, first);
      assert.equal(created.status, "Applied");
      assert.equal(created.item.codeState, "Active");
      assert.equal((await command("Issue", row, first)).status, "AlreadyApplied");
      let codes = (await issueRows()).rows;
      assert.equal(codes.length, 1);
      assert.equal(codes[0].qr_version, 1);
      const firstToken = codes[0].qr_token;
      const publicTable = codes[0].public_table_id;
      const verified = await enter(firstToken);
      assert.equal(verified.status, "Verified");
      assert.equal(verified.context.publicTableReference, publicTable);
      assert.equal(verified.context.revocationVersion, 1);

      // 3. Print: authorized staff get the sheet (audited); without permission nothing is printed.
      [row] = await list();
      const sheet = await port.sheet({ ...call, query: { tableReferences: [tableReference] } });
      assert.match(sheet.fileName, /^table-qr-codes-\d{4}-\d{2}-\d{2}\.html$/u);
      assert.ok(sheet.html.includes('href="https://127.0.0.1:4443/#qr=' + firstToken + '"'));
      assert.ok(sheet.html.includes("Table T 12"));
      assert.ok(!sheet.html.includes(tableReference));
      merchant.allowed = false;
      await assert.rejects(
        port.sheet({ ...call, query: { tableReferences: [tableReference] } }),
        /TABLE_QR_PERMISSION_DENIED/u,
      );
      await assert.rejects(command("Issue", row), /TABLE_QR_PERMISSION_DENIED/u);
      await assert.rejects(list(), /TABLE_QR_PERMISSION_DENIED/u);
      merchant.allowed = true;
      const printed = (await audits("DINING_TABLE_QR_PRINTED")).rows;
      assert.equal(printed.length, 1);
      assert.deepEqual(printed[0].after.tableReferences, [tableReference]);
      assert.equal(printed[0].actor, staff);

      // 4. Guests are seated; a lost code is replaced for this table only.
      const seated = fresh();
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=version+1, table_snapshot=table_snapshot || jsonb_build_object('activeDiningSessionReference',$2::text,'aggregateVersion',version+1) WHERE table_id=$1",
        [tableReference, seated],
      );
      await admin.query("SET session_replication_role = DEFAULT");
      [row] = await list();
      assert.equal(row.seated, true);
      await assert.rejects(
        command("Issue", { ...row, aggregateVersion: row.aggregateVersion - 1 }),
        /TABLE_QR_CONFLICT/u,
      );
      const replaced = await command("Issue", row);
      assert.equal(replaced.item.codeState, "Active");
      assert.equal(replaced.item.seated, true);
      codes = (await issueRows()).rows;
      assert.deepEqual(
        codes.map((code) => [code.qr_version, code.public_table_id]),
        [
          [1, publicTable],
          [2, publicTable],
        ],
      );
      const secondToken = codes[1].qr_token;
      assert.equal(await retired(firstToken), "Replaced");
      assert.equal((await enter(secondToken)).status, "Verified");
      // The dining session stays on the table; phones admitted with the old code must rescan.
      const table = await transactions.run((tx) =>
        createPostgresDiningTableStore({ run: (w) => w(tx) }, tableScope, references).loadTable(
          tableReference,
        ),
      );
      assert.equal(table.activeDiningSessionReference, seated);
      const oldContext = await transactions.run(async (tx) => {
        const oldIssue = await createPostgresDiningTableQrStore(tx, tableScope).loadByQrReference(
          codes[0].qr_id,
        );
        const registration = {
          payload: JSON.parse(Buffer.from(firstToken.split(".")[1], "base64url").toString()),
          tableReference,
          state: "Enabled",
          contextEvidenceReference: oldIssue.qrReference,
          validFrom: oldIssue.issuedAt,
          validUntil: oldIssue.expiresAt,
        };
        return createConfiguredDiningQrContext({
          binding,
          authorize: async () => true,
          registration,
          authorizeRegistration: async () => true,
          transaction: tx,
          evaluatedAt: now(),
          purpose: "GuestSessionBinding",
        }).resolve(registration.payload);
      });
      assert.equal(oldContext, null);

      // 5. Turn the code off (table out of service), then create a new one later.
      [row] = await list();
      await command("TurnOff", row);
      [row] = await list();
      assert.equal(row.codeState, "TurnedOff");
      assert.equal(await retired(secondToken), "TurnedOff");
      await assert.rejects(
        port.sheet({ ...call, query: { tableReferences: [tableReference] } }),
        /TABLE_QR_CONFLICT/u,
      );
      await command("Issue", row);
      codes = (await issueRows()).rows;
      assert.equal(codes.at(-1).qr_version, 4);
      assert.equal(codes.at(-1).public_table_id, publicTable);
      assert.equal(await retired(secondToken), "Replaced");
      assert.equal((await enter(codes.at(-1).qr_token)).status, "Verified");

      // 6. Audit: every change names the staff member and why.
      const reasons = [
        ...(await audits("DINING_TABLE_ISSUEQR")).rows,
        ...(await audits("DINING_TABLE_REVOKEQR")).rows,
      ].map((audit) => [audit.reason_code, audit.actor]);
      assert.deepEqual(reasons.map(([reason]) => reason).sort(), [
        "TABLE_QR_ISSUED",
        "TABLE_QR_ISSUED",
        "TABLE_QR_REPLACED",
        "TABLE_QR_TURNED_OFF",
      ]);
      assert.ok(reasons.every(([, actor]) => actor === staff));

      // 7. History is append-only, a forged code is refused, a code from elsewhere is not entry.
      await assert.rejects(
        transactions.run((tx) =>
          tx.query("DELETE FROM rms_dining.dining_table_qr_issue WHERE table_id=$1", [
            tableReference,
          ]),
        ),
      );
      await assert.rejects(
        transactions.run((tx) =>
          tx.query("UPDATE rms_dining.dining_table_qr_issue SET key_id='x' WHERE table_id=$1", [
            tableReference,
          ]),
        ),
      );
      const latest = codes.at(-1);
      await assert.rejects(
        transactions.run((tx) =>
          createPostgresDiningTableQrStore(tx, tableScope).recordIssue({
            qrReference: fresh(),
            tableReference,
            publicStoreReference: publicStore,
            publicTableReference: publicTable,
            qrVersion: 5,
            operationReference: fresh(),
            keyId: "test-v1",
            qrToken: latest.qr_token,
            issuedAt: now(),
            expiresAt: now(),
          }),
        ),
      );
      const forged = latest.qr_token.slice(0, -2) + (latest.qr_token.endsWith("AA") ? "BA" : "AA");
      await assert.rejects(enter(forged), /ENTRY_UNAVAILABLE/u);

      // 8. The proposed grants are what make this work: without them nothing is read or kept.
      await assert.rejects(
        runner(matrixOnly).run((tx) =>
          createPostgresDiningTableQrStore(tx, tableScope).loadLatestForTable(tableReference),
        ),
        /permission denied/u,
      );
    } finally {
      await admin.end();
    }
  });
});
