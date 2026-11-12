import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  allServices,
  createPilotRecoverySweep,
  storeWorkerServices,
} from "./pilot-recovery-sweep.mjs";
import { readHostedStoreHealth, readHostedStoreLiveness } from "./pilot-workload-health.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";
import { admitConfiguredStores } from "./pilot-admitted-stores.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import {
  assertPilotReady,
  checkConfiguredPilotCapabilities,
  currentPilotEnvironment,
  isPilotRuntime,
  isPilotStore,
} from "./pilot-environment.mjs";
import { pilotPaymentProviderReady } from "./pilot-payment-config.mjs";
import { readPilotStaffSignInReadiness } from "./pilot-staff-sign-in.mjs";
import { SUPERVISOR_HEALTH_FILE, writePrivateJson } from "./pilot-ops-files.mjs";
export async function acquirePilotSupervisorLease(runtimeDirectory) {
  const root = await fs.realpath(process.cwd());
  const directory = path.join(root, parsePilotRuntimeDirectory(runtimeDirectory));
  const stat = await fs.lstat(directory);
  if (
    process.platform !== "linux" ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw Error("PILOT_SUPERVISOR_DIRECTORY_INVALID");
  const file = path.join(directory, "supervisor.lock");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    try {
      await fs.lstat(path.join(directory, "maintenance.lock"));
      throw Error("PILOT_MAINTENANCE_IN_PROGRESS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const service of [
      "api",
      "customer",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
      "store-workers",
    ]) {
      try {
        await fs.lstat(path.join(directory, `${service}.restart-lock`));
        throw Error("PILOT_MAINTENANCE_IN_PROGRESS");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const selfStat = await fs.readFile("/proc/self/stat", "utf8");
    const started = selfStat
      .slice(selfStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, started, startedAt: new Date().toISOString() }) + "\n",
    );
  } catch (error) {
    await handle.close();
    await fs.unlink(file);
    throw error;
  }
  const owned = await handle.stat();
  let released = false;
  return async () => {
    if (released) return;
    const current = await fs.lstat(file);
    if (current.dev !== owned.dev || current.ino !== owned.ino)
      throw Error("PILOT_SUPERVISOR_LEASE_CHANGED");
    await fs.unlink(file);
    await handle.close();
    released = true;
  };
}
/** Which optional business workloads report health, from the installed worker configuration. */
export function createPilotWorkloadHealthOptions(
  runtimeDirectory,
  read = (file) => fs.readFile(file, "utf8"),
) {
  const directory = parsePilotRuntimeDirectory(runtimeDirectory);
  return async (service) => {
    if (service !== "business-worker") return {};
    const config = JSON.parse(await read(path.join(directory, "business-worker.json")));
    return {
      requireBatchCancellation: config?.workloads?.batchCancellation === true,
      requireCompensation: config?.workloads?.compensation === true,
    };
  };
}
/** WP-2423 pilot resilience: one alert line whenever the set of services or workloads needing a
 * person changes (names only), besides the full snapshot on every sweep. */
export function createPilotAttentionReporter(write = (line) => process.stderr.write(line)) {
  let previous = "[]";
  return (snapshot) => {
    const needs = snapshot.services
      .flatMap((entry) => [
        // DEC-WORKER-HEALTH-TRUTH: a Store's worker that is not running needs a person too.
        ...(entry.state === "attention_required" || entry.state === "down" ? [entry.service] : []),
        ...(entry.attention ?? []).map((component) => entry.service + ":" + component),
      ])
      .sort();
    const current = JSON.stringify(needs);
    if (current === previous) return;
    previous = current;
    write(
      JSON.stringify({
        level: needs.length > 0 ? 50 : 30,
        time: snapshot.observedAt,
        event: needs.length > 0 ? "pilot_attention_required" : "pilot_attention_cleared",
        attention: needs,
      }) + "\n",
    );
  };
}
/**
 * WP-2423 (guest-table-open-and-busy-reads, v15 2026-11-12): a part of a running worker is named
 * as needing a person only when two sweeps in a row (5 s apart) find its health report missing or
 * stale. A healthy part whose report was written a moment late (the host busy, an image being
 * built) raised a level-50 pilot_attention_required that cleared on the next sweep, so staff and
 * the operations monitor learned to ignore it. A part that really stopped reporting is named on
 * the second sweep, 5 s later; a whole service that is down or refused is named at once, as before.
 */
export function createPilotAttentionConfirmation() {
  let seen = new Map();
  return (snapshot) => {
    const next = new Map();
    const services = snapshot.services.map((entry) => {
      if (!Array.isArray(entry.attention)) return entry;
      const before = seen.get(entry.service) ?? [];
      next.set(entry.service, entry.attention);
      const confirmed = entry.attention.filter((component) => before.includes(component));
      const { attention, ...rest } = entry;
      void attention;
      return confirmed.length === 0 ? rest : { ...rest, attention: confirmed };
    });
    seen = next;
    return { ...snapshot, services };
  };
}
/** WP-2423 Q13: the latest sweep as a private file, so the separate operations monitor can alert
 * on services needing a person and notice when the supervisor itself stops (names and states only). */
