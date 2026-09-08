import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processHasEnvironmentVariable, processMatches } from "./process.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
function platform(value) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}
afterEach(() => {
  vi.restoreAllMocks();
  execFileSync.mockReset();
  Object.defineProperty(process, "platform", platformDescriptor);
});
const root = "/synthetic repo";
const script = "tooling/environment/local.mjs";

describe("supervisor process identity", () => {
  it.each(["linux", "darwin"])("matches exact script and start argument on %s", (host) => {
    platform(host);
    if (host === "linux")
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `${process.execPath}\0${root}/${script}\0start\0--env-file\0local.env\0`,
      );
    else
      execFileSync.mockReturnValue(
        `${process.execPath} ${root}/${script} start --env-file local.env\n`,
      );
    expect(processMatches(123, root, script, "start")).toBe(true);
  });
  it.each(["linux", "darwin"])("rejects script/argument/interpreter lookalikes on %s", (host) => {
    platform(host);
    const read = vi.spyOn(fs, "readFileSync");
    for (const args of [
      [process.execPath, `${root}/${script}.other`, "start"],
      [process.execPath, `${root}/${script}`, "startled"],
      [process.execPath, `${root}/${script}`, "status"],
      ["/unrelated/node", `${root}/${script}`, "start"],
      [process.execPath, "-e", `${root}/${script}`, "start"],
    ]) {
      read.mockReturnValue(`${args.join("\0")}\0`);
      execFileSync.mockReturnValue(args.join(" "));
      expect(processMatches(123, root, script, "start")).toBe(false);
    }
  });
  it.each([0, -1, NaN, "123", undefined])("rejects invalid PID %s", (pid) => {
    expect(processMatches(pid, root, script, "start")).toBe(false);
  });
  it("fails closed on unavailable inspection", () => {
    platform("darwin");
    execFileSync.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(processMatches(123, root, script, "start")).toBe(false);
  });
  it.each(["linux", "darwin"])(
    "checks environment key boundaries on %s without returning values",
    (host) => {
      platform(host);
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        "OTHER_BOP_RMS_PROBE=value\0BOP_RMS_PROBE=synthetic\0",
      );
      execFileSync.mockReturnValue("node script OTHER_BOP_RMS_PROBE=value BOP_RMS_PROBE=synthetic");
      expect(processHasEnvironmentVariable(123, "BOP_RMS_PROBE")).toBe(true);
      expect(processHasEnvironmentVariable(123, "PROBE")).toBe(false);
    },
  );
  it("does not treat failed environment inspection as successful isolation", () => {
    platform("darwin");
    execFileSync.mockReturnValue("");
    expect(() => processHasEnvironmentVariable(123, "BOP_RMS_PROBE")).toThrow("unavailable");
  });
  it("redacts captured process output when inspection fails", () => {
    platform("darwin");
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("synthetic-private-output"), {
        stdout: "BOP_RMS_PROBE=synthetic-private-output",
      });
    });
    let failure;
    try {
      processHasEnvironmentVariable(123, "BOP_RMS_PROBE");
    } catch (error) {
      failure = error;
    }
    expect(failure.message).toBe("Process environment inspection unavailable");
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("synthetic-private-output");
  });
  it.each([process.execPath, "node"])(
    "inspects a real host child via %s in a path containing spaces",
    async (executable) => {
      const actual = await vi.importActual("node:child_process");
      execFileSync.mockImplementation(actual.execFileSync);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bop process test "));
      const file = path.join(directory, "worker.mjs");
      fs.writeFileSync(file, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
      const child = spawn(executable, [file, "start"], {
        env: { ...process.env, BOP_RMS_PROCESS_TEST: "synthetic" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await once(child.stdout, "data");
        expect(processMatches(child.pid, directory, "worker.mjs", "start")).toBe(true);
        expect(processMatches(child.pid, directory, "other.mjs", "start")).toBe(false);
        expect(processHasEnvironmentVariable(child.pid, "BOP_RMS_PROCESS_TEST")).toBe(true);
        expect(processHasEnvironmentVariable(child.pid, "BOP_RMS_ABSENT_TEST")).toBe(false);
      } finally {
        child.kill("SIGTERM");
        await once(child, "exit");
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
