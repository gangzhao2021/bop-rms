import console from "node:console";
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadOutboxEnvelope } from "../../packages/bop/eventing/src/index.ts";
import {
  loadOrderCanonicalPhase,
  orderKitchenProgressConsumerName,
  orderKitchenProgressEventTypes,
} from "../../packages/rms/ordering/src/index.ts";
import { createInternalOrderProgressConsumers } from "./pilot-order-progress-consumers.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";

const rolledBack = Symbol("ORDER_PROGRESS_CATCH_UP_DRY_RUN");

async function scoped(transaction, scope) {
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
}

/** Published Kitchen progress events of this Store that Ordering's consumer has not recorded. */
async function pendingEvents(transaction, scope) {
  await scoped(transaction, scope);
  const found = await transaction.query(
    "SELECT o.event_id::text AS event_id FROM platform_eventing.outbox_event o " +
      "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.event_type=ANY($3::text[]) AND o.published_at IS NOT NULL " +
      "AND NOT EXISTS (SELECT 1 FROM platform_eventing.consumer_inbox i WHERE i.consumer_name=$4 AND i.event_id=o.event_id) " +
      "ORDER BY o.recorded_at,o.event_id LIMIT 100001",
    [
      scope.brandReference,
      scope.storeReference,
      [...orderKitchenProgressEventTypes],
      orderKitchenProgressConsumerName,
    ],
  );
  if (found.rows.length > 100000) throw new Error("ORDER_PROGRESS_CATCH_UP_TOO_MANY");
  return found.rows.map((row) => row.event_id);
}

/** Each Order's guest-status projection phase and the phase Ordering now merges for it. */
async function phases(transaction, scope) {
  await scoped(transaction, scope);
  const orders = await transaction.query(
    "SELECT h.order_id::text AS order_id,h.order_type,g.projection_snapshot_json->>'canonicalPhase' AS projected " +
      "FROM rms_ordering.order_header h LEFT JOIN rms_ordering.order_status_projection p " +
      "ON p.order_id=h.order_id AND p.brand_id=h.brand_id AND p.store_id=h.store_id " +
      "LEFT JOIN rms_ordering.order_status_projection_generation g ON g.generation_id=p.generation_id " +
      "WHERE h.brand_id=$1 AND h.store_id=$2 ORDER BY h.created_at,h.order_id",
    [scope.brandReference, scope.storeReference],
  );
  const result = new Map();
  for (const row of orders.rows) {
    const merged = await loadOrderCanonicalPhase(transaction, scope, row.order_id);
    result.set(row.order_id, {
      orderType: row.order_type,
      projected: row.projected ?? null,
      merged: merged?.canonicalPhase ?? null,
    });
  }
  return result;
}

function summarize(before, after) {
  const byType = {};
  let changedByCatchUp = 0;
  for (const [order, value] of after) {
    const key = value.orderType + " " + (value.projected ?? "none") + " -> " + value.merged;
    byType[key] = (byType[key] ?? 0) + 1;
    if (before.get(order)?.merged !== value.merged) changedByCatchUp += 1;
  }
  return { phaseChanges: byType, ordersChangedByCatchUp: changedByCatchUp };
}

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01 catch-up (v15 use): Kitchen events published before
 * Ordering's `ordering.kitchen-progress:v1` consumer existed are replayed from the outbox through
 * that same consumer, so the inbox makes it idempotent (a second run finds nothing pending).
 * dryRun runs everything in one transaction and rolls it back, reporting what would change.
 */
export async function catchUpOrderKitchenProgress({ resources, dryRun, consumers }) {
  const scope = resources.scope;
  const byType = new Map(consumers.map((consumer) => [consumer.registration.eventType, consumer]));
  const replay = async (transaction, eventId) => {
    await scoped(transaction, scope);
    const envelope = await loadOutboxEnvelope(transaction, eventId);
    const consumer = envelope && byType.get(envelope.eventType);
    if (!consumer) throw new Error("ORDER_PROGRESS_CATCH_UP_EVENT_UNAVAILABLE");
    return consumer.consume(transaction, envelope);
  };
  if (dryRun) {
    let report;
    try {
      await resources.transactions.run(async (transaction) => {
        const before = await phases(transaction, scope);
        const pending = await pendingEvents(transaction, scope);
        const outcomes = {};
        for (const eventId of pending) {
          await transaction.query("SAVEPOINT order_progress_catch_up", []);
          let status;
          try {
            status = (await replay(transaction, eventId)).status;
            await transaction.query("RELEASE SAVEPOINT order_progress_catch_up", []);
          } catch {
            await transaction.query("ROLLBACK TO SAVEPOINT order_progress_catch_up", []);
            status = "failed";
          }
          outcomes[status] = (outcomes[status] ?? 0) + 1;
        }
        const after = await phases(transaction, scope);
        report = {
          mode: "dry-run (rolled back)",
          pendingEvents: pending.length,
          outcomes,
          ...summarize(before, after),
        };
        throw rolledBack;
      });
    } catch (error) {
      if (error !== rolledBack) throw error;
    }
    return report;
  }
  const before = await resources.transactions.run((transaction) => phases(transaction, scope));
  const pending = await resources.transactions.run((transaction) =>
    pendingEvents(transaction, scope),
  );
  const outcomes = {};
  for (const eventId of pending) {
    let status;
    try {
      status = (await resources.transactions.run((transaction) => replay(transaction, eventId)))
        .status;
    } catch {
      status = "failed";
    }
    outcomes[status] = (outcomes[status] ?? 0) + 1;
  }
  const after = await resources.transactions.run((transaction) => phases(transaction, scope));
  return { mode: "apply", pendingEvents: pending.length, outcomes, ...summarize(before, after) };
}

export function parseCatchUpArguments(argv) {
  const [directory, flag, ...rest] = argv;
  if (
    typeof directory !== "string" ||
    !directory.startsWith(".local/") ||
    rest.length !== 0 ||
    (flag !== "--dry-run" && flag !== "--apply")
  )
    throw new Error("ORDER_PROGRESS_CATCH_UP_ARGUMENTS");
  return { directory, dryRun: flag === "--dry-run" };
}

async function main() {
  const { createConfiguredPilotResources } = await import("./pilot-configured-resources.mjs");
  let resources;
  try {
    if (!isPilotRuntime()) throw new Error("UNAVAILABLE");
    const { directory, dryRun } = parseCatchUpArguments(process.argv.slice(2));
    resources = await createConfiguredPilotResources(path.resolve(directory));
    const report = await catchUpOrderKitchenProgress({
      resources,
      dryRun,
      consumers: createInternalOrderProgressConsumers(resources),
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("ORDER_PROGRESS_CATCH_UP_UNAVAILABLE", error?.message ?? "");
    process.exitCode = 1;
  } finally {
    await resources?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
