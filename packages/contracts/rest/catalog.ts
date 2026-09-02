import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const publicRestOperations = Object.freeze([
  ["get", "/api/v1/public/stores/{store_public_id}/menu", "getPublicStoreMenu", false],
  ["post", "/api/v1/carts", "createCart", true],
  ["get", "/api/v1/carts/{cart_id}", "getCart", false],
  ["post", "/api/v1/carts/{cart_id}/items", "addCartItem", true],
  ["patch", "/api/v1/carts/{cart_id}/items/{cart_item_id}", "updateCartItem", true],
  ["delete", "/api/v1/carts/{cart_id}/items/{cart_item_id}", "removeCartItem", true],
  ["post", "/api/v1/carts/{cart_id}/quote", "quoteCart", true],
  ["get", "/api/v1/merchant/brands/{brand_id}/catalog/menus", "listMerchantMenus", false],
  [
    "post",
    "/api/v1/merchant/brands/{brand_id}/catalog/menus/{menu_id}/versions/{version_id}/submit-review",
    "submitMenuReview",
    true,
  ],
  [
    "post",
    "/api/v1/merchant/brands/{brand_id}/catalog/menus/{menu_id}/versions/{version_id}/approve",
    "approveMenu",
    true,
  ],
  [
    "post",
    "/api/v1/merchant/brands/{brand_id}/catalog/menus/{menu_id}/versions/{version_id}/publish",
    "publishMenu",
    true,
  ],
  [
    "post",
    "/api/v1/merchant/brands/{brand_id}/catalog/menus/{menu_id}/versions/{version_id}/archive",
    "archiveMenu",
    true,
  ],
] as const);

const Reference = z.string().uuid().openapi({ example: "018f0f58-767a-7f3b-a1d0-000000000001" });
const ErrorBody = z
  .object({
    error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/u), message: z.string() }),
  })
  .strict()
  .openapi("ErrorResponse");
const SuccessBody = z
  .object({ schemaVersion: z.literal(1) })
  .passthrough()
  .openapi("SuccessResponse");

export function buildRestRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register("ErrorResponse", ErrorBody);
  registry.register("SuccessResponse", SuccessBody);
  for (const [method, path, operationId, mutation] of publicRestOperations) {
    const pathParams = Object.fromEntries(
      [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => [match[1] as string, Reference]),
    );
    registry.registerPath({
      method,
      path,
      operationId,
      request: {
        ...(Object.keys(pathParams).length === 0 ? {} : { params: z.object(pathParams) }),
        ...(mutation
          ? {
              headers: z.object({
                "idempotency-key": Reference,
                ...(method === "post" && operationId === "createCart"
                  ? {}
                  : { "if-match": z.string().regex(/^"[1-9][0-9]{0,8}"$/u) }),
              }),
              body: { content: { "application/json": { schema: z.object({}).passthrough() } } },
            }
          : {}),
      },
      responses: {
        200: {
          description: "Successful public contract response",
          content: { "application/json": { schema: SuccessBody } },
        },
        400: {
          description: "Safe request rejection",
          content: { "application/json": { schema: ErrorBody } },
        },
        403: {
          description: "Permission denied without object disclosure",
          content: { "application/json": { schema: ErrorBody } },
        },
        409: {
          description: "Idempotency or expected-version conflict",
          content: { "application/json": { schema: ErrorBody } },
        },
        500: {
          description: "Safe internal failure",
          content: { "application/json": { schema: ErrorBody } },
        },
      },
    });
  }
  return registry;
}
