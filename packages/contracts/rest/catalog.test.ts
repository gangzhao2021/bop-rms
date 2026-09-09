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
  it("documents the exact Quote version, authorization and terminal receipt", () => {
    const document = JSON.parse(renderOpenApi());
    const quote = document.paths["/api/v1/carts/{cart_id}/quote"].post;
    expect(quote.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining([
        "idempotency-key",
        "x-csrf-token",
        "__Host-bop-guest",
        "sec-fetch-site",
      ]),
    );
    expect(quote.parameters.map((p: { name: string }) => p.name)).not.toContain("if-match");
    expect(quote.requestBody.content["application/json"].schema.required).toEqual(["cartVersion"]);
    expect(quote.responses["410"].content["application/json"].schema.$ref).toContain(
      "QuoteOperationExpiredResponse",
    );
    const schema = document.components.schemas.QuoteOperationExpiredResponse;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.resolution.required).toEqual([
      "operationReference",
      "cartReference",
      "cartVersion",
    ]);
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
      if (mutation && !["createCart", "quoteCart"].includes(operationId))
        expect(names).toContain("if-match");
      expect(operation.responses["500"]?.content["application/json"]?.schema.$ref).toContain(
        "ErrorResponse",
      );
    }
  });
});
