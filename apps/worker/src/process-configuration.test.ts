import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadWorkerProcessConfiguration } from "./process-configuration.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function moduleFile(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "bop-worker-config-"));
  directories.push(directory);
  const path = join(directory, "configuration.mjs");
  await writeFile(path, source);
  return path;
}
it("retains unconfigured startup and rejects ambiguous or nonlocal arguments", async () => {
  expect(await loadWorkerProcessConfiguration([])).toEqual({});
  for (const args of [
    ["--configuration"],
    ["--other", "/tmp/config.mjs"],
    ["--configuration", "relative.mjs"],
    ["--configuration", "https://example.invalid/config.mjs"],
    ["--configuration", "/tmp/config.json"],
    ["--configuration", "/tmp/config.mjs", "extra"],
  ]) {
    await expect(loadWorkerProcessConfiguration(args)).rejects.toThrow(
      "WORKER_CONFIGURATION_INVALID",
    );
  }
});
it("loads lifecycle configuration without starting work", async () => {
  const path = await moduleFile(
    'export const workload = { start() { throw new Error("must not start on load"); }, async stop() {} };',
  );
  const result = await loadWorkerProcessConfiguration(["--configuration", path]);
  expect(typeof result.workload?.start).toBe("function");
  await result.workload?.stop();
});
it("sanitizes module exceptions and rejects incomplete lifecycles", async () => {
  for (const source of [
    'throw new Error("synthetic-sensitive-value");',
    "export const workload = {};",
    "export const workload = { async start() {}, async stop() {}, completion: 1 };",
  ]) {
    const path = await moduleFile(source);
    await expect(loadWorkerProcessConfiguration(["--configuration", path])).rejects.toThrow(
      /^WORKER_CONFIGURATION_UNAVAILABLE$/,
    );
  }
});
