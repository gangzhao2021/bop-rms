import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  workspaceTypescriptCacheName,
  workspaceTypescriptCacheRoot,
  workspaceTypescriptCompilerOptions,
  workspaceTypescriptVersion,
} from "./workspace-typescript-cache.mjs";

// Local process entry only: workspace packages export source under the
// "development" condition and built dist otherwise. This hook selects source
// for workspace package specifiers, then supplies Node's missing .js -> .ts
// resolution and TypeScript syntax transformation. Type/lint gates remain separate.
const workspaceScopes = ["@bop/", "@rms/", "@bop-rms/"];
const packages = realpathSync(fileURLToPath(new URL("../../packages", import.meta.url)));
const manifest = realpathSync(
  fileURLToPath(new URL("../module-manifest/module.manifest.ts", import.meta.url)),
);
function isWorkspaceSource(url) {
  if (!url?.startsWith("file:")) return false;
  const filename = fileURLToPath(url);
  if (!existsSync(filename)) return false;
  const resolved = realpathSync(filename);
  if (resolved === manifest) return true;
  const relative = path.relative(packages, resolved);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep).includes("src") &&
    filename.endsWith(".ts")
  );
}
const require = createRequire(import.meta.url);
const cache = path.join(workspaceTypescriptCacheRoot, workspaceTypescriptVersion());
/** The image's stored result when it has this exact source; TypeScript is loaded only otherwise. */
function transpiled(source, fileName) {
  try {
    return readFileSync(path.join(cache, workspaceTypescriptCacheName(source)), "utf8");
  } catch {
    const ts = require("typescript");
    return ts.transpileModule(source, {
      fileName,
      compilerOptions: workspaceTypescriptCompilerOptions(ts),
    }).outputText;
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      workspaceScopes.some((scope) => specifier.startsWith(scope)) &&
      !context.conditions?.includes("development")
    )
      context = { ...context, conditions: [...(context.conditions ?? []), "development"] };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        !context.parentURL ||
        !isWorkspaceSource(context.parentURL) ||
        !specifier.startsWith(".") ||
        !specifier.endsWith(".js")
      )
        throw error;
      const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (!isWorkspaceSource(candidate.href)) throw error;
      return nextResolve(pathToFileURL(fileURLToPath(candidate)).href, context);
    }
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!isWorkspaceSource(url)) return loaded;
    return {
      ...loaded,
      format: "module",
      source: transpiled(String(loaded.source), fileURLToPath(url)),
    };
  },
});
