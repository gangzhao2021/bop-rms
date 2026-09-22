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
/** Process recovery only. Start performs authoritative identity/terminal checks.
 * Health failures never authorize terminating or replacing a live process. */
export function createPilotRecoverySweep({
  runtimeDirectory,
  service = runPilotService,
  now = Date.now,
}) {
  const directory = parsePilotRuntimeDirectory(runtimeDirectory);
  const states = new Map(
    services.map((name) => [name, { attempts: 0, retryAt: 0, runningSince: null, pid: null }]),
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
        }
        results.push({ service: name, state: "running", pid: observed.pid });
        continue;
      }
      if (signal?.aborted) break;
      state.runningSince = null;
      state.pid = null;
      if (state.attempts >= 3) {
        results.push({ service: name, state: "attention_required" });
        continue;
      }
      if (at < state.retryAt) {
        results.push({ service: name, state: "backoff" });
        continue;
      }
      state.attempts++;
      state.retryAt = at + 5000 * 2 ** (state.attempts - 1);
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
        results.push({ service: name, state: "unavailable" });
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
