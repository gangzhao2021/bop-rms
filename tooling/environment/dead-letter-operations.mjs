import console from "node:console";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import {
  applyDeadLetterCommand,
  resolveDeadLetter,
} from "../../packages/bop/eventing/src/index.ts";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423: platform support's dead-letter operations until the INT-DEAD-LETTER console has platform
 * sign-in (Cognito, an external gate). Every action is recorded in `dead_letter_action` with the
 * operator, permission, purpose and reason; a retry reuses the event's own idempotency so a consumer
 * never applies it twice.
 *
 *   list    --env-file                                              open items (no payloads)
 *   retry   --env-file --confirm-target --operator --consumer [--since YYYY-MM-DD]
 *           consumer-path items of one consumer, after their cause is fixed (DEPENDENCY_RECOVERED)
 *   discard --env-file --confirm-target --operator --dead-letter     AUTHORIZED_DISCARD of one item
 *   resolve --env-file --confirm-target --operator                   closes retries that completed
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const consumerName = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const shapes = {
  list: ["--env-file"],
  retry: ["--env-file", "--confirm-target", "--operator", "--consumer"],
  discard: ["--env-file", "--confirm-target", "--operator", "--dead-letter"],
  resolve: ["--env-file", "--confirm-target", "--operator"],
};
const optional = { retry: ["--since"] };

export function parseDeadLetterArguments(args) {
  const [command, ...rest] = args;
  const required = shapes[command];
  if (required === undefined)
    throw new Error("usage: dead-letter-operations list|retry|discard|resolve");
  const allowed = [...required, ...(optional[command] ?? [])];
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw new Error(`usage: dead-letter-operations ${command} ${allowed.join(" ")}`);
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag)))
    throw new Error(`usage: dead-letter-operations ${command} ${allowed.join(" ")}`);
  if (values.has("--operator") && !uuid.test(values.get("--operator")))
    throw new Error("DEAD_LETTER_OPERATOR_INVALID");
  if (values.has("--dead-letter") && !uuid.test(values.get("--dead-letter")))
    throw new Error("DEAD_LETTER_REFERENCE_INVALID");
  if (values.has("--consumer") && !consumerName.test(values.get("--consumer")))
    throw new Error("DEAD_LETTER_CONSUMER_INVALID");
  if (values.has("--since") && !/^\d{4}-\d{2}-\d{2}$/u.test(values.get("--since")))
    throw new Error("DEAD_LETTER_SINCE_INVALID");
  return { command, get: (flag) => values.get(flag) ?? null };
}

async function withClient(get, work, confirm) {
  const config = await loadMigrationConnectionConfig(root, get("--env-file"));
  if (confirm && get("--confirm-target") !== `${config.environment}:${config.database}`)
    throw new Error("DEAD_LETTER_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-dead-letter-operations",
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
const itemsSql = `SELECT d.dead_letter_id::text id,d.brand_id::text brand,d.store_id::text store,d.delivery_path path,
   d.consumer_name consumer,o.event_type,d.failure_class,d.safe_code,d.attempt_count,d.status,d.version::text version,
   to_char(d.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') opened_at
 FROM platform_eventing.dead_letter_item d JOIN platform_eventing.outbox_event o ON o.event_id=d.event_id`;
/** One transaction per item: a failure leaves the others as they are. */
async function each(client, rows, work) {
  const results = [];
  for (const row of rows) {
    await client.query("BEGIN");
    try {
      const outcome = await work(row);
      await client.query("COMMIT");
      results.push({ id: row.id, outcome });
    } catch (error) {
      await client.query("ROLLBACK");
      results.push({ id: row.id, outcome: "failed", code: error?.code ?? error?.name ?? "ERROR" });
    }
  }
  return results;
}
const command = (row, operator, action, reason) => ({
  deadLetterId: row.id,
  brandId: row.brand,
  ...(row.store === null ? {} : { storeId: row.store }),
  actorId: operator,
  permission: action === "retry" ? "EVENTING_DEAD_LETTER_RETRY" : "EVENTING_DEAD_LETTER_DISCARD",
  purpose: "RELIABILITY_RECOVERY",
  reason,
  expectedVersion: BigInt(row.version),
  // The same request repeated is recognised; a later request after a new failure is a new action.
  idempotencyKey: uuidV7(),
  actionId: uuidV7(),
});

export async function runDeadLetterOperations(args) {
  const { command: name, get } = parseDeadLetterArguments(args);
  if (name === "list")
    return withClient(
      get,
      async (client) =>
        (
          await client.query(
            `${itemsSql} WHERE d.status IN ('open','retry_scheduled') ORDER BY d.opened_at`,
          )
        ).rows,
      false,
    );
  const operator = get("--operator");
  return withClient(
    get,
    async (client) => {
      if (name === "retry") {
        const rows = (
          await client.query(
            `${itemsSql} WHERE d.status='open' AND d.delivery_path='consumer' AND d.consumer_name=$1
               AND ($2::date IS NULL OR d.opened_at>=$2::date) ORDER BY d.opened_at`,
            [get("--consumer"), get("--since")],
          )
        ).rows;
        return each(client, rows, (row) =>
          applyDeadLetterCommand(
            client,
            "retry",
            command(row, operator, "retry", "DEPENDENCY_RECOVERED"),
          ),
        );
      }
      if (name === "discard") {
        const rows = (
          await client.query(`${itemsSql} WHERE d.dead_letter_id=$1 AND d.status='open'`, [
            get("--dead-letter"),
          ])
        ).rows;
        if (rows.length !== 1) throw new Error("DEAD_LETTER_NOT_OPEN");
        return each(client, rows, (row) =>
          applyDeadLetterCommand(
            client,
            "discard",
            command(row, operator, "discard", "AUTHORIZED_DISCARD"),
          ),
        );
      }
      // resolve: retries whose consumer has now completed the event.
      const rows = (
        await client.query(
          `${itemsSql} JOIN platform_eventing.consumer_retry_schedule s ON s.event_id=d.event_id AND s.consumer_name=d.consumer_name
           WHERE d.status='retry_scheduled' AND s.state='completed' ORDER BY d.opened_at`,
        )
      ).rows;
      return each(client, rows, (row) =>
        resolveDeadLetter(
          client,
          "retry_completed",
          command(row, operator, "retry", "DEPENDENCY_RECOVERED"),
        ),
      );
    },
    true,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runDeadLetterOperations(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "DEAD_LETTER_OPERATION_FAILED");
    process.exitCode = 1;
  }
}
