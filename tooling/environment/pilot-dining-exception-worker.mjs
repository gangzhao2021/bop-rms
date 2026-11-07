import console from "node:console";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createBackgroundPilotResources } from "./pilot-configured-resources.mjs";
import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { createCompositeWorkerWorkload } from "../../apps/worker/dist/composite-workload.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { createInternalDiningProjection } from "./pilot-dining-projection.mjs";
import { createPilotWorkloadHealthObserver } from "./pilot-workload-health.mjs";
import { reportUnexpected } from "./pilot-unexpected.mjs";
import { createInternalMemberSweep } from "./pilot-member.mjs";
import { memberPointsSweepIntervalMs } from "../../apps/api/dist/member-points-sweep.js";
/** The ledger's agreement checks: a disagreement needs a person (wrong account or a missing fact). */
const LEDGER_DISAGREEMENTS = new Set([
  "OnlineCapturesDisagree",
  "OnlineRefundWithoutCapture",
  "TableRefundWithoutSettlement",
]);
const ledgerRuleOf = (error) => {
  let at = error;
  for (let depth = 0; depth < 8 && at !== null && typeof at === "object"; depth++) {
    if (typeof at.rule === "string" && LEDGER_DISAGREEMENTS.has(at.rule)) return at.rule;
    at = at.cause;
  }
  return null;
};

/**
 * WP-2423 取舍 18, v15 2026-11-06 (points-sweep): points follow refunds and expire after notice, as
 * the dining-exception worker's second supervised workload, with its own health file. A failed sweep
 * is retried and shows in that health (never hidden in a sibling's success): a lost connection is
 * retried every minute and raised once it lasts two minutes; a ledger that disagrees with itself
 * (MEMBER_POINTS_LEDGER_MISMATCH) needs a person at once and is retried every five minutes.
 */
export function createMemberPointsWorkload({
  directory,
  resources,
  providerAccountReference,
  createMemberSweep = createInternalMemberSweep,
  onSnapshot,
  now = Date.now,
}) {
  const store = /(?:^|\/)(stores\/[^/]+)$/u.exec(directory)?.[1];
  let sweep = null;
  let sweptAt = null;
  const loop = createOutboxWorkload({
    pollIntervalMs: 60000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    onSnapshot,
    dispatcher: {
      runOnce: async () => {
        if (resources.publicProfile === undefined) return 0;
        if (sweptAt !== null && now() - sweptAt < memberPointsSweepIntervalMs) return 0;
        const startedAt = now();
        let changed;
        try {
          sweep ??= await createMemberSweep({ directory, resources, providerAccountReference });
          changed = await sweep.settlePoints();
          await sweep.expirePoints();
        } catch (error) {
          reportUnexpected(
            "MEMBER_POINTS_SWEEP_UNAVAILABLE",
            error,
            store === undefined ? {} : { store },
          );
          const rule = ledgerRuleOf(error);
          if (rule === null) throw error;
          throw Object.assign(new Error("MEMBER_POINTS_LEDGER_MISMATCH", { cause: error }), {
            rule,
          });
        }
        sweptAt = startedAt;
        return Number.isSafeInteger(changed) && changed >= 0 ? changed : 0;
      },
      stop: async () => "drained",
    },
  });
  // Its health file exists from the start, before its first cycle (the health reads need it).
  try {
    onSnapshot?.(loop.snapshot());
  } catch {
    /* Diagnostics must not change the workload. */
  }
  return loop;
}

export async function startPilotDiningExceptionWorker({
  directory,
  createResources,
  providerAccountReference,
  createRecovery = createInternalDiningProjection,
  createMemberSweep = createInternalMemberSweep,
  startRuntime = startWorkerRuntime,
}) {
  const resources = await createResources();
  let closing;
  const close = () => (closing ??= Promise.resolve().then(() => resources.close()));
  try {
    const recover = createRecovery({ resources, providerAccountReference });
    const recovery = createOutboxWorkload({
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      // WP-2423 v15: supervised like the other pilot workloads — a failing cycle is retried
      // with backoff (attention when it persists), never stops the worker.
      supervision: supervisedCycleFailures,
      onSnapshot: createPilotWorkloadHealthObserver(directory, "dining-exception-worker"),
      dispatcher: {
        runOnce: async () => {
          const result = await recover();
          if (
            !result ||
            !Number.isSafeInteger(result.projectedCount) ||
            result.projectedCount < 0 ||
            result.projectedCount > 5 ||
            typeof result.scanComplete !== "boolean"
          )
            throw Error("DINING_EXCEPTION_RECOVERY_RESULT_INVALID");
          return result.projectedCount;
        },
        stop: async () => "drained",
      },
    });
    const memberPoints = createMemberPointsWorkload({
      directory,
      resources,
      providerAccountReference,
      createMemberSweep,
      onSnapshot: createPilotWorkloadHealthObserver(directory, "dining-exception-member-points"),
    });
    // One workload for the runtime (the Stores' shared process keeps exactly one per worker).
    const group = createCompositeWorkerWorkload([recovery, memberPoints]);
    await startRuntime({
      workload: {
        completion: group.completion,
        start: () => group.start(),
        stop: async () => {
          try {
            await group.stop();
          } finally {
            await close();
          }
        },
      },
    });
  } catch (error) {
    // v15 2026-10-31: never a silent start failure — its code (no secrets or ids) goes to the log.
    reportUnexpected("DINING_EXCEPTION_WORKER_START_UNAVAILABLE", error);
    await close();
    process.exitCode = 1;
  }
}

export async function startConfiguredDiningExceptionWorker({ directory, startRuntime }) {
  const installation = await loadPilotInstallation(directory);
  const config = await installation.loadDiningExceptionWorker();
  return startPilotDiningExceptionWorker({
    directory,
    ...(startRuntime === undefined ? {} : { startRuntime }),
    providerAccountReference: config.providerAccountReference,
    createResources: async () => {
      const resources = await createBackgroundPilotResources(directory);
      if (
        Object.entries(config.scope).some(
          ([key, value]) => resources.publicProfile.binding[key] !== value,
        )
      ) {
        await resources.close();
        throw Error("DINING_EXCEPTION_WORKER_SCOPE_CHANGED");
      }
      return resources;
    },
  });
}
export function parseDiningExceptionWorkerArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("DINING_EXCEPTION_WORKER_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtimeDirectory = parseDiningExceptionWorkerArguments(process.argv.slice(2));
    const directory = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      runtimeDirectory,
    );
    await startConfiguredDiningExceptionWorker({ directory });
  } catch (error) {
    reportUnexpected("DINING_EXCEPTION_WORKER_START_UNAVAILABLE", error);
    console.error("DINING_EXCEPTION_WORKER_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
