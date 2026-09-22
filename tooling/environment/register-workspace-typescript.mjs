import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

// Local process entry only: workspace packages intentionally export source.
// Type/lint gates remain separate; this supplies Node's missing .js -> .ts
// resolution and TypeScript syntax transformation for those package sources.
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
registerHooks({
  resolve(specifier, context, nextResolve) {
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
      source: ts.transpileModule(String(loaded.source), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
          verbatimModuleSyntax: true,
        },
      }).outputText,
    };
  },
});
