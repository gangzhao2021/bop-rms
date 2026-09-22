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
  { runtimeDirectory: ".local/pilot-v13" },
  { lease: { pid: 0, started: "9876" } },
])("rejects unrelated or reused process identity", (change) => {
  expect(() => verifySupervisorProcess({ ...base(), ...change })).toThrow();
});

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
    child = spawn(process.execPath, ["--input-type=module", "-e", script, directory, "exit"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(await runPilotSupervisorControl("status", directory)).toMatchObject({ state: "stale" });
    await expect(runPilotSupervisorControl("start", directory)).rejects.toThrow();
    expect(await runPilotSupervisorControl("clear-stale", directory)).toEqual({
      state: "stale_cleared",
    });
    expect(await runPilotSupervisorControl("status", directory)).toEqual({ state: "stopped" });
    child = spawn(process.execPath, ["--input-type=module", "-e", script, directory, "live"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
