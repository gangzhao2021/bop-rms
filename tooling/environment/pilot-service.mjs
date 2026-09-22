import { assertPilotMaintenanceAccess } from "./pilot-maintenance.mjs";
import { parsePilotWorkloadHealth, pilotHealthComponents } from "./pilot-workload-health.mjs";
import console from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const pilotRuntimeDirectory = ".local/pilot-v14";

const fail = () => {
  throw new Error("PILOT_PROCESS_UNAVAILABLE");
};
export function parsePilotRuntimeDirectory(value = pilotRuntimeDirectory) {
  if (typeof value !== "string" || !/^\.local\/[a-z0-9][a-z0-9_-]{0,63}$/u.test(value))
    return fail();
  return value;
}
export function pilotProcessArguments(root, service, runtimeDirectory = pilotRuntimeDirectory) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  if (
    ![
      "api",
      "customer",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ].includes(service)
  )
    return fail();
  return [
    process.execPath,
    "--import",
    "./tooling/environment/register-workspace-typescript.mjs",
    ...([
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
      "kitchen-queue-worker",
      "business-worker",
    ].includes(service)
      ? [`tooling/environment/pilot-${service}.mjs`, runtimeDirectory]
      : service === "api"
        ? ["tooling/environment/pilot-api-entry.mjs", runtimeDirectory]
        : service === "customer"
          ? ["tooling/environment/pilot-https-entry.mjs", runtimeDirectory]
          : service === "business-worker"
            ? [`${runtimeDirectory}/business-worker.mjs`]
            : [path.join(root, runtimeDirectory, `${service}.mjs`)]),
  ];
}
export function parsePilotProcess({
  root,
  service,
  cwd,
  cmdline,
  environ,
  stat,
  executable,
  runtimeDirectory = pilotRuntimeDirectory,
}) {
  const expected = pilotProcessArguments(root, service, runtimeDirectory);
  const args = cmdline.replace(/\0$/u, "").split("\0");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  if (
    cwd !== root ||
    args.length !== expected.length ||
    args.some((arg, i) => i > 0 && arg !== expected[i]) ||
    executable !== process.execPath ||
    !path.isAbsolute(args[0]) ||
    !/^\d+$/u.test(fields[19] ?? "") ||
    ["Z", "X"].includes(fields[0])
  )
    return fail();
  const environment = Object.create(null);
  for (const entry of environ.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 1) return fail();
    const key = entry.slice(0, separator);
    if (Object.hasOwn(environment, key)) return fail();
    environment[key] = entry.slice(separator + 1);
  }
  if (environment.NODE_ENV !== "development" || (service === "api" && environment.PORT !== "4300"))
    return fail();
  return { args, environment, started: fields[19] };
}
async function inspect(root, service, pid, runtimeDirectory) {
  const prefix = `/proc/${pid}`;
  const [cwd, cmdline, environ, stat, executable] = await Promise.all([
    fs.readlink(`${prefix}/cwd`),
    fs.readFile(`${prefix}/cmdline`, "utf8"),
    fs.readFile(`${prefix}/environ`, "utf8"),
    fs.readFile(`${prefix}/stat`, "utf8"),
    fs.readlink(`${prefix}/exe`),
  ]);
  if ((await fs.realpath(cmdline.split("\0")[0])) !== executable) return fail();
  return parsePilotProcess({
    root,
    service,
    cwd,
    cmdline,
    environ,
    stat,
    executable,
    runtimeDirectory,
  });
}
async function launchPilot(root, service, directory, pidFile, launch, state, runtimeDirectory) {
  const log = await fs.open(path.join(directory, `${service}.log`), "a", 0o600);
  let child;
  try {
    child = spawn(launch.args[0], launch.args.slice(1), {
      cwd: root,
      env: launch.environment,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const temporary = `${pidFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${child.pid}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, pidFile);
    child.unref();
  } catch (error) {
    // A newly spawned child without a published PID must not become an orphaned service.
    if (child?.pid) child.kill("SIGTERM");
    throw error;
  } finally {
    await log.close();
  }
  await delay(1000);
  await inspect(root, service, child.pid, runtimeDirectory);
  return { service, state, pid: child.pid };
}
export function pilotLaunchEnvironment(service, environment) {
  if (
    ![
      "api",
      "customer",
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ].includes(service)
  )
    return fail();
  const result = { NODE_ENV: "development", ...(service === "api" ? { PORT: "4300" } : {}) };
  for (const key of ["PATH", "HOME", "TMPDIR"])
    if (typeof environment[key] === "string") result[key] = environment[key];
  return result;
}
export function pilotProcessIsStopped(stat) {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  if (
    !/^[1-9][0-9]* \(/u.test(stat) ||
    !/^[A-Z]$/u.test(fields[0] ?? "") ||
    !/^\d+$/u.test(fields[19] ?? "")
  )
    return fail();
  return ["Z", "X"].includes(fields[0]);
}
export async function assertPilotPortFree(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
}
export function isPilotWorkerCandidate(
  root,
  service,
  cwd,
  cmdline,
  runtimeDirectory = pilotRuntimeDirectory,
) {
  if (
    ![
      "business-worker",
      "kitchen-queue-worker",
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
    ].includes(service) ||
    cwd !== root
  )
    return false;
  const script = pilotProcessArguments(root, service, runtimeDirectory)[3];
  const args = cmdline.split("\0").filter(Boolean);
  if (
    [
      "reconciliation-worker",
      "daily-settlement-worker",
      "dining-exception-worker",
      "kitchen-queue-worker",
      "business-worker",
    ].includes(service) &&
    args.at(-1) !== runtimeDirectory
  )
    return false;
  return args.some((arg) => arg === script || arg === path.resolve(root, script));
}
async function findPilotWorkers(root, service, runtimeDirectory) {
  const matches = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    let cwd, cmdline;
    try {
      [cwd, cmdline] = await Promise.all([
        fs.readlink(`/proc/${name}/cwd`),
        fs.readFile(`/proc/${name}/cmdline`, "utf8"),
      ]);
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) continue;
      throw error;
    }
    if (!isPilotWorkerCandidate(root, service, cwd, cmdline, runtimeDirectory)) continue;
    try {
      await inspect(root, service, Number(name), runtimeDirectory);
      matches.push(Number(name));
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) continue;
      throw error;
    }
  }
  return matches;
}
export async function confirmPilotServiceStopped({
  root,
  service,
  pid,
  runtimeDirectory = pilotRuntimeDirectory,
  readStat = (value) => fs.readFile(`/proc/${value}/stat`, "utf8"),
  portFree = assertPilotPortFree,
  findWorkers = findPilotWorkers,
}) {
  pilotProcessArguments(root, service, runtimeDirectory);
  if (pid !== null) {
    if (!Number.isSafeInteger(pid) || pid < 1) return fail();
    try {
      if (!pilotProcessIsStopped(await readStat(pid))) return false;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (service === "api" || service === "customer") await portFree(service === "api" ? 4300 : 4443);
  else if ((await findWorkers(root, service, runtimeDirectory)).length !== 0) return false;
  return true;
}
export async function runPilotService(
  action,
  service,
  runtimeDirectory = pilotRuntimeDirectory,
  healthOptions = {},
) {
  runtimeDirectory = parsePilotRuntimeDirectory(runtimeDirectory);
  if (
    process.platform !== "linux" ||
    !["status", "restart", "start", "stop", "health"].includes(action)
  )
    return fail();
  const root = await fs.realpath(process.cwd());
  pilotProcessArguments(root, service, runtimeDirectory);
  const directory = path.join(root, runtimeDirectory);
  if ((await fs.realpath(directory)) !== directory) return fail();
  const pidFile = path.join(directory, `${service}.pid`);
  const lock = path.join(directory, `${service}.restart-lock`);
  let locked = false;
  try {
    if (action !== "status" && action !== "health") {
      await fs.mkdir(lock, { mode: 0o700 });
      locked = true;
      await assertPilotMaintenanceAccess(runtimeDirectory, action);
    }
    if (action === "stop" || action === "restart") {
      try {
        await fs.lstat(path.join(directory, "supervisor.lock"));
        throw Error("PILOT_SUPERVISOR_MUST_STOP_FIRST");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    let rawPid;
    try {
      rawPid = (await fs.readFile(pidFile, "utf8")).trim();
    } catch (error) {
      if (!["start", "stop"].includes(action) || error.code !== "ENOENT") throw error;
    }
    if (rawPid !== undefined && !/^[1-9][0-9]*$/u.test(rawPid)) return fail();
    const pid = rawPid === undefined ? null : Number(rawPid);
    if (pid !== null && !Number.isSafeInteger(pid)) return fail();
    if (action === "start") {
      if ((await fs.readFile(path.join(root, ".nvmrc"), "utf8")).trim() !== process.versions.node)
        return fail();
      let stopped = pid === null;
      if (pid !== null) {
        try {
          stopped = pilotProcessIsStopped(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          stopped = true;
        }
      }
      if (!stopped) {
        await inspect(root, service, pid, runtimeDirectory);
        return { service, state: "running", pid };
      }
      if (service === "api" || service === "customer") {
        await assertPilotPortFree(service === "api" ? 4300 : 4443);
      } else {
        const matches = await findPilotWorkers(root, service, runtimeDirectory);
        if (matches.length > 1) return fail();
        if (matches.length === 1) {
          const recovered = matches[0];
          const temporary = `${pidFile}.${process.pid}.tmp`;
          await fs.writeFile(temporary, `${recovered}\n`, { mode: 0o600, flag: "wx" });
          await fs.rename(temporary, pidFile);
          return { service, state: "running", pid: recovered };
        }
      }
      return await launchPilot(
        root,
        service,
        directory,
        pidFile,
        {
          args: pilotProcessArguments(root, service, runtimeDirectory),
          environment: pilotLaunchEnvironment(service, process.env),
        },
        "started",
        runtimeDirectory,
      );
    }
    if (
      action === "stop" &&
      (await confirmPilotServiceStopped({ root, service, pid, runtimeDirectory }))
    )
      return { service, state: "stopped", pid };
    const original = await inspect(root, service, pid, runtimeDirectory);
    if (action === "status") return { service, state: "running", pid };
    if (action === "health") {
      const snapshots = {};
      for (const [component, filename] of Object.entries(
        pilotHealthComponents(service, healthOptions),
      )) {
        const file = path.join(directory, filename),
          stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.size > 4096
        )
          return fail();
        snapshots[component] = parsePilotWorkloadHealth(
          JSON.parse(await fs.readFile(file, "utf8")),
          { pid, started: original.started },
        );
      }
      if ((await inspect(root, service, pid, runtimeDirectory)).started !== original.started)
        return fail();
      return service === "kitchen-queue-worker"
        ? { service, pid, ...snapshots.kitchen }
        : service === "daily-settlement-worker"
          ? { service, pid, ...snapshots.dailySettlement }
          : service === "reconciliation-worker"
            ? { service, pid, ...snapshots.reconciliation }
            : service === "dining-exception-worker"
              ? { service, pid, ...snapshots.diningException }
              : { service, pid, workloads: snapshots };
    }
    // Recheck identity immediately before signalling. Never expose the captured environment.
    if ((await inspect(root, service, pid, runtimeDirectory)).started !== original.started)
      return fail();
    process.kill(pid, "SIGTERM");
    let stopped = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/u);
        if (["Z", "X"].includes(fields[0]) || fields[19] !== original.started) {
          stopped = true;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        stopped = true;
        break;
      }
      await delay(250);
    }
    if (!stopped) return fail();
    if (action === "stop") {
      if (!(await confirmPilotServiceStopped({ root, service, pid, runtimeDirectory })))
        return fail();
      return { service, state: "stopped", pid };
    }
    return await launchPilot(
      root,
      service,
      directory,
      pidFile,
      original,
      "restarted",
      runtimeDirectory,
    );
  } finally {
    if (locked) await fs.rmdir(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (![4, 5].includes(process.argv.length)) fail();
    console.log(
      JSON.stringify(await runPilotService(process.argv[2], process.argv[3], process.argv[4])),
    );
  } catch (error) {
    console.error(
      error.code === "EADDRINUSE"
        ? "PILOT_PORT_IN_USE: the required loopback port is occupied; no process was stopped."
        : "PILOT_PROCESS_UNAVAILABLE: check the pinned Node version, existing local configuration, PID and service log; no forced kill performed.",
    );
    process.exitCode = 1;
  }
}
