import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";
import {
  workspaceTypescriptCacheName,
  workspaceTypescriptCacheRoot,
  workspaceTypescriptCompilerOptions,
  workspaceTypescriptVersion,
} from "./workspace-typescript-cache.mjs";

/** Run once while the image is built, after the workspace is installed. */
export function buildWorkspaceTypescriptCache({
  root = fileURLToPath(new URL("../..", import.meta.url)),
  output = path.join(workspaceTypescriptCacheRoot, workspaceTypescriptVersion()),
} = {}) {
  mkdirSync(output, { recursive: true });
  const sources = [path.join(root, "tooling/module-manifest/module.manifest.ts")];
  const walk = (directory, inSource) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, inSource || entry.name === "src");
      else if (inSource && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
        sources.push(file);
    }
  };
  walk(path.join(root, "packages"), false);
  const compilerOptions = workspaceTypescriptCompilerOptions(ts);
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    const target = path.join(output, workspaceTypescriptCacheName(source));
    const temporary = target + "." + process.pid + ".tmp";
    writeFileSync(
      temporary,
      ts.transpileModule(source, { fileName: file, compilerOptions }).outputText,
    );
    renameSync(temporary, target);
  }
  return sources.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log("workspace TypeScript cache: " + buildWorkspaceTypescriptCache() + " files");
