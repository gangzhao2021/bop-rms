import {
  createCustomerSessionBootstrapHandler,
  customerSessionBootstrapRoute,
} from "./customer-session-bootstrap.js";
import {
  customerPickupCodeRoute,
  type CustomerPickupCodeHandler,
  unavailableCustomerPickupCodeHandler,
} from "./customer-pickup-code.js";
import {
  customerReceiptRoute,
  CustomerReceiptHandler,
  unavailableCustomerReceiptHandler,
} from "./customer-receipt.js";
import {
  customerOrderStatusRoute,
  type CustomerOrderStatusHandler,
  unavailableCustomerOrderStatusHandler,
} from "./customer-order-status.js";
import {
  CustomerPaymentResultHandler,
  customerPaymentResultRoute,
  unavailableCustomerPaymentResultHandler,
} from "./customer-payment-result.js";
import {
  CustomerPaymentHandoffHandler,
  customerPaymentHandoffRoute,
  unavailableCustomerPaymentHandoffHandler,
} from "./customer-payment-handoff.js";
import {
  CustomerPaymentIntentHandler,
  customerPaymentIntentRoute,
  unavailableCustomerPaymentIntentHandler,
} from "./customer-payment-intent.js";
import {
  CustomerCheckoutSessionHandler,
  CustomerCheckoutSessionReadHandler,
  customerCheckoutSessionReadRoute,
  customerCheckoutSessionRoute,
  unavailableCustomerCheckoutSessionHandler,
} from "./customer-checkout-session.js";
import {
  customerCheckoutDetailsRoute,
  customerCheckoutDetailsCurrentRoute,
  customerCheckoutPolicyRoute,
  type CustomerCheckoutDetailsHandler,
  unavailableCustomerCheckoutDetailsHandler,
} from "./customer-checkout-details.js";
import {
  customerOrderSubmissionRoute,
  type CustomerOrderSubmissionHandler,
  unavailableCustomerOrderSubmissionHandler,
} from "./customer-order-submission.js";
import {
  CustomerDiningJoinHandler,
  customerDiningJoinRoute,
  unavailableCustomerDiningJoinHandler,
} from "./customer-dining-join.js";
import {
  CustomerDiningBindingHandler,
  customerDiningBindingRoutes,
  unavailableCustomerDiningBindingHandler,
} from "./customer-dining-binding.js";
import {
  CustomerCartBindingHandler,
  customerCartBindingRoutes,
  unavailableCustomerCartBindingHandler,
} from "./customer-cart-binding.js";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { CoreTelemetry } from "@bop-rms/observability";
import {
  sendInvalidCustomerEntryRequest,
  type CustomerEntryHandler,
  unavailableCustomerEntryHandler,
} from "./customer-entry.js";
import {
  type CustomerCartHandler,
  customerCartRoutes,
  unavailableCustomerCartHandler,
} from "./customer-cart.js";
import { type CustomerMenuHandler, unavailableCustomerMenuHandler } from "./customer-menu.js";
import { type CustomerQuoteHandler, unavailableCustomerQuoteHandler } from "./customer-quote.js";
import { apiRouteTemplates } from "./http-route-templates.js";
import { merchantBrandApplicationRoutes } from "./merchant-brand-application.js";
import { HealthReadinessController } from "./health-readiness.js";
import {
  createHttpRequestLimitMiddleware,
  createHttpSecurityHeadersMiddleware,
  type DeploymentEnvironment,
} from "./http-security.js";
import {
  createUnavailableMerchantCatalogRouter,
  type MerchantCatalogRouterOptions,
  createMerchantCatalogRouter,
} from "./merchant-catalog.js";
import { createMerchantBffRouter, type MerchantBffRouterOptions } from "./merchant-bff.js";
import {
  createMerchantBrandAdministrationRouter,
  type MerchantBrandAdministrationHttpOptions,
} from "./merchant-brand-administration-http.js";
import {
  createPlatformAuthenticationRouter,
  type PlatformAuthenticationHttpOptions,
} from "./platform-authentication-http.js";
import {
  createPlatformTemplateAdministrationRouter,
  type PlatformTemplateAdministrationHttpOptions,
} from "./platform-template-administration-http.js";
import { type RealtimeTransport, unavailableRealtimeHandler } from "./realtime.js";
import {
  createRequestCorrelationMiddleware,
  getRequestCorrelationContext,
  markRequestError,
  type RequestCompletionLogger,
} from "./request-correlation.js";

