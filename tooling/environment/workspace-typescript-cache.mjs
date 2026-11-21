import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);

/**
 * WP-2423 (2026-11-02, measured): every pilot process imports about 1430 workspace files and
 * transpiled them all at start, 3 s of CPU alone and 12 s with five starting together, and the
 * whole of it in every process. The image stores each result once, by the source's digest, so a
 * process reads it instead. A source with no stored result (a checkout, a changed file) is
 * transpiled as before: this changes when the work happens, never what runs.
 */
export const workspaceTypescriptCacheRoot = fileURLToPath(
  new URL("../../.cache/workspace-typescript/", import.meta.url),
);
export const workspaceTypescriptVersion = () => require("typescript/package.json").version;
export const workspaceTypescriptCompilerOptions = (ts) => ({
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2024,
  verbatimModuleSyntax: true,
});
export const workspaceTypescriptCacheName = (source) =>
  createHash("sha256").update(source).digest("hex") + ".js";
