import { runPilotService, parsePilotRuntimeDirectory } from "./pilot-service.mjs";
const services = Object.freeze([
  "api",
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "daily-settlement-worker",
  "dining-exception-worker",
  "customer",
]);
const workers = new Set([
  "business-worker",
  "kitchen-queue-worker",
  "reconciliation-worker",
  "daily-settlement-worker",
  "dining-exception-worker",
]);
/** After three failed starts the service is reported attention_required, and start is still tried
 * at this slower pace: a store recovers by itself once the database or host is back. */
const EXHAUSTED_RETRY_MS = 60_000;
/** Workloads whose health is alert-worthy (attention_required, failed or failing persistently). */
function attentionComponents(health) {
  if (
    health &&
    typeof health === "object" &&
    health.workloads &&
    typeof health.workloads === "object"
  )
    return Object.entries(health.workloads)
      .filter(([, value]) => value?.attention === true)
      .map(([name]) => name)
      .sort();
  return health?.attention === true ? ["workload"] : [];
}
/** Process recovery only. Start performs authoritative identity/terminal checks.
 * Health failures never authorize terminating or replacing a live process; with `workloadHealth`
 * (the supervisor), a running worker's alert-worthy workloads are reported as `attention`. */
export function createPilotRecoverySweep({
  runtimeDirectory,
  service = runPilotService,
  now = Date.now,
  workloadHealth = null,
}) {
  const directory = parsePilotRuntimeDirectory(runtimeDirectory);
  const states = new Map(
    services.map((name) => [
      name,
      { attempts: 0, retryAt: 0, exhaustedRetryAt: null, runningSince: null, pid: null },
    ]),
  );
  let pending = null,
    lastNow = -Infinity;
  const run = async (signal) => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || at < lastNow)
      throw Error("PILOT_RECOVERY_CLOCK_INVALID");
    lastNow = at;
    const results = [];
    for (const name of services) {
      if (signal?.aborted) break;
      const state = states.get(name);
      let observed;
      try {
        observed = await service("status", name, directory);
      } catch {
        observed = null;
      }
      if (
        observed?.state === "running" &&
        observed.service === name &&
        Number.isSafeInteger(observed.pid) &&
        observed.pid > 0
      ) {
        if (state.pid !== observed.pid) {
          state.runningSince = at;
          state.pid = observed.pid;
        }
        state.runningSince ??= at;
        if (at - state.runningSince >= 60000) {
          state.attempts = 0;
          state.retryAt = 0;
          state.exhaustedRetryAt = null;
        }
        const running = { service: name, state: "running", pid: observed.pid };
        if (workloadHealth !== null && workers.has(name)) {
          try {
            const attention = attentionComponents(
              await service("health", name, directory, await workloadHealth(name)),
            );
            if (attention.length > 0) running.attention = attention;
          } catch {
            // Starting up or unreadable: reported, never used to stop or replace the process.
            running.health = "unavailable";
          }
        }
        results.push(running);
        continue;
      }
      if (signal?.aborted) break;
      state.runningSince = null;
      state.pid = null;
      const exhausted = state.attempts >= 3;
      if (exhausted) {
        state.exhaustedRetryAt ??= at + EXHAUSTED_RETRY_MS;
        if (at < state.exhaustedRetryAt) {
          results.push({ service: name, state: "attention_required" });
          continue;
        }
        state.exhaustedRetryAt = at + EXHAUSTED_RETRY_MS;
      } else if (at < state.retryAt) {
        results.push({ service: name, state: "backoff" });
        continue;
      } else {
        state.attempts++;
        state.retryAt = at + 5000 * 2 ** (state.attempts - 1);
      }
      try {
        // Never use restart: start rechecks /proc and adopts a matching existing worker.
        const result = await service("start", name, directory);
        if (
          !["started", "running"].includes(result?.state) ||
          result.service !== name ||
          !Number.isSafeInteger(result.pid) ||
          result.pid < 1
        )
          throw Error("PILOT_RECOVERY_UNAVAILABLE");
        state.runningSince = at;
        state.pid = result.pid;
        results.push({ service: name, state: result.state, pid: result.pid });
      } catch {
        results.push({ service: name, state: exhausted ? "attention_required" : "unavailable" });
      }
    }
    return Object.freeze(results.map(Object.freeze));
  };
  return Object.freeze({
    sweep({ signal } = {}) {
      if (pending) return pending;
      pending = run(signal).finally(() => {
        pending = null;
      });
      return pending;
    },
  });
}
