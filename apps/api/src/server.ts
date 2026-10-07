import {
  createCustomerSessionBootstrapHandler,
  createCustomerSessionBootstrapRead,
} from "./customer-session-bootstrap.js";
import { createCustomerPickupCodeRead } from "./customer-pickup-code-read.js";
import { CustomerPickupCodeHandler } from "./customer-pickup-code.js";
import type { CustomerPaymentIntentHandler } from "./customer-payment-intent.js";
import { loadApiProcessConfiguration } from "./process-configuration.js";
import type { CustomerOrderSubmissionHandler } from "./customer-order-submission.js";
import type { CustomerCheckoutDetailsHandler } from "./customer-checkout-details.js";
import { createMerchantRuntime, type MerchantRuntimeOptions } from "./merchant-runtime.js";
import {
  createMerchantBrandAdministrationRuntime,
  createCognitoMerchantBrandAdministrationRuntime,
  type CognitoMerchantBrandAdministrationRuntimeOptions,
  type MerchantBrandAdministrationRuntimeOptions,
} from "./merchant-brand-administration-runtime.js";
import type { MerchantBrandAdministrationHttpOptions } from "./merchant-brand-administration-http.js";
import {
  createPlatformAuthenticationRuntime,
  createCognitoPlatformAuthenticationRuntime,
  type CognitoPlatformAuthenticationRuntimeOptions,
  type PlatformAuthenticationRuntimeOptions,
} from "./platform-authentication-runtime.js";
import type { PlatformAuthenticationHttpOptions } from "./platform-authentication-http.js";
import type { PlatformTemplateAdministrationHttpOptions } from "./platform-template-administration-http.js";
import { createCustomerReceiptRead } from "./customer-receipt-read.js";
import { CustomerReceiptHandler } from "./customer-receipt.js";
import { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import { CustomerOrderStatusHandler } from "./customer-order-status.js";
import {
  createCustomerPaymentResultHandler,
  type CustomerPaymentResultRuntimeOptions,
} from "./customer-payment-result-runtime.js";
import {
  createCustomerPaymentHandoffHandler,
  type CustomerPaymentHandoffRuntimeOptions,
} from "./customer-payment-handoff-runtime.js";
import {
  createCustomerPaymentIntentHandler,
  type CustomerPaymentIntentRuntimeOptions,
} from "./customer-payment-intent-runtime.js";
import {
  createCustomerCheckoutSessionHandlers,
  type CustomerCheckoutSessionRuntimeOptions,
} from "./customer-checkout-session-runtime.js";
import type { CustomerDiningJoinHandler } from "./customer-dining-join.js";
import type { CustomerDiningBindingHandler } from "./customer-dining-binding.js";
import type { CustomerCartBindingHandler } from "./customer-cart-binding.js";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { RequestHandler } from "express";
import { pathToFileURL } from "node:url";
import {
  createCoreTelemetry,
  createNodeTelemetryRuntime,
  createStructuredLogger,
  type CoreTelemetry,
  type CoreTelemetryOptions,
  type LoggerEnvironment,
  type NodeTelemetryRuntime,
  type StructuredLogDestination,
  type StructuredLogger,
} from "@bop-rms/observability";
import { createApp } from "./app.js";
import { apiRouteTemplates } from "./http-route-templates.js";
import type { CustomerCartHandler } from "./customer-cart.js";
import type { CustomerEntryHandler } from "./customer-entry.js";
import type { CustomerMenuHandler } from "./customer-menu.js";
import type { CustomerQuoteHandler } from "./customer-quote.js";
import { HealthReadinessController } from "./health-readiness.js";
import type { MerchantBffRouterOptions } from "./merchant-bff.js";
import type { MerchantCatalogRouterOptions } from "./merchant-catalog.js";
import type { RealtimeTransport } from "./realtime.js";

const apiLogEvents = [
  "http_request_completed",
  "http_request_failed",
  "listening",
  "startup_failed",
  "shutdown_complete",
  "shutdown_failed",
  "shutdown_started",
  "telemetry_shutdown_failed",
] as const;

function runtimeEnvironment(): LoggerEnvironment {
  return (process.env.NODE_ENV ?? "development") as LoggerEnvironment;
}

export function createApiRuntimeLogger(destination?: StructuredLogDestination) {
  return createStructuredLogger(
    {
      allowedEvents: apiLogEvents,
      environment: runtimeEnvironment(),
      module: "api-runtime",
      service: "bop-rms-api",
    },
    destination === undefined ? {} : { destination },
  );
}

export interface ApiServerRuntime {
  healthReadiness: HealthReadinessController;
  listen: () => Promise<void>;
  server: Server;
  shutdown: (signal: "SIGINT" | "SIGTERM") => Promise<void>;
}

export interface ApiServerRuntimeOptions {
  coreTelemetry?: CoreTelemetry;
  customerCart?: CustomerCartHandler;
  customerCartBinding?: CustomerCartBindingHandler;
  customerDiningJoin?: CustomerDiningJoinHandler;
  customerDiningBinding?: CustomerDiningBindingHandler;
  customerEntry?: CustomerEntryHandler;
  customerMenu?: CustomerMenuHandler;
  customerQuote?: CustomerQuoteHandler;
  customerCheckoutSessions?: CustomerCheckoutSessionRuntimeOptions;
  customerOrderSubmission?: CustomerOrderSubmissionHandler;
  customerCheckoutDetails?: CustomerCheckoutDetailsHandler;
  customerPaymentIntent?: CustomerPaymentIntentRuntimeOptions;
  customerPaymentIntentHandler?: CustomerPaymentIntentHandler;
  customerPaymentHandoff?: CustomerPaymentHandoffRuntimeOptions;
  customerPaymentResult?: CustomerPaymentResultRuntimeOptions;
  customerReceipt?: Parameters<typeof createCustomerReceiptRead>[0] & { allowedOrigin: string };
  customerSessionBootstrap?: Parameters<typeof createCustomerSessionBootstrapRead>[0] & {
    allowedOrigin: string;
  };
  customerPickupCode?: Parameters<typeof createCustomerPickupCodeRead>[0] & {
    allowedOrigin: string;
  };
  customerOrderStatus?: Parameters<typeof createCustomerOrderStatusRead>[0] & {
    allowedOrigin: string;
  };
  healthReadiness?: HealthReadinessController;
  host?: string;
  logger?: StructuredLogger;
  merchantCatalog?: MerchantCatalogRouterOptions;
  merchantBff?: MerchantBffRouterOptions;
  merchantRuntime?: MerchantRuntimeOptions;
  brandAdministration?: MerchantBrandAdministrationHttpOptions;
  brandApplication?: RequestHandler;
  tls?: Readonly<{ key: string; cert: string }>;
  brandAdministrationRuntime?: MerchantBrandAdministrationRuntimeOptions;
  brandCognitoAdministrationRuntime?: CognitoMerchantBrandAdministrationRuntimeOptions;
  platformAuthentication?: PlatformAuthenticationHttpOptions;
  platformAuthenticationRuntime?: PlatformAuthenticationRuntimeOptions;
  platformCognitoAuthenticationRuntime?: CognitoPlatformAuthenticationRuntimeOptions;
  platformTemplateAdministration?: PlatformTemplateAdministrationHttpOptions;
  nodeTelemetry?: NodeTelemetryRuntime;
  nowMilliseconds?: () => number;
  port?: number;
  realtime?: RealtimeTransport;
}

export function createApiCoreTelemetry(options: CoreTelemetryOptions = {}): CoreTelemetry {
  return createCoreTelemetry(
    {
      allowedErrorCodes: ["API_SHUTDOWN_FAILED", "API_START_FAILED", "INTERNAL_ERROR"],
      allowedOperations: ["api_shutdown", "api_startup", "http_request"],
      allowedResultCodes: [
        "API_SHUTDOWN_FAILED",
        "API_START_FAILED",
        "HTTP_CLIENT_ERROR",
        "HTTP_SERVER_ERROR",
        "HTTP_SUCCESS",
        "SUCCESS",
      ],
      environment: runtimeEnvironment(),
      module: "api-runtime",
      routes: apiRouteTemplates,
      service: "bop-rms-api",
    },
    options,
  );
}

function runtimeDuration(startedAt: number, completedAt: number): number {
  const duration = completedAt - startedAt;
  if (!Number.isFinite(duration)) return 0;
  return Math.min(86_400_000, Math.max(0, Math.trunc(duration)));
}

export function createApiServerRuntime({
  coreTelemetry = createApiCoreTelemetry(),
  customerCart,
  customerCartBinding,
  customerDiningJoin,
  customerDiningBinding,
  customerEntry,
  customerMenu,
  customerQuote,
  customerCheckoutSessions,
  customerOrderSubmission,
  customerCheckoutDetails,
  customerPaymentIntent,
  customerPaymentIntentHandler,
  customerPaymentHandoff,
  customerPaymentResult,
  customerOrderStatus,
  customerSessionBootstrap,
  customerPickupCode,
  customerReceipt,
  healthReadiness = new HealthReadinessController(),
  host = "127.0.0.1",
  logger = createApiRuntimeLogger(),
  merchantCatalog,
  merchantBff,
  merchantRuntime,
  brandAdministration,
  brandApplication,
  tls,
  brandAdministrationRuntime,
  brandCognitoAdministrationRuntime,
  platformAuthentication,
  platformAuthenticationRuntime,
  platformCognitoAuthenticationRuntime,
  platformTemplateAdministration,
  nodeTelemetry = createNodeTelemetryRuntime({
    environment: runtimeEnvironment(),
    serviceName: "bop-rms-api",
  }),
  nowMilliseconds = Date.now,
  port = 3000,
  realtime,
}: ApiServerRuntimeOptions = {}): ApiServerRuntime {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("port must be an integer from 0 to 65535");
  if (merchantBff !== undefined && merchantRuntime !== undefined)
    throw new Error("MERCHANT_RUNTIME_CONFIGURATION_CONFLICT");
  if (
    [brandAdministration, brandAdministrationRuntime, brandCognitoAdministrationRuntime].filter(
      (value) => value !== undefined,
    ).length > 1
  )
    throw new Error("BRAND_ADMINISTRATION_RUNTIME_CONFIGURATION_CONFLICT");
  if (
    [
      platformAuthentication,
      platformAuthenticationRuntime,
      platformCognitoAuthenticationRuntime,
    ].filter((value) => value !== undefined).length > 1
  )
    throw new Error("PLATFORM_AUTHENTICATION_RUNTIME_CONFIGURATION_CONFLICT");
  if (
    platformTemplateAdministration !== undefined &&
    platformCognitoAuthenticationRuntime?.enableTemplateAdministration === true
  )
    throw new Error("PLATFORM_TEMPLATE_ADMINISTRATION_RUNTIME_CONFIGURATION_CONFLICT");
  if (customerPaymentIntent !== undefined && customerPaymentIntentHandler !== undefined)
    throw new Error("CUSTOMER_PAYMENT_INTENT_CONFIGURATION_CONFLICT");
  if (
    brandApplication !== undefined &&
    (typeof brandApplication !== "function" ||
      tls === undefined ||
      [brandAdministration, brandAdministrationRuntime, brandCognitoAdministrationRuntime].every(
        (value) => value === undefined,
      ))
  )
    throw new Error("BRAND_APPLICATION_CONFIGURATION_INVALID");
  if (
    tls !== undefined &&
    (tls === null ||
      typeof tls !== "object" ||
      typeof tls.key !== "string" ||
      typeof tls.cert !== "string" ||
      tls.key.length < 1 ||
      tls.cert.length < 1 ||
      tls.key.length > 65536 ||
      tls.cert.length > 65536 ||
      Object.keys(tls).sort().join(",") !== "cert,key")
  )
    throw new Error("API_TLS_CONFIGURATION_INVALID");
  const configuredMerchant =
    merchantRuntime === undefined ? merchantBff : createMerchantRuntime(merchantRuntime);
  const configuredBrand =
    brandCognitoAdministrationRuntime !== undefined
      ? createCognitoMerchantBrandAdministrationRuntime(brandCognitoAdministrationRuntime)
      : brandAdministrationRuntime === undefined
        ? brandAdministration
        : createMerchantBrandAdministrationRuntime(brandAdministrationRuntime);
  const concretePlatform =
    platformCognitoAuthenticationRuntime === undefined
      ? undefined
      : createCognitoPlatformAuthenticationRuntime(platformCognitoAuthenticationRuntime);
  const configuredPlatform =
    concretePlatform !== undefined
      ? concretePlatform
      : platformAuthenticationRuntime === undefined
        ? platformAuthentication
        : createPlatformAuthenticationRuntime(platformAuthenticationRuntime);
  const configuredPlatformTemplates =
    concretePlatform?.templateAdministration === undefined
      ? platformTemplateAdministration
      : {
          exactOrigin: concretePlatform.exactOrigin,
          acceptedHost: concretePlatform.acceptedHost,
          administration: concretePlatform.templateAdministration,
        };
  const application = createApp({
    ...(configuredBrand === undefined ? {} : { brandAdministration: configuredBrand }),
    ...(brandApplication === undefined ? {} : { brandApplication }),
    ...(configuredPlatform === undefined ? {} : { platformAuthentication: configuredPlatform }),
    ...(configuredPlatformTemplates === undefined
      ? {}
      : { platformTemplateAdministration: configuredPlatformTemplates }),
    ...(customerOrderSubmission === undefined ? {} : { customerOrderSubmission }),
    ...(customerCheckoutDetails === undefined ? {} : { customerCheckoutDetails }),
    ...(customerCart === undefined ? {} : { customerCart }),
    ...(customerCartBinding === undefined ? {} : { customerCartBinding }),
    ...(customerDiningJoin === undefined ? {} : { customerDiningJoin }),
    ...(customerDiningBinding === undefined ? {} : { customerDiningBinding }),
    ...(customerEntry === undefined ? {} : { customerEntry }),
    healthReadiness,
    ...(customerMenu === undefined ? {} : { customerMenu }),
    ...(customerQuote === undefined ? {} : { customerQuote }),
    ...(customerCheckoutSessions === undefined
      ? {}
      : createCustomerCheckoutSessionHandlers(customerCheckoutSessions)),
    ...(customerPaymentIntentHandler !== undefined
      ? { customerPaymentIntent: customerPaymentIntentHandler }
      : customerPaymentIntent === undefined
        ? {}
        : { customerPaymentIntent: createCustomerPaymentIntentHandler(customerPaymentIntent) }),
    ...(customerPaymentHandoff === undefined
      ? {}
      : { customerPaymentHandoff: createCustomerPaymentHandoffHandler(customerPaymentHandoff) }),
    ...(customerReceipt === undefined
      ? {}
      : {
          customerReceipt: new CustomerReceiptHandler({
            allowedOrigin: customerReceipt.allowedOrigin,
            port: createCustomerReceiptRead(customerReceipt),
          }),
        }),
    ...(customerSessionBootstrap === undefined
      ? {}
      : {
          customerSessionBootstrap: createCustomerSessionBootstrapHandler({
            allowedOrigin: customerSessionBootstrap.allowedOrigin,
            port: createCustomerSessionBootstrapRead(customerSessionBootstrap),
          }),
        }),
    ...(customerPickupCode === undefined
      ? {}
      : {
          customerPickupCode: new CustomerPickupCodeHandler({
            allowedOrigin: customerPickupCode.allowedOrigin,
            port: createCustomerPickupCodeRead(customerPickupCode),
          }),
        }),
    ...(customerOrderStatus === undefined
      ? {}
      : {
          customerOrderStatus: new CustomerOrderStatusHandler({
            allowedOrigin: customerOrderStatus.allowedOrigin,
            port: createCustomerOrderStatusRead(customerOrderStatus),
          }),
        }),
    ...(customerPaymentResult === undefined
      ? {}
      : { customerPaymentResult: createCustomerPaymentResultHandler(customerPaymentResult) }),
    deploymentEnvironment: runtimeEnvironment(),
    ...(merchantCatalog === undefined ? {} : { merchantCatalog }),
    ...(configuredMerchant === undefined ? {} : { merchantBff: configuredMerchant }),
    errorLogger: logger,
    nowMilliseconds,
    ...(realtime === undefined ? {} : { realtime }),
    requestLogger: logger,
    telemetry: coreTelemetry,
  });
  const server = (() => {
    if (tls === undefined) return createServer(application);
    try {
      return createHttpsServer(
        { key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" },
        application,
      );
    } catch {
      throw new Error("API_TLS_CONFIGURATION_INVALID");
    }
  })();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  let listenPromise: Promise<void> | undefined;
  const listen = (): Promise<void> => {
    if (listenPromise !== undefined) return listenPromise;
    listenPromise = Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            nodeTelemetry.start();
          } catch (error) {
            logger.error({
              error: { code: "API_START_FAILED", value: error },
              event: "startup_failed",
              resultCode: "API_START_FAILED",
            });
            reject(error);
            return;
          }
          const startedAt = nowMilliseconds();
          const telemetryOperation = coreTelemetry.startOperation("api_startup");
          const onError = (error: Error) => {
            server.off("listening", onListening);
            telemetryOperation.complete({
              durationMs: runtimeDuration(startedAt, nowMilliseconds()),
              errorCode: "API_START_FAILED",
              resultCode: "API_START_FAILED",
            });
            logger.error({
              error: { code: "API_START_FAILED", value: error },
              event: "startup_failed",
              resultCode: "API_START_FAILED",
            });
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            healthReadiness.completeStartup();
            telemetryOperation.complete({
              durationMs: runtimeDuration(startedAt, nowMilliseconds()),
              resultCode: "SUCCESS",
            });
            const address = server.address();
            logger.info({
              event: "listening",
              ...(address !== null && typeof address !== "string" ? { port: address.port } : {}),
              resultCode: "SUCCESS",
            });
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        }),
    );
    return listenPromise;
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    healthReadiness.beginDrain();
    logger.info({ event: "shutdown_started", signal });
    const startedAt = nowMilliseconds();
    const telemetryOperation = coreTelemetry.startOperation("api_shutdown");
    shutdownPromise = (async () => {
      let shutdownError: unknown;
      try {
        await realtime?.beginDrain();
      } catch (error) {
        shutdownError = error;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      } catch (error) {
        shutdownError ??= error;
      }
      if (shutdownError === undefined) {
        logger.info({ event: "shutdown_complete", resultCode: "SUCCESS" });
        telemetryOperation.complete({
          durationMs: runtimeDuration(startedAt, nowMilliseconds()),
          resultCode: "SUCCESS",
        });
      } else {
        logger.error({
          error: { code: "API_SHUTDOWN_FAILED", value: shutdownError },
          event: "shutdown_failed",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        telemetryOperation.complete({
          durationMs: runtimeDuration(startedAt, nowMilliseconds()),
          errorCode: "API_SHUTDOWN_FAILED",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
      }
      const telemetryShutdown = await nodeTelemetry.shutdown();
      if (telemetryShutdown === "failed" || telemetryShutdown === "timeout")
        logger.warn({
          event: "telemetry_shutdown_failed",
          resultCode: "TELEMETRY_SHUTDOWN_FAILED",
        });
      if (shutdownError !== undefined) throw shutdownError;
    })();
    return shutdownPromise;
  };

  return { healthReadiness, listen, server, shutdown };
}

export function startApiRuntime(configured?: ApiServerRuntime): void {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const runtime = configured ?? createApiServerRuntime({ port });
  process.once("SIGINT", () => void runtime.shutdown("SIGINT").catch(() => undefined));
  process.once("SIGTERM", () => void runtime.shutdown("SIGTERM").catch(() => undefined));
  void runtime.listen().catch(async () => {
    process.exitCode = 1;
    await runtime.shutdown("SIGTERM").catch(() => undefined);
  });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    const port = Number(process.env.PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT_INVALID");
    void loadApiProcessConfiguration(process.argv.slice(2), port)
      .then((runtime) => startApiRuntime(runtime))
      .catch(() => {
        createApiRuntimeLogger().error({ event: "startup_failed", resultCode: "API_START_FAILED" });
        process.exitCode = 1;
      });
  } catch {
    createApiRuntimeLogger().error({ event: "startup_failed", resultCode: "API_START_FAILED" });
    process.exitCode = 1;
  }
}
