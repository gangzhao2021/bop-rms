import console from "node:console";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import { expediteConsumerRetries } from "../../packages/bop/eventing/src/index.ts";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423: platform support's "retry now" for consumer retries still waiting out their backoff.
 * After the cause of a failure is fixed, a retry can wait up to 30 minutes (retry policy v2) before
 * its next delivery, keeping the monitor's "Some order updates are being retried" alert up. This
 * brings those retries forward to now so the retry worker delivers them on its next pass.
 *
 *   list      --env-file                                         pending consumer retries (no payloads)
 *   retry-now --env-file --confirm-target --operator (--consumer <name> | --all) [--dry-run]
 *
 * retry-now moves only retries that are scheduled and due later; a retry being delivered (claimed)
 * is left alone. Only the due time changes: event, attempt count, deadline and payload stay. Every
 * retry moved is recorded in `consumer_retry_expedite_action` with the operator, permission
 * EVENTING_DEAD_LETTER_RETRY, purpose RELIABILITY_RECOVERY and reason DEPENDENCY_RECOVERED.
 * --dry-run lists what would move and writes nothing.
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const consumerName = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const shapes = {
  list: { required: ["--env-file"], optional: [], switches: [] },
  "retry-now": {
    required: ["--env-file", "--confirm-target", "--operator"],
    optional: ["--consumer"],
    switches: ["--all", "--dry-run"],
  },
};

export function parseConsumerRetryArguments(args) {
  const [command, ...rest] = args;
  const shape = shapes[command];
  if (shape === undefined) throw new Error("usage: consumer-retry-operations list|retry-now");
  const usage = `usage: consumer-retry-operations ${command} ${[
    ...shape.required,
    ...shape.optional,
    ...shape.switches,
  ].join(" ")}`;
  const values = new Map();
  const switches = new Set();
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (shape.switches.includes(flag)) {
      if (switches.has(flag)) throw new Error(usage);
      switches.add(flag);
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (
      ![...shape.required, ...shape.optional].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw new Error(usage);
    values.set(flag, value);
    index += 2;
  }
  if (
    shape.required.some((flag) => !values.has(flag)) ||
    (command === "retry-now" && values.has("--consumer") === switches.has("--all"))
  )
    throw new Error(usage);
  if (values.has("--operator") && !uuid.test(values.get("--operator")))
    throw new Error("CONSUMER_RETRY_OPERATOR_INVALID");
  if (values.has("--consumer") && !consumerName.test(values.get("--consumer")))
    throw new Error("CONSUMER_RETRY_CONSUMER_INVALID");
  return {
    command,
    get: (flag) => values.get(flag) ?? null,
    has: (flag) => switches.has(flag),
  };
}

async function withClient(get, work, confirm) {
  const config = await loadMigrationConnectionConfig(root, get("--env-file"));
  if (confirm && get("--confirm-target") !== `${config.environment}:${config.database}`)
    throw new Error("CONSUMER_RETRY_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-consumer-retry-operations",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const pendingSql = `SELECT s.schedule_id::text id,s.brand_id::text brand,s.store_id::text store,
   s.consumer_name consumer,o.event_type,s.state,s.attempt_count,
   to_char(s.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') available_at,
   to_char(s.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') deadline_at
 FROM platform_eventing.consumer_retry_schedule s
 JOIN platform_eventing.outbox_event o ON o.event_id=s.event_id
 WHERE s.state IN ('scheduled','claimed')
 ORDER BY s.available_at, s.schedule_id`;

export const scopesSql = `SELECT DISTINCT brand_id brand, store_id store
 FROM platform_eventing.consumer_retry_schedule
 WHERE state='scheduled' AND available_at>statement_timestamp()
   AND ($1::text IS NULL OR consumer_name=$1)
 ORDER BY brand_id, store_id`;

export async function runConsumerRetryOperations(args) {
  const { command: name, get, has } = parseConsumerRetryArguments(args);
  if (name === "list")
    return withClient(get, async (client) => (await client.query(pendingSql)).rows, false);
  const consumer = get("--consumer");
  const dryRun = has("--dry-run");
  return withClient(
    get,
    async (client) => {
      const scopes = (await client.query(scopesSql, [consumer])).rows;
      const results = [];
      // One transaction per Brand/Store scope: a failure leaves the other scopes as they are.
      for (const scope of scopes) {
        await client.query("BEGIN");
        try {
          await client.query("SELECT set_config('bop.brand_id', $1, true)", [scope.brand]);
          await client.query("SELECT set_config('bop.store_id', $1, true)", [scope.store ?? ""]);
          const outcome = await expediteConsumerRetries(client, {
            brandId: scope.brand,
            ...(scope.store === null ? {} : { storeId: scope.store }),
            consumerName: consumer,
            actorId: get("--operator"),
            permission: "EVENTING_DEAD_LETTER_RETRY",
            purpose: "RELIABILITY_RECOVERY",
            reason: "DEPENDENCY_RECOVERED",
            // Each run is one request; a later run after a new failure is a new request.
            idempotencyKey: uuidV7(),
            dryRun,
            actionId: () => uuidV7(),
          });
          await client.query(dryRun ? "ROLLBACK" : "COMMIT");
          results.push({ brand: scope.brand, store: scope.store, ...outcome });
        } catch (error) {
          await client.query("ROLLBACK");
          results.push({
            brand: scope.brand,
            store: scope.store,
            status: "failed",
            code: error?.code ?? error?.name ?? "ERROR",
          });
        }
      }
      return results;
    },
    true,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runConsumerRetryOperations(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CONSUMER_RETRY_OPERATION_FAILED");
    process.exitCode = 1;
  }
}
