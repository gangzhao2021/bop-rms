import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const publicRestOperations = Object.freeze([
  [
    "get",
    "/api/v1/checkout-sessions/{checkout_session_id}/payment-result",
    "getCustomerPaymentResult",
    false,
  ],
  [
    "post",
    "/api/v1/checkout-sessions/{checkout_session_id}/payment-handoff",
    "getCustomerPaymentHandoff",
    false,
  ],
  [
    "post",
    "/api/v1/checkout-sessions/{checkout_session_id}/payment-intents",
    "createCustomerPaymentIntent",
    true,
  ],
  ["get", "/api/v1/checkout-sessions/{checkout_session_id}", "getCheckoutSession", false],
  ["get", "/api/v1/public/stores/{store_public_id}/menu", "getPublicStoreMenu", false],
  ["post", "/api/v1/carts", "createCart", true],
  ["post", "/api/v1/carts/{cart_id}/checkout-sessions", "createCheckoutSession", true],
  ["post", "/api/v1/orders", "submitCustomerOrder", true],
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
  // DEC-STRIPE-PILOT-WIRING / DEC-PILOT-NOTIFICATIONS: Provider callbacks deduplicate by the
  // Provider's own event/message ID and the order link is single-use, so none takes an
  // Idempotency-Key (mutation flag false).
  ["post", "/api/v1/payment-provider/stripe/webhook", "receiveStripeWebhook", false],
  ["post", "/api/v1/provider/ses-feedback", "receiveNotificationFeedback", false],
  ["get", "/api/v1/customer/order-messages", "getCustomerOrderMessageOptions", false],
  ["post", "/api/v1/customer/order-recovery", "consumeCustomerOrderLink", false],
  ["get", "/api/v1/customer/store", "getCustomerStoreProfile", false],
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

const OrderSubmissionRequest = z
  .object({
    cartReference: QuoteReference,
    cartVersion: QuoteVersion,
    quoteReference: QuoteReference,
  })
  .strict()
  .openapi("OrderSubmissionRequest");
const OrderSubmissionResponse = z
  .object({
    schemaVersion: z.literal(1),
    order: z
      .object({
        orderReference: QuoteReference,
        orderNumber: z.string().min(1),
        submissionReference: QuoteReference,
        cartReference: QuoteReference,
        cartVersion: QuoteVersion,
        quoteReference: QuoteReference,
        quoteVersion: z.union([z.literal(1), z.literal(2)]),
        orderType: z.enum(["DineIn", "Pickup"]),
        phase: z.literal("Submitted"),
        paymentStatus: z.literal("NotReported"),
        total: z
          .object({
            amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
            currency: z.literal("CAD"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .openapi("OrderSubmissionResponse");
const OrderSubmissionError = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "order_request_invalid",
          "order_not_found",
          "order_version_conflict",
          "order_idempotency_conflict",
          "order_requote_required",
          "order_service_unavailable",
        ]),
        messageKey: z.string().regex(/^customer\.order\.[a-z_]+$/u),
      })
      .strict(),
  })
  .strict()
  .openapi("OrderSubmissionError");

const CheckoutSessionRequestBody = z
  .object({ cartVersion: QuoteVersion, quoteReference: QuoteReference })
  .strict();
const CheckoutSessionResponse = z
  .object({
    schemaVersion: z.literal(1),
    session: z
      .object({
        checkoutSessionReference: QuoteReference,
        cartReference: QuoteReference,
        cartVersion: QuoteVersion,
        quoteReference: QuoteReference,
        quoteVersion: z.union([z.literal(1), z.literal(2)]),
        createdAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .openapi("CheckoutSessionResponse");
const CheckoutSessionErrorBody = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "checkout_session_request_invalid",
          "checkout_session_not_found",
          "checkout_session_intent_conflict",
          "checkout_session_service_unavailable",
          // WP-2423: 409, the Store's stock can't make the Cart as it stands (nothing created).
          "checkout_session_item_short",
          "checkout_session_item_unavailable",
        ]),
        messageKey: z.string().regex(/^customer\.checkoutSession\.[a-z_]+$/u),
        // WP-2423: the guest's own Cart line the refusal is about; `available` (item_short only)
        // is how many of that item can still be made with the rest of the Cart.
        line: z
          .object({
            cartItemReference: QuoteReference,
            available: z.number().int().min(0).optional(),
            sharedStock: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("CheckoutSessionError");

const CustomerPaymentResponse = z
  .object({
    schemaVersion: z.literal(1),
    payment: z
      .object({
        checkoutSessionReference: QuoteReference,
        paymentIntentReference: QuoteReference,
        orderReference: QuoteReference,
        creationStatus: z.enum(["Created", "AlreadyCreated", "Processing"]),
        total: z
          .object({
            amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
            currency: z.literal("CAD"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .openapi("CustomerPaymentIntentResponse");
const CustomerPaymentError = z
  .object({
    schemaVersion: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "payment_request_invalid",
          "payment_not_found",
          "payment_intent_conflict",
          "payment_not_ready",
          "payment_service_unavailable",
          // WP-2423: 409, items ran out after checkout; no order was placed, nothing charged.
          "payment_items_short",
        ]),
        messageKey: z.string().regex(/^customer\.payment\.[a-z_]+$/u),
      })
      .strict(),
  })
  .strict()
  .openapi("CustomerPaymentIntentError");

export function buildRestRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register("ErrorResponse", ErrorBody);
  registry.register("SuccessResponse", SuccessBody);
  for (const [method, path, operationId, mutation] of publicRestOperations) {
    if (operationId === "getCustomerPaymentResult") {
      const payment = z.union([
        z
          .object({
            checkoutSessionReference: QuoteReference,
            paymentIntentReference: z.null(),
            orderReference: z.null(),
            status: z.literal("Pending"),
            total: z.null(),
          })
          .strict(),
        z
          .object({
            checkoutSessionReference: QuoteReference,
            paymentIntentReference: QuoteReference,
            orderReference: QuoteReference,
            status: z.enum(["Pending", "Unknown", "Succeeded", "Failed"]),
            total: z
              .object({
                amountMinor: z
                  .string()
                  .regex(/^(0|[1-9][0-9]{0,18})$/u)
                  .describe("CAD minor units at most signed int64 maximum"),
                currency: z.literal("CAD"),
              })
              .strict(),
          })
          .strict(),
      ]);
      const error = z
        .object({
          schemaVersion: z.literal(1),
          error: z
            .object({
              code: z.enum([
                "payment_result_request_invalid",
                "payment_result_not_found",
                "payment_result_service_unavailable",
              ]),
              messageKey: z.string().regex(/^customer\.payment\.result\.[a-z_]+$/u),
            })
            .strict(),
        })
        .strict();
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Read the current Guest's exact CheckoutSession payment result. Current session authorization is checked before and after owner reads. Succeeded/Failed require committed Payment terminal facts; Provider snapshots alone remain unconfirmed. No Provider call or mutation. No query/body or caller operation IDs. Missing configuration fails closed. No-store/no-referrer.",
        request: {
          params: z.object({ checkout_session_id: QuoteReference }),
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1).optional(),
            "sec-fetch-site": z.literal("same-origin"),
          }),
        },
        responses: {
          200: {
            description: "Persisted payment result; Pending is not paid",
            headers: {
              "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
              "Referrer-Policy": { schema: { type: "string", enum: ["no-referrer"] } },
            },
            content: {
              "application/json": {
                schema: z.object({ schemaVersion: z.literal(1), payment }).strict(),
              },
            },
          },
          400: {
            description: "Invalid request",
            content: { "application/json": { schema: error } },
          },
          404: {
            description: "Current session access unavailable",
            content: { "application/json": { schema: error } },
          },
          503: {
            description: "Payment result dependency unavailable",
            content: { "application/json": { schema: error } },
          },
        },
      });
      continue;
    }
    if (operationId === "getCustomerPaymentHandoff") {
      const error = z
        .object({
          schemaVersion: z.literal(1),
          error: z
            .object({
              code: z.enum([
                "payment_handoff_request_invalid",
                "payment_handoff_not_found",
                "payment_handoff_not_ready",
                "payment_handoff_service_unavailable",
              ]),
              messageKey: z.string().regex(/^customer\.payment\.handoff\.[a-z_]+$/u),
            })
            .strict(),
        })
        .strict();
      const response = z
        .object({
          schemaVersion: z.literal(1),
          clientSecret: z
            .string()
            .max(512)
            .regex(/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u)
            .describe(
              "Ephemeral payment credential. Current customer page memory only; never log, cache or store in URLs/Web Storage.",
            ),
        })
        .strict();
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "CUST-PAYMENT reads the original intent credential after current Guest/Store/Order/capacity/Inventory and confirmation-policy checks before and after Provider retrieval. Closed empty JSON body, no query or caller operation IDs. Same-origin CSRF-protected POST read: does not create, confirm or retry payment. TLS required. Response is no-store/no-referrer; credential remains in page memory and is passed only to Stripe.js. No paid-status inference. Missing configuration fails closed.",
        request: {
          params: z.object({ checkout_session_id: QuoteReference }),
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1),
            "sec-fetch-site": z.literal("same-origin"),
          }),
          body: {
            required: true,
            content: { "application/json": { schema: z.object({}).strict() } },
          },
        },
        responses: {
          200: {
            description: "Ephemeral customer credential; not payment success",
            headers: {
              "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
              "Referrer-Policy": { schema: { type: "string", enum: ["no-referrer"] } },
            },
            content: { "application/json": { schema: response } },
          },
          400: {
            description: "Invalid closed request",
            content: { "application/json": { schema: error } },
          },
          404: {
            description: "Current session access unavailable",
            content: { "application/json": { schema: error } },
          },
          422: {
            description: "Current payment handoff not permitted or expired",
            content: { "application/json": { schema: error } },
          },
          503: {
            description: "Handoff unavailable; no credential returned",
            content: { "application/json": { schema: error } },
          },
          500: {
            description: "Safe transport failure",
            content: { "application/json": { schema: ErrorBody } },
          },
        },
      });
      continue;
    }
    if (operationId === "createCustomerPaymentIntent") {
      const content = (
        schema: typeof CustomerPaymentResponse | typeof CustomerPaymentError | typeof ErrorBody,
      ) => ({ "application/json": { schema } });
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "CUST-PAYMENT creation using current Guest/Store/session authorization and CSRF. Idempotency-Key is the immutable tip selection intent; repeat the original key and amount while uncertain. Amount is exact CAD minor units, maximum 9223372036854775807. Server session owns submission and payment operation IDs. No-store/no-referrer response. Creation status is not payment success; Provider secure handoff and authoritative payment result are separate. No Provider identifiers or secrets are returned.",
        request: {
          params: z.object({ checkout_session_id: QuoteReference }),
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "idempotency-key": QuoteReference,
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1),
            "sec-fetch-site": z.literal("same-origin"),
          }),
          body: {
            required: true,
            content: {
              "application/json": {
                schema: z
                  .object({
                    tip: z
                      .object({
                        amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
                        currency: z.literal("CAD"),
                      })
                      .strict(),
                  })
                  .strict(),
              },
            },
          },
        },
        responses: {
          200: {
            description: "Original creation outcome recovered, not a current paid status",
            content: content(CustomerPaymentResponse),
          },
          201: {
            description: "Payment intent created, not payment success",
            content: content(CustomerPaymentResponse),
          },
          202: {
            description: "Original local operation pending; preserve original intent",
            content: content(CustomerPaymentResponse),
          },
          400: {
            description: "Invalid closed request or exact amount",
            content: content(CustomerPaymentError),
          },
          404: {
            description: "Current access or session unavailable without disclosure",
            content: content(CustomerPaymentError),
          },
          409: {
            description: "Different intent for original operation",
            content: content(CustomerPaymentError),
          },
          422: {
            description: "Payment preparation not ready or expired",
            content: content(CustomerPaymentError),
          },
          503: {
            description: "Service unavailable or uncertain; preserve original operation",
            content: content(CustomerPaymentError),
          },
          500: { description: "Safe transport failure", content: content(ErrorBody) },
        },
      });
      continue;
    }
    if (operationId === "getCheckoutSession") {
      const content = (
        schema: typeof CheckoutSessionResponse | typeof CheckoutSessionErrorBody | typeof ErrorBody,
      ) => ({ "application/json": { schema } });
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Current-authorized CUST-CHECKOUT recovery. Current Guest, Store, channel and persisted source Cart access are checked before returning historical session facts. No query parameters, writes, deadline renewal or payment permission. Responses use no-store and no-referrer. Same-origin browser GET may omit Origin; a supplied Origin must match.",
        request: {
          params: z.object({ checkout_session_id: QuoteReference }),
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1).optional(),
            "sec-fetch-site": z.literal("same-origin"),
          }),
        },
        responses: {
          200: {
            description: "Historical session with current access; not payment admission",
            content: content(CheckoutSessionResponse),
          },
          400: { description: "Invalid request", content: content(CheckoutSessionErrorBody) },
          404: {
            description: "Missing or inaccessible session without disclosure",
            content: content(CheckoutSessionErrorBody),
          },
          409: { description: "Owner conflict", content: content(CheckoutSessionErrorBody) },
          503: { description: "Service unavailable", content: content(CheckoutSessionErrorBody) },
          500: { description: "Safe transport failure", content: content(ErrorBody) },
        },
      });
      continue;
    }
    if (operationId === "createCheckoutSession") {
      const content = (
        schema: typeof CheckoutSessionResponse | typeof CheckoutSessionErrorBody | typeof ErrorBody,
      ) => ({ "application/json": { schema } });
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Ordering-owned CUST-CHECKOUT session creation. Current Guest/Store authorization and CSRF required. Responses are no-store/no-referrer. Retry the same idempotency key after an uncertain outcome. Historical creation does not grant current payment eligibility or renew the original validation deadline. Internal Guest/submission/payment operation IDs are excluded.",
        request: {
          params: z.object({ cart_id: QuoteReference }),
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "idempotency-key": QuoteReference,
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1),
            "sec-fetch-site": z.literal("same-origin"),
          }),
          body: {
            required: true,
            content: { "application/json": { schema: CheckoutSessionRequestBody } },
          },
        },
        responses: {
          200: {
            description: "Original currently authorized session recovered",
            content: content(CheckoutSessionResponse),
          },
          201: {
            description: "Session created; payment eligibility is separately checked",
            content: content(CheckoutSessionResponse),
          },
          400: {
            description: "Closed request rejected",
            content: content(CheckoutSessionErrorBody),
          },
          404: {
            description: "Current access or object unavailable without disclosure",
            content: content(CheckoutSessionErrorBody),
          },
          409: {
            description: "Original operation has a different intent",
            content: content(CheckoutSessionErrorBody),
          },
          503: {
            description: "Unavailable or uncertain; retry original key",
            content: content(CheckoutSessionErrorBody),
          },
          500: { description: "Safe transport failure", content: content(ErrorBody) },
        },
      });
      continue;
    }
    if (operationId === "submitCustomerOrder") {
      const content = (
        schema: typeof OrderSubmissionResponse | typeof OrderSubmissionError | typeof ErrorBody,
      ) => ({ "application/json": { schema } });
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Ordering-owned submission; customer_pwa CUST-CHECKOUT consumer. Current Guest/Store authorization and CSRF required. Restricted owner facts are projected to a minimal customer response. Responses use no-store and no-referrer; no browser persistence is granted. Replay the same idempotency-key while uncertain. Submitted/NotReported does not imply payment eligibility or payment success. Existing operation history is immutable; no deprecation is planned.",
        request: {
          cookies: z.object({ "__Host-bop-guest": z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
          headers: z.object({
            "idempotency-key": QuoteReference,
            "x-csrf-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
            origin: z.string().min(1),
            "sec-fetch-site": z.literal("same-origin"),
          }),
          body: {
            required: true,
            content: { "application/json": { schema: OrderSubmissionRequest } },
          },
        },
        responses: {
          200: {
            description: "Original authorized submission recovered",
            content: content(OrderSubmissionResponse),
          },
          201: {
            description: "Order created; payment not reported",
            content: content(OrderSubmissionResponse),
          },
          400: { description: "Closed request rejected", content: content(OrderSubmissionError) },
          404: {
            description: "Current access or object unavailable without disclosure",
            content: content(OrderSubmissionError),
          },
          409: {
            description: "Version or idempotency conflict",
            content: content(OrderSubmissionError),
          },
          422: {
            description: "Current selection or quote requires review",
            content: content(OrderSubmissionError),
          },
          503: {
            description: "Unavailable or uncertain; retry original submission",
            content: content(OrderSubmissionError),
          },
          500: { description: "Safe transport failure", content: content(ErrorBody) },
        },
      });
      continue;
    }
    if (operationId === "receiveStripeWebhook") {
      // DEC-STRIPE-PILOT-WIRING: Stripe's signed callback, not a customer or merchant route.
      const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Stripe webhook endpoint (Payment Webhook Inbox). The exact raw bytes are verified against the Stripe-Signature header (current or next signing secret, five-minute tolerance) before anything is stored; the event's livemode must equal the installation's Provider environment. Deduplicated by Provider event ID, so no Idempotency-Key: Stripe redelivers after any non-2xx answer. 200 means durably accepted and processed. Raw evidence is Restricted and kept 30 days. No body, signature, key or Provider ID is logged or echoed.",
        request: {
          headers: z.object({
            "stripe-signature": z.string().min(1).max(8192),
            "content-type": z.literal("application/json"),
          }),
          body: {
            required: true,
            description: "Stripe event JSON, read as raw bytes (at most 1 MiB)",
            content: json(z.object({}).passthrough()),
          },
        },
        responses: {
          200: {
            description: "Event accepted and processed (or already processed)",
            headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
            content: json(
              z
                .object({ received: z.literal(true) })
                .strict()
                .openapi("ProviderWebhookAccepted"),
            ),
          },
          400: {
            description:
              "Signature, timestamp, environment or payload invalid; redelivery cannot succeed",
            content: json(ErrorBody),
          },
          503: {
            description: "Dependency unavailable; Stripe redelivers (Retry-After: 30)",
            headers: { "Retry-After": { schema: { type: "string", enum: ["30"] } } },
            content: json(ErrorBody),
          },
          500: {
            description: "Safe internal failure; Stripe redelivers",
            content: json(ErrorBody),
          },
        },
      });
      continue;
    }
    if (operationId === "receiveNotificationFeedback") {
      // DEC-PILOT-NOTIFICATIONS: the SNS HTTPS subscription for SES bounces and complaints.
      const Outcome = z
        .object({
          outcome: z.enum([
            "authorized",
            "failed",
            "forbidden",
            "rejected",
            "retry",
            "unauthenticated",
            "unavailable",
          ]),
        })
        .strict()
        .openapi("NotificationFeedbackOutcome");
      const json = { "application/json": { schema: Outcome } };
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Amazon SNS HTTPS subscription for Amazon SES bounce and complaint feedback. SNS posts JSON as text/plain; the message is authenticated (SNS signature version 2, fixed topic) before anything is stored, and only SubscriptionConfirmation for that topic is confirmed. Deduplicated by SNS message ID, so no Idempotency-Key. 404 while customer messages are not configured. Bodies and addresses are never logged or echoed.",
        request: {
          headers: z.object({
            "x-amz-sns-message-type": z.enum([
              "Notification",
              "SubscriptionConfirmation",
              "UnsubscribeConfirmation",
            ]),
          }),
          body: {
            required: true,
            description: "SNS message JSON sent as text/plain (at most 128 KiB)",
            content: { "text/plain": { schema: z.string().max(131072) } },
          },
        },
        responses: {
          200: { description: "Authenticated and recorded (or already recorded)", content: json },
          400: { description: "Malformed message", content: json },
          403: { description: "Signature or topic not accepted", content: json },
          404: { description: "Customer messages are not configured", content: json },
          413: { description: "Message too large", content: json },
          503: { description: "Dependency unavailable; SNS retries", content: json },
          500: {
            description: "Safe internal failure; SNS retries",
            content: { "application/json": { schema: ErrorBody } },
          },
        },
      });
      continue;
    }
    if (operationId === "getCustomerOrderMessageOptions") {
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "Which customer order-message channels can actually send now (DEC-PILOT-NOTIFICATIONS). Checkout offers a contact purpose only when it will really be used; unknown means nothing is offered. No query, no personal data. Response is no-store/no-referrer.",
        responses: {
          200: {
            description: "Channels that can send now",
            headers: {
              "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
              "Referrer-Policy": { schema: { type: "string", enum: ["no-referrer"] } },
            },
            content: {
              "application/json": {
                schema: z
                  .object({
                    schemaVersion: z.literal(1),
                    orderMessages: z.object({ sms: z.boolean(), email: z.boolean() }).strict(),
                  })
                  .strict()
                  .openapi("CustomerOrderMessageOptions"),
              },
            },
          },
          400: {
            description: "Query parameters are not accepted",
            content: {
              "application/json": {
                schema: z
                  .object({
                    schemaVersion: z.literal(1),
                    error: z.object({ code: z.literal("request_invalid") }).strict(),
                  })
                  .strict(),
              },
            },
          },
          500: {
            description: "Safe internal failure",
            content: { "application/json": { schema: ErrorBody } },
          },
        },
      });
      continue;
    }
    if (operationId === "getCustomerStoreProfile") {
      const localTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/u);
      const error = z
        .object({
          schemaVersion: z.literal(1),
          error: z
            .object({
              code: z.enum(["store_request_invalid", "session_unavailable", "store_unavailable"]),
            })
            .strict(),
        })
        .strict()
        .openapi("CustomerStoreProfileError");
      const noStore = {
        "Cache-Control": { schema: { type: "string" as const, enum: ["no-store"] } },
      };
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "WP-2423: the Guest Session's own Store as the start and menu pages show it — the published public profile (name, address, business phone; DEC-STORE-CUSTOMER-NAME) and, from the published operating reader the entry gate uses, whether it is open now with today's hours. Authenticated by the guest cookie only (read-only, same-origin); no query; no guest, staff or order data. All fields are Public classification, so the response may be kept by this browser for 30 seconds. No pickup ready time is given: none is computed by any owner.",
        responses: {
          200: {
            description:
              "The Store's public identity and today's hours (hours null when unreadable)",
            headers: {
              "Cache-Control": { schema: { type: "string", enum: ["private, max-age=30"] } },
              "Referrer-Policy": { schema: { type: "string", enum: ["no-referrer"] } },
            },
            content: {
              "application/json": {
                schema: z
                  .object({
                    schemaVersion: z.literal(1),
                    store: z
                      .object({
                        storeDisplayName: z.string().min(1),
                        brandDisplayName: z.string().min(1),
                        timeZone: z.string().min(1),
                        address: z
                          .object({
                            addressLines: z.array(z.string().min(1)).min(1).max(3),
                            locality: z.string().min(1),
                            regionCode: z.string().min(1),
                            postalCode: z.string().min(1),
                            countryCode: z.string().regex(/^[A-Z]{2}$/u),
                          })
                          .strict(),
                        phone: z
                          .string()
                          .regex(/^\+[1-9][0-9]{6,14}$/u)
                          .nullable(),
                        hours: z
                          .object({
                            status: z.enum(["Open", "Closed", "Paused"]),
                            todayHours: z.array(
                              z
                                .object({
                                  startLocalTime: localTime,
                                  endLocalTime: localTime,
                                  endsNextDay: z.boolean(),
                                })
                                .strict(),
                            ),
                            closesAt: localTime.nullable(),
                            opensAt: localTime.nullable(),
                          })
                          .strict()
                          .nullable(),
                      })
                      .strict(),
                  })
                  .strict()
                  .openapi("CustomerStoreProfile"),
              },
            },
          },
          400: {
            description: "Cross-site request or query parameters",
            headers: noStore,
            content: { "application/json": { schema: error } },
          },
          401: {
            description: "No current Guest Session",
            headers: noStore,
            content: { "application/json": { schema: error } },
          },
          503: {
            description: "The Store's published profile is unavailable; retry",
            headers: noStore,
            content: { "application/json": { schema: error } },
          },
          500: {
            description: "Safe internal failure",
            content: { "application/json": { schema: ErrorBody } },
          },
        },
      });
      continue;
    }
    if (operationId === "consumeCustomerOrderLink") {
      const error = z
        .object({
          schemaVersion: z.literal(1),
          error: z
            .object({
              code: z.enum([
                "order_link_unavailable",
                "order_link_rate_limited",
                "order_link_service_unavailable",
              ]),
            })
            .strict(),
        })
        .strict()
        .openapi("CustomerOrderLinkError");
      const json = { "application/json": { schema: error } };
      registry.registerPath({
        method,
        path,
        operationId,
        description:
          "IDR-0031 one-time order link (DEC-PILOT-NOTIFICATIONS R1). The page reads the 256-bit token from the URL fragment, clears the address bar and sends it once in this body. Success re-keys the Order's own Guest Session (Set-Cookie) and returns only the order path; the link and its siblings stop working. Every invalid, used or expired link gets the same answer. The single-use token is the idempotency control, so no Idempotency-Key. Never logged or echoed.",
        request: {
          headers: z.object({
            origin: z.string().min(1),
            "sec-fetch-site": z.literal("same-origin"),
          }),
          body: {
            required: true,
            content: {
              "application/json": {
                schema: z
                  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
                  .strict()
                  .openapi("CustomerOrderLinkRequest"),
              },
            },
          },
        },
        responses: {
          200: {
            description: "Order reopened in this browser",
            headers: {
              "Set-Cookie": { schema: { type: "string" }, description: "__Host-bop-guest" },
              "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
            },
            content: {
              "application/json": {
                schema: z
                  .object({
                    schemaVersion: z.literal(1),
                    redirectPath: z
                      .string()
                      .regex(
                        /^\/orders\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
                      ),
                  })
                  .strict()
                  .openapi("CustomerOrderLinkResult"),
              },
            },
          },
          400: { description: "Link unavailable (uniform answer)", content: json },
          429: { description: "Too many tries; Retry-After in seconds", content: json },
          503: { description: "Service unavailable; Retry-After: 30", content: json },
          500: {
            description: "Safe internal failure",
            content: { "application/json": { schema: ErrorBody } },
          },
        },
      });
      continue;
    }
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
