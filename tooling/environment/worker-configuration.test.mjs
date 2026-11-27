import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveWorkerConfiguration } from "./config.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
it("resolves checkout configuration without executing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bop-worker-path-"));
  directories.push(root);
  const module = path.join(root, "worker.mjs");
  fs.writeFileSync(module, 'throw new Error("must not import");');
  expect(resolveWorkerConfiguration(root, undefined)).toBeUndefined();
  expect(resolveWorkerConfiguration(root, "worker.mjs")).toBe(fs.realpathSync(module));
  expect(resolveWorkerConfiguration(root, module)).toBe(fs.realpathSync(module));
});
it("rejects missing, non-JavaScript and escaping symlink targets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bop-worker-path-"));
  directories.push(directory);
  const root = path.join(directory, "checkout");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(directory, "outside.mjs"), "");
  fs.writeFileSync(path.join(root, "secret.txt"), "");
  fs.symlinkSync(path.join(directory, "outside.mjs"), path.join(root, "escape.mjs"));
  for (const value of ["missing.mjs", "secret.txt", "../outside.mjs", "escape.mjs", "."])
    expect(() => resolveWorkerConfiguration(root, value)).toThrow(
      "Worker configuration must be an existing JavaScript file inside the checkout",
    );
});