export interface RequestErrorLogger {
  error(input: {
    readonly error: { readonly code: "INTERNAL_ERROR"; readonly value: unknown };
    readonly event: "http_request_failed";
    readonly resultCode: "INTERNAL_ERROR";
    readonly trustedContext: { readonly correlationId: string };
  }): void;
}

export interface AppOptions {
  correlationAcceptanceHandler?: RequestHandler;
  customerCart?: CustomerCartHandler;
  customerCartBinding?: CustomerCartBindingHandler;
  customerDiningJoin?: CustomerDiningJoinHandler;
  customerDiningBinding?: CustomerDiningBindingHandler;
  customerEntry?: CustomerEntryHandler;
  customerMenu?: CustomerMenuHandler;
  customerPaymentIntent?: CustomerPaymentIntentHandler;
  customerPaymentHandoff?: CustomerPaymentHandoffHandler;
  customerPaymentResult?: CustomerPaymentResultHandler;
  customerQuote?: CustomerQuoteHandler;
  customerCheckoutSessionRead?: CustomerCheckoutSessionReadHandler;
  customerCheckoutSession?: CustomerCheckoutSessionHandler;
  customerOrderSubmission?: CustomerOrderSubmissionHandler;
  customerOrderStatus?: CustomerOrderStatusHandler;
  customerSessionBootstrap?: ReturnType<typeof createCustomerSessionBootstrapHandler>;
  customerPickupCode?: CustomerPickupCodeHandler;
  customerReceipt?: CustomerReceiptHandler;
  customerCheckoutDetails?: CustomerCheckoutDetailsHandler;
  deploymentEnvironment?: DeploymentEnvironment;
  errorLogger?: RequestErrorLogger;
  healthReadiness?: HealthReadinessController;
  merchantCatalog?: MerchantCatalogRouterOptions;
  merchantBff?: MerchantBffRouterOptions;
  brandAdministration?: MerchantBrandAdministrationHttpOptions;
  brandApplication?: RequestHandler;
  platformAuthentication?: PlatformAuthenticationHttpOptions;
  platformTemplateAdministration?: PlatformTemplateAdministrationHttpOptions;
  now?: () => string;
  nowMilliseconds?: () => number;
  realtime?: RealtimeTransport;
  requestLogger?: RequestCompletionLogger;
  telemetry?: CoreTelemetry;
  uuidV7Factory?: () => string;
}

function createErrorHandler(errorLogger: RequestErrorLogger | undefined): ErrorRequestHandler {
  return (error, request, response, next) => {
    void next;
    const candidate = error as { status?: number; type?: string };
    if (
      request.originalUrl === "/bff/customer/entry" &&
      (candidate.type === "entity.too.large" || candidate.status === 400)
    ) {
      sendInvalidCustomerEntryRequest(response);
      return;
    }
    const status =
      candidate.type === "entity.too.large" ? 413 : candidate.status === 400 ? 400 : 500;
    if (status === 500) {
      markRequestError(request, "INTERNAL_ERROR");
      try {
        errorLogger?.error({
          error: { code: "INTERNAL_ERROR", value: error },
          event: "http_request_failed",
          resultCode: "INTERNAL_ERROR",
          trustedContext: getRequestCorrelationContext(request).correlation,
        });
      } catch {
        // Error response and business control flow never depend on observability.
      }
    }
    response.status(status).json({
      error: {
        code:
          status === 413 ? "payload_too_large" : status === 400 ? "invalid_json" : "internal_error",
        message:
          status >= 500 ? "The request could not be completed." : "The request was rejected.",
      },
    });
  };
}

