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

const QuoteReference = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const QuoteVersion = z.number().int().min(1).max(2147483647);
const QuoteErrorBody = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "quote_request_invalid",
          "quote_not_found",
          "quote_version_conflict",
          "quote_idempotency_conflict",
          "quote_configuration_invalid",
          "quote_service_unavailable",
        ]),
        messageKey: z.string().regex(/^customer\.quote\.[a-z_]+$/u),
      })
      .strict(),
  })
  .strict()
  .openapi("QuoteErrorResponse");
const QuoteExpiredBody = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: z.literal("quote_operation_expired"),
        messageKey: z.literal("customer.quote.operation_expired"),
      })
      .strict(),
    resolution: z
      .object({
        operationReference: QuoteReference,
        cartReference: QuoteReference,
        cartVersion: QuoteVersion,
      })
      .strict(),
  })
  .strict()
  .openapi("QuoteOperationExpiredResponse");

export function buildRestRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register("ErrorResponse", ErrorBody);
  registry.register("SuccessResponse", SuccessBody);
  for (const [method, path, operationId, mutation] of publicRestOperations) {
    const pathParams = Object.fromEntries(
      [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => [match[1] as string, Reference]),
    );
    registry.registerPath({
      ...(operationId === "quoteCart"
        ? {
            description:
              "Current Guest Session and exact Store/Cart authorization required. Ordering owns the expiry resolution; Checkout consumes this no-store, request-bound receipt. Internal scoped references only; no credentials or personal facts in responses. Repeat the original operation while unknown. A persisted expiry permits an explicit new operation; it never renews the original Quote.",
          }
        : {}),
      method,
      path,
      operationId,
      request: {
        ...(Object.keys(pathParams).length === 0 ? {} : { params: z.object(pathParams) }),
        ...(mutation
          ? {
              headers: z.object({
                "idempotency-key": Reference,
                ...(method === "post" &&
                (operationId === "createCart" || operationId === "quoteCart")
                  ? {}
                  : { "if-match": z.string().regex(/^"[1-9][0-9]{0,8}"$/u) }),
              }),
              ...(operationId === "quoteCart"
                ? {
                    cookies: z.object({
                      "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
                    }),
                    headers: z.object({
                      "idempotency-key": QuoteReference,
                      "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
                      origin: z.string().min(1),
                      "sec-fetch-site": z.literal("same-origin"),
                    }),
                  }
                : {}),
              body: {
                content: {
                  "application/json": {
                    schema:
                      operationId === "quoteCart"
                        ? z.object({ cartVersion: QuoteVersion }).strict()
                        : z.object({}).passthrough(),
                  },
                },
              },
            }
          : {}),
      },
      responses: {
        200: {
          description: "Successful public contract response",
          content: { "application/json": { schema: SuccessBody } },
        },
        ...(operationId === "quoteCart"
          ? {
              201: {
                description: "Original immutable Quote created or replayed",
                content: { "application/json": { schema: SuccessBody } },
              },
              404: {
                description: "Current Session or Cart not available",
                content: { "application/json": { schema: QuoteErrorBody } },
              },
              410: {
                description:
                  "Original operation is durably expired; late attachment is fenced. Explicit new operation is allowed.",
                content: { "application/json": { schema: QuoteExpiredBody } },
              },
              422: {
                description: "Quote configuration invalid; not an expiry receipt",
                content: { "application/json": { schema: QuoteErrorBody } },
              },
              503: {
                description: "Outcome unavailable or unknown; preserve original operation",
                content: { "application/json": { schema: QuoteErrorBody } },
              },
            }
          : {}),
        400: {
          description: "Safe request rejection",
          content: {
            "application/json": {
              schema: operationId === "quoteCart" ? QuoteErrorBody : ErrorBody,
            },
          },
        },
        403: {
          description: "Permission denied without object disclosure",
          content: { "application/json": { schema: ErrorBody } },
        },
        409: {
          description: "Idempotency or expected-version conflict",
          content: {
            "application/json": {
              schema: operationId === "quoteCart" ? QuoteErrorBody : ErrorBody,
            },
          },
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