export function createPilotSupervisorHealthWriter(
  runtimeDirectory,
  write = writePrivateJson,
  report = (line) => process.stderr.write(line),
) {
  const file = path.join(parsePilotRuntimeDirectory(runtimeDirectory), SUPERVISOR_HEALTH_FILE);
  return async (snapshot) => {
    try {
      await write(file, {
        schemaVersion: 1,
        observedAt: snapshot.observedAt,
        services: snapshot.services.map((entry) => ({
          service: entry.service,
          state: entry.state,
          ...(entry.attention ? { attention: [...entry.attention] } : {}),
        })),
      });
    } catch {
      // Reporting must never stop supervision; the monitor alerts on a stale file instead.
      report("PILOT_SUPERVISOR_HEALTH_WRITE_UNAVAILABLE\n");
    }
  };
}
/**
 * WP-2423: how long a Store service may take to start in the shared process (from the process's own
 * word, or from when the process was first seen if it has said nothing) before it is not running.
 */
export const HOSTED_STORE_STARTING_MS = 5 * 60_000;
/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the installation's own services, then each other Store's
 * workers from its own directory (`stores.json`), each Store's processes started, watched and
 * reported on their own, so one Store's failing worker never stops another's. Every Store's
 * day-end settlement worker runs, waiting by itself until the Store's first business day has
 * closed. Reported as `stores/<name>:<service>`.
 *
 * DEC-WORKER-HEALTH-TRUTH (v15 bc7e2965): a Store's worker is `running` only when the shared
 * process says it started it (`store-workers.liveness.json`, its own identity, a heartbeat of the
 * last two minutes) and every part of it has a current health report (missing, earlier or stale
 * parts are named in `attention`). One the process says is down, or that has not started 5 minutes
 * on, is `down`; a process that says nothing about it counts as not started.
 */
