import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { buildRestRegistry } from "./catalog.ts";

export const outputPath = fileURLToPath(new URL("./generated/openapi.json", import.meta.url));
export function renderOpenApi(): string {
  const document = new OpenApiGeneratorV31(buildRestRegistry().definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "BOP-RMS Public REST API", version: "1.0.0" },
    servers: [{ url: "/" }],
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}
const mode = process.argv[2];
if (mode === "--write") {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderOpenApi(), "utf8");
} else if (mode === "--check") {
  if ((await readFile(outputPath, "utf8")) !== renderOpenApi()) throw new Error("OPENAPI_DRIFT");
}
