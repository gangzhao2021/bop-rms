import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Parser } from "@asyncapi/parser";

const documentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "generated/event-catalog.asyncapi.json",
);
const source = await readFile(documentPath, "utf8");
const parsedSource = JSON.parse(source) as unknown;

const visit = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "$ref" &&
      (typeof child !== "string" || (!child.startsWith("#/") && child.length > 0))
    )
      throw new Error("EVENT_CATALOG_REMOTE_REFERENCE_PROHIBITED");
    visit(child);
  }
};
visit(parsedSource);

const parser = new Parser();
const { document, diagnostics } = await parser.parse(source);
const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 0);
if (!document || errors.length > 0)
  throw new Error(`EVENT_CATALOG_ASYNCAPI_INVALID:${errors.map(({ code }) => code).join(",")}`);
process.stdout.write("event catalog AsyncAPI parser validation passed\n");
