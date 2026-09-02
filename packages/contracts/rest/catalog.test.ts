import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { publicRestOperations } from "./catalog.ts";
import { outputPath, renderOpenApi } from "./generate.ts";

describe("WP-2000 OpenAPI contract", () => {
  it("is byte-identical to the generated artifact with unique operations", async () => {
    expect(await readFile(outputPath, "utf8")).toBe(renderOpenApi());
    expect(new Set(publicRestOperations.map((item) => item[2])).size).toBe(
      publicRestOperations.length,
    );
  });
  it("documents exactly the currently composed public REST routes", () => {
    const document = JSON.parse(renderOpenApi()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(publicRestOperations.map((item) => item[1]))].sort(),
    );
    expect(Object.keys(document.paths)).not.toContain("/merchant/session");
    expect(Object.keys(document.paths)).not.toContain("/bff/realtime");
  });
  it("requires idempotency and expected-version headers for mutations", () => {
    const document = JSON.parse(renderOpenApi()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            parameters?: readonly { name: string }[];
            responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }>;
          }
        >
      >;
    };
    for (const [method, path, operationId, mutation] of publicRestOperations) {
      const operation = document.paths[path]?.[method];
      expect(operation).toBeDefined();
      if (operation === undefined) throw new Error("OPENAPI_OPERATION_MISSING");
      expect(operation.operationId).toBe(operationId);
      const names = (operation.parameters ?? []).map((item) => item.name);
      if (mutation) expect(names).toContain("idempotency-key");
      if (mutation && operationId !== "createCart") expect(names).toContain("if-match");
      expect(operation.responses["500"]?.content["application/json"]?.schema.$ref).toContain(
        "ErrorResponse",
      );
    }
  });
});
