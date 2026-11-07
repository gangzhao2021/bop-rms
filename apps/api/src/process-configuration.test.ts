// Prepare the API module graph before the per-test deadline; the dynamic factory still owns runtime creation.
import "./server.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadApiProcessConfiguration } from "./process-configuration.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function moduleFile(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "bop-api-config-"));
  directories.push(directory);
  const path = join(directory, "configuration.mjs");
  await writeFile(path, source);
  return path;
}
it("loads an actual HTTP runtime without listening until explicitly started", async () => {
  const source = new URL("./server.ts", import.meta.url).href;
  const path = await moduleFile(
    "import { createApiServerRuntime, createApiRuntimeLogger } from " +
      JSON.stringify(source) +
      "; export function createRuntime({port}) { return createApiServerRuntime({port,logger:createApiRuntimeLogger({write(){}})}); }",
  );
  const runtime = await loadApiProcessConfiguration(["--configuration", path], 0);
  if (!runtime) throw new Error("missing configured runtime");
  expect(runtime.server.listening).toBe(false);
  try {
    await runtime.listen();
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await fetch("http://127.0.0.1:" + address.port + "/health");
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await runtime.shutdown("SIGTERM");
  }
  expect(runtime.server.listening).toBe(false);
});
it("keeps missing configuration distinct and sanitizes failed factories", async () => {
  expect(await loadApiProcessConfiguration([], 3000)).toBeUndefined();
  await expect(
    loadApiProcessConfiguration(["--configuration", "relative.mjs"], 3000),
  ).rejects.toThrow("API_CONFIGURATION_INVALID");
  for (const source of [
    'export function createRuntime() { throw new Error("synthetic-sensitive-value"); }',
    "export function createRuntime() { return {}; }",
  ]) {
    const path = await moduleFile(source);
    await expect(loadApiProcessConfiguration(["--configuration", path], 3000)).rejects.toThrow(
      /^API_CONFIGURATION_UNAVAILABLE$/,
    );
  }
});
