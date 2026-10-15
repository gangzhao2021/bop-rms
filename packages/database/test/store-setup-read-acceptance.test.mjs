import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantStoreSetup } from "../../../apps/api/src/merchant-store-setup.ts";
import {
  StoreSetupOperationError,
  createUnconfiguredStoreSetupDraftContent,
} from "../../rms/store/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client } = pg;
const id = (n) => "01a7e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q15/Q16: the Owner opens Store setup (where Receipts and privacy lives). The read runs as
 * a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (pilot ACL matrix +
 * additions): an Owner (organization.manage) gets the Store and its setup; a Store Manager without
 * it is refused (403, not 503).
 */
it("WP-2423: the Owner reads Store setup under the pilot API grants", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_setup_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_ss_" + context.runId,
      worker = "wp2423_ss_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
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
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
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
      const scope = { tenantReference: id(3), brandReference: id(1), storeReference: id(2) };
      const now = () => new Date().toISOString();
      let next = 0x100;
      const setupFor = (session) =>
        createMerchantStoreSetup({
          persistence: session.persistence,
          authentication: session.authentication,
          nextReference: () => id(next++),
        });
      const read = (session) =>
        setupFor(session).read({
          sessionCookie: session.sessionCookie,
          expectedStoreReference: scope.storeReference,
        });
      const owner = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: id(10),
        at: now(),
        extraPermissions: ["organization.manage"],
      });
      // Before the store_setup_draft_* api grants this read failed as 503 (permission denied for
      // table store_setup_draft_revision behind STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE).
      const value = await read(owner);
      assert.equal(value.profile, "StoreSetupWorkspaceV1");
      assert.equal(value.store.storeReference, scope.storeReference);
      assert.equal(value.scope.actorReference, id(10));
      assert.equal(value.setup.snapshot, null);

      // The Owner saves a draft on the same page and reads it back.
      const content = {
        ...createUnconfiguredStoreSetupDraftContent(),
        timeZone: { state: "Configured", value: "America/Toronto" },
      };
      const saved = await setupFor(owner).write({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        expectedScope: { ...scope, actorReference: id(10) },
        command: {
          command: "SaveDraft",
          operationReference: id(40),
          expectedSetupReference: null,
          expectedRevision: 0,
          content,
        },
      });
      assert.equal(saved.snapshot.revision, 1);
      const reread = await read(owner);
      assert.equal(reread.setup.snapshot.revision, 1);
      assert.deepEqual(reread.setup.snapshot.content, content);

      const manager = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: id(11),
        at: now(),
        referencePrefix: "01909969",
        sessionReferencePrefix: "01909966",
      });
      await assert.rejects(
        read(manager),
        (error) =>
          error instanceof StoreSetupOperationError &&
          error.code === "STORE_SETUP_OPERATION_PERMISSION_DENIED",
      );
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
});
