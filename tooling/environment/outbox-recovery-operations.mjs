import console from "node:console";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createManualOutboxRecoveryExecution,
  createManualOutboxRecoveryStore,
} from "../../packages/bop/eventing/src/index.ts";
import { createManualOutboxRecoveryExecutor } from "../../apps/worker/dist/manual-outbox-recovery-executor.js";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import { composeConfiguredBusinessWorker } from "./pilot-business-composition.mjs";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423: manual recovery of Outbox events that exhausted their eight automatic deliveries
 * (pilot-exhausted-event-recovery design, WP-0033). Run inside the pilot image after the cause is
 * fixed. For each open exhausted Outbox dead letter of the pilot Store, in aggregate order, it
 * schedules one recovery recorded against the operator (reason DEPENDENCY_RECOVERED) and performs
 * the single permitted handoff through the business worker's own consumer transport and registry.
 * Consumers that already completed the event acknowledge it as a duplicate; only a full
 * acknowledgement publishes the event and resolves its dead letter. The worker composition is
 * built but never started.
 *
 * TEST-ONLY authority: until platform sign-in exists (Cognito, an external gate), the operator
 * acts through the pilot runtime credential; the named operator is recorded on every action.
 *
 *   recover --operator <uuid> [--dead-letter <uuid>]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseOutboxRecoveryArguments(args) {
  const [command, ...rest] = args;
  if (command !== "recover") throw new Error("usage: outbox-recovery-operations recover");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      !["--operator", "--dead-letter"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      !uuid.test(value)
    )
      throw new Error(
        "usage: outbox-recovery-operations recover --operator <uuid> [--dead-letter <uuid>]",
      );
    values.set(flag, value);
  }
  if (!values.has("--operator"))
    throw new Error(
      "usage: outbox-recovery-operations recover --operator <uuid> [--dead-letter <uuid>]",
    );
  return { operator: values.get("--operator"), deadLetter: values.get("--dead-letter") ?? null };
}

/** Open exhausted Outbox items of the Store, earliest aggregate version first. */
const candidatesSql = `SELECT d.dead_letter_id::text id, d.version::text version
  FROM platform_eventing.dead_letter_item d JOIN platform_eventing.outbox_event o ON o.event_id=d.event_id
  WHERE d.brand_id=$1 AND d.store_id IS NOT DISTINCT FROM $2 AND d.delivery_path='outbox'
    AND d.status='open' AND d.failure_class='exhausted'
    AND d.safe_code IN ('TRANSPORT_UNAVAILABLE','TRANSPORT_TIMEOUT')
    AND ($3::uuid IS NULL OR d.dead_letter_id=$3::uuid)
  ORDER BY o.aggregate_type, o.aggregate_id, o.aggregate_version, o.event_id`;

export async function runOutboxRecovery(args, environment = process.env) {
  const { operator, deadLetter } = parseOutboxRecoveryArguments(args);
  const directory = path.join(root, environment.PILOT_RUNTIME_DIRECTORY ?? "");
  const installation = await loadPilotInstallation(directory);
  const config = await installation.loadBusinessWorker();
  const resources = await createConfiguredPilotResources(directory);
  try {
    const worker = await composeConfiguredBusinessWorker({ directory, installation, config })(
      resources,
      {},
      {},
    );
    const scope = Object.freeze({
      brandId: resources.scope.brandReference,
      storeId: resources.scope.storeReference,
    });
    const common = {
      scope,
      transactions: resources.transactions,
      // The operator, permission and purpose recorded on the request are the ones this run acts for.
      authorizeAndFence: async (_tx, command) =>
        command.actorId === operator &&
        command.permission === "EVENTING_DEAD_LETTER_RETRY" &&
        command.purpose === "RELIABILITY_RECOVERY",
      generateReference: uuidV7,
      now: resources.now,
    };
    const store = createManualOutboxRecoveryStore({
      ...common,
      registryDigest: worker.recoveryRegistry.digest,
    });
    const executor = createManualOutboxRecoveryExecutor({
      scope,
      registryDigest: worker.recoveryRegistry.digest,
      execution: createManualOutboxRecoveryExecution({
        ...common,
        registry: worker.recoveryRegistry,
        leaseOwner: "outbox-recovery-operations",
      }),
      adapter: worker.recoveryAdapter,
      adapterTimeoutMs: 20000,
      now: () => Date.now(),
    });
    const candidates = await resources.transactions.run(
      async (tx) =>
        (await tx.query(candidatesSql, [scope.brandId, scope.storeId, deadLetter])).rows,
    );
    const results = [];
    for (const item of candidates) {
      try {
        const scheduled = await store.schedule({
          deadLetterId: item.id,
          brandId: scope.brandId,
          storeId: scope.storeId,
          actorId: operator,
          permission: "EVENTING_DEAD_LETTER_RETRY",
          purpose: "RELIABILITY_RECOVERY",
          reason: "DEPENDENCY_RECOVERED",
          expectedVersion: BigInt(item.version),
          idempotencyKey: uuidV7(),
          actionId: uuidV7(),
        });
        const outcome = await executor.run(scheduled.recoveryReference);
        const status = await resources.transactions.run(
          async (tx) =>
            (
              await tx.query(
                "SELECT status FROM platform_eventing.dead_letter_item WHERE dead_letter_id=$1",
                [item.id],
              )
            ).rows[0]?.status ?? null,
        );
        results.push({ id: item.id, outcome, status });
      } catch (error) {
        results.push({
          id: item.id,
          outcome: "failed",
          code: error?.code ?? error?.message ?? "ERROR",
        });
      }
    }
    return results;
  } finally {
    await resources.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runOutboxRecovery(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OUTBOX_RECOVERY_FAILED");
    process.exitCode = 1;
  }
}
