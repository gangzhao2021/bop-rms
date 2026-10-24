import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { prepareCurrentEntryProfile } from "../test-support/current-entry-profile.mjs";
import { exercisePersistentProfileEntry } from "../test-support/persistent-profile-entry.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// WP-2423 DEC-DINING-GUEST-INVITATION (v15 8c4480dd H1): the real path. A guest enters by the
// table QR, joins with the staff code and binds over HTTP; the Host then reads and issues through
// the pilot's own invitation composition served by createLocalCustomerRuntime, as the restricted
// NOBYPASSRLS role with the rendered pilot api grants. Before the fix every read returned 404.
it("lets the joined Host make a code over the composed API that seats the next guest once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_invite_http" }, async (env) => {
    const client = new pg.Client(env.clientConfig);
    await client.connect();
    const role = "wp2423ih_" + env.runId;
    try {
      await client.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await client.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await client.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);

      await client.query(
        "GRANT USAGE ON SCHEMA rms_store,platform_helpers,platform_audit TO " + role,
      );
      await client.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_store.public_store_profile_version TO " + role,
      );
      await client.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_record,platform_audit.audit_chain_head TO " +
          role,
      );
      // Independent reads may run concurrently; never share transaction context.
      const run = async (work) => {
        const connection = new pg.Client({
          ...env.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await connection.connect();
        try {
          await connection.query("BEGIN");
          await connection.query("SET LOCAL ROLE " + role);
          await connection.query("SET LOCAL statement_timeout='5s'");
          await connection.query("SET LOCAL lock_timeout='5s'");
          const result = await work({
            query: (sql, values) => connection.query(sql, [...values]),
          });
          await connection.query("COMMIT");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          await connection.end();
        }
      };

      await client.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_store.public_store_profile_timing TO " + role,
      );
      let activeWorkerConnections = 0;
      const acquire = async () => {
        const connection = new pg.Client({
          ...env.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await connection.connect();
        try {
          await connection.query("SET ROLE " + role);
          await connection.query("SET statement_timeout='5s'");
          await connection.query("SET lock_timeout='5s'");
        } catch (error) {
          await connection.end();
          throw error;
        }
        activeWorkerConnections++;
        let released = false;
        return {
          query: (sql, values) => connection.query(sql, [...values]),
          release: async () => {
            if (released) return;
            released = true;
            try {
              await connection.end();
            } finally {
              activeWorkerConnections--;
            }
          },
        };
      };
      const at = new Date(Date.now() - 1000).toISOString();
      const publicOptions = await prepareCurrentEntryProfile({ admin: client, role, run, at });
      const journey = await exercisePersistentProfileEntry({
        admin: client,
        role,
        run,
        publicOptions,
        at,
        currentClock: true,
        acquire,
        diningInvitation: true,
      });
      await journey.close();
      assert.equal(activeWorkerConnections, 0);
    } finally {
      await client.end();
    }
  });
});
