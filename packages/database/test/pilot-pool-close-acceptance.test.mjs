// WP-2423 (ci-brand-startup-cleanup, CI shard 8 2026-11-16) on a real isolated PostgreSQL: the
// brand startup's cleanup found the API role's connections still listed right after the runtime's
// shutdown. pg-pool's end() resolves once it has asked each client to end, before the connections
// close; on a loaded host the database still held them. A closed application database now means
// the database no longer lists any of its connections.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import { createApplicationDatabase } from "../../../tooling/environment/pilot-connections.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const rounds = 200;

it("an application database's close returns only after the database lists none of its connections", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pool_close" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const directory = await realpath(await mkdtemp(join(tmpdir(), "bop-pool-close-")));
    try {
      const role = "wp2423_pc_" + context.runId,
        password = randomBytes(32).toString("hex");
      await admin.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
      );
      await admin.query(`GRANT CONNECT ON DATABASE ${context.clientConfig.database} TO ${role}`);
      const passwordFile = join(directory, "api-password");
      await writeFile(passwordFile, password, { mode: 0o600, flag: "wx" });
      const connection = {
        passwordFile: () => passwordFile,
        host: context.clientConfig.host,
        port: Number(context.clientConfig.port),
        database: context.clientConfig.database,
        user: () => role,
      };
      const listed = async () =>
        (
          await admin.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename=$2",
            [context.clientConfig.database, role],
          )
        ).rows[0].n;
      let stillListed = 0;
      for (let round = 0; round < rounds; round += 1) {
        const database = await createApplicationDatabase("api", connection);
        // Two connections in use at once, as in a request burst (every pool here may open two).
        const held = await Promise.all([database.acquire(), database.acquire()]);
        await Promise.all(held.map((client) => client.query("SELECT pg_sleep(0.005)")));
        for (const client of held) client.release();
        await database.close();
        if ((await listed()) !== 0) stillListed += 1;
        // The next round starts from a database with none of the role's connections.
        for (let wait = 0; wait < 200 && (await listed()) !== 0; wait += 1) await sleep(10);
      }
      assert.equal(
        stillListed,
        0,
        `CLOSED_POOL_CONNECTIONS_STILL_LISTED rounds=${stillListed}/${rounds}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await admin.end();
    }
  });
});
