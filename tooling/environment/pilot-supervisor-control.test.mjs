import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runPilotSupervisorControl } from "./pilot-supervisor-control.mjs";
import { expect, it } from "vitest";
import process from "node:process";
import { verifySupervisorProcess } from "./pilot-supervisor-control.mjs";
const base = () => ({
  root: "/synthetic",
  runtimeDirectory: ".local/pilot-v14",
  lease: { pid: 123, started: "9876" },
  cwd: "/synthetic",
  executable: process.execPath,
  cmdline: [
    process.execPath,
    "--import",
    "./tooling/environment/register-workspace-typescript.mjs",
    "tooling/environment/pilot-supervisor.mjs",
    ".local/pilot-v14",
    "",
  ].join("\0"),
  stat: "123 (node) " + ["S", ...Array(18).fill("0"), "9876", "0"].join(" "),
});
it("verifies the exact supervisor identity", () => {
  expect(verifySupervisorProcess(base())).toBe(123);
});
it.each([
  { cwd: "/other" },
  { executable: "/other/node" },
  { lease: { pid: 123, started: "9875" } },
  { cmdline: "node\0unrelated\0" },
  // The pre-fix launch without the workspace loader is not the supervisor this tool starts.
  {
    cmdline: [
      process.execPath,
      "tooling/environment/pilot-supervisor.mjs",
      ".local/pilot-v14",
      "",
    ].join("\0"),
  },
  { runtimeDirectory: ".local/pilot-v13" },
  { lease: { pid: 0, started: "9876" } },
])("rejects unrelated or reused process identity", (change) => {
  expect(() => verifySupervisorProcess({ ...base(), ...change })).toThrow();
});

// pilot-supervisor.mjs imports workspace TypeScript packages: plain node cannot load it.
const loader = ["--import", "./tooling/environment/register-workspace-typescript.mjs"];
it("starts the supervisor with the workspace loader, reports it running and stops it", async () => {
  await fs.mkdir(".local", { recursive: true, mode: 0o700 });
  const directory = ".local/supervisor-control-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  const saved = { node: process.env.NODE_ENV, pilot: process.env.BOP_PILOT_ENVIRONMENT };
  // InternalTest supervisor (no installation files: every service start fails and is retried,
  // nothing connects anywhere); the supervisor itself must load and hold its lease.
  process.env.NODE_ENV = "development";
  delete process.env.BOP_PILOT_ENVIRONMENT;
  try {
    const started = await runPilotSupervisorControl("start", directory);
    expect(started).toMatchObject({ state: "started" });
    expect(await runPilotSupervisorControl("status", directory)).toEqual({
      state: "running",
      pid: started.pid,
    });
    expect(await runPilotSupervisorControl("start", directory)).toEqual({
      state: "running",
      pid: started.pid,
    });
    expect(await runPilotSupervisorControl("stop", directory)).toEqual({ state: "stopped" });
    expect(await runPilotSupervisorControl("status", directory)).toEqual({ state: "stopped" });
  } finally {
    if (saved.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.node;
    if (saved.pilot === undefined) delete process.env.BOP_PILOT_ENVIRONMENT;
    else process.env.BOP_PILOT_ENVIRONMENT = saved.pilot;
    try {
      await runPilotSupervisorControl("stop", directory);
    } catch {
      // already stopped or never started
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("clears only an actual exited child lease and refuses a live unrelated child", async () => {
  await fs.mkdir(".local", { recursive: true, mode: 0o700 });
  const directory = ".local/supervisor-control-test-" + randomUUID();
  await fs.mkdir(directory, { mode: 0o700 });
  let child;
  try {
    const script = `import { acquirePilotSupervisorLease } from "./tooling/environment/pilot-supervisor.mjs";
      await acquirePilotSupervisorLease(process.argv[1]);
      process.stdout.write("ready");
      if (process.argv[2] === "live") setInterval(() => {}, 1000);`;
    child = spawn(
      process.execPath,
      [...loader, "--input-type=module", "-e", script, directory, "exit"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(await runPilotSupervisorControl("status", directory)).toMatchObject({ state: "stale" });
    await expect(runPilotSupervisorControl("start", directory)).rejects.toThrow();
    expect(await runPilotSupervisorControl("clear-stale", directory)).toEqual({
      state: "stale_cleared",
    });
    expect(await runPilotSupervisorControl("status", directory)).toEqual({ state: "stopped" });
    child = spawn(
      process.execPath,
      [...loader, "--input-type=module", "-e", script, directory, "live"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await once(child.stdout, "data");
    const before = await fs.readFile(directory + "/supervisor.lock", "utf8");
    await expect(runPilotSupervisorControl("clear-stale", directory)).rejects.toThrow();
    await expect(runPilotSupervisorControl("stop", directory)).rejects.toThrow();
    expect(await fs.readFile(directory + "/supervisor.lock", "utf8")).toBe(before);
    expect(child.exitCode).toBeNull();
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    expect(await runPilotSupervisorControl("clear-stale", directory)).toEqual({
      state: "stale_cleared",
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
