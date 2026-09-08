import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolchain } from "./config.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const descriptors = Object.fromEntries(
  ["platform", "version", "execPath"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(process, key),
  ]),
);
function setProcess(key, value) {
  Object.defineProperty(process, key, { configurable: true, value });
}

beforeEach(() => {
  setProcess("platform", "darwin");
  setProcess("version", "v24.18.0");
  setProcess("execPath", "/tools/node");
  vi.stubEnv("PATH", "/tools");
  vi.spyOn(fs, "realpathSync").mockImplementation((file) => file);
  vi.spyOn(fs, "accessSync").mockReturnValue(undefined);
  vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true });
  execFileSync.mockImplementation((file, args) => {
    if (file.endsWith("/corepack")) return "0.35.0";
    if (file.endsWith("/pnpm")) return args[0] === "exec" ? "2.10.5" : "11.13.0";
    if (file.endsWith("/git")) return "git version 2";
    return args[0] === "info" ? "linux" : "5.5.1";
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [key, descriptor] of Object.entries(descriptors))
    Object.defineProperty(process, key, descriptor);
});

describe("local toolchain host boundary", () => {
  it.each(["darwin", "linux"])("accepts pinned tools and Linux Docker on %s", (platform) => {
    setProcess("platform", platform);
    expect(validateToolchain("/repo").actual.node).toBe("v24.18.0");
  });
  it.each(["win32", "freebsd"])("rejects unsupported %s before invoking tools", (platform) => {
    execFileSync.mockClear();
    setProcess("platform", platform);
    expect(() => validateToolchain("/repo")).toThrow("Linux/WSL2 or native macOS");
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("rejects Windows-mounted checkouts", () => {
    expect(() => validateToolchain("/mnt/c/repo")).toThrow("not /mnt/*");
  });
  it.each(["/mnt/c/node", "/tools/node.EXE"])("rejects foreign Node %s", (executable) => {
    setProcess("execPath", executable);
    expect(() => validateToolchain("/repo")).toThrow("native Linux/macOS executable");
  });
  it("rejects Windows tool resolution", () => {
    fs.realpathSync.mockImplementation((file) => (file === "/tools/git" ? "/mnt/c/git.exe" : file));
    expect(() => validateToolchain("/repo")).toThrow("git must resolve");
  });
  it("retains the Docker Desktop WSL Linux CLI bridge", () => {
    setProcess("platform", "linux");
    fs.realpathSync.mockImplementation((file) =>
      file === "/tools/docker" ? "/mnt/wsl/docker-desktop/cli-tools/docker" : file,
    );
    expect(validateToolchain("/repo").executables.docker).toContain("/mnt/wsl/docker-desktop/");
  });
  it("rejects a wrong Node version", () => {
    setProcess("version", "v24.19.0");
    expect(() => validateToolchain("/repo")).toThrow("Node.js must be v24.18.0");
  });
  it("rejects wrong package tool versions", () => {
    execFileSync.mockReturnValue("wrong");
    expect(() => validateToolchain("/repo")).toThrow("corepack must be 0.35.0");
  });
  it("requires a Linux Docker Engine on macOS too", () => {
    const actual = execFileSync.getMockImplementation();
    execFileSync.mockImplementation((file, args) =>
      args[0] === "info" ? "windows" : actual(file, args),
    );
    expect(() => validateToolchain("/repo")).toThrow("Docker Engine must use Linux containers");
  });
});
