/** Merchant BFF routes: task inbox, operations alerts, business day and service control. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { parseMerchantTaskInboxFilters } from "./merchant-task-inbox-filters.js";
import { Buffer } from "node:buffer";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantOperationsRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
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
    const filterHeaders = rawHeaderValues(request, "x-bop-task-filters");
    let filters: ReturnType<typeof parseMerchantTaskInboxFilters> | undefined;
    try {
      if (filterHeaders.length > 1) throw new Error("invalid");
      if (filterHeaders[0] !== undefined) {
        if (Buffer.byteLength(filterHeaders[0], "utf8") > 512) throw new Error("invalid");
        filters = parseMerchantTaskInboxFilters(JSON.parse(filterHeaders[0]));
      }
    } catch {
      denied(response);
      return;
    }
    if (!options.taskInbox) {
      response.status(503).json({ error: "task_inbox_unavailable" });
      return;
    }
    void options
      .taskInbox(sessionCookie, {
        afterTaskReference: after ?? null,
        ...(filters === undefined ? {} : { filters }),
      })
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
            canClaim: item.canClaim,
          })),
        });
      })
      .catch(() => denied(response));
  });

  // WP-2423 Q13: operations alerts (system down, backups, certificate, disk) for the Home.
  router.get("/operations-alerts", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.operationsAlerts) {
      response
        .status(503)
        .set("Cache-Control", NO_STORE)
        .json({ error: "operations_alerts_unavailable" });
      return;
    }
    void options
      .operationsAlerts({ sessionCookie })
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch(() => denied(response));
  });

  // WP-2423 Q21: "today" for this Store — its business day, not the calendar day.
  router.get("/business-day", safeRead(options), (request, response) => {
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
    if (!options.businessDay) {
      response.status(503).json({ error: "business_day_unavailable" });
      return;
    }
    void options
      .businessDay(sessionCookie)
      .then((day) =>
        response.set("Cache-Control", NO_STORE).json({
          businessDate: day.businessDate,
          startsAt: day.startsAt,
          endsAt: day.endsAt,
          timeZone: day.timeZone,
          observedAt: day.observedAt,
          // WP-2423 item 8 ③ follow-up: when guests stop ordering in this period (or null).
          lastOrdersAt: day.lastOrdersAt ?? null,
        }),
      )
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
}