export function createApp({
  correlationAcceptanceHandler,
  customerCart,
  customerCartBinding,
  customerDiningJoin,
  customerDiningBinding,
  customerEntry,
  customerMenu,
  customerPaymentIntent,
  customerPaymentHandoff,
  customerPaymentResult,
  customerQuote,
  customerCheckoutSessionRead,
  customerCheckoutSession,
  customerOrderSubmission,
  customerOrderStatus,
  customerSessionBootstrap,
  customerPickupCode,
  customerReceipt,
  customerCheckoutDetails,
  deploymentEnvironment = "development",
  errorLogger,
  healthReadiness,
  merchantCatalog,
  merchantBff,
  brandAdministration,
  brandApplication,
  platformAuthentication,
  platformTemplateAdministration,
  now = () => new Date().toISOString(),
  nowMilliseconds,
  realtime,
  requestLogger,
  telemetry,
  uuidV7Factory,
}: AppOptions = {}): Express {
  const app = express();
  const health = healthReadiness ?? new HealthReadinessController({ now });
  app.disable("x-powered-by");
  app.use(
    createRequestCorrelationMiddleware({
      ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
      ...(requestLogger === undefined ? {} : { logger: requestLogger }),
      routeTemplates: apiRouteTemplates,
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(uuidV7Factory === undefined ? {} : { uuidV7Factory }),
    }),
  );
  app.use(...createHttpSecurityHeadersMiddleware(deploymentEnvironment));
  app.use(createHttpRequestLimitMiddleware());
  if (platformAuthentication !== undefined)
    app.use("/platform/auth", createPlatformAuthenticationRouter(platformAuthentication));
  if (platformTemplateAdministration !== undefined)
    app.use(
      "/platform/templates",
      createPlatformTemplateAdministrationRouter(platformTemplateAdministration),
    );
  if (brandAdministration !== undefined)
    app.use(
      "/merchant/organization/brands",
      createMerchantBrandAdministrationRouter(brandAdministration),
    );
  if (merchantBff !== undefined) app.use("/merchant", createMerchantBffRouter(merchantBff));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_request, response) => response.status(200).json(health.healthSnapshot()));
  app.get("/ready", async (_request, response) => {
    const snapshot = await health.readinessSnapshot();
    response.status(snapshot.status === "ready" ? 200 : 503).json(snapshot);
  });
  app.get("/bff/realtime", realtime?.handler() ?? unavailableRealtimeHandler);
  app.post("/bff/customer/entry", customerEntry?.handler() ?? unavailableCustomerEntryHandler);
  app.post(
    customerCartBindingRoutes.prepare,
    customerCartBinding?.prepare() ?? unavailableCustomerCartBindingHandler,
  );
  app.post(
    customerCartBindingRoutes.activate,
    customerCartBinding?.activate() ?? unavailableCustomerCartBindingHandler,
  );
  app.post(
    customerCartBindingRoutes.complete,
    customerCartBinding?.complete() ?? unavailableCustomerCartBindingHandler,
  );

  app.post(
    customerDiningJoinRoute,
    customerDiningJoin?.join() ?? unavailableCustomerDiningJoinHandler,
  );
  app.post(
    customerDiningBindingRoutes.prepare,
    customerDiningBinding?.prepare() ?? unavailableCustomerDiningBindingHandler,
  );
  app.post(
    customerDiningBindingRoutes.activate,
    customerDiningBinding?.activate() ?? unavailableCustomerDiningBindingHandler,
  );
  app.post(
    customerDiningBindingRoutes.complete,
    customerDiningBinding?.complete() ?? unavailableCustomerDiningBindingHandler,
  );
  app.get(customerCartRoutes.current, customerCart?.current() ?? unavailableCustomerCartHandler);
  app.get(
    "/api/v1/public/stores/:store_public_id/menu",
    customerMenu?.handler() ?? unavailableCustomerMenuHandler,
  );
  app.post(customerCartRoutes.create, customerCart?.create() ?? unavailableCustomerCartHandler);
  app.post(
    customerCartRoutes.replacement,
    customerCart?.replace() ?? unavailableCustomerCartHandler,
  );
  app.get(customerCartRoutes.read, customerCart?.read() ?? unavailableCustomerCartHandler);
  app.post(customerCartRoutes.addItem, customerCart?.addItem() ?? unavailableCustomerCartHandler);
  app.patch(
    customerCartRoutes.updateItem,
    customerCart?.updateItem() ?? unavailableCustomerCartHandler,
  );
  app.delete(
    customerCartRoutes.removeItem,
    customerCart?.removeItem() ?? unavailableCustomerCartHandler,
  );
  app.post(
    customerCheckoutPolicyRoute,
    customerCheckoutDetails?.policy() ?? unavailableCustomerCheckoutDetailsHandler,
  );
  app.post(
    customerCheckoutDetailsCurrentRoute,
    customerCheckoutDetails?.current() ?? unavailableCustomerCheckoutDetailsHandler,
  );
  app.post(
    customerCheckoutDetailsRoute,
    customerCheckoutDetails?.handler() ?? unavailableCustomerCheckoutDetailsHandler,
  );
  app.get(
    customerPaymentResultRoute,
    customerPaymentResult?.handler() ?? unavailableCustomerPaymentResultHandler,
  );
  app.post(
    customerPaymentHandoffRoute,
    customerPaymentHandoff?.handler() ?? unavailableCustomerPaymentHandoffHandler,
  );
  app.post(
    customerPaymentIntentRoute,
    customerPaymentIntent?.handler() ?? unavailableCustomerPaymentIntentHandler,
  );
  app.get(
    customerCheckoutSessionReadRoute,
    customerCheckoutSessionRead?.handler() ?? unavailableCustomerCheckoutSessionHandler,
  );
  app.post(
    customerCheckoutSessionRoute,
    customerCheckoutSession?.handler() ?? unavailableCustomerCheckoutSessionHandler,
  );
  app.get(
    customerSessionBootstrapRoute,
    customerSessionBootstrap ?? createCustomerSessionBootstrapHandler(),
  );
  app.get(
    customerPickupCodeRoute,
    customerPickupCode?.handler() ?? unavailableCustomerPickupCodeHandler,
  );
  app.get(customerReceiptRoute, customerReceipt?.handler() ?? unavailableCustomerReceiptHandler);
  app.get(
    customerOrderStatusRoute,
    customerOrderStatus?.handler() ?? unavailableCustomerOrderStatusHandler,
  );
  app.post(
    customerOrderSubmissionRoute,
    customerOrderSubmission?.handler() ?? unavailableCustomerOrderSubmissionHandler,
  );
  app.post(
    "/api/v1/carts/:cart_id/quote",
    customerQuote?.handler() ?? unavailableCustomerQuoteHandler,
  );
  app.use(
    merchantCatalog === undefined
      ? createUnavailableMerchantCatalogRouter()
      : createMerchantCatalogRouter(merchantCatalog),
  );
  if (correlationAcceptanceHandler !== undefined)
    app.post("/__acceptance/request-command-event", correlationAcceptanceHandler);
  if (brandApplication !== undefined) {
    for (const route of merchantBrandApplicationRoutes) app.all(route, brandApplication);
    app.use(brandApplication);
  }
  app.use((_request, response) =>
    response
      .status(404)
      .json({ error: { code: "not_found", message: "The requested resource is unavailable." } }),
  );
  app.use(createErrorHandler(errorLogger));
  return app;
}
