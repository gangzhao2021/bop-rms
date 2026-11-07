import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { buildWorkspaceTypescriptCache } from "./build-workspace-typescript-cache.mjs";
import { workspaceTypescriptCacheName } from "./workspace-typescript-cache.mjs";

const made = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workspace-ts-"));
  made.push(directory);
  return directory;
};

it("stores each workspace source by its digest, and no test or built output", () => {
  const root = temporary();
  const source = "export const size: number = 1;\n";
  mkdirSync(path.join(root, "tooling/module-manifest"), { recursive: true });
  writeFileSync(path.join(root, "tooling/module-manifest/module.manifest.ts"), "export {};\n");
  mkdirSync(path.join(root, "packages/rms/x/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/rms/x/dist/src"), { recursive: true });
  writeFileSync(path.join(root, "packages/rms/x/src/a.ts"), source);
  writeFileSync(path.join(root, "packages/rms/x/src/a.d.ts"), "export declare const b: 1;\n");
  writeFileSync(path.join(root, "packages/rms/x/dist/src/z.ts"), "export const z = 1;\n");
  const output = path.join(temporary(), "cache");
  expect(buildWorkspaceTypescriptCache({ root, output })).toBe(2);
  expect(readFileSync(path.join(output, workspaceTypescriptCacheName(source)), "utf8")).toContain(
    "export const size = 1;",
  );
});

it("an uncached workspace source still loads through the hook", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tooling/environment/register-workspace-typescript.mjs",
      "--input-type=module",
      "-e",
      'const m = await import("./packages/bop/identity/src/index.ts"); console.log(typeof m.parseOpaqueUuidV7);',
    ],
    { encoding: "utf8", env: { ...process.env, NODE_ENV: "development" } },
  );
  expect(result.stdout.trim()).toBe("function");
});
