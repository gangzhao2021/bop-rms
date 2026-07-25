import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { eventCatalog } from "./catalog.ts";
import { renderCatalogArtifacts } from "./render.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const artifacts = renderCatalogArtifacts(eventCatalog);
const outputs = new Map([
  [path.join(packageRoot, "events/generated/event-catalog.asyncapi.json"), artifacts.asyncApi],
  [
    path.join(packageRoot, "events/generated/event-catalog-entry.schema.json"),
    artifacts.catalogEntrySchema,
  ],
  [path.join(repositoryRoot, "docs/events/event-catalog.md"), artifacts.markdown],
]);

async function writeOutputs(): Promise<void> {
  for (const [filePath, content] of outputs) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

async function checkOutputs(): Promise<void> {
  for (const [filePath, expected] of outputs) {
    let actual: string;
    try {
      actual = await readFile(filePath, "utf8");
    } catch {
      throw new Error(
        `EVENT_CATALOG_GENERATED_FILE_MISSING:${path.relative(repositoryRoot, filePath)}`,
      );
    }
    if (actual !== expected)
      throw new Error(`EVENT_CATALOG_GENERATED_DRIFT:${path.relative(repositoryRoot, filePath)}`);
  }
}

const mode = process.argv[2];
if (mode === "--write") await writeOutputs();
else if (mode === "--check") await checkOutputs();
else throw new Error("EVENT_CATALOG_GENERATE_MODE_INVALID");
