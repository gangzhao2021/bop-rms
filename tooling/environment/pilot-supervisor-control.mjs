import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  parsePilotRuntimeDirectory,
  pilotLaunchEnvironment,
  pilotProcessIsStopped,
} from "./pilot-service.mjs";
const fail = () => {
  throw Error("PILOT_SUPERVISOR_CONTROL_UNAVAILABLE");
};
export function verifySupervisorProcess({
  root,
  runtimeDirectory,
  lease,
  cwd,
  executable,
  cmdline,
  stat,
}) {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const args = cmdline.replace(/\0$/u, "").split("\0");
  if (
    !Number.isSafeInteger(lease?.pid) ||
    lease.pid < 1 ||
    typeof lease.started !== "string" ||
    !/^\d+$/u.test(lease.started) ||
    fields[19] !== lease.started ||
    pilotProcessIsStopped(stat) ||
    cwd !== root ||
    executable !== process.execPath ||
    args.length !== 3 ||
    args[0] !== process.execPath ||
    args[1] !== "tooling/environment/pilot-supervisor.mjs" ||
    args[2] !== parsePilotRuntimeDirectory(runtimeDirectory)
  )
    return fail();
  return lease.pid;
}
export async function runPilotSupervisorControl(action, runtimeDirectory) {
  if (process.platform !== "linux" || !["start", "stop", "status", "clear-stale"].includes(action))
    return fail();
  const directoryName = parsePilotRuntimeDirectory(runtimeDirectory),
    root = await fs.realpath(process.cwd()),
    directory = path.join(root, directoryName);
  const directoryStat = await fs.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    return fail();
  const file = path.join(directory, "supervisor.lock"),
    control = path.join(directory, "supervisor-control.lock");
  let locked = false;
  const inspect = async () => {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (e) {
      if (e.code === "ENOENT") return { state: "stopped" };
      throw e;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 1024
    )
      return fail();
    const lease = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) return fail();
    let proc;
    try {
      proc = await fs.readFile(`/proc/${lease.pid}/stat`, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { state: "stale", lease, stat };
      throw e;
    }
    if (pilotProcessIsStopped(proc)) return { state: "stale", lease, stat };
    const [cwd, executable, cmdline] = await Promise.all([
      fs.readlink(`/proc/${lease.pid}/cwd`),
      fs.readlink(`/proc/${lease.pid}/exe`),
      fs.readFile(`/proc/${lease.pid}/cmdline`, "utf8"),
    ]);
    verifySupervisorProcess({
      root,
      runtimeDirectory: directoryName,
      lease,
      cwd,
      executable,
      cmdline,
      stat: proc,
    });
    return { state: "running", lease, stat };
  };
  try {
    if (action !== "status") {
      await fs.mkdir(control, { mode: 0o700 });
      locked = true;
    }
    const prior = await inspect();
    if (action === "status")
      return { state: prior.state, ...(prior.lease ? { pid: prior.lease.pid } : {}) };
    if (action === "clear-stale") {
      if (prior.state !== "stale") return fail();
      const current = await fs.lstat(file);
      if (current.ino !== prior.stat.ino || current.dev !== prior.stat.dev) return fail();
      await fs.unlink(file);
      return { state: "stale_cleared" };
    }
    if (action === "stop") {
      if (prior.state === "stopped") return { state: "stopped" };
      if (prior.state !== "running") return fail();
      const fresh = await inspect();
      if (
        fresh.state !== "running" ||
        fresh.lease.started !== prior.lease.started ||
        fresh.lease.pid !== prior.lease.pid
      )
        return fail();
      process.kill(fresh.lease.pid, "SIGTERM");
      for (let n = 0; n < 100; n++) {
        const current = await inspect();
        if (current.state === "stopped") return { state: "stopped" };
        if (
          current.lease?.pid !== prior.lease.pid ||
          current.lease?.started !== prior.lease.started
        )
          return fail();
        await delay(200);
      }
      return fail();
    }
    if (prior.state === "running") return { state: "running", pid: prior.lease.pid };
    if (prior.state !== "stopped") return fail();
    if ((await fs.readFile(path.join(root, ".nvmrc"), "utf8")).trim() !== process.versions.node)
      return fail();
    const log = await fs.open(path.join(directory, "supervisor.log"), "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, ["tooling/environment/pilot-supervisor.mjs", directoryName], {
        cwd: root,
        env: pilotLaunchEnvironment("business-worker", process.env),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
    } finally {
      await log.close();
    }
    let spawnFailed = false;
    child.on("error", () => {
      spawnFailed = true;
    });
    child.unref();
    for (let n = 0; n < 100; n++) {
      if (spawnFailed || child.exitCode !== null) return fail();
      let current;
      try {
        current = await inspect();
      } catch {
        await delay(100);
        continue;
      }
      if (current.state === "running") {
        if (current.lease.pid !== child.pid) return fail();
        return { state: "started", pid: child.pid };
      }
      await delay(100);
    }
    return fail();
  } finally {
    if (locked) await fs.rmdir(control);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) fail();
    console.log(JSON.stringify(await runPilotSupervisorControl(process.argv[2], process.argv[3])));
  } catch {
    console.error("PILOT_SUPERVISOR_CONTROL_UNAVAILABLE");
    process.exitCode = 1;
  }
}
