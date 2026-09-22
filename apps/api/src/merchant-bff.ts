import type { createMerchantReconciliationAssigneeQuery } from "./merchant-reconciliation-assignee-query.js";
import { parseOpaqueUuidV7 } from "@bop/identity";
import type { createMerchantReconciliationEvidenceQuery } from "./merchant-reconciliation-evidence-query.js";
import type { createMerchantReconciliationFollowUpQuery } from "./merchant-reconciliation-follow-up-query.js";
import type { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
import { ReconciliationFollowUpError, PaymentReconciliationError } from "@rms/payment";
import type { createMerchantCompensationReconciliationQuery } from "./merchant-compensation-reconciliation-query.js";
import { BrowserSessionError, parseCanonicalInstant } from "@bop/identity";
import type { createMerchantCompensationReconciliationCommand } from "./merchant-compensation-reconciliation-command.js";
import type { createMerchantOrdinaryRefundSendCommand } from "./merchant-ordinary-refund-send-command.js";
import type { createMerchantOrdinaryRefundReconciliationCommand } from "./merchant-ordinary-refund-reconciliation-command.js";
import type { createMerchantDiningHostSelection } from "./merchant-dining-host-selection.js";
import type { createMerchantDiningHostTransfer } from "./merchant-dining-host-transfer.js";
import type { createMerchantOrdinaryRefundStatus } from "./merchant-ordinary-refund-status.js";
import type { createMerchantRefundPaymentContext } from "./merchant-refund-payment-context.js";
import type { createMerchantOrdinaryRefundItems } from "./merchant-ordinary-refund-items.js";
import type { createMerchantOrdinaryRefundRequest } from "./merchant-ordinary-refund-request.js";
import type { createMerchantDiningJoinState } from "./merchant-dining-join-state.js";
import type { createMerchantDiningJoinRegenerate } from "./merchant-dining-join-regenerate.js";
import type { createMerchantDiningSessionStart } from "./merchant-dining-session-start.js";
import type { createMerchantDiningTables } from "./merchant-dining-tables.js";
import type { createMerchantDiningClosingCommand } from "./merchant-dining-closing-command.js";
import type { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
import type { createMerchantTaskInboxRead } from "./merchant-task-inbox-read.js";
import type { createMerchantDiningServeCommand } from "./merchant-dining-serve-command.js";
import type { createMerchantDiningOrderProgress } from "./merchant-dining-order-progress.js";
import type { createMerchantPickupQuery } from "./merchant-pickup-query.js";
import { FulfillmentReadinessError } from "@rms/fulfillment";
import type { createMerchantPickupProof } from "./merchant-pickup-proof.js";
import type { createMerchantPickupHandoff } from "./merchant-pickup-handoff.js";
import { PickupHandoffError, PickupProofError } from "@rms/fulfillment";
import type { createMerchantKitchenCommand } from "./merchant-kitchen-command.js";
import type { createMerchantKitchenQuery } from "./merchant-kitchen-query.js";
import { KitchenQueueProjectionError, KitchenWorkLifecycleError } from "@rms/kitchen";
import type { createBrandLifecycleCommand } from "./brand-lifecycle-command.js";
import { BrandAdministrationServiceError } from "@bop/tenant";
import type { createMerchantProductDraftCommand } from "./merchant-product-draft-command.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
import type { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import type { createMerchantMenuDraftQuery } from "./merchant-menu-draft-query.js";
import type { createMerchantProductCreationCommand } from "./merchant-product-creation-command.js";
import { CatalogError } from "@rms/catalog";
import type { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
import { PriceBookWorkflowError } from "@rms/pricing";
import type { createMerchantPriceBookHttpCommand } from "./merchant-price-book-http-command.js";
import type { createPersistentMerchantOrderQueue } from "./persistent-merchant-order-queue.js";
import type { createMerchantOrderAcceptanceCommand } from "./merchant-order-acceptance-command.js";
import type { createMerchantDiningItemService } from "./merchant-dining-item-service.js";
import type { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type { createMerchantServiceControl } from "./merchant-service-control.js";
import type { createMerchantOrderExceptionRead } from "./merchant-order-exception-read.js";
import type {
  AuthenticationSession,
  BrowserCookieMutation,
  RawBrowserCredential,
} from "@bop/identity";
import express, { type Request, type RequestHandler, type Router } from "express";

export interface MerchantWorkspaceSnapshot {
  readonly screenId: "HOME-OVERVIEW";
  readonly selectedScope: {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  };
  readonly authorizedStores: readonly {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  }[];
  readonly businessDate: string;
  readonly storeStatus: "Open" | "Closed" | "Paused" | "Unavailable";
  readonly freshness: "Current" | "Stale";
  readonly dashboardAvailability: "UnavailableUntilWP1905";
  readonly navigation: readonly MerchantNavigationItem[];
}

const merchantNavigation = Object.freeze({
  "HOME-OVERVIEW": ["/app", "merchant.access"],
  "ORG-STORE-LIST": ["/app/organization/stores", "organization.store.read"],
  "CAT-MENU-LIST": ["/app/commerce/menus", "catalog.read"],
  "OPS-ORDER-QUEUE": ["/operations/orders", "ordering.operate"],
  "OPS-ORDER-EXCEPTION": ["/operations/order-exceptions", "operations.order-exception.manage"],
  "KIT-KITCHEN-QUEUE": ["/operations/kitchen", "kitchen.operate"],
  "FUL-PICKUP-QUEUE": ["/operations/pickup", "fulfillment.operate"],
  "DEV-KDS-PROFILE": ["/app/integrations/kds-profiles", "integration.manage"],
  "IAM-ROLE-LIST": ["/app/organization/roles", "identity.manage"],
} as const);

export interface MerchantNavigationItem {
  readonly screenId: keyof typeof merchantNavigation;
  readonly label: string;
  readonly href: string;
  readonly permission: string;
}

export interface MerchantBffService {
  start(postLoginPath: unknown): Promise<{
    readonly authorizationUrl: string;
    readonly cookie: BrowserCookieMutation;
  }>;
  callback(input: {
    readonly code: unknown;
    readonly state: unknown;
    readonly authCookie: unknown;
  }): Promise<{
    readonly postLoginPath: string;
    readonly session: AuthenticationSession;
    readonly cookies: readonly BrowserCookieMutation[];
  }>;
  bootstrap(sessionCookie: unknown): Promise<{
    readonly session: AuthenticationSession;
    readonly csrf: RawBrowserCredential;
    readonly workspace: unknown;
  }>;
  authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession>;
  logout(sessionCookie: unknown): Promise<BrowserCookieMutation>;
  switchStore(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly targetStoreReference: unknown;
  }): Promise<{ readonly cookie: BrowserCookieMutation; readonly workspace: unknown }>;
}

export interface MerchantBffRouterOptions {
  readonly reconciliationAssigneeQuery?: ReturnType<
    typeof createMerchantReconciliationAssigneeQuery
  >;
  readonly reconciliationEvidenceQuery?: ReturnType<
    typeof createMerchantReconciliationEvidenceQuery
  >;
  readonly reconciliationFollowUpQuery?: ReturnType<
    typeof createMerchantReconciliationFollowUpQuery
  >;
  readonly reconciliationFollowUp?: ReturnType<typeof createMerchantReconciliationFollowUpCommand>;
  readonly compensationQuery?: ReturnType<typeof createMerchantCompensationReconciliationQuery>;
  readonly compensationReconciliation?: ReturnType<
    typeof createMerchantCompensationReconciliationCommand
  >;
  readonly refundPaymentContext?: ReturnType<typeof createMerchantRefundPaymentContext>;
  readonly ordinaryRefundPreview?: ReturnType<
    typeof createMerchantOrdinaryRefundRequest
  >["preview"];
  readonly ordinaryRefundStatus?: ReturnType<typeof createMerchantOrdinaryRefundStatus>;
  readonly ordinaryRefundItems?: ReturnType<typeof createMerchantOrdinaryRefundItems>;
  readonly ordinaryRefundRequest?: (
    ...args: Parameters<ReturnType<typeof createMerchantOrdinaryRefundRequest>>
  ) => ReturnType<ReturnType<typeof createMerchantOrdinaryRefundRequest>>;
  readonly taskInbox?: ReturnType<typeof createMerchantTaskInboxRead>;
  readonly pickupQuery?: ReturnType<typeof createMerchantPickupQuery>;
  readonly pickupProof?: ReturnType<typeof createMerchantPickupProof>;
  readonly pickupHandoff?: ReturnType<typeof createMerchantPickupHandoff>;
  readonly kitchenQuery?: ReturnType<typeof createMerchantKitchenQuery>;
  readonly kitchenCommand?: ReturnType<typeof createMerchantKitchenCommand>;
  readonly ordinaryRefund?: ReturnType<typeof createMerchantOrdinaryRefundCommand>;
  readonly ordinaryRefundSend?: ReturnType<typeof createMerchantOrdinaryRefundSendCommand>;
  readonly ordinaryRefundReconciliation?: ReturnType<
    typeof createMerchantOrdinaryRefundReconciliationCommand
  >;
  readonly orderQueue?: ReturnType<typeof createPersistentMerchantOrderQueue>;
  readonly menuPublication?: ReturnType<typeof createMerchantMenuPublicationCommand>;
  readonly menuDraft?: ReturnType<typeof createMerchantMenuDraftQuery>;
  readonly brandLifecycle?: ReturnType<typeof createBrandLifecycleCommand>;
  readonly productDraft?: ReturnType<typeof createMerchantProductDraftCommand>;
  readonly productCreation?: ReturnType<typeof createMerchantProductCreationCommand>;
  readonly productLifecycle?: ReturnType<typeof createMerchantProductLifecycleCommand>;
  readonly priceBooks?: ReturnType<typeof createMerchantPriceBookHttpCommand>;
  readonly diningJoinState?: ReturnType<typeof createMerchantDiningJoinState>;
  readonly diningJoinRegenerate?: ReturnType<typeof createMerchantDiningJoinRegenerate>;
  readonly diningHostSelection?: ReturnType<typeof createMerchantDiningHostSelection>;
  readonly diningHostTransfer?: ReturnType<typeof createMerchantDiningHostTransfer>;
  readonly diningSessionStart?: ReturnType<typeof createMerchantDiningSessionStart>;
  readonly diningClosing?: ReturnType<typeof createMerchantDiningClosingCommand>;
  readonly orderClosure?: ReturnType<typeof createMerchantDiningOrderCloseCommand>;
  readonly orderAcceptance?: ReturnType<typeof createMerchantOrderAcceptanceCommand>;
  readonly diningServe?: ReturnType<typeof createMerchantDiningServeCommand>;
  readonly diningTables?: ReturnType<typeof createMerchantDiningTables>;
  readonly diningOrderProgress?: ReturnType<typeof createMerchantDiningOrderProgress>;
  readonly diningItemService?: ReturnType<typeof createMerchantDiningItemService>;
  readonly serviceControl?: (
    input: Parameters<ReturnType<typeof createMerchantServiceControl>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantServiceControl>>;
  readonly storeConfiguration?: (
    input: Parameters<ReturnType<typeof createMerchantStoreConfiguration>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantStoreConfiguration>>;
  readonly storeConfigurationState?: ReturnType<typeof createMerchantStoreConfiguration>["read"];
  readonly serviceControlState?: ReturnType<typeof createMerchantServiceControl>["read"];
  readonly orderExceptions?: ReturnType<typeof createMerchantOrderExceptionRead>;
  readonly service: MerchantBffService;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
}

const NO_STORE = "no-store";

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function cookie(request: Request, name: string): string | null {
  const headers = rawHeaderValues(request, "cookie");
  const header = headers[0];
  if (headers.length !== 1 || header === undefined || header.length > 4096) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match === undefined) return null;
  const value = match.slice(name.length + 1);
  return value && !/[\s;,]/u.test(value) ? value : null;
}

function serializeCookie(mutation: BrowserCookieMutation): string {
  const { descriptor } = mutation;
  const parts = [
    `${descriptor.name}=${mutation.value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mutation.clear) parts.push("Max-Age=0");
  else if (descriptor.maxAgeSeconds !== null) parts.push(`Max-Age=${descriptor.maxAgeSeconds}`);
  return parts.join("; ");
}

function exactHeader(request: Request, name: string): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function trustedHost(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (exactHeader(request, "host") !== options.acceptedHost) {
      response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
      return;
    }
    next();
  };
}

function safeRead(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      (fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function oidcCallbackNavigation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      !["same-origin", "cross-site", "none"].includes(fetchSite ?? "")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function sameOriginMutation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (
      exactHeader(request, "origin") !== options.exactOrigin ||
      exactHeader(request, "sec-fetch-site") !== "same-origin"
    ) {
      denied(response);
      return;
    }
    next();
  };
}

const workspaceKeys = [
  "screenId",
  "selectedScope",
  "authorizedStores",
  "businessDate",
  "storeStatus",
  "freshness",
  "dashboardAvailability",
  "navigation",
] as const;
const scopeKeys = ["brandLabel", "storeLabel", "storeReference"] as const;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeLabel = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function targetStoreReference(value: unknown): unknown {
  return closed(value, ["targetStoreReference"]).targetStoreReference;
}

function scope(value: unknown) {
  const input = closed(value, scopeKeys);
  if (
    typeof input.brandLabel !== "string" ||
    !safeLabel.test(input.brandLabel) ||
    typeof input.storeLabel !== "string" ||
    !safeLabel.test(input.storeLabel) ||
    typeof input.storeReference !== "string" ||
    !uuidV7.test(input.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    brandLabel: input.brandLabel,
    storeLabel: input.storeLabel,
    storeReference: input.storeReference,
  });
}

function navigationItem(value: unknown): MerchantNavigationItem {
  const input = closed(value, ["screenId", "label", "href", "permission"]);
  if (
    typeof input.screenId !== "string" ||
    !Object.hasOwn(merchantNavigation, input.screenId) ||
    typeof input.label !== "string" ||
    !safeLabel.test(input.label)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const screenId = input.screenId as keyof typeof merchantNavigation;
  const expected = merchantNavigation[screenId];
  if (input.href !== expected[0] || input.permission !== expected[1])
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId,
    label: input.label,
    href: expected[0],
    permission: expected[1],
  });
}

export function parseMerchantWorkspaceSnapshot(value: unknown): MerchantWorkspaceSnapshot {
  const input = closed(value, workspaceKeys);
  const parsedBusinessDate =
    typeof input.businessDate === "string"
      ? Date.parse(`${input.businessDate}T00:00:00.000Z`)
      : Number.NaN;
  if (
    input.screenId !== "HOME-OVERVIEW" ||
    !Array.isArray(input.authorizedStores) ||
    input.authorizedStores.length < 1 ||
    input.authorizedStores.length > 100 ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isFinite(parsedBusinessDate) ||
    new Date(parsedBusinessDate).toISOString().slice(0, 10) !== input.businessDate ||
    !["Open", "Closed", "Paused", "Unavailable"].includes(String(input.storeStatus)) ||
    (input.freshness !== "Current" && input.freshness !== "Stale") ||
    input.dashboardAvailability !== "UnavailableUntilWP1905" ||
    !Array.isArray(input.navigation) ||
    input.navigation.length > 20
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const navigation = Object.freeze(input.navigation.map(navigationItem));
  if (new Set(navigation.map((item) => item.screenId)).size !== navigation.length)
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const selectedScope = scope(input.selectedScope);
  const authorizedStores = Object.freeze(input.authorizedStores.map(scope));
  if (
    new Set(authorizedStores.map((item) => item.storeReference)).size !== authorizedStores.length ||
    !authorizedStores.some((item) => item.storeReference === selectedScope.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId: "HOME-OVERVIEW",
    selectedScope,
    authorizedStores,
    businessDate: input.businessDate,
    storeStatus: input.storeStatus as MerchantWorkspaceSnapshot["storeStatus"],
    freshness: input.freshness,
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation,
  });
}

function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}

export function createMerchantBffRouter(options: MerchantBffRouterOptions): Router {
  const router = express.Router();
  router.use(express.json({ limit: "8kb", strict: true }));
  router.use(trustedHost(options));
  router.use((_request, response, next) => {
    response.set("Cache-Control", NO_STORE);
    next();
  });

  router.get("/orders", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const after = request.query.after;
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).some((key) => key !== "after") ||
      (after !== undefined &&
        (typeof after !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after))) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderQueue) {
      response.status(503).json({ error: "order_queue_unavailable" });
      return;
    }
    void options
      .orderQueue({ sessionCookie, afterOrderReference: after ?? null })
      .then((view) =>
        response.json({
          items: view.items.map((item) => ({
            orderReference: item.orderReference,
            orderNumber: item.orderNumber,
            orderType: item.orderType,
            sourceChannel: item.sourceChannel,
            submittedAt: item.submittedAt,
            initialBatchReference: item.initialBatchReference,
            canRequestAcceptance: item.canRequestAcceptance,
            batches: item.batches.map((batch) => ({
              orderBatchReference: batch.orderBatchReference,
              sequence: batch.sequence,
              acceptanceStatus: batch.acceptanceStatus,
              canRequestAcceptance: batch.canRequestAcceptance,
            })),
            currentPhase: item.currentPhase,
            currentVersion: item.currentVersion,
            observedAt: item.observedAt,
          })),
          nextAfterOrderReference: view.nextAfterOrderReference,
        }),
      )
      .catch(() => denied(response));
  });

  router.get("/tasks", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const cursors = rawHeaderValues(request, "x-bop-task-after"),
      after = cursors[0];
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      cursors.length > 1 ||
      (after !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(after))
    ) {
      denied(response);
      return;
    }
    if (!options.taskInbox) {
      response.status(503).json({ error: "task_inbox_unavailable" });
      return;
    }
    void options
      .taskInbox(sessionCookie, { afterTaskReference: after ?? null })
      .then((view) => {
        response.json({
          screenId: view.screenId,
          storeLabel: view.storeLabel,
          observedAt: view.observedAt,
          nextAfterTaskReference: view.nextAfterTaskReference,
          items: view.items.map((item) => ({
            taskReference: item.taskReference,
            version: item.version,
            taskType: item.taskType,
            severity: item.severity,
            priority: item.priority,
            status: item.status,
            ownerStatus: item.ownerStatus,
            dueAt: item.dueAt,
            sourceType: item.sourceType,
            sourceReference: item.sourceReference,
            canClaim: item.canClaim,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.get("/order-exceptions", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      sessionCookie === null ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderExceptions) {
      response.status(503).json({ error: "order_exceptions_unavailable" });
      return;
    }
    void options
      .orderExceptions(sessionCookie)
      .then((view) => {
        response.json({
          screenId: view.screenId,
          projectionName: view.projectionName,
          storeLabel: view.storeLabel,
          businessDate: view.businessDate,
          projectedAt: view.projectedAt,
          freshnessStatus: view.freshnessStatus,
          items: view.items.map((item) => ({
            exceptionReference: item.exceptionReference,
            orderReference: item.orderReference,
            kind: item.kind,
            severity: item.severity,
            status: item.status,
            providerState: item.providerState,
            compensationStatus: item.compensationStatus,
            sourceOwner: item.sourceOwner,
            createdAt: item.createdAt,
            dueAt: item.dueAt,
            ownerStatus: item.ownerStatus,
            sourceFinal: item.sourceFinal,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.get("/login", safeRead(options), (request, response) => {
    void options.service
      .start(request.query.returnTo ?? "/")
      .then((result) => {
        response.set("Set-Cookie", serializeCookie(result.cookie));
        response.redirect(303, result.authorizationUrl);
      })
      .catch(() => denied(response));
  });

  router.get("/callback", oidcCallbackNavigation(options), (request, response) => {
    void options.service
      .callback({
        code: request.query.code,
        state: request.query.state,
        authCookie: cookie(request, "__Host-bop-auth"),
      })
      .then((result) => {
        response.set("Set-Cookie", result.cookies.map(serializeCookie));
        response.redirect(303, result.postLoginPath);
      })
      .catch(() => {
        response.set(
          "Set-Cookie",
          "__Host-bop-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        denied(response);
      });
  });

  router.get("/session", safeRead(options), (request, response) => {
    void options.service
      .bootstrap(cookie(request, "__Host-bop-merchant"))
      .then((result) => {
        response.json({
          authenticated: true,
          csrf: result.csrf,
          workspace: parseMerchantWorkspaceSnapshot(result.workspace),
        });
      })
      .catch(() => denied(response));
  });

  router.get("/service-control", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.serviceControlState) {
      response.status(503).json({ error: "service_control_unavailable" });
      return;
    }
    void options
      .serviceControlState(sessionCookie)
      .then((state) => response.json(state))
      .catch(() => denied(response));
  });

  router.get("/store-configuration", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.storeConfigurationState) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfigurationState(sessionCookie)
      .then((state) => response.json(state))
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/status", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundStatus) {
      response.status(503).json({ error: "refund_status_unavailable" });
      return;
    }
    void options
      .ordinaryRefundStatus({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          observedAt: result.observedAt,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          payments: result.payments.map((payment) => ({
            paymentAttemptReference: payment.paymentAttemptReference,
            paymentIntentReference: payment.paymentIntentReference,
            state: payment.state,
            executionOperationReference: payment.executionOperationReference,
            amountMinor: payment.amountMinor,
            confirmedMinor: payment.confirmedMinor,
            pendingMinor: payment.pendingMinor,
          })),
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/context", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.refundPaymentContext) {
      response.status(503).json({ error: "refund_payment_context_unavailable" });
      return;
    }
    void options
      .refundPaymentContext({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          paymentIntentReference: result.paymentIntentReference,
          paymentAttemptReference: result.paymentAttemptReference,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          observedAt: result.observedAt,
          paymentState: result.paymentState,
          currencyCode: result.currencyCode,
          capturedAmountMinor: result.capturedAmountMinor,
          confirmedRefundMinor: result.confirmedRefundMinor,
          pendingRefundMinor: result.pendingRefundMinor,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/items", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundItems) {
      response.status(503).json({ error: "refund_items_unavailable" });
      return;
    }
    void options
      .ordinaryRefundItems({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          orderNumber: result.orderNumber,
          claimVersion: result.claimVersion,
          recentRequests: result.recentRequests.map((entry) => ({
            requestReference: entry.requestReference,
            operationReference: entry.operationReference,
            claimVersion: entry.claimVersion,
            requestedAt: entry.requestedAt,
            reasonCode: entry.reasonCode,
            currencyCode: entry.currencyCode,
            amountMinor: entry.amountMinor,
          })),
          items: result.items.map((item) => ({
            orderBatchReference: item.orderBatchReference,
            orderItemReference: item.orderItemReference,
            label: item.label,
            quantity: item.quantity,
            unclaimedQuantity: item.unclaimedQuantity,
            paymentCaptured: item.paymentCaptured,
            paymentIntentReference: item.paymentIntentReference,
          })),
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/preview", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundPreview) {
      response.status(503).json({ error: "refund_preview_unavailable" });
      return;
    }
    void options
      .ordinaryRefundPreview({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          components: {
            netAmountMinor: result.components.netAmountMinor,
            taxAmountMinor: result.components.taxAmountMinor,
            tipAmountMinor: result.components.tipAmountMinor,
            serviceChargeAmountMinor: result.components.serviceChargeAmountMinor,
            serviceChargeTaxAmountMinor: result.components.serviceChargeTaxAmountMinor,
          },
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/request", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundRequest) {
      response.status(503).json({ error: "refund_request_unavailable" });
      return;
    }
    void options
      .ordinaryRefundRequest({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.status(202).json({
          status: "RequestRecorded",
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          replayed: result.status === "AlreadyCommitted",
        });
      })
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/prepare", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefund) {
      response.status(503).json({ error: "refund_preparation_unavailable" });
      return;
    }
    void options
      .ordinaryRefund({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.status(202).json({
          status: "PreparationRecorded",
          operationReference: result.operationReference,
          replayed: result.status === "AlreadyCommitted",
        }),
      )
      .catch(() => denied(response));
  });

  router.post(
    "/operations/compensations/query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.compensationQuery) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationQuery({ sessionCookie, csrf, query: request.body })
        .then((result) =>
          response.json({
            caseVersion: result.caseVersion,
            caseState: result.caseState,
            refund: {
              amountMinor: result.refund.amountMinor,
              currencyCode: result.refund.currencyCode,
              confirmedAt: result.refund.confirmedAt,
            },
            acknowledgmentRecorded: result.acknowledgmentRecorded,
          }),
        )
        .catch(() =>
          response.status(503).json({ error: "compensation_reconciliation_unavailable" }),
        );
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-assignees",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationAssigneeQuery) {
        response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        return;
      }
      void options
        .reconciliationAssigneeQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (!Array.isArray(result.items) || result.items.length > 25)
            throw Error("RECONCILIATION_ASSIGNEES_INVALID");
          const seen = new Set<string>();
          const items = result.items.map((item) => {
            const actorReference = String(
              parseOpaqueUuidV7(item.actorReference, "ACTOR_REFERENCE_INVALID"),
            );
            if (
              seen.has(actorReference) ||
              typeof item.label !== "string" ||
              !/^([^\p{Cc}\p{Cf}]){1,80}$/u.test(item.label) ||
              item.label.trim() !== item.label ||
              item.label.includes("@")
            )
              throw Error("RECONCILIATION_ASSIGNEES_INVALID");
            seen.add(actorReference);
            return { actorReference, label: item.label };
          });
          const nextAfterActorReference =
            result.nextAfterActorReference === null
              ? null
              : String(
                  parseOpaqueUuidV7(result.nextAfterActorReference, "ACTOR_REFERENCE_INVALID"),
                );
          response.status(200).json({ items, nextAfterActorReference });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-evidence",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationEvidenceQuery) {
        response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        return;
      }
      void options
        .reconciliationEvidenceQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (result === null) {
            response.status(200).json({ evidence: null });
            return;
          }
          if (
            typeof result.amountMinor !== "string" ||
            !/^[1-9][0-9]{0,18}$/.test(result.amountMinor) ||
            BigInt(result.amountMinor) > 9223372036854775807n ||
            result.currencyCode !== "CAD" ||
            !["Test", "Live"].includes(result.environment) ||
            result.recordedReason !== "ProviderCaptureWithoutInternalOperation"
          )
            throw Error("RECONCILIATION_EVIDENCE_INVALID");
          const occurredAt = String(parseCanonicalInstant(result.occurredAt)),
            observedAt = String(parseCanonicalInstant(result.observedAt));
          if (occurredAt > observedAt) throw Error("RECONCILIATION_EVIDENCE_INVALID");
          response.status(200).json({
            evidence: {
              amountMinor: result.amountMinor,
              currencyCode: "CAD",
              environment: result.environment,
              occurredAt,
              observedAt,
              recordedReason: result.recordedReason,
            },
          });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof PaymentReconciliationError &&
              error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationFollowUpQuery) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUpQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (
            !Number.isSafeInteger(result.version) ||
            result.version < 1 ||
            !["Open", "Acknowledged", "Assigned"].includes(result.followUpStatus) ||
            typeof result.acknowledged !== "boolean" ||
            typeof result.assigned !== "boolean" ||
            (result.followUpStatus === "Open" && (result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Acknowledged" &&
              (!result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Assigned" && !result.assigned)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          response.status(200).json({
            version: result.version,
            followUpStatus: result.followUpStatus,
            acknowledged: result.acknowledged,
            assigned: result.assigned,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "reconciliation_follow_up_unavailable" }));
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationFollowUp) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUp({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (
            !["Created", "Duplicate"].includes(result.status) ||
            !Number.isSafeInteger(result.version) ||
            result.version < 2 ||
            !["Acknowledged", "Assigned"].includes(result.followUpStatus)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          return response.status(202).json({
            status: "FollowUpRecorded",
            replayed: result.status === "Duplicate",
            version: result.version,
            followUpStatus: result.followUpStatus,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch((error) => {
          if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") {
            denied(response);
            return;
          }
          if (error instanceof ReconciliationFollowUpError) {
            if (error.code === "RECONCILIATION_FOLLOW_UP_CONFLICT") {
              response.status(409).json({ error: "reconciliation_follow_up_conflict" });
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED") {
              denied(response);
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_INVALID") {
              response.status(400).json({ error: "reconciliation_follow_up_invalid" });
              return;
            }
          }
          response.status(503).json({ error: "reconciliation_follow_up_unknown" });
        });
    },
  );

  router.post(
    "/operations/compensations/reconcile",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.compensationReconciliation) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationReconciliation({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (result.status !== "Created" && result.status !== "Duplicate")
            throw new Error("COMPENSATION_RECONCILIATION_RESULT_INVALID");
          return response.status(202).json({
            status: "ReconciliationRecorded",
            replayed: result.status === "Duplicate",
            reconciledAt: String(parseCanonicalInstant(result.reconciledAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "compensation_reconciliation_unknown" }));
    },
  );

  for (const [path, capability, status] of [
    ["send", "ordinaryRefundSend", "DispatchRecorded"],
    ["reconcile", "ordinaryRefundReconciliation", "ReconciliationRecorded"],
  ] as const) {
    router.post("/payments/refunds/" + path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      const execute = options[capability];
      if (!execute) {
        response.status(503).json({ error: "refund_execution_unavailable" });
        return;
      }
      void execute({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (path === "send") return response.status(202).json({ status });
          if (!("receipt" in result)) throw new Error("REFUND_RECEIPT_RESULT_INVALID");
          const receipt = result.receipt;
          return response.status(202).json({
            status,
            receipt: {
              status: receipt.status,
              version: receipt.version,
              kind: receipt.kind,
            },
          });
        })
        // A failure may follow committed dispatch/observation. Never tell the client
        // to discard its original identity or infer that nothing happened.
        .catch(() => response.status(503).json({ error: "refund_execution_unknown" }));
    });
  }

  router.post("/kitchen/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenQuery) {
      response.status(503).json({ error: "kitchen_queue_unavailable" });
      return;
    }
    void options
      .kitchenQuery({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenQueueProjectionError)) {
          denied(response);
          return;
        }
        const status = {
          KITCHEN_QUEUE_INPUT_INVALID: 400,
          KITCHEN_QUEUE_PERMISSION_DENIED: 403,
          KITCHEN_QUEUE_NOT_FOUND: 404,
          KITCHEN_QUEUE_VERSION_CONFLICT: 409,
          KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/kitchen/work", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenCommand) {
      response.status(503).json({ error: "kitchen_work_unavailable" });
      return;
    }
    void options
      .kitchenCommand({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenWorkLifecycleError)) {
          denied(response);
          return;
        }
        const status = {
          KITCHEN_WORK_INPUT_INVALID: 400,
          KITCHEN_WORK_PERMISSION_DENIED: 403,
          KITCHEN_WORK_NOT_FOUND: 404,
          KITCHEN_WORK_VERSION_CONFLICT: 409,
          KITCHEN_WORK_PRECONDITION_FAILED: 422,
          KITCHEN_WORK_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupQuery) {
      response.status(503).json({ error: "pickup_queue_unavailable" });
      return;
    }
    void options
      .pickupQuery({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof FulfillmentReadinessError)) {
          denied(response);
          return;
        }
        const status = {
          FULFILLMENT_READINESS_INPUT_INVALID: 400,
          FULFILLMENT_READINESS_PERMISSION_DENIED: 403,
          FULFILLMENT_READINESS_NOT_FOUND: 404,
          FULFILLMENT_READINESS_CONFLICT: 409,
          FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/handoff", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupHandoff) {
      response.status(503).json({ error: "pickup_handoff_unavailable" });
      return;
    }
    void options
      .pickupHandoff({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/proof", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupProof) {
      response.status(503).json({ error: "pickup_proof_unavailable" });
      return;
    }
    void options
      .pickupProof({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError) && !(error instanceof PickupProofError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_PROOF_INPUT_INVALID: 400,
          PICKUP_PROOF_NOT_READY: 422,
          PICKUP_PROOF_VERSION_CONFLICT: 409,
          PICKUP_PROOF_UNAVAILABLE: 422,
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/dining/sessions/join-state", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinState) {
      response.status(503).json({ error: "dining_join_state_unavailable" });
      return;
    }
    void options
      .diningJoinState({ sessionCookie, csrf, query: request.body })
      .then((r) =>
        response.json({
          diningSessionReference: r.diningSessionReference,
          tableReference: r.tableReference,
          sessionVersion: r.sessionVersion,
          tableAssignmentVersion: r.tableAssignmentVersion,
          capabilityVersion: r.capabilityVersion,
          generation: r.generation,
          joinKind: r.joinKind,
        }),
      )
      .catch(() => denied(response));
  });
  router.post("/dining/sessions/regenerate", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinRegenerate) {
      response.status(503).json({ error: "dining_join_regenerate_unavailable" });
      return;
    }
    void options
      .diningJoinRegenerate({ sessionCookie, csrf, command: request.body })
      .then((r) => {
        if (
          !r ||
          !["Issued", "AlreadyApplied"].includes(r.status) ||
          !Number.isSafeInteger(r.generation) ||
          r.generation < 1 ||
          !Number.isSafeInteger(r.capabilityVersion) ||
          r.capabilityVersion < 1 ||
          !["HumanCode", "Invitation"].includes(r.joinKind) ||
          (r.status === "Issued" &&
            (typeof r.joinCredential !== "string" ||
              !(r.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                r.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: r.status,
          generation: r.generation,
          capabilityVersion: r.capabilityVersion,
          joinKind: r.joinKind,
          ...(r.status === "Issued" ? { joinCredential: r.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post(
    "/dining/sessions/host-transfer",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostTransfer) {
        response.status(503).json({ error: "dining_host_transfer_unavailable" });
        return;
      }
      void options
        .diningHostTransfer({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !result ||
            !["Applied", "AlreadyApplied"].includes(result.status) ||
            !reference.test(result.operationReference) ||
            !reference.test(result.diningSessionReference) ||
            !reference.test(String(result.hostParticipantReference)) ||
            (result.previousHostParticipantReference !== null &&
              !reference.test(result.previousHostParticipantReference)) ||
            result.hostParticipantReference === result.previousHostParticipantReference ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 2 ||
            result.sessionVersion > 2147483647 ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.transferredAt) ||
            !Number.isFinite(Date.parse(result.transferredAt)) ||
            new Date(result.transferredAt).toISOString() !== result.transferredAt
          ) {
            denied(response);
            return;
          }
          response.json({
            status: result.status,
            operationReference: result.operationReference,
            diningSessionReference: result.diningSessionReference,
            previousHostParticipantReference: result.previousHostParticipantReference,
            hostParticipantReference: result.hostParticipantReference,
            sessionVersion: result.sessionVersion,
            transferredAt: result.transferredAt,
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post(
    "/dining/sessions/host-selection",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostSelection) {
        response.status(503).json({ error: "dining_host_selection_unavailable" });
        return;
      }
      void options
        .diningHostSelection({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          const instant = (value: string) =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value;
          if (
            !result ||
            !reference.test(result.diningSessionReference) ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 1 ||
            result.sessionVersion >= 2147483647 ||
            !["Active", "Closing"].includes(result.phase) ||
            (result.hostParticipantReference !== null &&
              !reference.test(result.hostParticipantReference)) ||
            !instant(result.observedAt) ||
            !Array.isArray(result.participants) ||
            result.participants.length > 100
          ) {
            denied(response);
            return;
          }
          const seen = new Set<string>();
          for (const p of result.participants) {
            if (
              !p ||
              !reference.test(p.participantReference) ||
              !instant(p.joinedAt) ||
              p.joinedAt > result.observedAt ||
              p.isHost !== (p.participantReference === result.hostParticipantReference) ||
              seen.has(p.participantReference)
            ) {
              denied(response);
              return;
            }
            seen.add(p.participantReference);
          }
          response.json({
            diningSessionReference: result.diningSessionReference,
            sessionVersion: result.sessionVersion,
            phase: result.phase,
            hostParticipantReference: result.hostParticipantReference,
            observedAt: result.observedAt,
            participants: result.participants.map((p) => ({
              participantReference: p.participantReference,
              joinedAt: p.joinedAt,
              isHost: p.isHost,
            })),
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post("/dining/sessions/start", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningSessionStart) {
      response.status(503).json({ error: "dining_session_start_unavailable" });
      return;
    }
    void options
      .diningSessionStart({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        if (
          !result ||
          !["Issued", "AlreadyApplied"].includes(result.status) ||
          !reference.test(result.diningSessionReference) ||
          !reference.test(result.tableReference) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1 ||
          !Number.isSafeInteger(result.tableAssignmentVersion) ||
          result.tableAssignmentVersion < 1 ||
          !["Invitation", "HumanCode"].includes(result.joinKind) ||
          (result.status === "Issued" &&
            (typeof result.joinCredential !== "string" ||
              !(result.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                result.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          diningSessionReference: result.diningSessionReference,
          sessionVersion: result.sessionVersion,
          tableReference: result.tableReference,
          tableAssignmentVersion: result.tableAssignmentVersion,
          joinKind: result.joinKind,
          ...(result.status === "Issued" ? { joinCredential: result.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/tables", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTables) {
      response.status(503).json({ error: "dining_tables_unavailable" });
      return;
    }
    void options
      .diningTables({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch(() => denied(response));
  });

  router.post("/dining/order-progress", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningOrderProgress) {
      response.status(503).json({ error: "dining_order_progress_unavailable" });
      return;
    }
    void options
      .diningOrderProgress({ sessionCookie, csrf, query: request.body })
      .then((current) => {
        if (!current) {
          response.status(404).json({ error: "dining_order_progress_unavailable" });
          return;
        }
        response.json({
          orderReference: current.orderReference,
          tableLabel: current.tableLabel,
          diningSessionReference: current.diningSessionReference,
          sessionPhase: current.sessionPhase,
          closureStatus: current.closureStatus,
          closureVersion: current.closureVersion,
          currentOrderVersion: current.currentOrderVersion,
          sessionVersion: current.sessionVersion,
          tableAssignmentVersion: current.tableAssignmentVersion,
          orderVersion: current.orderVersion,
          phase: current.phase,
          observedAt: current.observedAt,
          items: current.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            orderBatchReference: item.orderBatchReference,
            displayName: item.displayName,
            batchSequence: item.batchSequence,
            itemOrdinal: item.itemOrdinal,
            phase: item.phase,
            orderedQuantity: item.orderedQuantity,
            deliveredQuantity: item.deliveredQuantity,
            remainingQuantity: item.remainingQuantity,
            itemServiceVersion: item.itemServiceVersion,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/serve", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningServe) {
      response.status(503).json({ error: "dining_serve_unavailable" });
      return;
    }
    void options
      .diningServe({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/dining/item-service", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningItemService) {
      response.status(503).json({ error: "dining_item_service_unavailable" });
      return;
    }
    void options
      .diningItemService({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.record.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/catalog/menus/publication", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.menuPublication) {
      response.status(503).json({ error: "menu_publication_unavailable" });
      return;
    }
    void options
      .menuPublication({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_publication_invalid"
              : status === 409
                ? "menu_publication_conflict"
                : status === 503
                  ? "menu_publication_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/menus/draft", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.menuDraft) {
      response.status(503).json({ error: "menu_draft_unavailable" });
      return;
    }
    void options
      .menuDraft({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_draft_invalid"
              : status === 409
                ? "menu_draft_conflict"
                : status === 503
                  ? "menu_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post(
    "/organization/brands/lifecycle",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.brandLifecycle) {
        response.status(503).json({ error: "brand_lifecycle_unavailable" });
        return;
      }
      void options
        .brandLifecycle({ sessionCookie, csrf, command: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (!(error instanceof BrandAdministrationServiceError)) {
            denied(response);
            return;
          }
          const status =
            error.code === "BRAND_ADMIN_INPUT_INVALID"
              ? 400
              : [
                    "BRAND_ADMIN_VERSION_CONFLICT",
                    "BRAND_ADMIN_IDEMPOTENCY_CONFLICT",
                    "BRAND_ADMIN_LIFECYCLE_CONFLICT",
                  ].includes(error.code)
                ? 409
                : error.code === "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
          response.status(status).json({
            error:
              status === 400
                ? "brand_lifecycle_invalid"
                : status === 409
                  ? "brand_lifecycle_conflict"
                  : status === 503
                    ? "brand_lifecycle_unavailable"
                    : "request_denied",
          });
        });
    },
  );

  router.post("/catalog/products", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.productCreation) {
      response.status(503).json({ error: "product_creation_unavailable" });
      return;
    }
    void options
      .productCreation({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_creation_invalid"
              : status === 409
                ? "product_creation_conflict"
                : status === 503
                  ? "product_creation_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/draft", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.productDraft) {
      response.status(503).json({ error: "product_draft_unavailable" });
      return;
    }
    void options
      .productDraft({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_draft_invalid"
              : status === 409
                ? "product_draft_conflict"
                : status === 503
                  ? "product_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/lifecycle", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.productLifecycle) {
      response.status(503).json({ error: "product_lifecycle_unavailable" });
      return;
    }
    void options
      .productLifecycle({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_lifecycle_invalid"
              : status === 409
                ? "product_lifecycle_conflict"
                : status === 503
                  ? "product_lifecycle_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/pricing/price-books", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.priceBooks) {
      response.status(503).json({ error: "price_book_unavailable" });
      return;
    }
    void options
      .priceBooks({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PriceBookWorkflowError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "PRICE_BOOK_INPUT_INVALID"
            ? 400
            : [
                  "PRICE_BOOK_VERSION_CONFLICT",
                  "PRICE_BOOK_IDEMPOTENCY_CONFLICT",
                  "PRICE_BOOK_CODE_CONFLICT",
                  "PRICE_BOOK_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "PRICE_BOOK_COVERAGE_INVALID"
                ? 422
                : error.code === "PRICE_BOOK_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
        response.status(status).json({
          error:
            status === 403
              ? "request_denied"
              : status === 400
                ? "price_book_invalid"
                : status === 409
                  ? "price_book_conflict"
                  : status === 422
                    ? "price_book_coverage_invalid"
                    : "price_book_unavailable",
        });
      });
  });

  router.post("/dining/closing", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningClosing) {
      response.status(503).json({ error: "dining_closing_unavailable" });
      return;
    }
    void options
      .diningClosing({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Applied", "AlreadyApplied"].includes(result.status) ||
          !["Closing", "Closed"].includes(result.phase) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          phase: result.phase,
          sessionVersion: result.sessionVersion,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/orders/close", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderClosure) {
      response.status(503).json({ error: "order_closure_unavailable" });
      return;
    }
    void options
      .orderClosure({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Committed", "AlreadyCommitted"].includes(result.status) ||
          !Number.isSafeInteger(result.closedOrderVersion) ||
          result.closedOrderVersion < 1 ||
          !Number.isSafeInteger(result.closureVersion) ||
          result.closureVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          closedOrderVersion: result.closedOrderVersion,
          closureVersion: result.closureVersion,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/orders/accept", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderAcceptance) {
      response.status(503).json({ error: "order_acceptance_unavailable" });
      return;
    }
    void options
      .orderAcceptance({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          acceptedOrderVersion: result.acceptedOrderVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/service-control", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
      denied(response);
      return;
    }
    if (!options.serviceControl) {
      response.status(503).json({ error: "service_control_unavailable" });
      return;
    }
    void options
      .serviceControl({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({ status: result.status, resultingVersion: result.resultingVersion }),
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          ["STORE_SERVICE_VERSION_CONFLICT", "STORE_SERVICE_IDEMPOTENCY_CONFLICT"].includes(
            error.message,
          )
        )
          response.status(409).json({ error: "service_control_conflict" });
        else denied(response);
      });
  });

  router.post("/store-configuration", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
      denied(response);
      return;
    }
    if (!options.storeConfiguration) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfiguration({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({ status: result.status, resultingVersion: result.resultingVersion }),
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          [
            "STORE_CONFIGURATION_VERSION_CONFLICT",
            "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT",
          ].includes(Object.getOwnPropertyDescriptor(error, "code")?.value)
        )
          response.status(409).json({ error: "store_configuration_conflict" });
        else denied(response);
      });
  });

  router.post("/store-context", sameOriginMutation(options), (request, response) => {
    let target: unknown;
    try {
      target = targetStoreReference(request.body);
    } catch {
      denied(response);
      return;
    }
    void options.service
      .switchStore({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
        targetStoreReference: target,
      })
      .then((result) => {
        response
          .set("Set-Cookie", serializeCookie(result.cookie))
          .json({ workspace: parseMerchantWorkspaceSnapshot(result.workspace) });
      })
      .catch(() => denied(response));
  });

  router.post("/protected", sameOriginMutation(options), (request, response) => {
    void options.service
      .authorize({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
      })
      .then(() => {
        response.json({ authorized: true });
      })
      .catch(() => denied(response));
  });

  router.post("/logout", sameOriginMutation(options), (request, response) => {
    void options.service
      .logout(cookie(request, "__Host-bop-merchant"))
      .then((mutation) => {
        response.set("Set-Cookie", serializeCookie(mutation)).status(204).end();
      })
      .catch(() => denied(response));
  });

  return router;
}