export function createPilotInstallationSweep({
  runtimeDirectory,
  createSweep = createPilotRecoverySweep,
  root = () => process.cwd(),
  readHealth = readHostedStoreHealth,
  readLiveness = readHostedStoreLiveness,
  listStores = async () =>
    loadServedStoreDirectories(path.join(await fs.realpath(process.cwd()), runtimeDirectory)),
  // WP-2423 (2026-11-02): which of them fit the database role's connections (a refused Store is
  // reported each sweep, so the operations monitor alerts on it, and its workers aren't started).
  admit = async (relatives) => admitConfiguredStores(runtimeDirectory, relatives),
  now = () => Date.now(),
  startingMs = HOSTED_STORE_STARTING_MS,
}) {
  // When the shared process (by pid) was first seen without a word about a Store's worker: never
  // dropped from the report, and never running on that silence.
  const unconfirmedSince = new Map();
  // DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: the Stores after the first run in one process; each is
  // still reported on its own, from its own health files. The Store list is read once per run.
  let prepared = null;
  const prepare = async () => {
    if (prepared !== null) return prepared;
    const { admitted, refused } = await admit(await listStores());
    prepared = {
      refused,
      own: createSweep({
        runtimeDirectory,
        ...(admitted.length === 0
          ? {}
          : { services: Object.freeze([...allServices, "store-workers"]) }),
        workloadHealth: createPilotWorkloadHealthOptions(runtimeDirectory),
      }),
      stores: admitted,
    };
    return prepared;
  };
  return Object.freeze({
    async sweep(options) {
      const { own, stores, refused } = await prepare();
      const services = [...(await own.sweep(options))];
      const host = services.find((entry) => entry.service === "store-workers");
      for (const relative of stores) {
        if (options?.signal?.aborted) break;
        if (host?.state !== "running") {
          services.push({ service: relative, state: host?.state ?? "unavailable" });
          continue;
        }
        const directory = path.join(root(), runtimeDirectory, relative);
        const liveness = await readLiveness(directory, host.pid);
        for (const service of storeWorkerServices) {
          const name = relative + ":" + service;
          const said =
            liveness === null || liveness === "unavailable" ? undefined : liveness[service];
          if (said?.state === "running") {
            unconfirmedSince.delete(name);
            services.push({
              service: name,
              state: "running",
              ...(await readHealth(directory, service, host.pid)),
            });
            continue;
          }
          if (said?.state === "down") {
            unconfirmedSince.delete(name);
            services.push({ service: name, state: "down" });
            continue;
          }
          let since;
          if (said?.state === "starting") {
            unconfirmedSince.delete(name);
            since = said.sinceMs;
          } else {
            const seen = unconfirmedSince.get(name);
            since = seen?.pid === host.pid ? seen.since : now();
            unconfirmedSince.set(name, { pid: host.pid, since });
          }
          const word = said === undefined ? { liveness: "unconfirmed" } : {};
          services.push({
            service: name,
            state: now() - since < startingMs ? "starting" : "down",
            ...word,
          });
        }
      }
      for (const relative of refused)
        services.push({ service: relative, state: "attention_required" });
      return services;
    },
  });
}
export async function runPilotSupervisor({
  runtimeDirectory,
  signal,
  acquire = acquirePilotSupervisorLease,
  sweep = createPilotInstallationSweep({ runtimeDirectory }),
  wait = delay,
  observe = () => undefined,
}) {
  parsePilotRuntimeDirectory(runtimeDirectory);
  if (!signal || typeof signal.aborted !== "boolean")
    throw Error("PILOT_SUPERVISOR_SIGNAL_REQUIRED");
  if (signal.aborted) return;
  const release = await acquire(runtimeDirectory);
  try {
    while (!signal.aborted) {
      const services = await sweep.sweep({ signal });
      if (signal.aborted) break;
      await observe({ observedAt: new Date().toISOString(), services });
      try {
        await wait(5000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    await release();
  }
}
/**
 * WP-2423 P1b / DEC-PILOT-RUNTIME-ENVIRONMENT: the start check of the supervisor. In a Pilot
 * Store it checks the hosting's secrets and certificate (DEC-PILOT-SECRETS, printing one
 * `PILOT_NOT_READY` line per problem: file names and fixed reasons only), the issued installation
 * files (DEC-PILOT-INSTALLATION, `checkInstallation`), the payment Provider
 * (DEC-STRIPE-PILOT-WIRING) and the staff sign-in (DEC-COGNITO-STORE-STAFF), then refuses with
 * `PILOT_CAPABILITY_MISSING:<codes>` while any gap remains. `checkCapabilities` exists for the
 * test harness only (a test certificate root); the supervisor itself never passes it.
 */
export async function checkPilotStartReadiness({
  runtimeDirectory,
  absoluteDirectory,
  checkCapabilities = checkConfiguredPilotCapabilities,
  checkInstallation = async (directory) =>
    (await import("./pilot-installation-issue.mjs")).checkPilotInstallation(directory),
  report = (line) => console.error(line),
}) {
  let met = [];
  if (isPilotStore()) {
    const checked = await checkCapabilities(absoluteDirectory);
    met = checked.met;
    for (const problem of checked.problems) report("PILOT_NOT_READY " + problem);
    // DEC-PILOT-INSTALLATION: the issued runtime files, loaded exactly as the services load them.
    const installation = await checkInstallation(absoluteDirectory);
    for (const problem of installation) report("PILOT_NOT_READY " + problem);
    if (installation.length === 0) met = [...met, "Installation"];
  }
  // A configured Provider whose secrets are present and whose mode matches the environment.
  if (await pilotPaymentProviderReady(runtimeDirectory, { environment: currentPilotEnvironment() }))
    met = [...met, "PaymentProvider"];
  // Staff sign in with Cognito and its client secret is present (no local stand-in).
  if ((await readPilotStaffSignInReadiness(absoluteDirectory)) === "CognitoConfigured")
    met = [...met, "StaffLogin"];
  return assertPilotReady({ met });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (process.argv.length !== 3 || !isPilotRuntime())
      throw Error("PILOT_SUPERVISOR_ARGUMENT_INVALID");
    try {
      const directory = parsePilotRuntimeDirectory(process.argv[2]);
      await checkPilotStartReadiness({
        runtimeDirectory: directory,
        absoluteDirectory: path.join(await fs.realpath(process.cwd()), directory),
      });
    } catch (error) {
      // WP-2423 P1b: name what a Pilot Store still lacks (capability codes only, no data).
      console.error(
        String(error?.message).startsWith("PILOT_CAPABILITY_MISSING:")
          ? error.message
          : "PILOT_ENVIRONMENT_INVALID",
      );
      throw error;
    }
    await runPilotSupervisor({
      runtimeDirectory: process.argv[2],
      signal: controller.signal,
      observe: (() => {
        const report = createPilotAttentionReporter();
        const health = createPilotSupervisorHealthWriter(process.argv[2]);
        const confirm = createPilotAttentionConfirmation();
        return async (snapshot) => {
          console.log(JSON.stringify(snapshot));
          // The alert line and the monitor's file name a stale part only once it is confirmed.
          const confirmed = confirm(snapshot);
          report(confirmed);
          await health(confirmed);
        };
      })(),
    });
  } catch {
    console.error("PILOT_SUPERVISOR_UNAVAILABLE");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
